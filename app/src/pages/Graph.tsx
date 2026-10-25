/* 关系网 (#graph) —— 方向 B「仪器」的三维关系网。
 *
 *   07–09 左栏   分级开关、核心圈聚焦、显示开关、图例                 pages/graph/LeftPanel.tsx
 *   10    中间   三维关系网（canvas）                                 components/extras/GraphView.tsx
 *   11–14 右栏   总览 / 核心圈 / 选中的人 / 两个人之间                  pages/graph/*Panel.tsx
 *
 * 数据：/api/graph?scope=private&top_n=N（后端缓存了原始汇总，换 N 只是重新取一次，不会重新扫库；
 * 见 tests/test_graph_raw_cache.py）。切换 N 时旧图留在屏幕上，新图到了再替换。
 * 主题跟随全局（设置 → 外观），页面里不再有自己的明暗开关。样式：./Graph.css（前缀 gx-）。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GraphView } from '../components/extras/GraphView';
import type { NodeInfo } from '../components/extras/GraphView';
import { computeLayout, summarize } from '../components/graph3d/engine';
import type { SceneState, Tier } from '../components/graph3d/engine';
import { API_BASE, getAgents } from '../data/api';
import type { FriendConnection, LocalAgent } from '../data/api';
import { useBatchTracker } from '../components/extras/BatchTracker';
import { maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { usePageKeys } from '../utils/usePageKeys';
import { useActivePlatform } from '../utils/activeProfile';
import { PageHeader } from '../shell/PageHeader';
import { Button, EmptyState, ErrorState, SegmentedControl, cx } from '../ui';
import { IconNetwork, IconSidebarCollapse, IconSidebarExpand, IconSparkle } from '../ui/icons';
import type { BackendGraph } from './graph/model';
import { buildModel, clusterName, codeOf, edgeEvidence, edgeKey, nameOf } from './graph/model';
import { LeftPanel } from './graph/LeftPanel';
import type { DisplayOpts } from './graph/LeftPanel';
import { SubjectPanel } from './graph/SubjectPanel';
import { PairPanel } from './graph/PairPanel';
import { CirclePanel, OverviewPanel } from './graph/OverviewPanel';
import { BatchPanel } from './graph/BatchPanel';
import './Graph.css';

interface Props {
  onBack: () => void;
  onOpenFriend?: (id: string) => void;
}

const TOPN_KEY = 'murmur.graph.topN';
const DISPLAY_KEY = 'murmur.graph.display';
const TOP_N_OPTIONS = [50, 100, 200, 300];
const NARROW = '(max-width: 1059px)';

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch { return fallback; }
}
function writeLS(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage can be unavailable */ }
}

export function GraphPage({ onBack, onOpenFriend }: Props) {
  const privacy = usePrivacy();   // names and codes re-render when the privacy toggle flips
  const isQQ = useActivePlatform() === 'qq';

  const [topN, setTopN] = useState<number>(() => {
    let n = 100;
    try { n = parseInt(localStorage.getItem(TOPN_KEY) || '100', 10); } catch { /* default */ }
    return Number.isFinite(n) && n > 0 ? n : 100;
  });
  const [graph, setGraph] = useState<{ n: number; g: BackendGraph } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [selected, setSelected] = useState<string | null>(null);
  const [peer, setPeer] = useState<{ id: string; conn?: FriendConnection } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<Tier>>(() => new Set());
  const [display, setDisplay] = useState<DisplayOpts>(() => readJSON(DISPLAY_KEY, { onlySel: true, cloud: true, ground: true }));
  const [autoRotate, setAutoRotate] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [hotPeer, setHotPeer] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(() => !window.matchMedia?.(NARROW).matches);
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(NARROW).matches);

  const [agents, setAgents] = useState<LocalAgent[] | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const { batch, status: batchStatus, startBatchJob, clearBatch } = useBatchTracker();

  useEffect(() => { getAgents().then(setAgents).catch(() => setAgents([])); }, []);
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW);
    if (!mq) return;
    const on = () => { setNarrow(mq.matches); setLeftOpen(!mq.matches); };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // ——— data ———
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/graph?scope=private&top_n=${topN}`)
      .then(async r => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(`后端返回错误：${(body && (body.message || body.error)) || `HTTP ${r.status}`}`);
        return body as BackendGraph | null;
      })
      .then(bg => {
        if (cancelled) return;
        if (!bg || !Array.isArray(bg.nodes) || !Array.isArray(bg.edges)) {
          throw new Error('关系网数据格式不对（缺少 nodes / edges）。可能是缓存坏了，到「设置 → 重建缓存」试试。');
        }
        setGraph({ n: topN, g: bg });
        setLoading(false);
      })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [topN, nonce]);

  const model = useMemo(() => (graph ? buildModel(graph.g) : null), [graph]);
  const layout = useMemo(() => (model ? computeLayout({
    nodes: model.nodes.map(n => ({ id: n.id, tier: n.tier, cluster: n.cluster, score: n.score, msgs: n.privateMsgs })),
    edges: model.edges.map(e => ({ source: e.a, target: e.b })),
    clusters: model.clusters.map(c => ({ id: c.id, members: c.members })),
  }) : null), [model]);

  // selection that no longer exists in the new top-N quietly falls away
  const sel = selected && model?.byId.has(selected) ? selected : null;
  const foc = focus && model?.clusterById.has(focus) ? focus : null;
  const pair = sel && peer ? peer : null;

  const codes = useMemo(() => {
    void privacy;
    return new Map((model?.nodes || []).map(n => [n.id, codeOf(nameOf(n))] as const));
  }, [model, privacy]);
  const clusterNames = useMemo(() => {
    void privacy;
    return new Map((model?.clusters || []).map(c => [c.id, clusterName(c, model!)] as const));
  }, [model, privacy]);

  const state: SceneState | null = useMemo(() => {
    if (!model) return null;
    const fc = foc ? model.clusterById.get(foc) : undefined;
    return {
      selected: sel, peer: pair?.id ?? null, focus: foc, hidden, onlySel: display.onlySel, cloud: display.cloud, ground: display.ground,
      expanded, hotPeer, codes, clusterNames,
      focusLabel: fc ? `核心圈 · ${clusterNames.get(fc.id)} · ${fc.members.length} 人` : null,
    };
  }, [model, sel, pair, foc, hidden, display, expanded, hotPeer, codes, clusterNames]);
  const summary = useMemo(() => (layout && state ? summarize(layout, state) : null), [layout, state]);

  // ——— actions ———
  const select = useCallback((id: string | null) => {
    setSelected(id);
    setPeer(null);
    setHotPeer(null);
    if (id) setAutoRotate(false);
  }, []);
  const openPair = useCallback((a: string, b: string, conn?: FriendConnection) => {
    setSelected(a);
    setPeer({ id: b, conn });
    setHotPeer(null);
    setAutoRotate(false);
  }, []);
  const focusCluster = useCallback((id: string | null) => {
    setFocus(id);
    setExpanded(new Set());
  }, []);
  const changeTopN = (n: number) => {
    setTopN(n);
    writeLS(TOPN_KEY, String(n));
    setFocus(null);
    setExpanded(new Set());
  };
  const changeDisplay = (d: DisplayOpts) => { setDisplay(d); writeLS(DISPLAY_KEY, JSON.stringify(d)); };
  const toggleTier = (t: Tier) => setHidden(h => { const n = new Set(h); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const toggleSector = (s: number) => setExpanded(e => { const n = new Set(e); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const openProfile = (id: string) => onOpenFriend?.(id);
  const openChat = (id: string) => { window.location.hash = `#/chat/${encodeURIComponent(id)}`; };

  async function startGraphBatch(topPairs: number, cli: string, parallel: number) {
    setBatchErr(null);
    try {
      const r = await startBatchJob(
        { cli, mode: 'pairs-graph', top: 0, top_pairs: topPairs, parallel },
        { label: `关系网 前 ${topPairs} 对${cli === 'both' ? ' · 双引擎' : ''}` },
      );
      if (!r.ok) setBatchErr(r.error || '未知原因');
    } catch (e) {
      setBatchErr(e instanceof Error ? e.message : String(e));
    }
  }

  const escape = () => {
    if (pair) setPeer(null);
    else if (sel) select(null);
    else if (foc) focusCluster(null);
    else if (narrow && leftOpen) setLeftOpen(false);
  };
  usePageKeys({
    p: sel ? () => openProfile(sel) : undefined,
    c: sel ? () => openChat(sel) : undefined,
    Escape: (pair || sel || foc || (narrow && leftOpen)) ? escape : undefined,
  }, !batchOpen);

  const describe = useCallback((id: string): NodeInfo | null => {
    const n = model?.byId.get(id);
    if (!n) return null;
    const c = n.cluster ? model!.clusterById.get(n.cluster) : undefined;
    return { code: codes.get(id) || '·', name: nameOf(n), tier: n.tier, msgs: n.privateMsgs, circle: c ? clusterNames.get(c.id) || null : null };
  }, [model, codes, clusterNames]);
  const describeEdge = useCallback((a: string, b: string): string | null => {
    const e = model?.adj.get(a)?.find(x => x.key === edgeKey(a, b));
    if (!e) return null;
    const ev = edgeEvidence(e);
    return `${codes.get(a)} ↔ ${codes.get(b)} · ${ev.label} ${ev.value}`;
  }, [model, codes]);

  // ——— header ———
  const batchRunning = Boolean(batch && batchStatus?.running);
  const header = (
    <PageHeader title="关系网" subtitle={`前 ${topN} 位 · 可以转动的三维关系网`}>
      <span className="app-header__label">显示前</span>
      <SegmentedControl
        label="显示前多少位朋友"
        size="sm"
        value={String(topN)}
        onChange={(v) => changeTopN(Number(v))}
        options={TOP_N_OPTIONS.map(n => ({ value: String(n), label: String(n) }))}
      />
      <Button size="sm" variant={batchRunning ? 'primary' : 'secondary'}
        onClick={() => setBatchOpen(o => !o)} aria-expanded={batchOpen}
        icon={batchRunning ? <span className="ui-spinner" aria-hidden="true" /> : <IconSparkle size={14} />}
        title="一次跑完关系网里重要朋友对的 AI 分析">
        批量分析关系{batchRunning ? ` · ${batchStatus?.pairs_done ?? batchStatus?.n_pairs ?? 0} 已完成` : ''}
      </Button>
    </PageHeader>
  );
  const batchPanel = batchOpen && (
    <BatchPanel agents={agents} batch={batch} status={batchStatus} isQQ={isQQ} error={batchErr}
      onLaunch={startGraphBatch} onReset={() => { clearBatch(); setBatchErr(null); }} onClose={() => setBatchOpen(false)} />
  );

  // ——— first load / error / empty ———
  if (!model || !layout || !state || !summary) {
    return (
      <div className="app-fill gx">
        {header}
        <div className="ui-rack gx-rack gx-rack--wait">
          <section className="ui-mod gx-wait">
            <header className="ui-mod__head">
              <span className="ui-mod__id">10</span><span className="ui-mod__title">关系网</span><span className="ui-mod__en">SOCIAL SCOPE · 3D</span>
            </header>
            <div className="gx-wait__body">
              {error ? (
                <ErrorState
                  title="关系网没能载入"
                  reason={maskText(error)}
                  onRetry={() => setNonce(n => n + 1)}
                  actions={<Button size="sm" variant="ghost" onClick={onBack}>回首页</Button>}
                />
              ) : (
                <div className="gx-wait__msg" role="status" aria-live="polite">
                  <span className="gx-wait__scope" aria-hidden="true"><i /><i /><i /></span>
                  <div className="ui-label">WEAVING<b>正在编织前 {topN} 位的关系网…</b></div>
                  <p>第一次大约 15 秒，之后命中缓存，几乎秒开。</p>
                </div>
              )}
            </div>
            <span className="ui-crop" aria-hidden="true" />
          </section>
        </div>
        {batchPanel}
      </div>
    );
  }
  if (model.nodes.length === 0) {
    return (
      <div className="app-fill gx">
        {header}
        <div className="ui-rack gx-rack gx-rack--wait">
          <section className="ui-mod gx-wait">
            <EmptyState icon={<IconNetwork size={22} />} label="NO CONTACTS" title="还没有可以画进关系网的人"
              description="读取聊天记录之后，和你有私聊的人会按亲疏落在这张网上。" />
          </section>
        </div>
        {batchPanel}
      </div>
    );
  }

  const node = sel ? model.byId.get(sel)! : null;
  const focusC = foc ? model.clusterById.get(foc)! : null;
  let right;
  if (node && pair) {
    right = <PairPanel key={`${node.id}|${pair.id}`} model={model} a={node} bId={pair.id} conn={pair.conn} isQQ={isQQ} agents={agents}
      onBack={() => setPeer(null)} onOpenFriend={openProfile} />;
  } else if (node) {
    right = <SubjectPanel key={node.id} model={model} node={node} isQQ={isQQ} agents={agents}
      hotPeer={hotPeer} onHotPeer={setHotPeer}
      onPair={(pid, conn) => openPair(node.id, pid, conn)}
      onFocus={focusCluster}
      onOpenProfile={() => openProfile(node.id)} onOpenChat={() => openChat(node.id)} onClose={() => select(null)} />;
  } else if (focusC) {
    right = <CirclePanel model={model} cluster={focusC} onSelect={select} onClose={() => focusCluster(null)} />;
  } else {
    right = <OverviewPanel model={model} summary={summary} topN={graph?.n ?? topN} onSelect={select} onFocus={focusCluster} />;
  }

  const toggleLeft = (
    <button type="button" className="ui-icon-btn gx-left-toggle" onClick={() => setLeftOpen(o => !o)}
      aria-expanded={leftOpen} aria-controls="gx-left" title={leftOpen ? '收起左栏' : '展开左栏：分级、核心圈、显示、图例'}>
      {leftOpen ? <IconSidebarCollapse size={15} /> : <IconSidebarExpand size={15} />}
    </button>
  );

  return (
    <div className="app-fill gx">
      {header}
      <div className={cx('ui-rack gx-rack', !leftOpen && 'is-left-closed', narrow && 'is-narrow')}>
        {leftOpen && (
          <LeftPanel id="gx-left" model={model} hidden={hidden} onToggleTier={toggleTier}
            focus={foc} onFocus={focusCluster}
            display={display} onDisplay={changeDisplay}
            autoRotate={autoRotate} onAutoRotate={setAutoRotate}
            onClose={narrow ? () => setLeftOpen(false) : undefined} />
        )}
        {narrow && leftOpen && <button type="button" className="gx-scrim" aria-label="收起左栏" onClick={() => setLeftOpen(false)} />}
        <GraphView
          layout={layout}
          state={state}
          autoRotate={autoRotate}
          onAutoRotateChange={setAutoRotate}
          describe={describe}
          describeEdge={describeEdge}
          onSelect={select}
          onSelectEdge={(a, b) => (sel === b ? openPair(b, a) : openPair(a, b))}
          onFocusNode={(id) => { const c = model.byId.get(id)?.cluster; if (c) focusCluster(c); }}
          onToggleSector={toggleSector}
          leading={toggleLeft}
          busy={loading ? `LOADING · 前 ${topN}` : undefined}
          notes={[
            `三层壳从内到外是 A / B / C 级；外圈点云是 D / E 级（${model.tierCount.D + model.tierCount.E} 人），地面最外一圈柱子是每 10° 扇区的人数`,
            '虚线是每个人落到赤道面的投影；被挡住的 C 级缩成小点，悬停显示代号；与选中的人相连的 D / E 级用虚线框画出',
          ]}
        />
        <aside className="ui-mod gx-right" aria-label="详情">{right}</aside>
      </div>
      {error && graph && (
        <div className="gx-toast" role="alert">
          <span className="ui-led ui-led--error" />换成前 {topN} 位没成功：{maskText(error).slice(0, 80)}
          <Button size="sm" variant="ghost" onClick={() => setNonce(n => n + 1)}>重试</Button>
        </div>
      )}
      {batchPanel}
    </div>
  );
}
