import { useCallback, useEffect, useState } from 'react';
import { GraphView } from '../components/extras/GraphView';
import type { GraphData, GraphNode, GraphEdge, GraphCluster, Spotlight } from '../components/extras/GraphView';
import { API_BASE, getFriend, getPairPack, findPairReport, getReport, getFriendConnections, invokeAgent, getInvokeStream, getAgents, invokePairAgent, getPairStream } from '../data/api';
import { PairAnalysisPanel } from './extras/PairAnalysisPanel';
import type { BatchStatus, LocalAgent } from '../data/api';
import type { FriendConnection } from '../data/api';
import type { Friend, FriendStats } from '../data/types';
import { mdToHtml, MURMUR_MD_CSS } from '../utils/markdown';
import { displayName, maskedWxid, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { useBatchTracker } from '../components/extras/BatchTracker';
import type { BatchHandle } from '../components/extras/BatchTracker';
import { ProfileSwitcher } from '../components/ProfileSwitcher';
import { useActivePlatform } from '../utils/activeProfile';

const TIER_COLORS: Record<string, string> = {
  self: '#FFE6CF', A: '#FF6B47', B: '#E8B57A',
  C: '#5A7A99', D: '#9E9583', E: '#C8BFAB',
};

interface BackendNode {
  id: string;
  wxid: string;
  name: string;
  is_self: boolean;
  tier: string;
  size: number;
  private_msgs: number;
  group_msgs: number;
  groups: number;
  moments_back: number;
  moments_out: number;
  combined_score?: number;
  // Topology fields populated by backend's _compute_friend_topology
  cluster?: string | null;  // cluster_id ("core_1" etc) or null if isolated
  bridge?: boolean;         // top betweenness-centrality node
}

interface BackendEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
  shared_group_count?: number;
  mention_count?: number;
  moments_cross?: number;
  moments_a_to_b?: number;
  moments_b_to_a?: number;
}

interface BackendCluster {
  id: string;
  label: string;
  members: string[];
}

interface BackendGraph {
  nodes: BackendNode[];
  edges: BackendEdge[];
  clusters: BackendCluster[];
  stats: {
    total_people: number; total_edges: number; private_count: number; groups: number;
    core_circles?: number; bridges?: number;
  };
}

/**
 * Layout: Original Fibonacci sphere + GENTLE cluster bias.
 *
 * Default version is the first-version Fibonacci sphere — friends spread
 * uniformly via golden-angle spiral, radius from origin = f(combined_score
 * rank), range 150-700. Result: spectacular criss-cross sphere.
 *
 * Then a SOFT directional pull: each cluster member's angular direction is
 * slerp-ed PARTWAY (CLUSTER_BIAS = 0.45) toward the cluster's centroid
 * direction. Radius unchanged. Members keep their original spread but lean
 * toward a common region — same big neighborhood without collapsing.
 *
 * Why gentle: previous attempts (0.55+ slerp, sector caps, planet system)
 * all over-clustered → "粘在一起，看不清". Original spread is the aesthetic;
 * cluster cohesion is a soft hint, not a hard partition.
 */
function layoutNodes(graph: BackendGraph): GraphData {
  const nodes: GraphNode[] = [];
  const self = graph.nodes.find(n => n.is_self);
  if (self) {
    nodes.push({
      id: 'self', name: '你', is_self: true, tier: 'self',
      cluster: null, color: '#FFE6CF', size: 16,
      x: 0, y: 0, z: 0,
      msgs: 0, private_msgs: 0, group_msgs: 0, groups: graph.clusters.length,
    });
  }

  type Vec3 = { x: number; y: number; z: number };
  const friends = graph.nodes.filter(n => !n.is_self)
    .sort((a, b) => (b.combined_score || 0) - (a.combined_score || 0));
  const N = Math.max(1, friends.length);
  const PHI = Math.PI * (1 + Math.sqrt(5));
  const maxScore = (friends[0]?.combined_score || 1);

  // Step 1 — Original Fibonacci direction + radius for every friend.
  type Slot = { dir: Vec3; r: number };
  const slots = new Map<string, Slot>();
  friends.forEach((bn, i) => {
    const t = (i + 0.5) / N;
    const phi = Math.acos(1 - 2 * t);
    const theta = PHI * i;
    const dir: Vec3 = {
      x: Math.sin(phi) * Math.cos(theta),
      y: Math.cos(phi),
      z: Math.sin(phi) * Math.sin(theta),
    };
    const norm = (bn.combined_score || 0) / maxScore;
    const r = 150 + (1 - norm) * 550;
    slots.set(bn.id, { dir, r });
  });

  // Step 2 — For each cluster ≥3 members, compute centroid direction and
  // gently slerp each member toward it. Bias = 0.45 means members keep ~55%
  // of their original angular distance from centroid → loose grouping.
  const clusterIdToMembers = new Map<string, typeof friends>();
  for (const f of friends) {
    if (!f.cluster) continue;
    if (!clusterIdToMembers.has(f.cluster)) clusterIdToMembers.set(f.cluster, []);
    clusterIdToMembers.get(f.cluster)!.push(f);
  }
  const CLUSTER_BIAS = 0.45;  // 0 = no grouping, 1 = collapse onto centroid
  for (const [, mems] of clusterIdToMembers) {
    if (mems.length < 3) continue;
    // Average direction (already unit) → unit centroid
    let cx = 0, cy = 0, cz = 0;
    for (const m of mems) {
      const s = slots.get(m.id)!;
      cx += s.dir.x; cy += s.dir.y; cz += s.dir.z;
    }
    const clen = Math.hypot(cx, cy, cz) || 1;
    const centroid: Vec3 = { x: cx / clen, y: cy / clen, z: cz / clen };
    // Slerp every member's direction partway to centroid
    for (const m of mems) {
      const s = slots.get(m.id)!;
      const dot = Math.max(-1, Math.min(1,
        s.dir.x * centroid.x + s.dir.y * centroid.y + s.dir.z * centroid.z));
      const omega = Math.acos(dot);
      if (omega < 1e-5) continue;  // already at centroid; nothing to do
      const sinO = Math.sin(omega);
      const k1 = Math.sin((1 - CLUSTER_BIAS) * omega) / sinO;
      const k2 = Math.sin(CLUSTER_BIAS * omega) / sinO;
      s.dir = {
        x: s.dir.x * k1 + centroid.x * k2,
        y: s.dir.y * k1 + centroid.y * k2,
        z: s.dir.z * k1 + centroid.z * k2,
      };
      // Re-normalize to handle floating-point drift
      const len = Math.hypot(s.dir.x, s.dir.y, s.dir.z) || 1;
      s.dir = { x: s.dir.x / len, y: s.dir.y / len, z: s.dir.z / len };
    }
  }

  // Step 3 — Emit nodes (direction × radius + tier jitter).
  friends.forEach((bn, i) => {
    const s = slots.get(bn.id)!;
    // Original tier jitter — keep the breathing-room aesthetic intact since
    // the slerp is gentle and members are still mostly spread by Fibonacci.
    const tierJitter = ({ A: 20, B: 35, C: 50, D: 70, E: 80 } as Record<string, number>)[bn.tier] || 60;
    const jx = Math.sin(i * 7.1) * tierJitter;
    const jy = Math.cos(i * 5.3) * tierJitter;
    const jz = Math.sin(i * 3.7) * tierJitter;
    const pos = { x: s.dir.x * s.r, y: s.dir.y * s.r, z: s.dir.z * s.r };
    nodes.push({
      id: bn.id, name: bn.name,
      is_self: false, tier: bn.tier,
      cluster: bn.cluster ?? null, color: TIER_COLORS[bn.tier] || '#9E9583',
      bridge: !!bn.bridge,
      size: Math.max(8, Math.min(26, bn.size * 0.35)),
      x: pos.x + jx,
      y: pos.y + jy,
      z: pos.z + jz,
      msgs: bn.private_msgs + bn.group_msgs,
      private_msgs: bn.private_msgs,
      group_msgs: bn.group_msgs,
      groups: bn.groups,
      moments_back: bn.moments_back,
      moments_out: bn.moments_out,
      combined_score: bn.combined_score,
    });
  });

  // Pass backend's named clusters (id/label/members) through to GraphView so
  // a future design pass can render cluster visualizations. The stats counter
  // still comes from graph.stats.core_circles (authoritative), but having the
  // list available here means the design AI doesn't need a second roundtrip.
  const designClusters: GraphCluster[] = (graph.clusters || []).map(c => ({
    id: c.id,
    label: c.label,
    members: c.members,
  }));

  const edges: GraphEdge[] = graph.edges.map(e => ({
    source: e.source,
    target: e.target,
    type: (e.type === 'private' ? 'private'
         : e.type === 'mutual_reply' ? 'co_active'
         : e.type === 'mention' ? 'mention'
         : e.type === 'moments_cross' ? 'moments_cross'
         : 'co_group') as GraphEdge['type'],
    raw_weight: e.weight,
    weight: Math.min(1, Math.max(0.05, e.weight / 30)),
    moments_cross: e.moments_cross,
    mention_count: e.mention_count,
    shared_group_count: e.shared_group_count,
  }));

  // Stats — prefer backend's topology-derived counts when present
  // (graph.stats.core_circles + .bridges), fall back to local count when
  // hitting an older etcli that hasn't shipped the topology fields yet.
  const ffEdges = edges.filter(e => e.source !== 'self' && e.target !== 'self').length;
  const isolates = nodes.filter(n => n.isolated).length;
  const bridgesCount = graph.stats.bridges ?? nodes.filter(n => n.bridge).length;
  const coreCirclesCount = graph.stats.core_circles ?? designClusters.length;
  const stats = {
    people: nodes.length,
    edges: edges.length,
    bridges: bridgesCount,
    isolates,
    clusters: coreCirclesCount,
    ffEdges,
  };

  return { nodes, edges, clusters: designClusters, stats };
}

interface Props {
  onBack: () => void;
  onOpenFriend?: (id: string) => void;
}

const TOPN_KEY = 'murmur.graph.topN';

export function GraphPage({ onBack, onOpenFriend }: Props) {
  void usePrivacy();  // re-render when privacy toggle flips
  const [data, setData] = useState<GraphData | null>(null);
  const [backendNodes, setBackendNodes] = useState<BackendNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  // Design handoff (kk/Graph Spotlight): cluster + bridge spotlight is owned
  // up here so multiple GraphView remounts don't lose the focus, and so the
  // banner / picker have a stable place to live across re-renders.
  const [spotlight, setSpotlight] = useState<Spotlight>(null);
  // When entering a spotlight, drop selected node/edge so the side panel
  // doesn't fight the spotlight layer for the same screen real estate.
  const handleSpotlight = useCallback((s: Spotlight) => {
    if (s) { setSelected(null); setSelectedEdge(null); }
    setSpotlight(s);
  }, []);
  const [dark, setDark] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
  const [autoRotateResumeSignal, setAutoRotateResumeSignal] = useState(0);
  const [topN, setTopN] = useState<number>(() => {
    const stored = parseInt(localStorage.getItem(TOPN_KEY) || '100', 10);
    return Number.isFinite(stored) && stored > 0 ? stored : 100;
  });
  const [loading, setLoading] = useState(true);
  // Batch analysis state
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [batchPanelOpen, setBatchPanelOpen] = useState(false);
  const { batch, status: batchStatus, startBatchJob, clearBatch } = useBatchTracker();

  // Load agents once
  useEffect(() => { getAgents().then(setAgents).catch(() => { /* no local agents available */ }); }, []);

  async function startGraphBatch(top_pairs: number, cli: 'claude' | 'codex' | 'both', parallel: number) {
    try {
      const r = await startBatchJob(
        { cli, mode: 'pairs-graph', top: 0, top_pairs, parallel },
        { label: `关系网 Top ${top_pairs} 对${cli === 'both' ? ' · 双引擎' : ''}` },
      );
      if (!r.ok) { alert('启动失败：' + maskText(r.error || '')); return; }
      setBatchPanelOpen(true);
    } catch (e: any) {
      alert('错误：' + (e?.message || e));
    }
  }

  useEffect(() => {
    setLoading(true);
    setData(null);
    fetch(`${API_BASE}/api/graph?scope=private&top_n=${topN}`)
      .then(r => r.json())
      .then((bg: BackendGraph) => {
        setBackendNodes(bg.nodes);
        setData(layoutNodes(bg));
        setLoading(false);
      })
      .catch(e => { setError(e.message || String(e)); setLoading(false); });
  }, [topN]);

  function changeTopN(n: number) {
    setTopN(n);
    localStorage.setItem(TOPN_KEY, String(n));
  }

  function selectNode(id: string | null) {
    setSelected(id);
    if (id) {
      setSelectedEdge(null);
      setAutoRotate(false);
    }
  }
  function selectEdge(edge: GraphEdge | null) {
    setSelectedEdge(edge);
    if (edge) setAutoRotate(false);
  }
  function toggleAutoRotate() {
    if (autoRotate) {
      setAutoRotate(false);
      return;
    }
    setSelected(null);
    setSelectedEdge(null);
    setAutoRotate(true);
    setAutoRotateResumeSignal(s => s + 1);
  }
  const pauseAutoRotate = useCallback(() => setAutoRotate(false), []);
  function nameOf(id: string): string {
    const real = backendNodes.find(n => n.id === id)?.name || id;
    return displayName(id, real);
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div className="et-h2" style={{ color: 'var(--et-rose)' }}>关系图加载失败</div>
        <div className="et-meta" style={{ marginTop: 8 }}>{maskText(error)}</div>
        <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer', marginTop: 16,
          padding: '8px 18px', borderRadius: 8, background: 'var(--et-orange)', color: '#fff' }}>
          返回
        </button>
      </div>
    );
  }
  if (!data || loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
        <div style={{ display: 'inline-block', animation: 'spin 1.4s linear infinite', fontSize: 32 }}>🪐</div>
        <div className="et-meta">正在编织 top {topN} 关系网络…</div>
        <div className="et-meta" style={{ fontSize: 11, color: 'var(--et-faint)' }}>
          首次约 15 秒，之后命中缓存秒开
        </div>
        <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const selectedNode = selected ? data.nodes.find(n => n.id === selected) : null;

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <GraphView
        data={data}
        dark={dark}
        selected={selected}
        selectedEdge={selectedEdge}
        onSelect={selectNode}
        onSelectEdge={selectEdge}
        autoRotate={autoRotate}
        autoRotateResumeSignal={autoRotateResumeSignal}
        onAutoRotatePause={pauseAutoRotate}
        spotlight={spotlight}
        onChangeSpotlight={handleSpotlight}
      />
      {/* Top chrome bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5,
        padding: '14px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: dark
          ? 'linear-gradient(180deg, rgba(11,15,34,0.7), transparent)'
          : 'linear-gradient(180deg, rgba(247,241,230,0.85), transparent)',
        pointerEvents: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, pointerEvents: 'auto' }}>
          <button onClick={onBack} style={{
            all: 'unset', cursor: 'pointer', padding: '6px 12px', borderRadius: 8,
            background: dark ? 'rgba(20,24,42,0.6)' : 'rgba(251,246,238,0.8)',
            border: `0.5px solid ${dark ? 'rgba(244,236,218,0.18)' : 'rgba(26,43,74,0.18)'}`,
            fontSize: 12, color: dark ? '#F4ECDA' : '#1A2B4A',
            backdropFilter: 'blur(8px)',
          }}>← 返回首页</button>
          <ProfileSwitcher />
          <span style={{ fontFamily: 'var(--et-serif)', fontSize: 18, fontWeight: 600,
            color: dark ? '#F4ECDA' : '#1A2B4A' }}>Murmur · 关系网络</span>
          <span style={{ fontSize: 11, color: dark ? 'rgba(244,236,218,0.65)' : 'rgba(26,43,74,0.65)',
            letterSpacing: '0.12em' }}>一张可旋转的社交星图</span>
        </div>
        <div style={{ display: 'flex', gap: 8, pointerEvents: 'auto', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: dark ? 'rgba(244,236,218,0.7)' : 'rgba(26,43,74,0.7)' }}>显示 top</span>
          {[50, 100, 200, 300].map(n => (
            <button key={n} onClick={() => changeTopN(n)}
              style={{
                ...chromeBtn(dark),
                background: topN === n
                  ? (dark ? 'rgba(255,107,71,0.3)' : 'var(--et-orange-soft)')
                  : (dark ? 'rgba(20,24,42,0.6)' : 'rgba(251,246,238,0.8)'),
                color: topN === n ? (dark ? '#FFE6CF' : 'var(--et-orange-2)') : (dark ? '#F4ECDA' : '#1A2B4A'),
                fontWeight: topN === n ? 600 : 500,
              }}>{n}</button>
          ))}
          <button onClick={toggleAutoRotate} style={chromeBtn(dark)}>
            {autoRotate ? '⏸ 暂停旋转' : '▶ 自动旋转'}
          </button>
          <button onClick={() => setBatchPanelOpen(o => !o)} style={{
            ...chromeBtn(dark),
            background: batch && batchStatus?.running
              ? (dark ? 'rgba(255,107,71,0.4)' : 'var(--et-orange-soft)')
              : (dark ? 'rgba(20,24,42,0.6)' : 'rgba(251,246,238,0.8)'),
            color: batch && batchStatus?.running
              ? (dark ? '#FFE6CF' : 'var(--et-orange-2)')
              : (dark ? '#F4ECDA' : '#1A2B4A'),
            fontWeight: batch && batchStatus?.running ? 600 : 500,
          }} title="一次跑完关系网里所有重要朋友对的 AI 分析">
            🤖 批量分析关系{batch && batchStatus?.running ? ` (${batchStatus.pairs_done ?? batchStatus.n_pairs} 已完成)` : ''}
          </button>
          <button onClick={() => setDark(d => !d)} style={chromeBtn(dark)}>
            {dark ? '☼ 亮' : '☾ 暗'}
          </button>
        </div>
      </div>
      {batchPanelOpen && (
        <BatchAnalysisPanel
          dark={dark}
          agents={agents}
          batch={batch}
          status={batchStatus}
          onLaunch={startGraphBatch}
          onReset={clearBatch}
          onClose={() => setBatchPanelOpen(false)}
        />
      )}
      {/* Side panel for selected node */}
      {selectedNode && !selectedNode.is_self && !selectedEdge && (
        <SidePanel node={selectedNode} onClose={() => setSelected(null)}
                   onOpenFriend={() => onOpenFriend?.(selectedNode.id)}
                   onSelectPeer={(peerWxid) => {
                     // Click a "重要连线" entry → open EdgePanel for the X↔peer pair.
                     // The actual graph edge if it exists; otherwise synthesize one.
                     const peerEdge = data.edges.find(e =>
                       (e.source === selectedNode.id && e.target === peerWxid) ||
                       (e.target === selectedNode.id && e.source === peerWxid));
                     selectEdge(peerEdge || ({
                       source: selectedNode.id, target: peerWxid,
                       type: 'mention', weight: 0.1,
                     } as GraphEdge));
                   }} />
      )}
      {/* Side panel for selected edge */}
      {selectedEdge && (
        <EdgePanel
          edge={selectedEdge}
          aName={nameOf(selectedEdge.source)}
          bName={nameOf(selectedEdge.target)}
          onClose={() => setSelectedEdge(null)}
          onOpenFriend={onOpenFriend}
        />
      )}
    </div>
  );
}

function chromeBtn(dark: boolean): React.CSSProperties {
  return {
    all: 'unset', cursor: 'pointer', padding: '7px 12px', borderRadius: 999,
    fontFamily: 'var(--et-sans)', fontSize: 12, fontWeight: 500,
    background: dark ? 'rgba(20,24,42,0.6)' : 'rgba(251,246,238,0.8)',
    border: `0.5px solid ${dark ? 'rgba(244,236,218,0.18)' : 'rgba(26,43,74,0.18)'}`,
    color: dark ? '#F4ECDA' : '#1A2B4A',
    backdropFilter: 'blur(8px)',
  };
}

function AnalysisStreamBox({ stream }: { stream: { output: string; stage: string; elapsed: number } | null }) {
  const tail = stream?.output?.trim().slice(-2000);
  return (
    <div style={{ marginTop: 10 }}>
      <div className="et-meta" style={{
        color: 'var(--et-orange-2)', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span>{stream?.stage || '排队中'}…</span>
        <span style={{ fontFamily: 'var(--et-mono)', fontSize: 10 }}>{stream?.elapsed || 0}s</span>
      </div>
      {tail && (
        <div style={{
          marginTop: 8, padding: '10px 12px', borderRadius: 6,
          background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
          fontFamily: 'var(--et-mono)', fontSize: 11, lineHeight: 1.55,
          color: 'var(--et-ink-soft)', whiteSpace: 'pre-wrap',
          maxHeight: 220, overflow: 'auto',
        }}>
          {maskText(tail)}
          <span style={{
            display: 'inline-block', width: 6, height: 12,
            background: 'var(--et-orange)', marginLeft: 2, verticalAlign: 'middle',
            animation: 'et-blink 1s steps(1) infinite',
          }} />
        </div>
      )}
      <style>{`@keyframes et-blink { 50% { opacity: 0; } }`}</style>
    </div>
  );
}

// QQ 数据没有 SNS — 节点 / 边 / 批量分析里所有 「朋友圈」相关字段全部隐藏。
function SidePanel({ node, onClose, onOpenFriend, onSelectPeer }: {
  node: GraphNode; onClose: () => void; onOpenFriend: () => void;
  onSelectPeer?: (peerWxid: string) => void;
}) {
  void usePrivacy();
  const isQQ = useActivePlatform() === 'qq';
  const maskedName = displayName(node.id, node.name);
  const [detail, setDetail] = useState<(Friend & { stats: FriendStats | null }) | null>(null);
  const [reportContent, setReportContent] = useState<string | null>(null);
  const [showFullReport, setShowFullReport] = useState(false);
  const [connections, setConnections] = useState<FriendConnection[] | null>(null);
  const [showAllConnections, setShowAllConnections] = useState(false);
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [analyzing, setAnalyzing] = useState<'idle' | 'running' | 'error'>('idle');
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analysisStream, setAnalysisStream] = useState<{ output: string; stage: string; elapsed: number } | null>(null);

  useEffect(() => {
    getAgents().then(setAgents).catch(() => { /* no local agents available */ });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setReportContent(null);
    setShowFullReport(false);
    setConnections(null);
    setShowAllConnections(false);
    setAnalyzing('idle');
    setAnalyzeError(null);
    setAnalysisStream(null);
    getFriend(node.id).then(d => { if (!cancelled) setDetail(d); }).catch(() => {});
    getFriendConnections(node.id).then(r => { if (!cancelled) setConnections(r.connections); }).catch(() => { if (!cancelled) setConnections([]); });
    getInvokeStream(node.id).then(s => {
      if (cancelled) return;
      if (s.running) {
        setAnalyzing('running');
        setAnalysisStream({ output: s.output || '', stage: s.stage || 'running', elapsed: s.elapsed || 0 });
      } else if (s.error) {
        setAnalyzeError(s.error);
        setAnalyzing('error');
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [node.id]);

  useEffect(() => {
    if (analyzing !== 'running') return;
    let cancelled = false;
    async function tick() {
      try {
        const s = await getInvokeStream(node.id);
        if (cancelled) return;
        setAnalysisStream({ output: s.output || '', stage: s.stage || 'running', elapsed: s.elapsed || 0 });
        if (!s.running) {
          if (s.error) {
            setAnalyzeError(s.error);
            setAnalyzing('error');
            return;
          }
          const updated = await getFriend(node.id);
          if (cancelled) return;
          setDetail(updated);
          setAnalyzing('idle');
          setAnalysisStream(null);
        }
      } catch {
        // Keep polling; the stream endpoint can briefly race with process startup.
      }
    }
    tick();
    const pollId = window.setInterval(tick, 2000);
    return () => { cancelled = true; window.clearInterval(pollId); };
  }, [node.id, analyzing]);

  async function runAnalysis(cli: string) {
    setAnalyzeError(null);
    setAnalysisStream({ output: '', stage: '排队中', elapsed: 0 });
    try {
      const r = await invokeAgent({ cli, wxid: node.id });
      if (!r.ok) {
        setAnalyzeError(r.error || 'failed to queue');
        setAnalyzing('error');
        return;
      }
      setAnalyzing('running');
    } catch (e: any) {
      setAnalyzeError(e?.message || String(e));
      setAnalyzing('error');
    }
  }

  async function viewFullReport() {
    if (!detail?.aiReport) return;
    if (reportContent) { setShowFullReport(true); return; }
    try {
      const r = await getReport(detail.aiReport.path);
      setReportContent(r.content);
      setShowFullReport(true);
    } catch {
      // Full report preview is optional; keep the side panel usable if it fails.
    }
  }

  const total = (node.private_msgs || 0) + (node.group_msgs || 0);
  const briefSummary = detail?.aiReport?.short
    ? detail.aiReport.short
        .replace(/^#[^\n]*\n+/, '').replace(/^>[^\n]*\n+/gm, '')
        .replace(/^---+\n+/m, '').replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1').trim().slice(0, 320)
    : null;

  return (
    <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} style={{
      position: 'absolute', right: 0, top: 0, bottom: 0, width: 460,
      zIndex: 150,
      background: 'var(--et-paper)', borderLeft: '0.5px solid var(--et-line-2)',
      boxShadow: '-12px 0 32px rgba(20,24,42,0.25)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ padding: '18px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '0.5px solid var(--et-line)' }}>
        <button onClick={onClose} style={{ all: 'unset', cursor: 'pointer', fontSize: 12, color: 'var(--et-mute)' }}>← 收起</button>
        <span className="et-meta" style={{ fontFamily: 'var(--et-mono)', fontSize: 10 }}>{maskedWxid(node.id)}</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: `radial-gradient(circle at 30% 30%, ${node.color}, ${node.color}99)`,
            border: '0.5px solid rgba(26,43,74,0.18)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontFamily: 'var(--et-serif)', fontSize: 24, fontWeight: 600,
          }}>{maskedName.charAt(0).toUpperCase()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--et-serif)', fontSize: 22, fontWeight: 600,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{maskedName}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <span style={{ padding: '2px 10px', borderRadius: 999, background: 'var(--et-orange-soft)',
                color: 'var(--et-orange-2)', fontSize: 11, fontWeight: 600 }}>{node.tier} 级</span>
              {detail?.aiReport && (
                <span style={{ padding: '2px 10px', borderRadius: 999, background: 'var(--et-orange)',
                  color: '#fff', fontSize: 10, fontWeight: 600 }}>AI 已分析</span>
              )}
            </div>
            {detail && (
              <div className="et-meta" style={{ marginTop: 6, fontSize: 11, color: 'var(--et-mute)' }}>
                {detail.knew} · 最近活跃 {detail.last}
              </div>
            )}
          </div>
        </div>
        {detail && (
          <div className="et-serif" style={{
            marginTop: 14, fontSize: 14, lineHeight: 1.6, color: 'var(--et-ink-soft)',
            paddingLeft: 12, borderLeft: '2px solid var(--et-orange)', fontStyle: 'italic',
          }}>「{maskText(detail.bond)}」</div>
        )}

        {detail?.stats && (
          <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Stat label="总消息" value={(detail.stats.totalSelf + detail.stats.totalOther).toLocaleString()} />
            <Stat label="时间跨度" value={`${detail.stats.spanDays} 天`} />
            <Stat label="最长沉默" value={`${detail.stats.longestSilenceDays} 天`} />
            <Stat label="高频词" value={`「${maskText(detail.stats.topPhrase)}」`} />
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <div className="et-eyebrow">跨场景</div>
          <div style={{ marginTop: 8, padding: '12px 14px', borderRadius: 12,
            background: 'rgba(26,43,74,0.04)', border: '0.5px solid var(--et-line)' }}>
            <CrossScene label="私聊" value={node.private_msgs || 0} total={total} color="#FF6B47" />
            <div style={{ height: 8 }} />
            <CrossScene label="群聊" value={node.group_msgs || 0} total={total} color="#5A7A99" />
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--et-mute)' }}>
              {node.groups != null && <>共群 {node.groups} 个</>}
              {!isQQ && (
                <>
                  {node.groups != null && ' · '}
                  <span>朋友圈：他赞你 {node.moments_back || 0} · 你赞他 {node.moments_out || 0}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* AI report card — always rendered. If exists: summary + full. If not: analyze-now button */}
        <div style={{ marginTop: 18 }}>
          <div className="et-eyebrow">AI 关系档案</div>
          {briefSummary ? (
            <>
              <div className="et-serif" style={{
                marginTop: 8, padding: '12px 14px', borderRadius: 10,
                background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
                fontSize: 13, lineHeight: 1.7, color: 'var(--et-ink-soft)',
                maxHeight: 200, overflow: 'hidden', position: 'relative',
              }}>
                {maskText(briefSummary)}…
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0, height: 36,
                  background: 'linear-gradient(to bottom, transparent, var(--et-paper-2))',
                  pointerEvents: 'none',
                }} />
              </div>
              <button onClick={viewFullReport} style={{
                all: 'unset', cursor: 'pointer', marginTop: 8,
                padding: '6px 14px', borderRadius: 8,
                background: 'var(--et-ink)', color: 'var(--et-paper)',
                fontSize: 12, fontWeight: 600,
              }}>📖 阅读完整报告</button>
            </>
          ) : (
            <div style={{
              marginTop: 8, padding: '14px 16px', borderRadius: 10,
              background: 'var(--et-paper-2)', border: '0.5px dashed var(--et-line-2)',
            }}>
              <div className="et-serif" style={{ fontSize: 13.5, color: 'var(--et-mute)', lineHeight: 1.6 }}>
                还没让 AI 分析过这个人。
              </div>
              {analyzing === 'running' && (
                <AnalysisStreamBox stream={analysisStream} />
              )}
              {analyzing === 'error' && analyzeError && (
                <div className="et-meta" style={{ marginTop: 10, color: 'var(--et-rose)' }}>
                  失败：{maskText(analyzeError.slice(0, 120))}
                </div>
              )}
              {analyzing !== 'running' && (
                <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {agents.length === 0 ? (
                    <span className="et-meta" style={{ color: 'var(--et-faint)', fontSize: 11 }}>
                      没检测到 claude / codex CLI；请先安装
                    </span>
                  ) : (
                    agents.map(a => (
                      <button key={a.cli} onClick={() => runAnalysis(a.cli)} style={{
                        all: 'unset', cursor: 'pointer',
                        padding: '6px 12px', borderRadius: 8,
                        background: 'var(--et-orange)', color: '#fff',
                        fontSize: 12, fontWeight: 600,
                      }}>🤖 让 {a.name} 分析</button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {connections && connections.length > 0 && onSelectPeer && (
          <div style={{ marginTop: 22 }}>
            <div className="et-eyebrow">他的重要连线（点击看 {maskedName} ↔ X 之间）</div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {(showAllConnections ? connections : connections.slice(0, 6)).map(conn => (
                <button key={conn.wxid + conn.edge_type}
                  onClick={() => onSelectPeer(conn.wxid)}
                  style={{
                    all: 'unset', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 12px', borderRadius: 8,
                    background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--et-orange-soft)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'var(--et-paper-2)'}
                >
                  <span style={{ fontSize: 13, color: 'var(--et-ink)', fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>
                    {displayName(conn.wxid, conn.name)}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--et-mute)' }}>
                    {edgeKindLabel(conn)}
                  </span>
                </button>
              ))}
            </div>
            {connections.length > 6 && (
              <button onClick={() => setShowAllConnections(s => !s)} style={{
                all: 'unset', cursor: 'pointer', marginTop: 6,
                fontSize: 11, color: 'var(--et-mute)',
              }}>
                {showAllConnections ? '收起' : `展开剩下 ${connections.length - 6} 条…`}
              </button>
            )}
          </div>
        )}
      </div>
      <div style={{ padding: '12px 22px', borderTop: '0.5px solid var(--et-line)' }}>
        <button onClick={onOpenFriend} style={{
          all: 'unset', cursor: 'pointer', display: 'block', width: '100%',
          textAlign: 'center', padding: '10px 0', borderRadius: 10,
          background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
          fontSize: 12.5, fontWeight: 600, color: 'var(--et-ink)',
        }}>📓 完整人物档案 →</button>
      </div>
      {showFullReport && reportContent && (
        <ReportOverlay content={reportContent} title={maskedName} onClose={() => setShowFullReport(false)} />
      )}
    </div>
  );
}

function edgeKindLabel(conn: FriendConnection): string {
  if (conn.edge_type === 'mutual_reply') return `群里互动 ${conn.weight}`;
  if (conn.edge_type === 'mention') return `提及 ${conn.mention_count ?? Math.round(conn.weight * 30)}`;
  if (conn.edge_type === 'moments_cross') return `朋友圈 ${conn.moments_cross ?? '—'}`;
  if (conn.edge_type === 'co_group') return `共群 ${conn.shared_group_count ?? conn.weight}`;
  if (conn.edge_type === 'private') return `私聊 ${conn.weight}`;
  return conn.edge_type;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '10px 12px', background: 'var(--et-paper-2)',
      border: '0.5px solid var(--et-line-2)', borderRadius: 8 }}>
      <div className="et-eyebrow" style={{ fontSize: 9 }}>{label}</div>
      <div className="et-num" style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function ReportOverlay({ content, title, onClose }: { content: string; title: string; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(20,24,42,0.6)',
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      paddingTop: 40, overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '85%', maxWidth: 920, marginBottom: 40,
        background: 'var(--et-paper)', borderRadius: 'var(--et-r-lg)',
        boxShadow: 'var(--et-shadow-3)', padding: '30px 44px', position: 'relative',
      }}>
        <button onClick={onClose} style={{
          all: 'unset', cursor: 'pointer', position: 'absolute', top: 14, right: 18,
          fontSize: 22, color: 'var(--et-mute)', padding: 6,
        }}>×</button>
        <div className="et-eyebrow">AI 关系档案</div>
        <div style={{ fontFamily: 'var(--et-serif)', fontSize: 13, color: 'var(--et-mute)', marginTop: 4 }}>关于 {title}</div>
        <article className="murmur-md" style={{
          marginTop: 18, fontFamily: 'var(--et-sans)',
          fontSize: 15, lineHeight: 1.78, color: 'var(--et-ink)',
        }} dangerouslySetInnerHTML={{ __html: mdToHtml(maskText(content)) }} />
      </div>
      <style>{MURMUR_MD_CSS}</style>
    </div>
  );
}

const EDGE_LABEL: Record<string, { label: string; tone: string }> = {
  private: { label: '私聊往来', tone: '#FF6B47' },
  mutual_reply: { label: '群里真互动', tone: '#2C4670' },
  co_active: { label: '群里真互动', tone: '#2C4670' },
  mention: { label: '在你聊天里被互相提及', tone: '#B98643' },
  co_group: { label: '同处群聊', tone: '#5A7A99' },
  moments_cross: { label: '朋友圈互动（不经你）', tone: '#D17545' },
};

function pairEvidenceErrorMessage(e: any): string {
  const msg = e?.message || String(e);
  if (msg.includes('no_direct_pair_evidence') || msg.includes('共同群/共同出现') || msg.includes('422')) {
    return '这条线目前只有共群/共同出现等弱信号，还没有互相回复、名字提及或朋友圈互动这类直接证据。为避免分析串，暂不生成 AI 朋友间关系报告。';
  }
  return msg;
}

function EdgePanel(props: {
  edge: GraphEdge; aName: string; bName: string; onClose: () => void;
  onOpenFriend?: (id: string) => void;
}) { return <EdgePanelInner {...props} isQQ={useActivePlatform() === 'qq'} />; }
function EdgePanelInner({ edge, aName, bName, onClose, onOpenFriend, isQQ }: {
  edge: GraphEdge; aName: string; bName: string; onClose: () => void;
  onOpenFriend?: (id: string) => void;
  isQQ: boolean;
}) {
  const [pack, setPack] = useState<string | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [aiReport, setAIReport] = useState<{ available: boolean; path?: string; short?: string } | null>(null);
  const [showFullReport, setShowFullReport] = useState(false);
  const [fullReport, setFullReport] = useState<string | null>(null);
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [analyzing, setAnalyzing] = useState<'idle' | 'running' | 'error'>('idle');
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null);
  const [stream, setStream] = useState<{ output: string; stage: string; elapsed: number } | null>(null);
  const isSelfEdge = edge.source === 'self' || edge.target === 'self';
  const selfFriendId = edge.source === 'self' ? edge.target : edge.source;
  const meta = EDGE_LABEL[edge.type] || EDGE_LABEL.co_group;
  const otherName = edge.source === 'self' ? bName : aName;
  const rawWeight = Math.max(0, Math.round(edge.raw_weight ?? edge.weight));

  useEffect(() => {
    getAgents().then(setAgents).catch(() => { /* no local agents available */ });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPack(null);
    setPackError(null);
    setAIReport(null);
    setFullReport(null);
    setShowFullReport(false);
    setAnalyzing('idle');
    setAnalyzeErr(null);
    setStream(null);
    if (isSelfEdge) {
      getFriend(selfFriendId)
        .then(d => { if (!cancelled) setAIReport(d.aiReport || { available: false }); })
        .catch(() => { if (!cancelled) setAIReport({ available: false }); });
      getInvokeStream(selfFriendId)
        .then(s => {
          if (cancelled) return;
          if (s.running) {
            setAnalyzing('running');
            setStream({ output: s.output || '', stage: s.stage || 'running', elapsed: s.elapsed || 0 });
          } else if (s.error) {
            setAnalyzeErr(s.error);
            setAnalyzing('error');
          }
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }
    setPackLoading(true);
    getPairPack(edge.source, edge.target)
      .then(r => { if (!cancelled) setPack(r.pack); })
      .catch(e => { if (!cancelled) setPackError(pairEvidenceErrorMessage(e)); })
      .finally(() => { if (!cancelled) setPackLoading(false); });
    findPairReport(edge.source, edge.target).then(r => { if (!cancelled) setAIReport(r); }).catch(() => { /* no saved pair report */ });
    return () => { cancelled = true; };
  }, [edge.source, edge.target, isSelfEdge, selfFriendId]);

  useEffect(() => {
    if (!isSelfEdge || analyzing !== 'running') return;
    let cancelled = false;
    async function tick() {
      try {
        const s = await getInvokeStream(selfFriendId);
        if (cancelled) return;
        setStream({ output: s.output || '', stage: s.stage || 'running', elapsed: s.elapsed || 0 });
        if (!s.running) {
          if (s.error) {
            setAnalyzeErr(s.error);
            setAnalyzing('error');
            return;
          }
          const updated = await getFriend(selfFriendId);
          if (cancelled) return;
          setAIReport(updated.aiReport || { available: false });
          setAnalyzing('idle');
          setStream(null);
        }
      } catch {
        // Keep polling; the stream endpoint can briefly race with process startup.
      }
    }
    tick();
    const pollId = window.setInterval(tick, 2000);
    return () => { cancelled = true; window.clearInterval(pollId); };
  }, [isSelfEdge, selfFriendId, analyzing]);

  async function runPairAnalysis(cli: string) {
    setAnalyzing('running');
    setAnalyzeErr(null);
    setStream({ output: '', stage: 'queued', elapsed: 0 });
    try {
      const r = await invokePairAgent({ cli, a: edge.source, b: edge.target });
      if (!r.ok) {
        setAnalyzeErr(r.error || 'failed to queue');
        setAnalyzing('error');
        return;
      }
      // Poll the live stream every 2 sec
      const startedAt = Date.now();
      const pollId = setInterval(async () => {
        if (Date.now() - startedAt > 5 * 60 * 1000) {
          clearInterval(pollId);
          setAnalyzeErr('5 分钟还没完成');
          setAnalyzing('error');
          return;
        }
        try {
          const s = await getPairStream(edge.source, edge.target);
          setStream({ output: s.output, stage: s.stage, elapsed: s.elapsed });
          if (!s.running) {
            clearInterval(pollId);
            if (s.error) {
              setAnalyzeErr(s.error);
              setAnalyzing('error');
            } else {
              // Re-fetch saved report
              const rep = await findPairReport(edge.source, edge.target);
              setAIReport(rep);
              setAnalyzing('idle');
              setStream(null);
            }
          }
        } catch {
          // Keep polling; stream endpoints can briefly race with process startup.
        }
      }, 2000);
    } catch (e: any) {
      setAnalyzeErr(pairEvidenceErrorMessage(e));
      setAnalyzing('error');
    }
  }

  async function runSelfAnalysis(cli: string) {
    setAnalyzeErr(null);
    setStream({ output: '', stage: '排队中', elapsed: 0 });
    try {
      const r = await invokeAgent({ cli, wxid: selfFriendId });
      if (!r.ok) {
        setAnalyzeErr(r.error || 'failed to queue');
        setAnalyzing('error');
        return;
      }
      setAnalyzing('running');
    } catch (e: any) {
      setAnalyzeErr(e?.message || String(e));
      setAnalyzing('error');
    }
  }

  async function viewFullReport() {
    if (!aiReport?.path) return;
    if (fullReport) { setShowFullReport(true); return; }
    try {
      const r = await getReport(aiReport.path);
      setFullReport(r.content);
      setShowFullReport(true);
    } catch {
      // Full report preview is optional; keep the side panel usable if it fails.
    }
  }

  return (
    <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} style={{
      position: 'absolute', right: 0, top: 0, bottom: 0, width: 460,
      zIndex: 150,
      background: 'var(--et-paper)', borderLeft: '0.5px solid var(--et-line-2)',
      boxShadow: '-12px 0 32px rgba(20,24,42,0.25)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ padding: '18px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '0.5px solid var(--et-line)' }}>
        <button onClick={onClose} style={{ all: 'unset', cursor: 'pointer', fontSize: 12, color: 'var(--et-mute)' }}>← 收起</button>
        <span style={{
          padding: '3px 10px', borderRadius: 999, fontSize: 10, fontWeight: 600,
          background: meta.tone, color: '#fff',
        }}>{meta.label}</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '22px 24px' }}>
        <div className="et-eyebrow">关系连线</div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12, fontSize: 18, fontWeight: 600 }}>
          {onOpenFriend && (
            <div style={{ position: 'absolute', right: 24, marginTop: -4, display: 'flex', gap: 6 }}>
              {isSelfEdge ? (
                <button onClick={() => onOpenFriend(selfFriendId)} style={{
                  all: 'unset', cursor: 'pointer', padding: '3px 8px', borderRadius: 6,
                  background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
                  fontSize: 10, color: 'var(--et-mute)',
                }}>📓 完整档案</button>
              ) : (
                <>
                  <button onClick={() => onOpenFriend(edge.source)} style={{
                    all: 'unset', cursor: 'pointer', padding: '3px 8px', borderRadius: 6,
                    background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
                    fontSize: 10, color: 'var(--et-mute)',
                  }}>📓 看 {aName.length > 8 ? aName.slice(0, 8) + '…' : aName}</button>
                  <button onClick={() => onOpenFriend(edge.target)} style={{
                    all: 'unset', cursor: 'pointer', padding: '3px 8px', borderRadius: 6,
                    background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
                    fontSize: 10, color: 'var(--et-mute)',
                  }}>📓 看 {bName.length > 8 ? bName.slice(0, 8) + '…' : bName}</button>
                </>
              )}
            </div>
          )}
          {isSelfEdge ? (
            <>
              <span style={{ color: 'var(--et-orange)' }}>你</span>
              <span style={{ color: 'var(--et-faint)' }}>↔</span>
              <span style={{ color: 'var(--et-ink)' }}>{otherName}</span>
            </>
          ) : (
            <>
              <span style={{ color: 'var(--et-ink)' }}>{aName}</span>
              <span style={{ color: 'var(--et-faint)' }}>↔</span>
              <span style={{ color: 'var(--et-ink)' }}>{bName}</span>
            </>
          )}
        </div>

        <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {/* Always-visible interaction breakdown — every dimension at once */}
          {isSelfEdge && edge.type === 'private' && (
            <Stat label="你们的私聊消息" value={`${rawWeight.toLocaleString()} 条`} />
          )}
          {!isSelfEdge && edge.type === 'co_active' && (
            <Stat label="群里互相搭话" value={`${rawWeight.toLocaleString()} 次`} />
          )}
          {!isSelfEdge && edge.type !== 'co_active' && rawWeight > 1 && (
            <Stat label="互动信号强度" value={`${rawWeight.toLocaleString()}`} />
          )}
          {!isQQ && !!edge.moments_cross && (
            <Stat label="朋友圈互动" value={`${edge.moments_cross} 次`} />
          )}
          {!!edge.mention_count && (
            <Stat label="你提到他俩" value={`${edge.mention_count} 次`} />
          )}
          {!!edge.shared_group_count && (
            <Stat label="共同群" value={`${edge.shared_group_count} 个`} />
          )}
          {edge.type === 'close_pair' && <Stat label="近距离对" value="是" />}
        </div>

        {isSelfEdge && (
          <div style={{ marginTop: 18 }}>
            <div className="et-eyebrow">你们的关系档案</div>
            <div style={{
              marginTop: 8, padding: '14px 16px', borderRadius: 10,
              background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
            }}>
              <div className="et-serif" style={{ fontSize: 13.5, color: 'var(--et-ink-soft)', lineHeight: 1.6 }}>
                这条线代表你和 {otherName} 的一对一关系。完整分析会合并私聊、共群{isQQ ? '' : '、朋友圈'}和时间线。
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {onOpenFriend && (
                  <button onClick={() => onOpenFriend(selfFriendId)} style={{
                    all: 'unset', cursor: 'pointer',
                    padding: '7px 14px', borderRadius: 8,
                    background: 'var(--et-ink)', color: 'var(--et-paper)',
                    fontSize: 12, fontWeight: 600,
                  }}>📓 打开完整人物档案</button>
                )}
                {aiReport?.available && (
                  <button onClick={viewFullReport} style={{
                    all: 'unset', cursor: 'pointer',
                    padding: '7px 14px', borderRadius: 8,
                    background: 'var(--et-orange)', color: '#fff',
                    fontSize: 12, fontWeight: 600,
                  }}>📖 阅读 AI 关系报告</button>
                )}
              </div>
            </div>
          </div>
        )}

        {isSelfEdge && (
          <div style={{ marginTop: 18 }}>
            <div className="et-eyebrow">AI 关系报告</div>
            {aiReport?.available ? (
              <>
                <div className="et-serif" style={{
                  marginTop: 8, padding: '12px 14px', borderRadius: 10,
                  background: 'var(--et-orange-soft)', border: '0.5px solid var(--et-orange-2)',
                  fontSize: 13, lineHeight: 1.7, color: 'var(--et-ink-soft)',
                  maxHeight: 180, overflow: 'hidden', position: 'relative',
                }}>
                  {maskText(aiReport.short
                    ?.replace(/^#[^\n]*\n+/, '').replace(/^>[^\n]*\n+/gm, '')
                    .replace(/^---+\n+/m, '').replace(/^#{1,6}\s+/gm, '')
                    .replace(/\*\*([^*]+)\*\*/g, '$1').trim().slice(0, 260) || '')}…
                </div>
                <button onClick={viewFullReport} style={{
                  all: 'unset', cursor: 'pointer', marginTop: 8,
                  padding: '6px 14px', borderRadius: 8,
                  background: 'var(--et-ink)', color: 'var(--et-paper)',
                  fontSize: 12, fontWeight: 600,
                }}>📖 阅读完整报告</button>
              </>
            ) : (
              <div style={{
                marginTop: 8, padding: '14px 16px', borderRadius: 10,
                background: 'var(--et-paper-2)', border: '0.5px dashed var(--et-line-2)',
              }}>
                <div className="et-serif" style={{ fontSize: 13.5, color: 'var(--et-mute)', lineHeight: 1.6 }}>
                  还没让 AI 分析过你和 {otherName} 的关系。
                </div>
                {analyzing === 'running' && (
                  <AnalysisStreamBox stream={stream} />
                )}
                {analyzing === 'error' && analyzeErr && (
                  <div className="et-meta" style={{ marginTop: 10, color: 'var(--et-rose)' }}>
                    失败：{maskText(analyzeErr.slice(0, 120))}
                  </div>
                )}
                {analyzing !== 'running' && (
                  <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {agents.length === 0 ? (
                      <span className="et-meta" style={{ color: 'var(--et-faint)', fontSize: 11 }}>
                        没检测到 claude/codex CLI
                      </span>
                    ) : (
                      agents.map(a => (
                        <button key={a.cli} onClick={() => runSelfAnalysis(a.cli)} style={{
                          all: 'unset', cursor: 'pointer',
                          padding: '6px 12px', borderRadius: 8,
                          background: 'var(--et-orange)', color: '#fff',
                          fontSize: 12, fontWeight: 600,
                        }}>🤖 让 {a.name} 分析这段关系</button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!isSelfEdge && (
          <div style={{ marginTop: 18 }}>
            <div className="et-eyebrow">关系证据 / 数据样本</div>
            {packLoading && <div className="et-meta" style={{ marginTop: 8 }}>正在拉取证据…</div>}
            {packError && (
              <div className="et-serif" style={{
                marginTop: 8, padding: '12px 14px', borderRadius: 8,
                background: 'var(--et-paper-2)', border: '0.5px dashed var(--et-line-2)',
                fontSize: 13, lineHeight: 1.65, color: 'var(--et-mute)',
              }}>
                {maskText(packError)}
              </div>
            )}
            {pack && (
              <article className="murmur-md" style={{
                marginTop: 8, padding: '12px 14px', borderRadius: 8,
                background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
                fontSize: 13, lineHeight: 1.7, color: 'var(--et-ink-soft)',
                maxHeight: 360, overflow: 'auto',
              }} dangerouslySetInnerHTML={{ __html: mdToHtml(maskText(pack.slice(0, 4000) +
                (pack.length > 4000 ? '\n\n*…（省略，共 ' + Math.round(pack.length / 1000) + 'K 字）*' : '')))
              }} />
            )}
            <style>{MURMUR_MD_CSS}</style>
          </div>
        )}

        {!isSelfEdge && (
          <div style={{ marginTop: 18 }}>
            <div className="et-eyebrow">AI 推断报告</div>
            {aiReport?.available ? (
              <>
                <div className="et-serif" style={{
                  marginTop: 8, padding: '12px 14px', borderRadius: 10,
                  background: 'var(--et-orange-soft)', border: '0.5px solid var(--et-orange-2)',
                  fontSize: 13, lineHeight: 1.7, color: 'var(--et-ink-soft)',
                  maxHeight: 180, overflow: 'hidden', position: 'relative',
                }}>
                  {maskText(aiReport.short
                    ?.replace(/^#[^\n]*\n+/, '').replace(/^>[^\n]*\n+/gm, '')
                    .replace(/^---+\n+/m, '').replace(/^#{1,6}\s+/gm, '')
                    .replace(/\*\*([^*]+)\*\*/g, '$1').trim().slice(0, 240) || '')}…
                </div>
                <button onClick={viewFullReport} style={{
                  all: 'unset', cursor: 'pointer', marginTop: 8,
                  padding: '6px 14px', borderRadius: 8,
                  background: 'var(--et-ink)', color: 'var(--et-paper)',
                  fontSize: 12, fontWeight: 600,
                }}>📖 阅读完整推断</button>
              </>
            ) : (
              <div style={{
                marginTop: 8, padding: '14px 16px', borderRadius: 10,
                background: 'var(--et-paper-2)', border: '0.5px dashed var(--et-line-2)',
              }}>
                <div className="et-serif" style={{ fontSize: 13.5, color: 'var(--et-mute)', lineHeight: 1.6 }}>
                  {packError ? maskText(packError) : '这对朋友还没让 AI 推断过。'}
                </div>
                {analyzing === 'running' && (
                  <div style={{ marginTop: 10 }}>
                    <div className="et-meta" style={{ color: 'var(--et-orange-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>⏳ {stream?.stage || '排队中'}…</span>
                      <span style={{ fontFamily: 'var(--et-mono)', fontSize: 10 }}>{stream?.elapsed || 0}s</span>
                    </div>
                    {stream?.output && (
                      <div className="et-serif" style={{
                        marginTop: 8, padding: '10px 12px', borderRadius: 6,
                        background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
                        fontFamily: 'var(--et-mono)', fontSize: 11, lineHeight: 1.55,
                        color: 'var(--et-ink-soft)', whiteSpace: 'pre-wrap',
                        maxHeight: 280, overflow: 'auto',
                      }}>
                        {maskText(stream.output.slice(-2000))}
                        <span style={{
                          display: 'inline-block', width: 6, height: 12,
                          background: 'var(--et-orange)', marginLeft: 2, verticalAlign: 'middle',
                          animation: 'et-blink 1s steps(1) infinite',
                        }} />
                      </div>
                    )}
                    <style>{`@keyframes et-blink { 50% { opacity: 0; } }`}</style>
                  </div>
                )}
                {analyzing === 'error' && analyzeErr && (
                  <div className="et-meta" style={{ marginTop: 10, color: 'var(--et-rose)' }}>
                    失败：{maskText(analyzeErr.slice(0, 120))}
                  </div>
                )}
                {!packError && analyzing !== 'running' && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {agents.length === 0 ? (
                        <span className="et-meta" style={{ color: 'var(--et-faint)', fontSize: 11 }}>
                          没检测到 claude/codex CLI
                        </span>
                      ) : (
                        agents.map(a => (
                          <button key={a.cli} onClick={() => runPairAnalysis(a.cli)} style={{
                            all: 'unset', cursor: 'pointer',
                            padding: '6px 12px', borderRadius: 8,
                            background: 'var(--et-orange)', color: '#fff',
                            fontSize: 12, fontWeight: 600,
                          }}>🤖 让 {a.name} 分析这对</button>
                        ))
                      )}
                    </div>
                    {/* Pair export — issue #10. Productized panel from Round 2.
                        Hero copy frames it as Murmur's signature feature, three
                        format cards each with a use-case + body. Old PairExportRow
                        component is left defined below as fallback. */}
                    <PairAnalysisPanel a={edge.source} b={edge.target} aName={aName} bName={bName} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {showFullReport && fullReport && (
        <ReportOverlay
          content={fullReport}
          title={isSelfEdge ? `你 ↔ ${otherName}` : `${aName} ↔ ${bName}`}
          onClose={() => setShowFullReport(false)}
        />
      )}
    </div>
  );
}

function BatchAnalysisPanel(props: any) { return <BatchAnalysisPanelInner {...props} isQQ={useActivePlatform() === 'qq'} />; }
function BatchAnalysisPanelInner({
  dark, agents, batch, status, onLaunch, onReset, onClose, isQQ,
}: {
  dark: boolean;
  agents: LocalAgent[];
  batch: BatchHandle | null;
  status: BatchStatus | null;
  onLaunch: (top_pairs: number, cli: 'claude' | 'codex' | 'both', parallel: number) => void;
  onReset: () => void;
  onClose: () => void;
  isQQ: boolean;
}) {
  const running = !!batch && !!status?.running;
  const done = !!batch && status && !status.running;
  const friendDone = status?.friends_done ?? status?.n_friends ?? 0;
  const friendTotal = status?.friends_total ?? 0;
  const pairDone = status?.pairs_done ?? status?.n_pairs ?? 0;
  const pairTotal = status?.pairs_total ?? 0;
  const friendProgress = friendTotal > 0 ? `${friendDone}/${friendTotal}` : String(friendDone);
  const pairProgress = pairTotal > 0 ? `${pairDone}/${pairTotal}` : String(pairDone);
  const issueText = status && (status.crashed || (status.failures || 0) > 0 || (status.skipped || 0) > 0)
    ? ` · ${status.crashed ? '异常退出 · ' : ''}失败 ${status.failures || 0} · 跳过 ${status.skipped || 0}`
    : '';
  const claudeAgent = agents.find(a => a.cli === 'claude');
  const codexAgent = agents.find(a => a.cli === 'codex');
  const [selectedCli, setSelectedCli] = useState<'claude' | 'codex' | 'both'>(
    claudeAgent ? 'claude' : codexAgent ? 'codex' : 'claude'
  );
  const [parallel, setParallel] = useState(4);
  return (
    <div style={{
      position: 'absolute', top: 64, right: 28, zIndex: 7, width: 380,
      background: dark ? 'rgba(20,24,42,0.95)' : 'rgba(251,246,238,0.98)',
      border: `0.5px solid ${dark ? 'rgba(244,236,218,0.22)' : 'rgba(26,43,74,0.16)'}`,
      borderRadius: 12, padding: '18px 18px 14px',
      boxShadow: dark ? '0 24px 48px rgba(0,0,0,0.6)' : '0 24px 48px rgba(26,43,74,0.16)',
      backdropFilter: 'blur(12px)',
      color: dark ? '#F4ECDA' : '#1A2B4A',
      fontSize: 13,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontFamily: 'var(--et-serif)', fontSize: 16, fontWeight: 600 }}>批量分析关系</div>
        <button onClick={onClose} style={{ all: 'unset', cursor: 'pointer', fontSize: 16,
          color: dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.5)' }}>×</button>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: dark ? 'rgba(244,236,218,0.75)' : 'rgba(26,43,74,0.7)', marginBottom: 12 }}>
        一次性把关系网里 top-N 重要朋友对的关系档案全跑出来 ——
        合并私聊互相提及、共群活跃{isQQ ? '' : '、朋友圈点赞评论'}，AI 推断他们俩的关系类型 + 时间走向 + 关键证据。
      </div>
      {!running && !done && (
        <>
          {agents.length === 0 ? (
            <div style={{
              padding: '10px 12px', background: dark ? 'rgba(255,107,71,0.16)' : 'rgba(255,107,71,0.10)',
              border: `0.5px solid ${dark ? 'rgba(255,107,71,0.4)' : 'rgba(255,107,71,0.3)'}`,
              borderRadius: 8, fontSize: 12, lineHeight: 1.6,
            }}>
              没装 claude / codex CLI，AI 分析跑不了。装其一：<br/>
              <code style={{ background: 'rgba(0,0,0,0.2)', padding: '1px 5px', borderRadius: 3 }}>npm install -g @anthropic-ai/claude-code</code><br/>
              <code style={{ background: 'rgba(0,0,0,0.2)', padding: '1px 5px', borderRadius: 3 }}>npm install -g @openai/codex</code>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: dark ? 'rgba(244,236,218,0.55)' : 'rgba(26,43,74,0.55)', marginBottom: 6 }}>
                选 AI（已检测到 {agents.length} 个）：
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                <CliPick label="claude" sub="Anthropic" available={!!claudeAgent} selected={selectedCli === 'claude'} onClick={() => setSelectedCli('claude')} dark={dark} />
                <CliPick label="codex" sub="OpenAI" available={!!codexAgent} selected={selectedCli === 'codex'} onClick={() => setSelectedCli('codex')} dark={dark} />
                <CliPick label="both" sub="并行双跑" available={!!claudeAgent && !!codexAgent} selected={selectedCli === 'both'} onClick={() => setSelectedCli('both')} dark={dark} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: dark ? 'rgba(244,236,218,0.55)' : 'rgba(26,43,74,0.55)' }}>每个 CLI 并发：</span>
                {[2, 4, 6].map(n => (
                  <button key={n} onClick={() => setParallel(n)} style={{
                    all: 'unset', cursor: 'pointer', padding: '3px 8px', borderRadius: 6, fontSize: 11,
                    background: parallel === n ? (dark ? 'rgba(255,107,71,0.35)' : 'var(--et-orange-soft)') : (dark ? 'rgba(255,255,255,0.06)' : 'rgba(26,43,74,0.06)'),
                    border: `0.5px solid ${parallel === n ? 'rgba(255,107,71,0.45)' : 'transparent'}`,
                  }}>{n}</button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: dark ? 'rgba(244,236,218,0.55)' : 'rgba(26,43,74,0.55)', marginBottom: 8 }}>
                已有报告自动跳过；想全部重跑去 Reports 页面删 pairs/ 目录。
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                <BatchOption label="Top 10 对" sub={selectedCli === 'both' ? 'Claude + Codex 并行' : '约 10 分钟'} onClick={() => onLaunch(10, selectedCli, parallel)} />
                <BatchOption label="Top 20 对" sub={selectedCli === 'both' ? '双模型同时跑' : '约 20 分钟'} onClick={() => onLaunch(20, selectedCli, parallel)} primary />
                <BatchOption label="Top 40 对" sub={selectedCli === 'both' ? '会生成两套报告' : '约 40 分钟'} onClick={() => onLaunch(40, selectedCli, parallel)} />
              </div>
            </>
          )}
        </>
      )}
      {running && (
        <div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
            background: dark ? 'rgba(255,107,71,0.18)' : 'var(--et-orange-soft)',
            borderRadius: 8, marginBottom: 10,
          }}>
            <div style={{ fontSize: 18, animation: 'spin 1.4s linear infinite' }}>⏳</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>正在跑 · 朋友 {friendProgress} · 朋友间报告 {pairProgress}{issueText}</div>
              <div style={{ fontSize: 11, color: dark ? 'rgba(244,236,218,0.65)' : 'rgba(26,43,74,0.65)' }}>
                关掉这个面板没事，跑在后台{status.last_stage ? ` · ${maskText(status.last_stage)}` : ''}
              </div>
            </div>
          </div>
          <pre style={{
            margin: 0, padding: 10, fontSize: 10.5, lineHeight: 1.5, maxHeight: 200, overflowY: 'auto',
            background: dark ? 'rgba(0,0,0,0.3)' : 'rgba(26,43,74,0.05)',
            border: `0.5px solid ${dark ? 'rgba(244,236,218,0.12)' : 'rgba(26,43,74,0.1)'}`,
            borderRadius: 6, fontFamily: 'monospace', whiteSpace: 'pre-wrap',
          }}>{maskText(status.log_tail || '(等输出…)')}</pre>
          <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
      {done && (
        <div>
          <div style={{
            padding: '10px 12px',
            background: pairDone > 0
              ? (dark ? 'rgba(78,176,109,0.16)' : 'rgba(78,176,109,0.12)')
              : (dark ? 'rgba(255,107,71,0.16)' : 'rgba(255,107,71,0.10)'),
            border: `0.5px solid ${pairDone > 0
              ? (dark ? 'rgba(78,176,109,0.4)' : 'rgba(78,176,109,0.3)')
              : (dark ? 'rgba(255,107,71,0.4)' : 'rgba(255,107,71,0.3)')}`,
            borderRadius: 8, marginBottom: 10, fontSize: 13,
          }}>
            {pairDone > 0
              ? <>✓ 跑完了 · 本次 {pairProgress} 份朋友间关系档案已完成{issueText}</>
              : <>⚠ 跑完了但 0 份报告 — 看 <code style={{ fontSize: 10 }}>{maskText('~/Desktop/Murmur/agent_reports/_errors.txt')}</code> 排错</>
            }
          </div>
          <div style={{ fontSize: 11, color: dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.6)', marginBottom: 10 }}>
            报告路径：<code style={{ fontSize: 10 }}>{maskText(`${status.reports_root || '~/Desktop/Murmur/agent_reports'}/pairs/`)}</code>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={onReset} style={{
              all: 'unset', cursor: 'pointer', flex: 1,
              padding: '8px 12px', textAlign: 'center', borderRadius: 6,
              background: 'var(--et-orange)', color: '#fff',
              fontSize: 12, fontWeight: 600,
            }}>↻ 再跑一次</button>
            <button onClick={onClose} style={{
              all: 'unset', cursor: 'pointer', flex: 1,
              padding: '8px 12px', textAlign: 'center', borderRadius: 6,
              background: dark ? 'rgba(244,236,218,0.12)' : 'rgba(26,43,74,0.08)',
              fontSize: 12, fontWeight: 500,
            }}>关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CliPick({ label, sub, available, selected, onClick, dark }: {
  label: string; sub: string; available: boolean; selected: boolean; onClick: () => void; dark: boolean;
}) {
  return (
    <button onClick={available ? onClick : undefined} disabled={!available} style={{
      all: 'unset', flex: 1, cursor: available ? 'pointer' : 'not-allowed',
      padding: '8px 10px', textAlign: 'center', borderRadius: 6,
      background: selected ? 'var(--et-orange)' : (dark ? 'rgba(244,236,218,0.08)' : 'rgba(26,43,74,0.05)'),
      color: selected ? '#fff' : (available ? 'inherit' : (dark ? 'rgba(244,236,218,0.4)' : 'rgba(26,43,74,0.4)')),
      border: selected ? 'none' : `0.5px solid ${dark ? 'rgba(244,236,218,0.18)' : 'rgba(26,43,74,0.15)'}`,
      opacity: available ? 1 : 0.55,
    }}>
      <div style={{ fontWeight: 600, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 10, opacity: 0.75, marginTop: 1 }}>{available ? sub : '未装'}</div>
    </button>
  );
}

function BatchOption({ label, sub, onClick, primary }: { label: string; sub: string; onClick: () => void; primary?: boolean }) {
  return (
    <button onClick={onClick} style={{
      all: 'unset', cursor: 'pointer', padding: '10px 14px', borderRadius: 8,
      background: primary ? 'var(--et-orange)' : 'transparent',
      color: primary ? '#fff' : 'inherit',
      border: primary ? 'none' : '0.5px solid rgba(26,43,74,0.18)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    }}>
      <span style={{ fontWeight: primary ? 600 : 500, fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 11, opacity: 0.75 }}>{sub}</span>
    </button>
  );
}

function CrossScene({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
        <span className="et-num" style={{ fontFamily: 'var(--et-serif)', fontSize: 14, fontWeight: 600 }}>
          {value.toLocaleString()} <span style={{ fontSize: 11, color: 'var(--et-mute)' }}>条</span>
        </span>
      </div>
      <div style={{ height: 6, background: 'rgba(26,43,74,0.08)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 999 }} />
      </div>
    </div>
  );
}
