/* 关系网的数据模型：把 /api/graph 的原始返回整理成页面和 3D 引擎都好用的形状。
 * 这里只做整理和派生（排名、圈子成员、连线索引），不估算任何后端没给的数字。 */
import type { Tier } from '../../components/graph3d/engine';
import { displayName, maskText } from '../../utils/privacy';

// ———————————————————————— backend shapes (/api/graph) ————————————————————————

export interface BackendNode {
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
  cluster?: string | null;
  bridge?: boolean;
}

export interface BackendEdge {
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

export interface BackendCluster { id: string; label: string; members: string[] }

export interface BackendGraph {
  nodes: BackendNode[];
  edges: BackendEdge[];
  clusters: BackendCluster[];
  stats: {
    total_people: number; total_edges: number; private_count: number; groups: number;
    core_circles?: number; bridges?: number;
  };
}

// ———————————————————————— page model ————————————————————————

export interface GNode {
  id: string;
  name: string;            // real display name from the backend (mask with displayName before showing)
  tier: Tier;
  cluster: string | null;
  bridge: boolean;
  privateMsgs: number;
  groupMsgs: number;
  groups: number;
  momentsBack: number;
  momentsOut: number;
  score: number;
  rank: number;            // 1-based, by combined score, among everyone in the graph
  tierRank: number;        // 1-based, within the tier
}

export interface GEdge {
  key: string;
  a: string;
  b: string;
  type: string;            // mutual_reply | mention | moments_cross | co_group
  weight: number;
  mention?: number;
  groups?: number;
  moments?: number;
  momentsAB?: number;      // a → b
  momentsBA?: number;      // b → a
}

export interface GCluster {
  id: string;
  label: string;           // backend label, real names inside — show via clusterName()
  members: string[];       // friends only (no "self")
  anchorId: string | null;
}

export interface GraphModel {
  nodes: GNode[];
  byId: Map<string, GNode>;
  edges: GEdge[];          // friend ↔ friend only; 「你」↔ friend is the private_msgs readout
  adj: Map<string, GEdge[]>;
  clusters: GCluster[];
  clusterById: Map<string, GCluster>;
  tierCount: Record<Tier, number>;
  bridges: number;
  isolates: number;
}

export const TIER_LABEL: Record<Tier, string> = { A: '核心', B: '亲近', C: '常联系', D: '偶尔', E: '疏远' };
const TIERS_ALL: Tier[] = ['A', 'B', 'C', 'D', 'E'];

export function edgeKey(a: string, b: string): string { return a < b ? `${a}__${b}` : `${b}__${a}`; }

const asTier = (t: string): Tier => (TIERS_ALL.includes(t as Tier) ? (t as Tier) : 'E');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function buildModel(g: BackendGraph): GraphModel {
  const friends = g.nodes.filter(n => !n.is_self && n.id !== 'self');
  const sorted = friends.slice().sort((a, b) => num(b.combined_score) - num(a.combined_score) || (a.id < b.id ? -1 : 1));
  const tierSeen: Record<Tier, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const nodes: GNode[] = sorted.map((n, i) => {
    const tier = asTier(n.tier);
    tierSeen[tier]++;
    return {
      id: n.id, name: n.name || n.id, tier, cluster: n.cluster || null, bridge: !!n.bridge,
      privateMsgs: num(n.private_msgs), groupMsgs: num(n.group_msgs), groups: num(n.groups),
      momentsBack: num(n.moments_back), momentsOut: num(n.moments_out),
      score: num(n.combined_score) || num(n.private_msgs) + num(n.group_msgs),
      rank: i + 1, tierRank: tierSeen[tier],
    };
  });
  const byId = new Map(nodes.map(n => [n.id, n] as const));

  const edges: GEdge[] = [];
  const adj = new Map<string, GEdge[]>();
  const seen = new Set<string>();
  for (const e of g.edges) {
    if (e.source === 'self' || e.target === 'self' || e.source === e.target) continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    const key = edgeKey(e.source, e.target);
    if (seen.has(key)) continue;
    seen.add(key);
    const ge: GEdge = {
      key, a: e.source, b: e.target, type: e.type, weight: num(e.weight),
      mention: e.mention_count, groups: e.shared_group_count, moments: e.moments_cross,
      momentsAB: e.moments_a_to_b, momentsBA: e.moments_b_to_a,
    };
    edges.push(ge);
    for (const id of [ge.a, ge.b]) { const l = adj.get(id); if (l) l.push(ge); else adj.set(id, [ge]); }
  }

  const clusters: GCluster[] = (g.clusters || []).map(c => {
    const members = (c.members || []).filter(m => m !== 'self' && byId.has(m));
    // backend label = 「<anchor name> 这一圈 (N 人)」; find the anchor back by its name
    const anchorName = (c.label || '').replace(/\s*这一圈.*$/, '').trim();
    const anchor = members.find(m => byId.get(m)!.name === anchorName)
      ?? members.slice().sort((x, y) => byId.get(x)!.rank - byId.get(y)!.rank)[0] ?? null;
    return { id: c.id, label: c.label || c.id, members, anchorId: anchor };
  }).filter(c => c.members.length > 0);
  const clusterById = new Map(clusters.map(c => [c.id, c] as const));

  const tierCount: Record<Tier, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const n of nodes) tierCount[n.tier]++;
  const isolates = nodes.filter(n => !adj.has(n.id)).length;
  const bridges = g.stats?.bridges ?? nodes.filter(n => n.bridge).length;
  return { nodes, byId, edges, adj, clusters, clusterById, tierCount, bridges, isolates };
}

// ———————————————————————— names & codes ————————————————————————

export function nameOf(n: { id: string; name: string } | undefined | null, fallbackId = ''): string {
  if (!n) return displayName(fallbackId, fallbackId);
  return displayName(n.id, n.name);
}

/** Short code drawn in a node box: 「朋友 PB」→ PB；三个字以上的中文名取后两字；英文取首字母。 */
export function codeOf(name: string): string {
  const m = /^(?:朋友|群)\s*(\S{1,3})$/.exec(name);
  if (m) return m[1];
  const chars = Array.from(name.replace(/\s+/g, ''));
  if (!chars.length) return '·';
  const cjk = chars.filter(c => /[㐀-鿿豈-﫿]/.test(c));
  if (cjk.length >= 3) return cjk.slice(-2).join('');
  if (cjk.length) return cjk.join('');
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return chars.slice(0, 2).join('').toUpperCase();
}

/** 「PB 这一圈」 — the anchor's masked name, never the backend's raw label. */
export function clusterName(c: GCluster | undefined | null, model: GraphModel): string {
  if (!c) return '';
  const anchor = c.anchorId ? model.byId.get(c.anchorId) : undefined;
  if (anchor) {
    const nm = nameOf(anchor);
    const m = /^朋友\s*(\S{1,3})$/.exec(nm);
    return `${m ? m[1] : nm} 这一圈`;
  }
  return maskText(c.label.replace(/\s*\(\d+\s*人\)\s*$/, ''));
}

export function tierCode(n: GNode): string {
  return `${n.tier}-${String(n.tierRank).padStart(2, '0')}`;
}

// ———————————————————————— edges ————————————————————————

const TYPE_ORDER: Record<string, number> = { mutual_reply: 0, mention: 1, moments_cross: 2, co_group: 3 };

/** The strongest evidence on an edge, as a short label: 「互回 23」「提及 8」「朋友圈 5」「共群 3」. */
export function edgeEvidence(e: GEdge): { label: string; value: number; kind: string } {
  if (e.type === 'mutual_reply') return { kind: 'mutual_reply', label: '互回', value: Math.round(e.weight) };
  if (e.type === 'mention') return { kind: 'mention', label: '提及', value: e.mention ?? Math.round(e.weight) };
  if (e.type === 'moments_cross') return { kind: 'moments_cross', label: '朋友圈', value: e.moments ?? Math.round(e.weight * 30) };
  if (e.type === 'co_group') return { kind: 'co_group', label: '共群', value: e.groups ?? Math.round(e.weight) };
  return { kind: e.type, label: e.type, value: Math.round(e.weight) };
}

/** Every kind of evidence an edge carries (the primary type plus the counts the backend attached). */
export function edgeFacts(e: GEdge, isQQ: boolean): { k: string; zh: string; v: number; unit: string }[] {
  const out: { k: string; zh: string; v: number; unit: string }[] = [];
  if (e.type === 'mutual_reply') out.push({ k: 'REPLY', zh: '群里互回', v: Math.round(e.weight), unit: '次' });
  const mention = e.mention ?? (e.type === 'mention' ? Math.round(e.weight) : undefined);
  if (mention) out.push({ k: 'MENTION', zh: '你聊天里同时提到', v: mention, unit: '次' });
  if (!isQQ && e.moments) out.push({ k: 'MOMENTS', zh: '朋友圈互动', v: e.moments, unit: '次' });
  const groups = e.groups ?? (e.type === 'co_group' ? Math.round(e.weight) : undefined);
  if (groups) out.push({ k: 'GROUPS', zh: '共同群', v: groups, unit: '个' });
  return out;
}

export function edgeStrength(e: GEdge): number {
  const ev = edgeEvidence(e);
  return (3 - (TYPE_ORDER[ev.kind] ?? 3)) * 1e6 + ev.value;
}

export function sortEdges(list: GEdge[]): GEdge[] {
  return list.slice().sort((x, y) => edgeStrength(y) - edgeStrength(x));
}

export const other = (e: GEdge, id: string) => (e.a === id ? e.b : e.a);

// ———————————————————————— formatting ————————————————————————

export const fmt = (v: number) => v.toLocaleString('en-US');

export function cleanSummary(short: string | undefined | null, max = 320): string {
  if (!short) return '';
  return short
    .replace(/^#[^\n]*\n+/, '').replace(/^>[^\n]*\n+/gm, '').replace(/^---+\n+/m, '')
    .replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').trim().slice(0, max);
}

/** The first paragraph of a report, cut at a sentence end — what fits in a side panel. */
export function leadOf(short: string | undefined | null, max = 150): string {
  const para = cleanSummary(short, 1200).split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ').trim();
  if (para.length <= max) return para;
  const cut = para.slice(0, max);
  const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  return end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/[，、；：\s]+$/, '') + '…';
}

export function mmdd(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts * (ts < 1e12 ? 1000 : 1));
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function pairEvidenceErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('no_direct_pair_evidence') || msg.includes('共同群/共同出现') || msg.includes('422')) {
    return '这条线目前只有共群、共同出现这类弱信号，还没有互相回复、名字提及或朋友圈互动这样的直接证据。为了不把分析写串，暂不生成这两个人之间的 AI 关系报告。';
  }
  return msg;
}
