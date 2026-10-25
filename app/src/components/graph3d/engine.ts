/* 关系网 3D 引擎 —— 纯 TypeScript + Canvas 2D，不依赖任何 3D 库。
 *
 * 空间结构（方向 B「仪器」样稿）：
 *   「你」在原点；A / B / C 级落在三层椭球壳上（竖向拉长 VY 倍），同一核心圈的人在空间里聚成一团；
 *   D / E 级是外层贴近赤道面的点云，地面最外一圈是按 10° 扇区叠起来的人数柱。
 * 三维线索：透视投影（近大远小）、深度衰减（远处更淡）、赤道面网格 / 辐条 / 刻度、每个人落到赤道面的虚线和脚点、
 *   球壳轮廓与 C 层经纬线、坐标轴小标。
 *
 * 分两步：
 *   computeLayout(): 每份数据只算一次。按分级和核心圈给每个人一个三维位置，再在两个常用视角下做屏幕避让
 *     （位置仍是三维的，只是挑了不打架的点位）。布局只取决于数据，和选中 / 聚焦无关。
 *   Scene.render():  每帧一次。投影、逐帧标签避让（A / B / 选中 / 核心 / 相连必定可读，挤就外移拉引线；
 *     C 级放不下就缩成小点），然后按图层画到一张 canvas 上。线段按透明度分桶批量描边，避免每帧上千次 stroke。
 *
 * 颜色全部来自页面 CSS 变量（Graph.css 里的 --gx-*，浅色铝 / 深色石墨各一套），由调用方读好传进来。 */

export type Tier = 'A' | 'B' | 'C' | 'D' | 'E';
export const TIERS: Tier[] = ['A', 'B', 'C', 'D', 'E'];
export const SHELL_TIERS: Tier[] = ['A', 'B', 'C'];

export interface SceneNodeIn {
  id: string;
  tier: Tier;
  cluster: string | null;
  score: number;
  msgs: number;
}
export interface SceneEdgeIn { source: string; target: string }
export interface SceneClusterIn { id: string; members: string[] }
export interface SceneInput {
  nodes: SceneNodeIn[];
  edges: SceneEdgeIn[];
  clusters: SceneClusterIn[];
}

export interface View { yaw: number; pitch: number; zoom: number; panX: number; panY: number }
export const DEF_VIEW: View = { yaw: 100, pitch: 30, zoom: 1, panX: 0, panY: 0 };
export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 3;
export const PITCH_MIN = 2;
export const PITCH_MAX = 88;

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
const VY = 1.42;              // 椭球壳竖向拉长
const ELMAX = 1.12;           // 最大仰角（约 64°）
const SHELL: Record<'A' | 'B' | 'C', [number, number]> = { A: [0.9, 1.06], B: [1.55, 1.8], C: [2.3, 2.56] };
const GROUND: Record<Tier, number> = { A: 0.98, B: 1.68, C: 2.43, D: 2.86, E: 3.2 };
const CLOUD: Record<'D' | 'E', [number, number, number]> = { D: [2.66, 2.98, 0.32], E: [3.04, 3.3, 0.22] };
const HIST0 = 3.36;
const HISTMAX = 0.26;
const RIM = 3.68;
const DEF_DIST = 10;
const ROT_VIEW = { yaw: 155, pitch: 15 };
const FOC_REF = 930;          // 布局避让用的参考焦距（样稿画布 824×784 时的值）
type Kind = 'A' | 'B' | 'C' | 'X';
const LAB: Record<Kind, [number, number, number]> = {   // 宽、高、字号（默认视距处）
  A: [50, 32, 13.5], B: [35, 20.5, 12], C: [28, 16.5, 10.5], X: [28, 16.5, 10],
};
const SECTORS = 36;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const wrap = (a: number) => { a %= TAU; return a < 0 ? a + TAU : a; };
const adiff = (a: number, b: number) => { const d = wrap(a - b); return d > Math.PI ? d - TAU : d; };

/** Stable 0–1 hash of a string (FNV-1a). */
function h01(s: string, salt = 0): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ———————————————————————— camera ————————————————————————

interface Cam {
  cy: number; sy: number; cp: number; sp: number; dist: number;
  foc: number; ox: number; oy: number;
  R: [number, number, number]; U: [number, number, number];
}
interface Pt { x: number; y: number; d: number; k: number }

function makeCam(yaw: number, pitch: number, dist: number, foc: number, ox: number, oy: number): Cam {
  const cy = Math.cos(yaw * RAD), sy = Math.sin(yaw * RAD), cp = Math.cos(pitch * RAD), sp = Math.sin(pitch * RAD);
  return { cy, sy, cp, sp, dist, foc, ox, oy, R: [cy, 0, -sy], U: [-sy * sp, cp, -cy * sp] };
}
function P(c: Cam, x: number, y: number, z: number): Pt {
  const x1 = x * c.cy - z * c.sy;
  const z1 = x * c.sy + z * c.cy;
  const y2 = y * c.cp - z1 * c.sp;
  const z2 = y * c.sp + z1 * c.cp;
  const d = c.dist - z2;
  const k = c.foc / d;
  return { x: c.ox + x1 * k, y: c.oy - y2 * k, d, k };
}
/** zoom ≤ 1.4 dollies the camera in / out; beyond that the focal length grows (spreads crowded labels). */
function camDist(zoom: number) { return DEF_DIST / clamp(zoom, ZOOM_MIN, 1.4); }
function camMag(zoom: number) { return Math.max(1, zoom / 1.4); }
const lscale = (d: number) => clamp(Math.pow(DEF_DIST / d, 0.9), 0.84, 1.6);

// ———————————————————————— layout ————————————————————————

export interface LNode {
  id: string;
  tier: Tier;
  cluster: string | null;
  msgs: number;
  shell: boolean;
  r: number; phi: number; phi0: number; el: number;
  x: number; y: number; z: number;
  sector: number;
  // per-frame scratch
  sx: number; sy: number; d: number; gx: number; gy: number; s: number; dn: number;
}
export interface LEdge { a: LNode; b: LNode; key: string }
export interface Layout {
  nodes: LNode[];
  byId: Map<string, LNode>;
  edges: LEdge[];
  adj: Map<string, LEdge[]>;
  clusters: { id: string; members: LNode[] }[];
  clusterOf: Map<string, string>;
  sectors: { D: LNode[]; E: LNode[] }[];
  tierCount: Record<Tier, number>;
  ms: number;
}

export function edgeKey(a: string, b: string): string { return a < b ? `${a}__${b}` : `${b}__${a}`; }

function placeOnShell(v: LNode) {
  const c = Math.cos(v.el);
  v.x = v.r * c * Math.cos(v.phi);
  v.y = v.r * VY * Math.sin(v.el);
  v.z = v.r * c * Math.sin(v.phi);
}

export function computeLayout(input: SceneInput): Layout {
  const t0 = performance.now();
  const tierCount: Record<Tier, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const byTier: Record<Tier, SceneNodeIn[]> = { A: [], B: [], C: [], D: [], E: [] };
  for (const n of input.nodes) { byTier[n.tier].push(n); tierCount[n.tier]++; }

  // Core circles: the order decides which direction each one gets.
  const clusterOf = new Map<string, string>();
  for (const n of input.nodes) if (n.cluster) clusterOf.set(n.id, n.cluster);
  const known = new Set(input.nodes.map(n => n.id));
  const circles = input.clusters
    .map(c => ({ id: c.id, size: c.members.filter(m => known.has(m)).length }))
    .filter(c => c.size > 0)
    .sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));
  const EL_SEQ = [0.42, -0.34, 0.68, -0.58, 0.18, -0.12, 0.84, -0.8, 0.05, 0.55, -0.45, 0.3];
  const circleDir = new Map<string, { phi: number; el: number; spread: number }>();
  circles.forEach((c, k) => {
    // Spread circles around the azimuth; alternate up / down so they use the vertical space too.
    const phi = wrap(0.35 + (k + 0.5) / Math.max(1, circles.length) * TAU + (k % 2 ? 0.18 : 0));
    circleDir.set(c.id, { phi, el: EL_SEQ[k % EL_SEQ.length], spread: Math.min(0.42, 0.12 + 0.03 * c.size) });
  });

  const nodes: LNode[] = [];
  const mk = (n: SceneNodeIn, shell: boolean): LNode => ({
    id: n.id, tier: n.tier, cluster: n.cluster ?? null, msgs: n.msgs, shell,
    r: 0, phi: 0, phi0: 0, el: 0, x: 0, y: 0, z: 0, sector: 0,
    sx: 0, sy: 0, d: 0, gx: 0, gy: 0, s: 1, dn: 0,
  });

  // A / B / C on the shells
  for (const t of SHELL_TIERS) {
    const list = byTier[t].slice().sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const [r0, r1] = SHELL[t as 'A' | 'B' | 'C'];
    const lmax = Math.log(1 + (list[0]?.score || 1));
    const lmin = Math.log(1 + (list[list.length - 1]?.score || 0));
    list.forEach((n, i) => {
      const v = mk(n, true);
      const rankT = list.length > 1 ? i / (list.length - 1) : 0.5;
      const logT = lmax > lmin ? (lmax - Math.log(1 + n.score)) / (lmax - lmin) : 0.5;
      v.r = r0 + (0.6 * rankT + 0.4 * logT) * (r1 - r0);
      const cd = n.cluster ? circleDir.get(n.cluster) : undefined;
      if (cd) {
        v.phi = wrap(cd.phi + (h01(n.id, 3) * 2 - 1) * cd.spread);
        v.el = clamp(cd.el + (h01(n.id, 5) * 2 - 1) * 0.3, -ELMAX, ELMAX);
      } else {
        v.phi = h01(n.id, 1) * TAU;
        v.el = Math.asin((h01(n.id, 2) * 2 - 1) * 0.88);
      }
      v.phi0 = v.phi;
      nodes.push(v);
    });
  }
  const V = nodes.slice();

  // 1) same shell: push apart by angle
  const MINANG: Record<string, number> = { A: 0.5, B: 0.26, C: 0.15 };
  const ITER_ANG = V.length > 160 ? 60 : 120;
  for (let it = 0; it < ITER_ANG; it++) {
    for (let a = 0; a < V.length; a++) {
      const A = V[a];
      const mn = MINANG[A.tier];
      for (let b = a + 1; b < V.length; b++) {
        const B = V[b];
        if (A.tier !== B.tier) continue;
        const ce = Math.cos((A.el + B.el) / 2);
        let dp = adiff(B.phi, A.phi) * ce;
        let de = B.el - A.el;
        let dd = Math.sqrt(dp * dp + de * de);
        if (dd >= mn) continue;
        if (dd < 1e-4) { dp = 0.01; de = 0.005; dd = 0.0112; }
        const push = (mn - dd) / 2 * 0.6, ux = dp / dd, uy = de / dd;
        A.phi -= ux * push / ce; B.phi += ux * push / ce; A.el -= uy * push; B.el += uy * push;
      }
    }
    for (const v of V) v.el = clamp(v.el, -ELMAX, ELMAX);
  }
  V.forEach(placeOnShell);

  // 2) screen-space solve in the default and the rotated view: label boxes stop overlapping,
  //    then each point is pushed back onto its own shell.
  const toShell = (v: LNode, x: number, y: number, z: number) => {
    v.phi = Math.atan2(z, x);
    v.el = clamp(Math.atan2(y / VY, Math.sqrt(x * x + z * z)), -ELMAX, ELMAX);
    placeOnShell(v);
  };
  const MASS: Record<string, number> = { A: 4, B: 2, C: 1 };
  const views = [makeCam(DEF_VIEW.yaw, DEF_VIEW.pitch, DEF_DIST, FOC_REF, 0, 0), makeCam(ROT_VIEW.yaw, ROT_VIEW.pitch, DEF_DIST, FOC_REF, 0, 0)];
  const ITERS = clamp(Math.round(36000 / Math.max(40, V.length)), 60, 400);
  const pullUntil = Math.round(ITERS * 0.79);
  const qx = new Float64Array(V.length), qy = new Float64Array(V.length), qk = new Float64Array(V.length);
  const qw = new Float64Array(V.length), qh = new Float64Array(V.length);
  const mxv = new Float64Array(V.length), myv = new Float64Array(V.length);
  const PAD = 5;
  for (let it = 0; it < ITERS; it++) {
    const vs = it >= ITERS - 8 ? views.slice(0, 1) : it >= ITERS * 0.9 ? (it % 2 ? views.slice(0, 1) : views) : views;
    for (const c of vs) {
      for (let i = 0; i < V.length; i++) {
        const v = V[i], q = P(c, v.x, v.y, v.z), s = lscale(q.d);
        const lab = LAB[v.tier as Kind];
        qx[i] = q.x; qy[i] = q.y; qk[i] = q.k; qw[i] = (lab[0] + (v.tier === 'A' ? 6 : 0)) * s; qh[i] = lab[1] * s;
        mxv[i] = 0; myv[i] = 0;
      }
      for (let a = 0; a < V.length; a++) {
        for (let b = a + 1; b < V.length; b++) {
          const dx = qx[b] - qx[a], dy = qy[b] - qy[a];
          const pd = V[a].tier !== 'C' && V[b].tier !== 'C' ? PAD + 4 : PAD;
          const ox = (qw[a] + qw[b]) / 2 + pd - Math.abs(dx);
          if (ox <= 0) continue;
          const oy = (qh[a] + qh[b]) / 2 + pd - Math.abs(dy);
          if (oy <= 0) continue;
          const ma = MASS[V[a].tier], mb = MASS[V[b].tier], fa = mb / (ma + mb), fb = ma / (ma + mb);
          if (ox / (qw[a] + qw[b]) < oy / (qh[a] + qh[b])) {
            const sx = dx >= 0 ? 1 : -1; mxv[a] -= sx * ox * fa; mxv[b] += sx * ox * fb;
          } else {
            const sy = dy >= 0 ? 1 : -1; myv[a] -= sy * oy * fa; myv[b] += sy * oy * fb;
          }
        }
      }
      // keep clear of 「你」 at the origin
      const o = P(c, 0, 0, 0);
      for (let i = 0; i < V.length; i++) {
        const v = V[i];
        const ox = Math.min(qx[i] + qw[i] / 2 + PAD - (o.x - 26), o.x + 26 + PAD - (qx[i] - qw[i] / 2));
        const oy = Math.min(qy[i] + qh[i] / 2 + PAD - (o.y - 26), o.y + 26 + PAD - (qy[i] - qh[i] / 2));
        if (ox > 0 && oy > 0) {
          if (ox / (52 + qw[i]) < oy / (52 + qh[i])) mxv[i] += (qx[i] >= o.x ? 1 : -1) * ox;
          else myv[i] += (qy[i] >= o.y ? 1 : -1) * oy;
        }
        const dx = mxv[i] * 0.5, dy = myv[i] * 0.5;
        if (!dx && !dy) continue;
        const ix = dx / qk[i], iy = -dy / qk[i];
        toShell(v, v.x + ix * c.R[0] + iy * c.U[0], v.y + ix * c.R[1] + iy * c.U[1], v.z + ix * c.R[2] + iy * c.U[2]);
      }
    }
    if (it > pullUntil) continue;
    // gentle pull back: circle members towards their circle, the rest towards where they started
    const acc = new Map<string, { x: number; y: number; e: number; n: number }>();
    for (const v of V) {
      if (!v.cluster) continue;
      const m = acc.get(v.cluster) || { x: 0, y: 0, e: 0, n: 0 };
      m.x += Math.cos(v.phi); m.y += Math.sin(v.phi); m.e += v.el; m.n++;
      acc.set(v.cluster, m);
    }
    for (const v of V) {
      const m = v.cluster ? acc.get(v.cluster) : undefined;
      if (m && m.n > 1) {
        const cph = Math.atan2(m.y, m.x);
        v.phi += adiff(cph, v.phi) * 0.03;
        v.el += (m.e / m.n - v.el) * 0.03;
      } else {
        v.phi += adiff(v.phi0, v.phi) * 0.004;
      }
      placeOnShell(v);
    }
  }

  // D / E: the outer cloud, close to the equator. Circle members sit in their circle's direction.
  for (const t of ['D', 'E'] as const) {
    const list = byTier[t].slice().sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const [r0, r1, elK] = CLOUD[t];
    list.forEach((n, i) => {
      const v = mk(n, false);
      const cd = n.cluster ? circleDir.get(n.cluster) : undefined;
      v.phi = cd ? wrap(cd.phi + (h01(n.id, 3) * 2 - 1) * cd.spread * 1.3) : h01(n.id, 1) * TAU;
      v.el = (h01(n.id, 2) * 2 - 1) * elK;
      const rankT = list.length > 1 ? i / (list.length - 1) : 0.5;
      v.r = r0 + (0.7 * rankT + 0.3 * h01(n.id, 4)) * (r1 - r0);
      v.phi0 = v.phi;
      v.sector = Math.floor(wrap(v.phi) / TAU * SECTORS) % SECTORS;
      placeOnShell(v);
      nodes.push(v);
    });
  }

  const byId = new Map(nodes.map(v => [v.id, v] as const));
  const edges: LEdge[] = [];
  const adj = new Map<string, LEdge[]>();
  const seen = new Set<string>();
  for (const e of input.edges) {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b || a === b) continue;
    const key = edgeKey(a.id, b.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const le = { a, b, key };
    edges.push(le);
    (adj.get(a.id) || adj.set(a.id, []).get(a.id)!).push(le);
    (adj.get(b.id) || adj.set(b.id, []).get(b.id)!).push(le);
  }
  const clusters = circles.map(c => ({ id: c.id, members: nodes.filter(v => v.cluster === c.id) }));
  const sectors = Array.from({ length: SECTORS }, () => ({ D: [] as LNode[], E: [] as LNode[] }));
  for (const v of nodes) if (!v.shell) sectors[v.sector][v.tier as 'D' | 'E'].push(v);
  return { nodes, byId, edges, adj, clusters, clusterOf, sectors, tierCount, ms: performance.now() - t0 };
}

// ———————————————————————— per-frame state ————————————————————————

export interface Palette {
  panel: string; tx: string; tx2: string; tx3: string; sig: string; sigInk: string; onSig: string; line: string; line2: string;
  aFill: string; aText: string; aSub: string; bStroke: string; bText: string; cStroke: string; cText: string;
  eBase: string; eFaint: string; eSel: string; eCore: string; eHot: string;
  coreFill: string; coreStroke: string; hullFill: string; hullStroke: string;
  selStroke: string; selSub: string; selHalo: string; ring: string; rim: string;
  c2: string; c3: string; cloudD: string; cloudE: string;
  mono: string; sans: string;
}

export type HoverTarget =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; key: string; a: string; b: string }
  | { kind: 'sector'; s: number };

export interface SceneState {
  selected: string | null;
  peer: string | null;               // other end of the selected edge
  focus: string | null;              // cluster id
  hidden: ReadonlySet<Tier>;
  onlySel: boolean;
  cloud: boolean;
  ground: boolean;
  expanded: ReadonlySet<number>;     // sectors drawn as boxes
  hotPeer: string | null;            // hovered in the side panel
  codes: ReadonlyMap<string, string>;
  clusterNames: ReadonlyMap<string, string>;
  focusLabel: string | null;         // 「核心圈 · XX 这一圈 · 9 人」
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface FrameStats {
  ms: number;
  boxes: number;
  shownC: string;
  degradedC: number;
  movedAB: number;
  clashAB: number;
  overlaps: number;
  edges: number;
}

/** What is drawn individually / merged, and how many lines — the readouts above the canvas. */
export interface SceneSummary { shown: number; total: number; merged: number; edges: number; linked: number }

export function summarize(L: Layout, st: Pick<SceneState, 'selected' | 'focus' | 'hidden' | 'cloud' | 'expanded'>): SceneSummary {
  const boxed = boxedCloud(L, st);
  let shown = 0, merged = 0;
  for (const v of L.nodes) {
    const special = v.id === st.selected;
    if (v.shell) { if (!st.hidden.has(v.tier) || special) shown++; }
    else if (boxed.has(v.id)) shown++;
    else if (st.cloud && !st.hidden.has(v.tier)) merged++;
  }
  const drawn = (v: LNode) => (v.shell ? (!st.hidden.has(v.tier) || v.id === st.selected) : boxed.has(v.id));
  let edges = 0, linked = 0;
  for (const e of L.edges) {
    if (!drawn(e.a) || !drawn(e.b)) continue;
    edges++;
    if (st.selected && (e.a.id === st.selected || e.b.id === st.selected)) linked++;
  }
  return { shown, total: L.nodes.length, merged, edges, linked };
}

/** Cloud (D / E) people drawn as their own dashed box this frame. */
function boxedCloud(L: Layout, st: Pick<SceneState, 'selected' | 'focus' | 'hidden' | 'cloud' | 'expanded'> & { peer?: string | null; hotPeer?: string | null }): Set<string> {
  const out = new Set<string>();
  const sel = st.selected ? L.byId.get(st.selected) : undefined;
  if (sel) {
    if (!sel.shell) out.add(sel.id);
    for (const e of L.adj.get(sel.id) || []) {
      const o = e.a === sel ? e.b : e.a;
      if (!o.shell) out.add(o.id);
    }
  }
  if (st.peer) { const p = L.byId.get(st.peer); if (p && !p.shell) out.add(p.id); }
  if (st.hotPeer) { const p = L.byId.get(st.hotPeer); if (p && !p.shell) out.add(p.id); }
  if (st.focus) for (const c of L.clusters) if (c.id === st.focus) for (const m of c.members) if (!m.shell) out.add(m.id);
  if (st.cloud) for (const s of st.expanded) for (const t of ['D', 'E'] as const) for (const m of L.sectors[s]?.[t] || []) if (!st.hidden.has(t)) out.add(m.id);
  return out;
}

// ———————————————————————— drawing helpers ————————————————————————

/** Segments grouped by (style, alpha bucket): one stroke per bucket instead of one per segment. */
class SegBatch {
  private m = new Map<string, { color: string; w: number; dash: number[] | null; a: number; path: Path2D }>();
  add(color: string, w: number, dash: number[] | null, alpha: number, x1: number, y1: number, x2: number, y2: number) {
    const aq = Math.round(clamp(alpha, 0, 1) * 20) / 20;
    if (aq <= 0) return;
    const k = `${color}|${w}|${dash ? dash.join(',') : ''}|${aq}`;
    let b = this.m.get(k);
    if (!b) { b = { color, w, dash, a: aq, path: new Path2D() }; this.m.set(k, b); }
    b.path.moveTo(x1, y1);
    b.path.lineTo(x2, y2);
  }
  flush(ctx: CanvasRenderingContext2D) {
    for (const b of this.m.values()) {
      ctx.globalAlpha = b.a;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.w;
      ctx.setLineDash(b.dash || []);
      ctx.stroke(b.path);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    this.m.clear();
  }
}

/** Uniform-grid index of placed label boxes (keeps per-frame placement ~O(n)). */
class BoxGrid {
  private cells = new Map<number, Rect[]>();
  private all: Rect[] = [];
  private size: number;
  constructor(size = 48) { this.size = size; }
  private keys(b: Rect): number[] {
    const out: number[] = [];
    const x0 = Math.floor(b.x0 / this.size), x1 = Math.floor(b.x1 / this.size);
    const y0 = Math.floor(b.y0 / this.size), y1 = Math.floor(b.y1 / this.size);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push((x + 512) * 4096 + (y + 512));
    return out;
  }
  add(b: Rect) {
    this.all.push(b);
    for (const k of this.keys(b)) { const c = this.cells.get(k); if (c) c.push(b); else this.cells.set(k, [b]); }
  }
  hit(b: Rect): boolean {
    for (const k of this.keys(b)) {
      const c = this.cells.get(k);
      if (!c) continue;
      for (const o of c) if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) return true;
    }
    return false;
  }
  get boxes() { return this.all; }
}

const rectAt = (x: number, y: number, w: number, h: number, pad: number): Rect => ({ x0: x - w / 2 - pad, x1: x + w / 2 + pad, y0: y - h / 2 - pad, y1: y + h / 2 + pad });

/** Does the segment cross the rectangle (Liang–Barsky)? */
function segRect(x1: number, y1: number, x2: number, y2: number, b: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy], q = [x1 - b.x0, b.x1 - x1, y1 - b.y0, b.y1 - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

function hull(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  if (pts.length < 3) return pts.slice();
  const s = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: typeof s = [], up: typeof s = [];
  for (const p of s) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

/** Convex hull pushed outwards by `pad`, as a smooth closed path (Catmull-Rom → Bézier). */
function blob(pts: { x: number; y: number }[], pad: number): { path: Path2D; pts: { x: number; y: number }[] } | null {
  const h = hull(pts);
  if (h.length < 3) return null;
  let cx = 0, cy = 0;
  for (const p of h) { cx += p.x; cy += p.y; }
  cx /= h.length; cy /= h.length;
  const ex = h.map(p => { const dx = p.x - cx, dy = p.y - cy, l = Math.hypot(dx, dy) || 1; return { x: p.x + dx / l * pad, y: p.y + dy / l * pad }; });
  const n = ex.length, path = new Path2D();
  path.moveTo(ex[0].x, ex[0].y);
  for (let i = 0; i < n; i++) {
    const p0 = ex[(i - 1 + n) % n], p1 = ex[i], p2 = ex[(i + 1) % n], p3 = ex[(i + 2) % n];
    path.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
  }
  path.closePath();
  return { path, pts: ex };
}

function inPoly(pts: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function kfmt(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e5) return Math.round(v / 1000) + 'K';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return String(v);
}

// ———————————————————————— scene ————————————————————————

interface Box {
  v: LNode; kind: Kind;
  sel: boolean; peer: boolean; core: boolean; link: boolean; hot: boolean;
  w: number; h: number; fs: number;
  lx: number; ly: number; off: boolean; placed: boolean;
  code: string;
}

interface SectorHit { s: number; quad: { x: number; y: number }[] }

export interface SectorInfo {
  s: number; nD: number; nE: number; d: string[]; e: string[];
}

export class Scene {
  layout: Layout | null = null;
  view: View = { ...DEF_VIEW };
  pal: Palette | null = null;
  st: SceneState | null = null;
  hover: HoverTarget | null = null;
  obstacles: Rect[] = [];
  /** Screen anchor of the sector popup (CSS px), set by the caller from the popup's DOM box. */
  sectorAnchor: { x: number; y: number } | null = null;
  W = 0; H = 0; dpr = 1;
  private foc = FOC_REF; private ox = 0; private oy = 0; private gs = 1;
  private measureCache = new Map<string, number>();
  private mctx: CanvasRenderingContext2D | null = null;
  // last frame, for hit tests
  private boxes: Box[] = [];
  private dots: LNode[] = [];
  private cloudPts: LNode[] = [];
  private selSegs: { key: string; a: LNode; b: LNode; ax: number; ay: number; bx: number; by: number }[] = [];
  private sectorQuads: SectorHit[] = [];
  private youPt: Pt | null = null;
  lastStats: FrameStats | null = null;

  setLayout(L: Layout) { this.layout = L; }

  resize(W: number, H: number, dpr: number) {
    this.W = W; this.H = H; this.dpr = dpr;
    // Fit the whole scene (rim + C shell) into the canvas at the default view.
    const c = makeCam(DEF_VIEW.yaw, DEF_VIEW.pitch, DEF_DIST, 1, 0, 0);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    const add = (x: number, y: number, z: number) => { const q = P(c, x, y, z); u0 = Math.min(u0, q.x); u1 = Math.max(u1, q.x); v0 = Math.min(v0, q.y); v1 = Math.max(v1, q.y); };
    for (let i = 0; i < 90; i++) { const t = i / 90 * TAU; add((RIM + 0.4) * Math.cos(t), 0, (RIM + 0.4) * Math.sin(t)); }
    for (let e = -ELMAX; e <= ELMAX + 1e-6; e += ELMAX / 8) {
      for (let j = 0; j < 48; j++) {
        const t = j / 48 * TAU, r = SHELL.C[1] + 0.12, cc = Math.cos(e);
        add(r * cc * Math.cos(t), r * VY * Math.sin(e), r * cc * Math.sin(t));
      }
    }
    const top = 34, bot = H - (H > 560 ? 92 : 40);
    this.foc = Math.max(60, Math.min((W - 30) / (u1 - u0), (bot - top) / (v1 - v0)));
    this.ox = W / 2 - this.foc * (u0 + u1) / 2;
    this.oy = (top + bot) / 2 - this.foc * (v0 + v1) / 2;
    this.gs = clamp(Math.pow(this.foc / FOC_REF, 0.6), 0.72, 1.08);
  }

  private cam(): Cam {
    const v = this.view;
    return makeCam(v.yaw, v.pitch, camDist(v.zoom), this.foc * camMag(v.zoom), this.ox + v.panX, this.oy + v.panY);
  }

  private measure(txt: string, font: string): number {
    const k = font + '|' + txt;
    let w = this.measureCache.get(k);
    if (w == null) {
      if (!this.mctx) this.mctx = document.createElement('canvas').getContext('2d');
      if (!this.mctx) return txt.length * 7;
      this.mctx.font = font;
      w = this.mctx.measureText(txt).width;
      this.measureCache.set(k, w);
    }
    return w;
  }
  /** Fonts finished loading: cached text widths are stale. */
  resetMeasure() { this.measureCache.clear(); }

  render(ctx: CanvasRenderingContext2D): FrameStats | null {
    const L = this.layout, pal = this.pal, st = this.st;
    if (!L || !pal || !st || !this.W || !this.H) return null;
    const t0 = performance.now();
    const W = this.W, H = this.H, gs = this.gs;
    const C = this.cam();
    const dist = camDist(this.view.zoom);
    const dNear = dist - RIM * 0.95, dFar = dist + RIM * 0.95;
    const dn = (d: number) => clamp((d - dNear) / (dFar - dNear), 0, 1);
    const MONO = pal.mono, SANS = pal.sans;
    const batch = new SegBatch();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    const curve3 = (pts: [number, number, number][], color: string, w: number, dash: number[] | null, opNear: number, opFar: number) => {
      let a = P(C, pts[0][0], pts[0][1], pts[0][2]);
      for (let i = 1; i < pts.length; i++) {
        const b = P(C, pts[i][0], pts[i][1], pts[i][2]);
        if (a.d > 0.3 && b.d > 0.3) batch.add(color, w, dash, opNear - (opNear - opFar) * dn((a.d + b.d) / 2), a.x, a.y, b.x, b.y);
        a = b;
      }
    };
    const circ = (r: number, y: number, n: number): [number, number, number][] => {
      const p: [number, number, number][] = [];
      for (let i = 0; i <= n; i++) { const t = i / n * TAU; p.push([r * Math.cos(t), y, r * Math.sin(t)]); }
      return p;
    };

    const degLabs: { x: number; y: number; s: number; o: number; t: string }[] = [];
    // 1) equator: spokes, ground circles per tier, rim + ticks
    if (st.ground) {
      for (let sp = 0; sp < 12; sp++) {
        const t = sp / 12 * TAU, c = Math.cos(t), s = Math.sin(t);
        curve3([[0.3 * c, 0, 0.3 * s], [GROUND.C * c, 0, GROUND.C * s], [RIM * c, 0, RIM * s]], pal.ring, 1, null, 1, 0.45);
      }
      curve3(circ(GROUND.A, 0, 48), pal.rim, 1, null, 0.8, 0.25);
      curve3(circ(GROUND.B, 0, 56), pal.rim, 1, null, 0.75, 0.22);
      curve3(circ(GROUND.C, 0, 64), pal.rim, 1, null, 0.7, 0.2);
      curve3(circ(GROUND.D, 0, 72), pal.rim, 0.8, [2, 3], 0.6, 0.16);
      curve3(circ(GROUND.E, 0, 72), pal.rim, 0.8, [2, 3], 0.55, 0.15);
    }
    curve3(circ(RIM, 0, 90), pal.tx3, 1.1, null, 0.95, 0.3);
    for (let dg = 0; dg < 360; dg += 5) {
      const tt = dg * RAD, big = dg % 30 === 0, len = big ? 0.15 : 0.07;
      const p1 = P(C, RIM * Math.cos(tt), 0, RIM * Math.sin(tt)), p2 = P(C, (RIM + len) * Math.cos(tt), 0, (RIM + len) * Math.sin(tt));
      batch.add(pal.tx3, big ? 1 : 0.6, null, 1 - 0.65 * dn(p1.d), p1.x, p1.y, p2.x, p2.y);
      if (dg % 90 === 0) {
        const pl = P(C, (RIM + 0.32) * Math.cos(tt), 0, (RIM + 0.32) * Math.sin(tt));
        degLabs.push({ x: pl.x, y: pl.y, s: lscale(pl.d) * gs, o: 1 - 0.6 * dn(pl.d), t: String(dg).padStart(3, '0') + '°' });
      }
    }
    batch.flush(ctx);

    // 2) sector bars (D darker, E lighter, stacked outwards)
    this.sectorQuads = [];
    let secMax = 0;
    const secN = L.sectors.map(s => ({ D: st.hidden.has('D') ? 0 : s.D.length, E: st.hidden.has('E') ? 0 : s.E.length }));
    for (const s of secN) secMax = Math.max(secMax, s.D + s.E);
    const HS = secMax ? HISTMAX / secMax : 0;
    const hovSector = this.hover?.kind === 'sector' ? this.hover.s : -1;
    if (st.cloud && secMax > 0) {
      for (let si = 0; si < SECTORS; si++) {
        const a0 = si / SECTORS * TAU + 0.014, a1 = (si + 1) / SECTORS * TAU - 0.014;
        const r0 = HIST0, rD = r0 + secN[si].D * HS, rE = rD + secN[si].E * HS;
        const quad = (ra: number, rb: number) => [
          P(C, ra * Math.cos(a0), 0, ra * Math.sin(a0)), P(C, rb * Math.cos(a0), 0, rb * Math.sin(a0)),
          P(C, rb * Math.cos(a1), 0, rb * Math.sin(a1)), P(C, ra * Math.cos(a1), 0, ra * Math.sin(a1)),
        ];
        const segs: [number, number, string][] = [[r0, rD, pal.c3], [rD, rE, pal.c2]];
        for (const [ra, rb, col] of segs) {
          if (rb - ra < 0.004) continue;
          const q = quad(ra, rb);
          ctx.globalAlpha = 1 - 0.5 * dn(q[0].d);
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y); ctx.closePath();
          ctx.fill();
        }
        if (rE > r0 + 0.004) {
          const full = quad(r0 - 0.03, Math.max(rE, r0 + 0.06) + 0.03);
          this.sectorQuads.push({ s: si, quad: full });
          if (si === hovSector) {
            const q = quad(r0, rE);
            ctx.globalAlpha = 1; ctx.strokeStyle = pal.tx; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y); ctx.closePath(); ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // 3) shells: screen outline of each ellipsoid + latitude / longitude lines on C
    for (const t of SHELL_TIERS) {
      const sh = SHELL[t as 'A' | 'B' | 'C'], r = (sh[0] + sh[1]) / 2, pts: { x: number; y: number }[] = [];
      for (let e = -1.5; e <= 1.51; e += 0.25) for (let j = 0; j < 28; j++) {
        const a = j / 28 * TAU, c = Math.cos(e), q = P(C, r * c * Math.cos(a), r * VY * Math.sin(e), r * c * Math.sin(a));
        pts.push(q);
      }
      const hl = hull(pts);
      if (hl.length > 2) {
        ctx.globalAlpha = t === 'C' ? 0.75 : 0.55;
        ctx.strokeStyle = pal.rim; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(hl[0].x, hl[0].y); for (let i = 1; i < hl.length; i++) ctx.lineTo(hl[i].x, hl[i].y); ctx.closePath(); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }
    if (st.ground) {
      const rC = (SHELL.C[0] + SHELL.C[1]) / 2;
      for (const lat of [-55, -28, 28, 55]) { const e = lat * RAD; curve3(circ(rC * Math.cos(e), rC * VY * Math.sin(e), 64), pal.rim, 0.9, [1, 3], 0.75, 0.18); }
      for (let mi = 0; mi < 12; mi++) {
        const ma = mi / 12 * TAU, mp: [number, number, number][] = [];
        for (let e2 = -80; e2 <= 80; e2 += 8) { const ee = e2 * RAD; mp.push([rC * Math.cos(ee) * Math.cos(ma), rC * VY * Math.sin(ee), rC * Math.cos(ee) * Math.sin(ma)]); }
        curve3(mp, pal.rim, 0.9, [1, 3], 0.65, 0.12);
      }
      batch.flush(ctx);
    }

    // which cloud people get a box this frame
    const boxed = boxedCloud(L, st);
    const sel = st.selected ? L.byId.get(st.selected) || null : null;
    const linked = new Set<string>();
    if (sel) for (const e of L.adj.get(sel.id) || []) linked.add((e.a === sel ? e.b : e.a).id);
    const focusSet = new Set<string>();
    if (st.focus) for (const c of L.clusters) if (c.id === st.focus) for (const m of c.members) focusSet.add(m.id);

    // project everybody
    for (const v of L.nodes) {
      const p = P(C, v.x, v.y, v.z), g = P(C, v.x, 0, v.z);
      v.sx = p.x; v.sy = p.y; v.d = p.d; v.gx = g.x; v.gy = g.y; v.s = lscale(p.d) * gs; v.dn = dn(p.d);
    }
    const you = P(C, 0, 0, 0);
    this.youPt = you;

    // 4) the D / E cloud (far → near)
    this.cloudPts = [];
    if (st.cloud) {
      const cl = L.nodes.filter(v => !v.shell && !boxed.has(v.id) && !st.hidden.has(v.tier) && v.d > 0.3).sort((a, b) => b.d - a.d);
      for (const v of cl) {
        const s = (v.tier === 'D' ? 2.6 : 1.9) * v.s, hov = this.hover?.kind === 'node' && this.hover.id === v.id;
        ctx.globalAlpha = (v.tier === 'D' ? 0.9 : 0.65) * (1 - 0.55 * v.dn);
        ctx.fillStyle = v.tier === 'D' ? pal.cloudD : pal.cloudE;
        ctx.fillRect(v.sx - s / 2, v.sy - s / 2, s, s);
        if (hov) { ctx.globalAlpha = 1; ctx.strokeStyle = pal.tx; ctx.lineWidth = 1.2; ctx.strokeRect(v.sx - s / 2 - 3, v.sy - s / 2 - 3, s + 6, s + 6); }
        this.cloudPts.push(v);
      }
      ctx.globalAlpha = 1;
    }

    // boxes to place this frame
    const boxes: Box[] = [];
    const mkBox = (v: LNode, kind: Kind): Box => {
      const code = st.codes.get(v.id) || '·';
      const s = v.s, lab = LAB[kind];
      const isSel = v.id === st.selected, isPeer = v.id === st.peer;
      const fw = kind === 'A' ? 600 : kind === 'B' ? 600 : 500;
      const fs = lab[2] * s;
      const tw = this.measure(code, `${fw} ${fs.toFixed(1)}px ${MONO}`) + (kind === 'A' ? 14 : 9) * s;
      return {
        v, kind, code,
        sel: isSel, peer: isPeer, core: focusSet.has(v.id), link: linked.has(v.id) && !isSel, hot: st.hotPeer === v.id,
        w: Math.max(lab[0] * s, tw), h: lab[1] * s, fs, lx: v.sx, ly: v.sy, off: false, placed: false,
      };
    };
    for (const v of L.nodes) {
      if (v.d <= 0.3) continue;
      if (v.shell) {
        if (st.hidden.has(v.tier) && v.id !== st.selected && v.id !== st.peer) continue;
        boxes.push(mkBox(v, v.tier as Kind));
      } else if (boxed.has(v.id)) {
        boxes.push(mkBox(v, 'X'));
      }
    }

    // 5) label placement
    const grid = new BoxGrid();
    grid.add(rectAt(you.x, you.y, 42, 42, 0));
    for (const o of this.obstacles) grid.add(o);
    const extra = (b: Box) => (b.sel ? 7 : b.core && b.kind === 'A' ? 4 : 0);
    const pri = (b: Box) => (b.sel ? 0 : b.peer ? 0.5 : b.core ? 1 : b.link ? 2 : b.hot ? 2.5 : b.kind === 'A' ? 3 : b.kind === 'B' ? 4 : 6);
    const must = (b: Box) => pri(b) <= 4;
    const order = boxes.slice().sort((a, b) => (pri(a) - pri(b)) || (a.v.d - b.v.d));
    let moved = 0, clash = 0, cShown = 0, cAll = 0, deg = 0;
    const NUD = [[0, -5], [0, 5], [6, 0], [-6, 0], [6, -5], [-6, -5], [6, 5], [-6, 5], [0, -10], [0, 10], [11, 0], [-11, 0], [11, -10], [-11, -10], [11, 10], [-11, 10]];
    const placeMust = (b: Box) => {
      const pad = 2 + extra(b);
      const r0 = rectAt(b.v.sx, b.v.sy, b.w, b.h, pad);
      if (!grid.hit(r0)) { b.lx = b.v.sx; b.ly = b.v.sy; b.placed = true; grid.add(r0); return; }
      for (const [dx, dy] of NUD) {
        const r = rectAt(b.v.sx + dx, b.v.sy + dy, b.w, b.h, pad);
        if (!grid.hit(r)) { b.lx = b.v.sx + dx; b.ly = b.v.sy + dy; b.placed = true; grid.add(r); return; }
      }
      for (let k = 1; k <= 5; k++) {
        const dy = (b.h + 8) * k * 0.7, dx = (b.w + 8) * k * 0.62;
        const cands = [[0, -dy], [dx, 0], [-dx, 0], [0, dy], [dx, -dy], [-dx, -dy], [dx, dy], [-dx, dy]];
        for (const [cx, cy] of cands) {
          const x = b.v.sx + cx, y = b.v.sy + cy, r = rectAt(x, y, b.w, b.h, pad);
          if (r.x0 < 4 || r.x1 > W - 4 || r.y0 < 4 || r.y1 > H - 4) continue;
          if (!grid.hit(r)) { b.lx = x; b.ly = y; b.off = true; b.placed = true; grid.add(r); moved++; return; }
        }
      }
      // nowhere free: a plain B-tier box gives way and becomes a dot (hover still names it);
      // the selected / focused / linked people and A-tier stay readable even if that means touching
      if (b.kind === 'B' && !b.sel && !b.peer && !b.core && !b.link && !b.hot) { b.placed = false; deg++; return; }
      b.lx = b.v.sx; b.ly = b.v.sy; b.placed = true; grid.add(r0); clash++;
    };
    for (const b of order) if (must(b)) placeMust(b);

    // ring tags: on each ground circle, front-right of the screen
    const tags: { txt: string; x: number; y: number; w: number; h: number; s: number }[] = [];
    {
      const phR = (52 - this.view.yaw) * RAD;
      for (const t of TIERS) {
        const n = L.tierCount[t];
        if (!n || st.hidden.has(t) || (!st.cloud && (t === 'D' || t === 'E'))) continue;
        const r = GROUND[t], txt = `${t} ${n}`;
        for (let k = 0; k < 31; k++) {
          const ph = phR + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 6 * RAD, q = P(C, r * Math.cos(ph), 0, r * Math.sin(ph));
          const s = clamp(lscale(q.d), 0.9, 1.25) * gs;
          const w = this.measure(txt, `600 ${(9.5 * s).toFixed(1)}px ${MONO}`) + 10, h = 14 * s, bb = rectAt(q.x, q.y, w, h, 1.5);
          if (!grid.hit(bb)) { grid.add(bb); tags.push({ txt, x: q.x, y: q.y, w, h, s }); break; }
        }
      }
    }

    // 6) focused core circle: 3D envelope (bounding sphere projection + member label boxes)
    let hullShape: { path: Path2D; pts: { x: number; y: number }[] } | null = null;
    let coreLab: { x: number; y: number; w: number; h: number } | null = null;
    let cm: [number, number, number] | null = null, coreR = 0;
    // the envelope wraps the circle's A / B / C members; its D / E members sit out in the cloud, boxed but outside
    const coreAll = boxes.filter(b => b.core);
    const coreShell = coreAll.filter(b => b.v.shell);
    const coreBoxes = coreShell.length >= 2 ? coreShell : coreAll;
    if (st.focus && coreBoxes.length) {
      const ms = coreBoxes.map(b => b.v);
      cm = [0, 0, 0];
      for (const v of ms) { cm[0] += v.x / ms.length; cm[1] += v.y / ms.length; cm[2] += v.z / ms.length; }
      let rad = 0;
      for (const v of ms) rad = Math.max(rad, Math.hypot(v.x - cm[0], v.y - cm[1], v.z - cm[2]));
      coreR = Math.max(0.18, rad * 0.75);
      rad = rad * 0.5 + 0.12;
      const hp: { x: number; y: number }[] = [];
      for (let e = -1.4; e <= 1.41; e += 0.35) for (let j = 0; j < 16; j++) {
        const a = j / 16 * TAU, c = Math.cos(e);
        hp.push(P(C, cm[0] + rad * c * Math.cos(a), cm[1] + rad * Math.sin(e), cm[2] + rad * c * Math.sin(a)));
      }
      for (const b of coreBoxes) for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) hp.push({ x: b.lx + sx * (b.w / 2 + extra(b)), y: b.ly + sy * (b.h / 2 + extra(b)) });
      hullShape = blob(hp, 8);
      if (hullShape && st.focusLabel) {
        let hx0 = 1e9, hx1 = -1e9, hy0 = 1e9, hy1 = -1e9;
        for (const p of hullShape.pts) { hx0 = Math.min(hx0, p.x); hx1 = Math.max(hx1, p.x); hy0 = Math.min(hy0, p.y); hy1 = Math.max(hy1, p.y); }
        const lw = this.measure(st.focusLabel, `600 ${(10.5 * gs).toFixed(1)}px ${SANS}`) + 16, lh = 19 * gs, hcx = (hx0 + hx1) / 2;
        const cands = [[hcx, hy0 - 14], [hcx, hy1 + 14], [hx0 - lw / 2 - 6, (hy0 + hy1) / 2], [hx1 + lw / 2 + 6, (hy0 + hy1) / 2], [hx0 + lw / 2, hy0 - 14], [hx1 - lw / 2, hy0 - 14], [hx0 + lw / 2, hy1 + 14], [hx1 - lw / 2, hy1 + 14], [hcx, hy0 - 40], [hcx, hy1 + 40]];
        for (const [x, y] of cands) {
          const bb = rectAt(x, y, lw, lh, 3);
          if (bb.x0 < 4 || bb.x1 > W - 4 || bb.y0 < 4 || bb.y1 > H - 4) continue;
          if (!grid.hit(bb)) { coreLab = { x, y, w: lw, h: lh }; grid.add(bb); break; }
        }
      }
    }

    // C and expanded-sector boxes: nudge a little, otherwise shrink to a dot
    const keySegs = boxes.filter(b => b.sel || b.peer).length
      ? L.edges.filter(e => (e.a.id === st.selected || e.b.id === st.selected) || (focusSet.has(e.a.id) && focusSet.has(e.b.id)))
      : L.edges.filter(e => focusSet.has(e.a.id) && focusSet.has(e.b.id));
    const segHit = (bb: Rect, v: LNode) => keySegs.some(e => e.a !== v && e.b !== v && e.a.d > 0.3 && e.b.d > 0.3 && segRect(e.a.sx, e.a.sy, e.b.sx, e.b.sy, bb));
    const inHull = (bb: Rect) => !!hullShape && [[(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2], [bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x0, bb.y1], [bb.x1, bb.y1]].some(([x, y]) => inPoly(hullShape!.pts, x, y));
    const NUDC = [[0, 0], [0, -5], [0, 5], [6, 0], [-6, 0], [6, -5], [-6, -5], [6, 5], [-6, 5], [0, -10], [0, 10], [11, 0], [-11, 0]];
    for (const b of order) {
      if (must(b)) continue;
      cAll++;
      let ok = false;
      for (const [dx, dy] of NUDC) {
        const bb = rectAt(b.v.sx + dx, b.v.sy + dy, b.w, b.h, 1.5);
        if (!grid.hit(bb) && !segHit(bb, b.v) && !inHull(bb)) { b.lx = b.v.sx + dx; b.ly = b.v.sy + dy; b.placed = true; grid.add(bb); ok = true; break; }
      }
      if (ok) cShown++; else deg++;
    }

    // circle names floating outside each circle (if there is room)
    const clusterLabs: { x: number; y: number; w: number; h: number; fs: number; name: string; o: number }[] = [];
    const rimPx = C.foc * RIM / dist;
    for (const c of L.clusters) {
      if (c.id === st.focus) continue;
      const name = st.clusterNames.get(c.id);
      if (!name) continue;
      const ms = c.members.filter(v => v.shell);
      if (!ms.length) continue;
      let mx = 0, my = 0, me = 0;
      for (const v of ms) { mx += Math.cos(v.phi); my += Math.sin(v.phi); me += v.el; }
      const ph = Math.atan2(my, mx), eMean = me / ms.length;
      const cands: [number, number, number][] = [];
      for (const [r, ef] of [[2.74, 0.5], [2.9, 0.25], [2.74, 0.85], [3.0, 0.05]]) for (let k = 0; k < 7; k++) cands.push([r, ef, ph + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.09]);
      for (const [r, ef, p2] of cands) {
        const e4 = clamp(eMean * ef, -ELMAX, ELMAX);
        const q = P(C, r * Math.cos(e4) * Math.cos(p2), r * VY * Math.sin(e4), r * Math.cos(e4) * Math.sin(p2));
        // a circle that points at (or away from) the camera would put its name in the middle of the crowd
        if (Math.hypot(q.x - you.x, q.y - you.y) < rimPx * 0.46) continue;
        const fs = 11 * clamp(lscale(q.d), 0.9, 1.2) * gs;
        const w = this.measure(name, `500 ${fs.toFixed(1)}px ${SANS}`) + 12, h = fs + 8, bb = rectAt(q.x, q.y, w, h, 2);
        if (bb.x0 < 2 || bb.x1 > W - 2) continue;
        if (!grid.hit(bb) && !inHull(bb)) { grid.add(bb); clusterLabs.push({ x: q.x, y: q.y, w, h, fs, name, o: 1 - 0.5 * dn(q.d) }); break; }
      }
    }

    // 7) faint edges (far ones fainter)
    const drawnIds = new Set(boxes.map(b => b.v.id));
    const selId = st.selected;
    const hotKey = this.hover?.kind === 'edge' ? this.hover.key : st.hotPeer && selId ? edgeKey(selId, st.hotPeer) : null;
    const pairKey = selId && st.peer ? edgeKey(selId, st.peer) : null;
    let edgeCount = 0;
    const strong: { e: LEdge; cls: 'sel' | 'core' }[] = [];
    for (const e of L.edges) {
      if (!drawnIds.has(e.a.id) || !drawnIds.has(e.b.id)) continue;
      edgeCount++;
      const isSel = !!selId && (e.a.id === selId || e.b.id === selId);
      const isCore = focusSet.has(e.a.id) && focusSet.has(e.b.id);
      if (isSel) { strong.push({ e, cls: 'sel' }); continue; }
      if (isCore) { strong.push({ e, cls: 'core' }); continue; }
      const intra = !!e.a.cluster && e.a.cluster === e.b.cluster;
      const quiet = !!selId && st.onlySel;
      const color = quiet ? pal.eFaint : intra ? pal.eBase : pal.eFaint;
      const o = (quiet ? 0.6 : intra ? 0.8 : 0.5) * (1 - 0.6 * (e.a.dn + e.b.dn) / 2);
      batch.add(color, 0.9, null, o, e.a.sx, e.a.sy, e.b.sx, e.b.sy);
    }
    batch.flush(ctx);

    // 8) drop lines to the equator + foot marks
    if (st.ground) {
      for (const b of boxes) {
        const v = b.v, hot = b.sel || b.core || b.peer, big = hot || b.link || b.kind === 'A' || b.kind === 'B';
        const o = (hot ? 0.95 : big ? 0.7 : 0.4) * (1 - 0.6 * v.dn);
        const col = hot ? pal.coreStroke : pal.tx3;
        batch.add(col, big ? 1 : 0.7, [1.5, 2], o, v.sx, v.sy, v.gx, v.gy);
      }
      batch.flush(ctx);
      for (const b of boxes) {
        const v = b.v, hot = b.sel || b.core || b.peer, big = hot || b.link || b.kind === 'A' || b.kind === 'B';
        const o = (hot ? 0.95 : big ? 0.7 : 0.4) * (1 - 0.6 * v.dn);
        const col = hot ? pal.coreStroke : pal.tx3;
        const rr = (big ? 3.4 : 2) * v.s;
        ctx.globalAlpha = o;
        ctx.beginPath(); ctx.ellipse(v.gx, v.gy, rr, Math.max(0.6, rr * Math.max(0.2, C.sp)), 0, 0, TAU);
        if (big) { ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke(); } else { ctx.fillStyle = col; ctx.fill(); }
      }
      ctx.globalAlpha = 1;
    }

    // 9) focused circle: shadow on the equator + the envelope in space
    if (hullShape && cm) {
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let k = 0; k <= 48; k++) {
        const a = k / 48 * TAU, q = P(C, cm[0] + coreR * Math.cos(a), 0, cm[2] + coreR * Math.sin(a));
        if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      }
      ctx.closePath();
      ctx.fillStyle = pal.hullFill; ctx.fill();
      ctx.strokeStyle = pal.hullStroke; ctx.lineWidth = 1; ctx.setLineDash([1.5, 2.5]); ctx.stroke();
      const c0 = P(C, cm[0], 0, cm[2]), c1 = P(C, cm[0], cm[1], cm[2]);
      ctx.beginPath(); ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = pal.hullStroke; ctx.beginPath(); ctx.arc(c0.x, c0.y, 2, 0, TAU); ctx.fill();
      ctx.fillStyle = pal.hullFill; ctx.fill(hullShape.path);
      ctx.strokeStyle = pal.hullStroke; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]); ctx.stroke(hullShape.path); ctx.setLineDash([]);
    }

    // 10) key lines (selected person's, focused circle's) + leader lines for moved labels
    this.selSegs = [];
    for (const { e, cls } of strong) {
      if (cls !== 'core') continue;
      ctx.strokeStyle = pal.eCore; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(e.a.sx, e.a.sy); ctx.lineTo(e.b.sx, e.b.sy); ctx.stroke();
    }
    ctx.lineCap = 'round';
    for (const { e, cls } of strong) {
      if (cls !== 'sel') continue;
      const hot = e.key === hotKey || e.key === pairKey;
      // with a pair open, that one line carries the picture; the person's other lines step back
      ctx.globalAlpha = pairKey && !hot ? 0.38 : 1;
      ctx.strokeStyle = pal.selHalo; ctx.lineWidth = hot ? 9 : 6;
      ctx.beginPath(); ctx.moveTo(e.a.sx, e.a.sy); ctx.lineTo(e.b.sx, e.b.sy); ctx.stroke();
      ctx.strokeStyle = hot ? pal.eHot : pal.eSel; ctx.lineWidth = hot ? 2.6 : 1.6;
      ctx.beginPath(); ctx.moveTo(e.a.sx, e.a.sy); ctx.lineTo(e.b.sx, e.b.sy); ctx.stroke();
      this.selSegs.push({ key: e.key, a: e.a, b: e.b, ax: e.a.sx, ay: e.a.sy, bx: e.b.sx, by: e.b.sy });
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
    for (const b of boxes) {
      if (!b.placed || !b.off) continue;
      ctx.strokeStyle = pal.tx3; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(b.v.sx, b.v.sy); ctx.lineTo(b.lx, b.ly); ctx.stroke();
    }

    // 11) nodes far → near; 「你」 slotted in by depth; unplaced C as a small dot
    const hovId = this.hover?.kind === 'node' ? this.hover.id : null;
    let youDone = false;
    const drawYou = () => {
      youDone = true;
      const up = P(C, 0, 1.3 * VY, 0);
      ctx.strokeStyle = pal.tx3; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(you.x, you.y); ctx.lineTo(up.x, up.y); ctx.stroke(); ctx.setLineDash([]);
      const yr = 18 * Math.min(1, gs + 0.1);
      ctx.fillStyle = pal.panel; ctx.strokeStyle = pal.tx; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(you.x, you.y, yr, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = pal.tx; ctx.font = `600 ${(13 * Math.min(1, gs + 0.1)).toFixed(1)}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('你', you.x, you.y + 4.6);
    };
    this.dots = [];
    const drawOrder = boxes.slice().sort((a, b) => b.v.d - a.v.d);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const b of drawOrder) {
      const v = b.v;
      if (!youDone && v.d < you.d) drawYou();
      if (!b.placed) {
        const s = (b.kind === 'B' ? 4.4 : 3.4) * v.s;
        ctx.globalAlpha = 0.95 - 0.45 * v.dn;
        ctx.fillStyle = b.kind === 'B' ? pal.bStroke : pal.cStroke;
        ctx.fillRect(v.sx - s / 2, v.sy - s / 2, s, s);
        if (hovId === v.id) { ctx.globalAlpha = 1; ctx.strokeStyle = pal.tx; ctx.lineWidth = 1.2; ctx.strokeRect(v.sx - s / 2 - 3, v.sy - s / 2 - 3, s + 6, s + 6); }
        ctx.globalAlpha = 1;
        this.dots.push(v);
        continue;
      }
      if (b.off) { ctx.fillStyle = pal.tx2; ctx.fillRect(v.sx - 2, v.sy - 2, 4, 4); }
      const x0 = b.lx - b.w / 2, y0 = b.ly - b.h / 2;
      const o = 1 - 0.5 * v.dn;
      let fill = pal.panel, stroke: string | null = null, sw = 0, tx = pal.cText, dash: number[] | null = null, fo = 1, so = o;
      if (b.kind === 'A') { fill = pal.aFill; tx = pal.aText; fo = 1 - 0.4 * v.dn; }
      else if (b.kind === 'B') { stroke = pal.bStroke; sw = 1.2; tx = pal.bText; }
      else if (b.kind === 'C') { stroke = pal.cStroke; sw = 1; }
      else { stroke = pal.cStroke; sw = 1.1; dash = [2.5, 2]; tx = pal.tx; }
      if (b.core && !b.sel && b.kind !== 'A') { fill = pal.coreFill; stroke = pal.coreStroke; sw = 1.5; tx = pal.tx; so = 1; }
      if ((b.link || b.hot) && !b.core && !b.sel) { stroke = pal.eSel; sw = 1.4; tx = pal.tx; so = 1; }
      if (b.peer && !b.sel) { stroke = pal.selStroke; sw = 2; tx = b.kind === 'A' ? pal.aText : pal.tx; so = 1; }
      if (b.sel) { fill = pal.sig; stroke = pal.selStroke; sw = 1; tx = pal.onSig; fo = 1; so = 1; dash = null; }
      const hot = b.sel || b.core || b.link || b.peer || b.hot, to = hot ? 1 : o;
      if (b.core && b.kind === 'A' && !b.sel) {
        ctx.fillStyle = pal.panel; ctx.strokeStyle = pal.coreStroke; ctx.lineWidth = 1.5;
        roundRect(ctx, x0 - 3.5, y0 - 3.5, b.w + 7, b.h + 7, 4); ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = pal.panel; roundRect(ctx, x0, y0, b.w, b.h, 2); ctx.fill();
      ctx.globalAlpha = fo; ctx.fillStyle = fill;
      roundRect(ctx, x0 + sw / 2, y0 + sw / 2, b.w - sw, b.h - sw, b.kind === 'A' ? 3 : 2); ctx.fill();
      if (stroke) {
        ctx.globalAlpha = so; ctx.strokeStyle = stroke; ctx.lineWidth = sw; ctx.setLineDash(dash || []);
        ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
      if (b.kind === 'A') {
        ctx.fillStyle = tx; ctx.font = `600 ${b.fs.toFixed(1)}px ${MONO}`;
        ctx.fillText(b.code, b.lx, b.ly - 1.2 * v.s);
        ctx.fillStyle = b.sel ? pal.selSub : pal.aSub; ctx.font = `400 ${(9 * v.s).toFixed(1)}px ${MONO}`;
        ctx.fillText(kfmt(v.msgs), b.lx, b.ly + 11.5 * v.s);
      } else {
        ctx.globalAlpha = to; ctx.fillStyle = tx; ctx.font = `${b.kind === 'B' ? 600 : 500} ${b.fs.toFixed(1)}px ${MONO}`;
        ctx.fillText(b.code, b.lx, b.ly + b.fs * 0.36);
        ctx.globalAlpha = 1;
      }
      if (b.sel) {
        const q = 6, L2 = 7;
        ctx.strokeStyle = pal.tx; ctx.lineWidth = 1.3;
        for (const [cx, cy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const xx = b.lx + cx * (b.w / 2 + q), yy = b.ly + cy * (b.h / 2 + q);
          ctx.beginPath(); ctx.moveTo(xx - cx * L2, yy); ctx.lineTo(xx, yy); ctx.lineTo(xx, yy - cy * L2); ctx.stroke();
        }
      } else if (hovId === v.id) {
        ctx.strokeStyle = pal.tx; ctx.lineWidth = 1.2;
        roundRect(ctx, x0 - 3, y0 - 3, b.w + 6, b.h + 6, 3); ctx.stroke();
      }
    }
    if (!youDone) drawYou();
    this.boxes = drawOrder;

    // 12) circle label, circle names, ring tags, degree labels
    if (coreLab && hullShape && st.focusLabel) {
      let near = hullShape.pts[0];
      for (const p of hullShape.pts) if (Math.hypot(p.x - coreLab.x, p.y - coreLab.y) < Math.hypot(near.x - coreLab.x, near.y - coreLab.y)) near = p;
      const ex = clamp(near.x, coreLab.x - coreLab.w / 2, coreLab.x + coreLab.w / 2), ey = clamp(near.y, coreLab.y - coreLab.h / 2, coreLab.y + coreLab.h / 2);
      ctx.strokeStyle = pal.coreStroke; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(near.x, near.y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = pal.coreStroke; ctx.beginPath(); ctx.arc(near.x, near.y, 2, 0, TAU); ctx.fill();
      ctx.fillStyle = pal.coreFill; ctx.strokeStyle = pal.coreStroke; ctx.lineWidth = 1.2;
      roundRect(ctx, coreLab.x - coreLab.w / 2, coreLab.y - coreLab.h / 2, coreLab.w, coreLab.h, 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = pal.tx; ctx.font = `600 ${(10.5 * gs).toFixed(1)}px ${SANS}`;
      ctx.fillText(st.focusLabel, coreLab.x, coreLab.y + 3.8 * gs);
    }
    for (const c of clusterLabs) {
      ctx.globalAlpha = c.o;
      ctx.fillStyle = pal.panel; ctx.strokeStyle = pal.line2; ctx.lineWidth = 1;
      roundRect(ctx, c.x - c.w / 2, c.y - c.h / 2, c.w, c.h, 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = pal.tx2; ctx.font = `500 ${c.fs.toFixed(1)}px ${SANS}`;
      ctx.fillText(c.name, c.x, c.y + c.fs * 0.36);
    }
    ctx.globalAlpha = 1;
    for (const t of tags) {
      ctx.fillStyle = pal.panel; ctx.strokeStyle = pal.rim; ctx.lineWidth = 1;
      roundRect(ctx, t.x - t.w / 2, t.y - t.h / 2, t.w, t.h, 7 * t.s); ctx.fill(); ctx.stroke();
      ctx.fillStyle = pal.tx2; ctx.font = `600 ${(9.5 * t.s).toFixed(1)}px ${MONO}`;
      ctx.fillText(t.txt, t.x, t.y + 3.3 * t.s);
    }
    for (const d of degLabs) {
      const fs = 9 * d.s, bb = rectAt(d.x, d.y, fs * 2.6, fs + 4, 1);
      if (grid.hit(bb)) continue;
      ctx.globalAlpha = d.o; ctx.fillStyle = pal.tx3; ctx.font = `400 ${fs.toFixed(1)}px ${MONO}`;
      ctx.fillText(d.t, d.x, d.y + fs * 0.35);
    }
    ctx.globalAlpha = 1;

    // 13) sector popup leader (the popup itself is DOM)
    if (hovSector >= 0 && this.sectorAnchor) {
      const sN = secN[hovSector], mid = (hovSector + 0.5) / SECTORS * TAU, rr = HIST0 + (sN.D + sN.E) * HS;
      const pm = P(C, rr * Math.cos(mid), 0, rr * Math.sin(mid)), A = this.sectorAnchor;
      ctx.strokeStyle = pal.tx; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pm.x, pm.y); ctx.lineTo(A.x, A.y); ctx.stroke();
      ctx.fillStyle = pal.tx; ctx.beginPath(); ctx.arc(pm.x, pm.y, 2.5, 0, TAU); ctx.fill();
    }

    // 14) axis gizmo (turns with the view)
    {
      const gx = W - 50, gy = H - 52, L3 = 24;
      const axes: [number, number, number, string, string][] = [[1, 0, 0, 'X', pal.tx2], [0, 0, 1, 'Y', pal.tx2], [0, 1, 0, 'Z', pal.sigInk]];
      ctx.font = `600 9px ${MONO}`;
      const tips = axes.map(([ax, ay, az, nm, col]) => {
        const x1 = ax * C.cy - az * C.sy, z1 = ax * C.sy + az * C.cy, y2 = ay * C.cp - z1 * C.sp;
        return { x1, y2, nm, col, len: Math.hypot(x1, y2), lx: gx + x1 * (L3 + 9), ly: gy - y2 * (L3 + 9) + 3 };
      });
      // an axis pointing at the camera puts its letter on top of another one: step the shorter one aside
      for (let a = 0; a < tips.length; a++) for (let b = a + 1; b < tips.length; b++) {
        const p = tips[a], q = tips[b];
        if (Math.abs(p.lx - q.lx) < 9 && Math.abs(p.ly - q.ly) < 10) {
          const m = p.len < q.len ? p : q, o = m === p ? q : p;
          m.lx = o.lx + (m.lx <= o.lx ? -9 : 9);
        }
      }
      for (const t of tips) {
        ctx.strokeStyle = t.col; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + t.x1 * L3, gy - t.y2 * L3); ctx.stroke();
        ctx.fillStyle = t.col; ctx.textAlign = 'center'; ctx.fillText(t.nm, t.lx, t.ly);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = pal.tx2; ctx.beginPath(); ctx.arc(gx, gy, 2.2, 0, TAU); ctx.fill();
    }

    // self-check: overlaps between visible labels
    const vis = boxes.filter(b => b.placed).map(b => rectAt(b.lx, b.ly, b.w, b.h, 0));
    let ov = 0;
    if (vis.length < 400) for (let a = 0; a < vis.length; a++) for (let b = a + 1; b < vis.length; b++) {
      const p = vis[a], q = vis[b];
      if (p.x0 < q.x1 && p.x1 > q.x0 && p.y0 < q.y1 && p.y1 > q.y0) ov++;
    }
    const stats: FrameStats = {
      ms: performance.now() - t0, boxes: boxes.length, shownC: `${cShown}/${cAll}`, degradedC: deg,
      movedAB: moved, clashAB: clash, overlaps: ov, edges: edgeCount,
    };
    this.lastStats = stats;
    return stats;
  }

  /** What is under the pointer (CSS px), using the last frame's geometry. */
  hitTest(x: number, y: number): HoverTarget | null {
    // boxes, nearest first
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      if (!b.placed) continue;
      if (Math.abs(x - b.lx) <= b.w / 2 + 2 && Math.abs(y - b.ly) <= b.h / 2 + 2) return { kind: 'node', id: b.v.id };
    }
    let best: LNode | null = null, bd = 7;
    for (const v of this.dots) { const d = Math.hypot(v.sx - x, v.sy - y); if (d < bd) { bd = d; best = v; } }
    if (best) return { kind: 'node', id: best.id };
    let be: (typeof this.selSegs)[number] | null = null, bed = 6;
    for (const s of this.selSegs) {
      const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy || 1;
      const t = clamp(((x - s.ax) * dx + (y - s.ay) * dy) / l2, 0, 1);
      if (t < 0.06 || t > 0.94) continue;   // the ends belong to the boxes
      const d = Math.hypot(s.ax + dx * t - x, s.ay + dy * t - y);
      if (d < bed) { bed = d; be = s; }
    }
    if (be) return { kind: 'edge', key: be.key, a: be.a.id, b: be.b.id };
    if (this.youPt && Math.hypot(this.youPt.x - x, this.youPt.y - y) < 18) return null;
    best = null; bd = 5;
    for (const v of this.cloudPts) { const d = Math.hypot(v.sx - x, v.sy - y); if (d < bd) { bd = d; best = v; } }
    if (best) return { kind: 'node', id: best.id };
    for (const q of this.sectorQuads) if (inPoly(q.quad, x, y)) return { kind: 'sector', s: q.s };
    return null;
  }

  sectorInfo(s: number, codes: ReadonlyMap<string, string>): SectorInfo | null {
    const L = this.layout, st = this.st;
    if (!L || !st) return null;
    const sec = L.sectors[s];
    if (!sec) return null;
    const D = st.hidden.has('D') ? [] : sec.D, E = st.hidden.has('E') ? [] : sec.E;
    const pick = (list: LNode[]) => list.slice().sort((a, b) => b.msgs - a.msgs).map(v => codes.get(v.id) || '·');
    return { s, nD: D.length, nE: E.length, d: pick(D), e: pick(E) };
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
