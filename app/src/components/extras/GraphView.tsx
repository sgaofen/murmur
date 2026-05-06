// 3D 关系网络 — 拖拽旋转 / 滚轮缩放 / 投影。底层 SVG，无外部 force-graph 依赖。
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PATCH NOTES — Spotlight 功能（不影响现有 3D 建模 / 投影 / 节点 / 边）   ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║  v0.3.17：核心圈 spotlight 上线，桥梁 spotlight 评估后下线（rank-by-     ║
// ║  radius 布局下两群无法视觉分离，金光线效果鸡肋）。Spotlight 类型已收窄  ║
// ║  到 'circle' only；type 别动，要复活桥梁直接加回 'bridge' 变体即可。    ║
// ║                                                                          ║
// ║  [PATCH-1] 新增 Props: spotlight / onChangeSpotlight                     ║
// ║  [PATCH-2] <defs> 末尾追加 metaball filter (gooey)                       ║
// ║  [PATCH-3] cluster halo 块之后追加 spotlight 渲染层                      ║
// ║            ── 核心圈：每位成员一个 circle 走 metaball filter            ║
// ║            ── 非聚焦节点 / 边 整体 desaturate + 降透明度（不修改原代码） ║
// ║  [PATCH-4] OverviewPanel 「核心圈」Stat 改为可点；新增 PickerOverlay /   ║
// ║            SpotlightBanner 组件，maskText() 走隐私模式                   ║
// ║                                                                          ║
// ║  3D 建模 / 投影矩阵 / 节点渲染 / 边渲染：上游真品逻辑，0 行改动。       ║
// ║  数据通道：n.cluster, n.bridge, stats.core_circles, stats.bridges,       ║
// ║  data.clusters[].{id, label, members} 由后端 _compute_friend_topology   ║
// ║  计算（label-propagation + Brandes betweenness）。bridges 字段保留，    ║
// ║  仅 UI 不渲染，避免后端 cache 失效 + 留作日后可能的复活。               ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { displayName, maskText } from '../../utils/privacy';
import { usePrivacy } from '../../utils/usePrivacy';

export interface GraphNode {
  id: string;
  name: string;
  is_self?: boolean;
  tier: string;             // self | A | B | C | D | E
  cluster?: string | null;
  color?: string;
  size: number;
  x: number; y: number; z: number;
  msgs?: number;             // total
  private_msgs?: number;
  group_msgs?: number;
  groups?: number;
  moments_back?: number;
  moments_out?: number;
  combined_score?: number;
  isolated?: boolean;
  bridge?: boolean;
}
export interface GraphEdge {
  source: string;
  target: string;
  type: 'private' | 'co_group' | 'co_active' | 'mention' | 'dm_inferred' | 'mutual_reply' | 'close_pair' | 'moments_cross';
  raw_weight?: number;
  weight: number;
  dashed?: boolean;
  meta?: Record<string, any>;
  moments_cross?: number;
  mention_count?: number;
  shared_group_count?: number;
}
export interface GraphCluster {
  id: string;
  label: string;
  members?: string[];
  // Legacy positional fields — only populated for old payloads with explicit
  // cluster centroids. Current backend (label propagation) emits id/label/members only.
  cx?: number; cy?: number; cz?: number;
  color?: string;
  n?: number;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  stats: {
    people: number;
    edges: number;
    bridges: number;
    isolates: number;
    clusters: number;
    ffEdges: number;
  };
}

// ── [PATCH-1] Spotlight 类型 ──────────────────────────────────────────────
// 上层 (Graph.tsx) 维护 spotlight 状态。null = 默认干净画布；'circle' =
// 聚焦某核心圈（hull envelope 半透明 3D 包裹）。
// 桥梁功能产品决定永久砍掉（rank-by-radius 布局下两群聚焦视觉效果鸡肋，
// 反复迭代未达预期）。后端仍计算 bridge betweenness 留作 stats，但 UI 不
// 再有任何入口、按钮、渲染。
export type Spotlight =
  | null
  | { kind: 'circle'; clusterId: string };
// ──────────────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  self: '#FFE6CF',
  A: '#FF6B47',
  B: '#E8B57A',
  C: '#5A7A99',
  D: '#9E9583',
  E: '#C8BFAB',
};

// ── [PATCH-1] 9 个核心圈固定调色板（按 cluster.id 字典序映射）──────────────
const CIRCLE_PALETTE = [
  '#FF6B47', '#E8B57A', '#5A7A99', '#9E9583', '#7C9885',
  '#C9A66B', '#A87BA1', '#6B8FA8', '#D17545',
];
function clusterColor(clusterId: string, allClusters: GraphCluster[]): string {
  const sorted = [...allClusters].map(c => c.id).sort();
  const idx = sorted.indexOf(clusterId);
  return CIRCLE_PALETTE[(idx >= 0 ? idx : 0) % CIRCLE_PALETTE.length];
}
// ──────────────────────────────────────────────────────────────────────────

const EDGE_ORDER: Record<GraphEdge['type'], number> = {
  private: 0,
  co_group: 1,
  co_active: 2,
  mention: 3,
  moments_cross: 4,
  dm_inferred: 5,
  mutual_reply: 6,
  close_pair: 7,
};

interface Projected extends GraphNode {
  proj: { x: number; y: number; depth: number };
}

// Project 3D → 2D with rotations on Y (yaw) and X (pitch) axes,
// plus zoom (scales perspective f) and pan (offset).
function project(
  p: { x: number; y: number; z: number },
  rotY: number, rotX: number,
  zoom: number, panX: number, panY: number,
  w: number, h: number,
) {
  // Rotate around Y axis (yaw)
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
  const x = p.x * cosY - p.z * sinY;
  let z = p.x * sinY + p.z * cosY;
  let y = p.y;
  // Rotate around X axis (pitch)
  const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  const y2 = y * cosX - z * sinX;
  const z2 = y * sinX + z * cosX;
  y = y2; z = z2;
  // Perspective; zoom modifies effective focal length
  const f = 800 / Math.max(0.2, zoom);
  const scale = f / (f + z);
  return {
    x: w / 2 + panX + x * scale * zoom,
    y: h / 2 + panY + y * scale * zoom,
    depth: scale,
  };
}

interface Props {
  data: GraphData;
  dark?: boolean;
  selected: string | null;
  selectedEdge?: GraphEdge | null;
  onSelect: (id: string | null) => void;
  onSelectEdge?: (edge: GraphEdge | null) => void;
  autoRotate?: boolean;
  autoRotateResumeSignal?: number;
  onAutoRotatePause?: () => void;
  height?: number;
  // ── [PATCH-1] spotlight props ────────────────────────────────────────────
  spotlight?: Spotlight;
  onChangeSpotlight?: (s: Spotlight) => void;
  // ─────────────────────────────────────────────────────────────────────────
}

/** Andrew's monotone-chain convex hull — returns hull vertices in CCW order. */
function convexHull2D(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  if (pts.length < 3) return pts.slice();
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: {x:number;y:number}, a: {x:number;y:number}, b: {x:number;y:number}) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof sorted = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: typeof sorted = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** Build a smooth closed SVG path that wraps a set of 2D points. Convex hull
 *  → expand each vertex outward from centroid by `margin` → Catmull-Rom-to-
 *  Bezier closed loop. Used for the cluster spotlight envelope (one big
 *  transparent 3D-feeling shape that "刚好包裹" the cluster). */
function smoothEnvelopePath(points: { x: number; y: number }[], margin: number): string {
  const hull = convexHull2D(points);
  if (hull.length < 3) return '';
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  const expanded = hull.map(p => {
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / d) * margin, y: p.y + (dy / d) * margin };
  });
  const n = expanded.length;
  const out: string[] = [`M${expanded[0].x.toFixed(1)},${expanded[0].y.toFixed(1)}`];
  for (let i = 0; i < n; i++) {
    const p0 = expanded[(i - 1 + n) % n];
    const p1 = expanded[i];
    const p2 = expanded[(i + 1) % n];
    const p3 = expanded[(i + 2) % n];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    out.push(`C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`);
  }
  out.push('Z');
  return out.join(' ');
}

function edgeKey(edge: Pick<GraphEdge, 'source' | 'target'> | null | undefined): string {
  if (!edge) return '';
  return [edge.source, edge.target].sort().join('__');
}

export function GraphView({
  data,
  dark = false,
  selected,
  selectedEdge = null,
  onSelect,
  onSelectEdge,
  autoRotate = true,
  autoRotateResumeSignal = 0,
  onAutoRotatePause,
  height = 820,
  spotlight = null,                // [PATCH-1]
  onChangeSpotlight,               // [PATCH-1]
}: Props) {
  const privacy = usePrivacy();
  void privacy;  // re-render when privacy toggle flips (used in label render below)
  const W = 1240, H = height;
  // View state
  const [rotY, setRotY] = useState(0);
  const [rotX, setRotX] = useState(-0.15);    // slight tilt down so 3D depth is visible by default
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [userInteracted, setUserInteracted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; rotX: number; rotY: number; panX: number; panY: number; mode: 'rotate' | 'pan' } | null>(null);
  const lastHoverHitTestAtRef = useRef(0);

  const [hover, setHover] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<{ source: string; target: string } | null>(null);
  // [PATCH-4] picker 弹层（桥梁已永久砍掉，只剩 'circle'）
  const [pickerKind, setPickerKind] = useState<'circle' | null>(null);

  const pauseAutoRotateForUser = useCallback(() => {
    setUserInteracted(true);
    onAutoRotatePause?.();
  }, [onAutoRotatePause]);

  useEffect(() => {
    setUserInteracted(false);
    setDragging(false);
    dragRef.current = null;
  }, [autoRotateResumeSignal]);

  // Auto-rotate (paused when user interacts OR a panel is open OR spotlight is on)
  useEffect(() => {
    if (!autoRotate || userInteracted || selected || selectedEdge || spotlight) return;
    let raf = 0;
    let lastFrame = 0;
    const loop = (t: number) => {
      if (document.visibilityState === 'visible') {
        if (!lastFrame) lastFrame = t;
        const delta = t - lastFrame;
        if (delta >= 33) {
          setRotY(r => r + delta * 0.00008);
          lastFrame = t;
        }
      } else {
        lastFrame = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [autoRotate, userInteracted, selected, selectedEdge, spotlight]);

  // Keyboard nav: arrows = rotate, WASD = pan, +/- = zoom
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Skip if user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const rotStep = 0.06;
      const panStep = 30;
      const zoomStep = 0.1;
      let handled = true;
      let shouldPauseAutoRotate = true;
      switch (e.key) {
        case 'ArrowLeft':  setRotY(r => r - rotStep); break;
        case 'ArrowRight': setRotY(r => r + rotStep); break;
        case 'ArrowUp':    setRotX(r => Math.max(-Math.PI / 2 + 0.05, r - rotStep)); break;
        case 'ArrowDown':  setRotX(r => Math.min(Math.PI / 2 - 0.05, r + rotStep)); break;
        case 'w': case 'W': setPan(p => ({ ...p, y: p.y + panStep })); break;
        case 's': case 'S': setPan(p => ({ ...p, y: p.y - panStep })); break;
        case 'a': case 'A': setPan(p => ({ ...p, x: p.x + panStep })); break;
        case 'd': case 'D': setPan(p => ({ ...p, x: p.x - panStep })); break;
        case '+': case '=': setZoom(z => Math.min(4, z + zoomStep)); break;
        case '-': case '_': setZoom(z => Math.max(0.25, z - zoomStep)); break;
        case 'r': case 'R':
          setRotX(-0.15); setRotY(0); setZoom(1); setPan({ x: 0, y: 0 });
          setUserInteracted(false);
          shouldPauseAutoRotate = false;
          break;
        case 'Escape':
          // [PATCH-4] Esc 优先关 spotlight，再关选中
          if (spotlight && onChangeSpotlight) onChangeSpotlight(null);
          else { onSelect(null); if (onSelectEdge) onSelectEdge(null); }
          shouldPauseAutoRotate = false;
          break;
        default: handled = false;
      }
      if (handled) {
        e.preventDefault();
        if (shouldPauseAutoRotate) pauseAutoRotateForUser();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelect, onSelectEdge, pauseAutoRotateForUser, spotlight, onChangeSpotlight]);

  function svgPoint(e: ReactPointerEvent<SVGSVGElement>) {
    const svg = e.currentTarget as SVGSVGElement;
    const matrix = svg.getScreenCTM();
    if (matrix) {
      const point = svg.createSVGPoint();
      point.x = e.clientX;
      point.y = e.clientY;
      const local = point.matrixTransform(matrix.inverse());
      return { x: local.x, y: local.y };
    }
    const rect = svg.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (W / rect.width),
      y: (e.clientY - rect.top) * (H / rect.height),
    };
  }

  function nodeHitRadius(n: Projected) {
    const visual = n.size * n.proj.depth;
    if (selected) {
      if (n.id === selected) return Math.max(22, visual + 8);
      if (n.is_self) return Math.max(24, visual + 10);
      if (neighbors.has(n.id)) return Math.max(17, visual + 6);
      return Math.max(12, visual + 4);
    }
    return Math.max(n.is_self ? 34 : 40, visual + (n.is_self ? 22 : 30));
  }

  function nodeCoreRadius(n: Projected) {
    const visual = n.size * n.proj.depth;
    if (selected) {
      if (n.id === selected) return Math.max(16, visual + 3);
      if (n.is_self) return Math.max(18, visual + 4);
      return Math.max(11, visual + 2);
    }
    return Math.max(n.is_self ? 24 : 18, visual + (n.is_self ? 10 : 8));
  }

  function nodeLabelHitScore(n: Projected, sx: number, sy: number): number | null {
    if (selected && n.id !== selected) return null;
    const r = n.size * n.proj.depth;
    const isNeighbor = neighbors.has(n.id);
    const dim = !!selected && !n.is_self && selected !== n.id && !isNeighbor;
    if (dim || (!n.is_self && n.tier === 'E')) return null;
    const labelY = n.proj.y + r + (n.is_self ? 18 : 14);
    const label = n.is_self ? '你' : displayName(n.id, n.name);
    const halfWidth = Math.min(150, Math.max(36, label.length * 8 + 22));
    const dx = Math.abs(sx - n.proj.x);
    const dy = Math.abs(sy - labelY);
    if (dx > halfWidth || dy > 20) return null;
    return 0.18 + (dx / halfWidth) * 0.35 + (dy / 20) * 0.25;
  }

  function findNodeHit(sx: number, sy: number, includeLabels = false): Projected | null {
    let best: Projected | null = null;
    let bestScore = Infinity;
    let bestDepth = -Infinity;
    for (const n of projNodes) {
      const r = nodeHitRadius(n);
      const d = Math.hypot(n.proj.x - sx, n.proj.y - sy);
      let score = d <= r ? d / r : Infinity;
      if (includeLabels) {
        const labelScore = nodeLabelHitScore(n, sx, sy);
        if (labelScore !== null) score = Math.min(score, labelScore);
      }
      if (score === Infinity) continue;
      if (score < bestScore || (Math.abs(score - bestScore) < 0.08 && n.proj.depth > bestDepth)) {
        best = n;
        bestScore = score;
        bestDepth = n.proj.depth;
      }
    }
    return best;
  }

  function findNodeCoreHit(sx: number, sy: number): Projected | null {
    let best: Projected | null = null;
    let bestD = Infinity;
    let bestDepth = -Infinity;
    for (const n of projNodes) {
      const d = Math.hypot(n.proj.x - sx, n.proj.y - sy);
      if (d > nodeCoreRadius(n)) continue;
      if (d < bestD || (Math.abs(d - bestD) < 2 && n.proj.depth > bestDepth)) {
        best = n;
        bestD = d;
        bestDepth = n.proj.depth;
      }
    }
    return best;
  }

  function isNearAnyNode(sx: number, sy: number, extra = 8, coreOnly = false) {
    for (const n of projNodes) {
      const r = coreOnly ? nodeCoreRadius(n) : nodeHitRadius(n);
      if (Math.hypot(n.proj.x - sx, n.proj.y - sy) <= r + extra) return true;
    }
    return false;
  }

  function edgeDistance(edge: GraphEdge, sx: number, sy: number, tolerance: number) {
    const a = projById[edge.source];
    const b = projById[edge.target];
    if (!a || !b) return Infinity;
    const isSelfEdge = edge.source === 'self' || edge.target === 'self';
    const dx = b.proj.x - a.proj.x;
    const dy = b.proj.y - a.proj.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = isSelfEdge ? 0 : Math.min(28, len * 0.12);
    const pad = tolerance + bow + 6;
    if (sx < Math.min(a.proj.x, b.proj.x) - pad || sx > Math.max(a.proj.x, b.proj.x) + pad ||
        sy < Math.min(a.proj.y, b.proj.y) - pad || sy > Math.max(a.proj.y, b.proj.y) + pad) {
      return Infinity;
    }
    if (isSelfEdge) {
      const t = Math.max(0, Math.min(1, ((sx - a.proj.x) * dx + (sy - a.proj.y) * dy) / (len * len)));
      const px = a.proj.x + dx * t;
      const py = a.proj.y + dy * t;
      return Math.hypot(px - sx, py - sy);
    }

    const mx = (a.proj.x + b.proj.x) / 2;
    const my = (a.proj.y + b.proj.y) / 2;
    let nx = -dy / len, ny = dx / len;
    if (nx * (mx - W / 2) + ny * (my - H / 2) < 0) { nx = -nx; ny = -ny; }
    const cx = mx + nx * bow, cy = my + ny * bow;
    const nSamples = Math.max(8, Math.min(48, Math.round(len / 5)));
    let minD = Infinity;
    for (let i = 0; i <= nSamples; i++) {
      const t = i / nSamples;
      const it = 1 - t;
      const px = it * it * a.proj.x + 2 * it * t * cx + t * t * b.proj.x;
      const py = it * it * a.proj.y + 2 * it * t * cy + t * t * b.proj.y;
      const d = Math.hypot(px - sx, py - sy);
      if (d < minD) minD = d;
    }
    return minD;
  }

  function findEdgeHitResult(sx: number, sy: number, tolerance: number): { edge: GraphEdge; distance: number } | null {
    let bestEdge: GraphEdge | null = null;
    let bestEdgeScore = Infinity;
    for (const eg of data.edges) {
      if (selected && eg.source !== selected && eg.target !== selected) continue;
      const minD = edgeDistance(eg, sx, sy, tolerance);
      if (minD <= tolerance && minD < bestEdgeScore) {
        bestEdgeScore = minD;
        bestEdge = eg;
      }
    }
    return bestEdge ? { edge: bestEdge, distance: bestEdgeScore } : null;
  }

  function findEdgeHit(sx: number, sy: number, tolerance: number): GraphEdge | null {
    return findEdgeHitResult(sx, sy, tolerance)?.edge || null;
  }

  function selectedModeHit(sx: number, sy: number): { node: Projected | null; edge: GraphEdge | null } {
    const coreNode = findNodeCoreHit(sx, sy);
    const edgeHit = selected ? findEdgeHitResult(sx, sy, 13) : null;
    if (edgeHit) {
      if (!coreNode || edgeHit.distance <= 6) {
        return { node: null, edge: edgeHit.edge };
      }
    }
    return { node: coreNode || findNodeHit(sx, sy, true), edge: edgeHit?.edge || null };
  }

  function handlePointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    pauseAutoRotateForUser();
    setDragging(true);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const isPan = e.button === 2 || e.shiftKey || e.altKey;
    dragRef.current = { x: e.clientX, y: e.clientY, rotX, rotY, panX: pan.x, panY: pan.y, mode: isPan ? 'pan' : 'rotate' };
  }
  function handlePointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (dragging && dragRef.current) {
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      if (dragRef.current.mode === 'rotate') {
        setRotY(dragRef.current.rotY + dx * 0.005);
        const newRotX = dragRef.current.rotX + dy * 0.005;
        setRotX(Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, newRotX)));
      } else {
        setPan({ x: dragRef.current.panX + dx, y: dragRef.current.panY + dy });
      }
      return;
    }
    const now = performance.now();
    if (now - lastHoverHitTestAtRef.current < 32) return;
    lastHoverHitTestAtRef.current = now;

    const { x: sx, y: sy } = svgPoint(e);

    const selectedHit = selected ? selectedModeHit(sx, sy) : null;
    if (selectedHit?.edge && !selectedHit.node) {
      if (hover) setHover(null);
      const sameEdge = hoverEdge
        && selectedHit.edge.source === hoverEdge.source && selectedHit.edge.target === hoverEdge.target;
      if (!sameEdge) setHoverEdge({ source: selectedHit.edge.source, target: selectedHit.edge.target });
      return;
    }

    const bestNode = selectedHit?.node || findNodeHit(sx, sy, true);
    const bestNodeId = bestNode?.id || null;
    if (bestNodeId !== hover) setHover(bestNodeId);

    if (bestNodeId) {
      if (hoverEdge) setHoverEdge(null);
      return;
    }
    const bestEdge = selected && !isNearAnyNode(sx, sy, 2, true) ? findEdgeHit(sx, sy, 11) : null;
    const sameEdge = bestEdge && hoverEdge
      && bestEdge.source === hoverEdge.source && bestEdge.target === hoverEdge.target;
    if (!sameEdge) {
      setHoverEdge(bestEdge ? { source: bestEdge.source, target: bestEdge.target } : null);
    }
  }

  function handlePointerLeave() {
    lastHoverHitTestAtRef.current = 0;
    setHover(null);
    setHoverEdge(null);
  }
  function handlePointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    setDragging(false);
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      const wasClick = (dx * dx + dy * dy) < 256;
      if (wasClick) {
        const { x: sx, y: sy } = svgPoint(e);
        const hit = selected ? selectedModeHit(sx, sy) : { node: findNodeHit(sx, sy, true), edge: null };
        if (hit.edge && onSelectEdge && !hit.node) {
          onSelectEdge(hit.edge);
        } else if (hit.node) {
          onSelect(hit.node.id);
        } else if (onSelectEdge) {
          const bestEdge = selected && !isNearAnyNode(sx, sy, 2, true) ? findEdgeHit(sx, sy, 11) : null;
          if (bestEdge) onSelectEdge(bestEdge);
        }
      }
      dragRef.current = null;
    }
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  }
  function handleWheel(e: ReactWheelEvent<SVGSVGElement>) {
    e.stopPropagation();
    pauseAutoRotateForUser();
    const lineToPx = e.deltaMode === 1 ? 16 : 1;
    const px = e.deltaY * lineToPx;
    const factor = Math.exp(-px * 0.002);
    setZoom(z => Math.max(0.25, Math.min(4, z * factor)));
  }
  function resetView() {
    setRotX(-0.15); setRotY(0); setZoom(1); setPan({ x: 0, y: 0 });
    setUserInteracted(false);
  }

  const projNodes: Projected[] = useMemo(
    () => data.nodes.map(n => ({ ...n, proj: project(n, rotY, rotX, zoom, pan.x, pan.y, W, H) })),
    [data.nodes, rotY, rotX, zoom, pan.x, pan.y, H]
  );
  const projById = useMemo(() => Object.fromEntries(projNodes.map(n => [n.id, n])), [projNodes]);
  const sortedNodes = useMemo(() => [...projNodes].sort((a, b) => a.proj.depth - b.proj.depth), [projNodes]);
  const selectedEdgeKey = edgeKey(selectedEdge);
  const selectedEdgeEndpoints = useMemo(() => {
    if (!selectedEdge) return new Set<string>();
    return new Set([selectedEdge.source, selectedEdge.target]);
  }, [selectedEdge]);

  const neighbors = useMemo(() => {
    const s = new Set<string>();
    if (selected) {
      data.edges.forEach(e => {
        if (e.source === selected) s.add(e.target);
        if (e.target === selected) s.add(e.source);
      });
    }
    return s;
  }, [selected, data.edges]);

  const sortedEdges = useMemo(
    () => [...data.edges].sort((a, b) => {
      const aSelected = selectedEdgeKey && edgeKey(a) === selectedEdgeKey;
      const bSelected = selectedEdgeKey && edgeKey(b) === selectedEdgeKey;
      if (aSelected !== bSelected) return aSelected ? 1 : -1;
      return (EDGE_ORDER[a.type] ?? 0) - (EDGE_ORDER[b.type] ?? 0);
    }),
    [data.edges, selectedEdgeKey]
  );

  // ── [PATCH-3] Spotlight 派生数据 ─────────────────────────────────────────
  // 这些值仅用于额外渲染层，不修改 projNodes / sortedEdges。
  const spotMembers = useMemo<Set<string>>(() => {
    if (!spotlight) return new Set();
    if (spotlight.kind === 'circle') {
      const c = data.clusters.find(x => x.id === spotlight.clusterId);
      return new Set(c?.members || []);
    }
    return new Set();
  }, [spotlight, data.clusters]);

  // dim 比例：spotlight 时非聚焦节点/边降到很低
  const isNodeInSpot = useCallback((id: string): boolean => {
    if (!spotlight) return true;
    if (spotlight.kind === 'circle') return spotMembers.has(id);
    return false;
  }, [spotlight, spotMembers]);
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%',
      background: dark
        ? 'radial-gradient(ellipse at 50% 40%, #1B2548 0%, #0B0F22 70%, #050714 100%)'
        : 'linear-gradient(180deg, var(--et-bg) 0%, #EFE5D2 100%)',
      overflow: 'hidden',
    }}>
      {dark && <Starfield />}

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}
           style={{
             position: 'absolute', inset: 0, width: '100%', height: '100%',
             cursor: dragging ? (dragRef.current?.mode === 'pan' ? 'grabbing' : 'move') : 'grab',
             touchAction: 'none', userSelect: 'none',
           }}
           onPointerDown={handlePointerDown}
           onPointerMove={handlePointerMove}
           onPointerUp={handlePointerUp}
           onPointerCancel={handlePointerUp}
           onPointerLeave={handlePointerLeave}
           onWheel={handleWheel}
           onContextMenu={(e) => e.preventDefault()}>
        <defs>
          <radialGradient id="self-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#FFE6CF" stopOpacity="1" />
            <stop offset="60%" stopColor="#FF6B47" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#FF6B47" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="sel-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#FF6B47" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#FF6B47" stopOpacity="0" />
          </radialGradient>
          <filter id="edge-selected-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* ── [PATCH-2] Metaball gooey filter ──────────────────────────
              Bigger blur (24) than design default (14) so spherical-cap
              wedge members spread along a 150-700 px radial spoke can
              still merge into a single ribbon-shaped blob. Threshold
              alpha matrix kept aggressive (22, -10) for crisp edges.
              Drop-shadow + inner-highlight stacked outside this filter
              add the 3D feel (see render block). */}
          <filter id="metaball" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="24" result="blur" />
            <feColorMatrix in="blur"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
              result="goo" />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
          {/* Sharp inner-highlight layer — small white circles offset toward
              upper-left of each member to fake light source / 3D bump. */}
          <filter id="metaball-sharp" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="blur" />
            <feColorMatrix in="blur"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -12"
              result="goo" />
          </filter>
          {/* Soft outer shadow — gives the blob a 3D "lift off the
              background" feel. Layered behind the metaball. */}
          <filter id="metaball-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="18" result="blur" />
            <feColorMatrix in="blur"
              values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.6 0"
              result="shadow" />
          </filter>
          {/* Envelope soft-edge — light gaussian blur on the hull path so
              the boundary reads as 3D shell, not a flat polygon. */}
          <filter id="envelope-soft" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="b1" />
            <feMerge>
              <feMergeNode in="b1" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* Envelope outer glow — wider blur for the outermost layer of the
              cluster envelope, gives the wrap a "lit-up" 3D feel. */}
          <filter id="envelope-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="10" result="b1" />
            <feMerge>
              <feMergeNode in="b1" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="hot-edge" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="4" result="b1" />
            <feMerge>
              <feMergeNode in="b1" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* ───────────────────────────────────────────────────────────── */}
        </defs>

        {/* Legacy cluster halos — only renders when backend ships explicit
            centroid coords (cx/cy/cz). Current backend (_compute_friend_topology)
            does not. Default canvas stays clean; spotlight visualization is
            delegated to a design pass. */}
        {data.clusters.filter(c => typeof c.cx === 'number').map(c => {
          const center = project({ x: c.cx!, y: c.cy!, z: c.cz! }, rotY, rotX, zoom, pan.x, pan.y, W, H);
          const r = 80 + (c.n || 0) * 1.8;
          return (
            <g key={c.id}>
              <circle cx={center.x} cy={center.y} r={r * center.depth}
                fill={c.color} opacity={dark ? 0.08 : 0.06} />
              <circle cx={center.x} cy={center.y} r={r * center.depth}
                fill="none" stroke={c.color} strokeOpacity={dark ? 0.32 : 0.25} strokeWidth="0.5" strokeDasharray="3 4" />
            </g>
          );
        })}

        {/* ── [PATCH-3] Spotlight: 核心圈 hull envelope ───────────────────
            一个大的半透明 3D 包络，把整个 cluster 的成员 "刚好" 罩在里
            面。算法：取所有成员投影后 (x, y) 的凸包 → 整体往外膨胀 ~50 px
            → Catmull-Rom 转 cubic Bezier 平滑 → 三层叠加做立体感 (外发
            光 + 主体 + 内描边)。膨胀后的 hull 形状跟成员真实分布 "贴合"，
            不是硬圆，符合用户「立体的大的东西刚好包裹起来」诉求。 */}
        {spotlight?.kind === 'circle' && (() => {
          const color = clusterColor(spotlight.clusterId, data.clusters);
          const members = projNodes.filter(n => spotMembers.has(n.id));
          if (members.length < 3) return null;
          const points = members.map(n => ({ x: n.proj.x, y: n.proj.y }));
          // Inflate per-vertex by depth-aware margin so the envelope hugs
          // member spheres, not their centers
          const margin = 55;
          const innerPath = smoothEnvelopePath(points, margin);
          const outerPath = smoothEnvelopePath(points, margin + 22);
          const innerLinePath = smoothEnvelopePath(points, margin - 6);
          if (!innerPath || !outerPath) return null;
          return (
            <g style={{ pointerEvents: 'none' }}>
              {/* 外发光：大半径软描边 + 极低透明度，烘 3D 立体感 */}
              <path d={outerPath}
                fill={color} fillOpacity={0.05}
                stroke={color} strokeOpacity={0.25} strokeWidth={1}
                filter="url(#envelope-glow)" />
              {/* 主体：半透明填充 + 中等描边 */}
              <path d={innerPath}
                fill={color} fillOpacity={dark ? 0.13 : 0.10}
                stroke={color} strokeOpacity={0.7} strokeWidth={2}
                filter="url(#envelope-soft)" />
              {/* 内描边：细线，靠近成员一点点，加深「贴合」感 */}
              <path d={innerLinePath}
                fill="none"
                stroke={color} strokeOpacity={0.5} strokeWidth={1}
                strokeDasharray="3 5" />
            </g>
          );
        })()}

        {/* Bridge spotlight render permanently removed (feature deprecated). */}

        {/* Edges */}
        <g opacity={spotlight ? 0.18 : 1} style={{ filter: spotlight ? 'saturate(0.4)' : undefined }}>
          {/* [PATCH-3] 包裹一层 g，spotlight 时整体 dim+desaturate；不修改原 edge 渲染 */}
        {sortedEdges.map((e, i) => {
          const a = projById[e.source], b = projById[e.target];
          if (!a || !b) return null;
          const isSelfEdge = e.source === 'self' || e.target === 'self';
          const isHighlight = !!selected && (e.source === selected || e.target === selected);
          const isSelectedEdge = !!selectedEdgeKey && edgeKey(e) === selectedEdgeKey;
          const isHoverEdge = !!hoverEdge && hoverEdge.source === e.source && hoverEdge.target === e.target;
          const styleByType: Record<string, { stroke: string; width: number; opMul: number; dash: string | null }> = {
            private:      { stroke: '#FF6B47',                                width: 1.2, opMul: 0.5,  dash: e.dashed ? '2 4' : null },
            co_group:     { stroke: dark ? '#5A7A99' : '#1A2B4A',              width: 0.8, opMul: 0.32, dash: '1 3' },
            co_active:    { stroke: dark ? '#8FA8C4' : '#2C4670',              width: 1.4, opMul: 0.6,  dash: null },
            mention:      { stroke: dark ? '#E8B57A' : '#B98643',              width: 1.0, opMul: 0.5,  dash: null },
            dm_inferred:  { stroke: dark ? '#FF8867' : '#D85A37',              width: 1.1, opMul: 0.55, dash: '5 4' },
            mutual_reply: { stroke: dark ? '#8FA8C4' : '#2C4670',              width: 1.6, opMul: 0.7,  dash: null },
            close_pair:   { stroke: dark ? '#FF6B47' : '#E0532E',              width: 2.4, opMul: 0.95, dash: null },
            moments_cross:{ stroke: dark ? '#FFB382' : '#D17545',              width: 1.2, opMul: 0.55, dash: '6 3' },
          };
          const s = styleByType[e.type] || styleByType.co_group;
          const baseOp = e.weight * s.opMul + 0.05;
          let op = isSelectedEdge ? 1 : (isHoverEdge ? 1 : (isHighlight ? Math.min(1, baseOp * 2.5) : baseOp));
          if (selected && !isHighlight && !isHoverEdge) op = baseOp * 0.18;
          const widthMul = isSelectedEdge ? 3.4 : (isHoverEdge ? 2.4 : (isHighlight ? 1.8 : 1));
          const edgeStroke = (isSelectedEdge || isHoverEdge) ? '#FFC857' : s.stroke;
          const edgeFilter = isSelectedEdge ? 'url(#edge-selected-glow)' : undefined;
          const edgeDash = isSelectedEdge ? undefined : (s.dash || undefined);
          if (isSelfEdge) {
            const strokeWidth = (s.width * Math.max(0.4, e.weight)) * widthMul;
            return (
              <line key={i}
                x1={a.proj.x} y1={a.proj.y} x2={b.proj.x} y2={b.proj.y}
                stroke={edgeStroke}
                strokeOpacity={op}
                strokeWidth={isSelectedEdge ? Math.max(strokeWidth, 5.5) : strokeWidth}
                strokeLinecap="round"
                strokeDasharray={edgeDash}
                filter={edgeFilter} />
            );
          }
          const mx = (a.proj.x + b.proj.x) / 2;
          const my = (a.proj.y + b.proj.y) / 2;
          const dx = b.proj.x - a.proj.x;
          const dy = b.proj.y - a.proj.y;
          const len = Math.hypot(dx, dy) || 1;
          const bow = Math.min(28, len * 0.12);
          let nx = -dy / len, ny = dx / len;
          const cxFromMid = mx - W / 2, cyFromMid = my - H / 2;
          if (nx * cxFromMid + ny * cyFromMid < 0) { nx = -nx; ny = -ny; }
          const cx = mx + nx * bow, cy = my + ny * bow;
          const strokeWidth = (s.width * Math.max(0.5, e.weight)) * widthMul;
          return (
            <path key={i}
              d={`M${a.proj.x},${a.proj.y} Q${cx},${cy} ${b.proj.x},${b.proj.y}`}
              stroke={edgeStroke}
              strokeOpacity={op}
              strokeWidth={isSelectedEdge ? Math.max(strokeWidth, 5.5) : strokeWidth}
              strokeDasharray={edgeDash}
              fill="none" strokeLinecap="round"
              filter={edgeFilter} />
          );
        })}
        </g>

        {/* Self ping ripples */}
        {!selected && !selectedEdge && !spotlight && (
          <g>
            {[0, 1].map(i => (
              <circle key={i}
                cx={W / 2} cy={H / 2} r="20"
                fill="none" stroke="#FF6B47"
                strokeOpacity="0.35"
                strokeWidth="1">
                <animate
                  attributeName="r"
                  values="20;240"
                  dur="4.8s"
                  begin={`${i * 2.4}s`}
                  repeatCount="indefinite" />
                <animate
                  attributeName="stroke-opacity"
                  values="0.35;0"
                  dur="4.8s"
                  begin={`${i * 2.4}s`}
                  repeatCount="indefinite" />
              </circle>
            ))}
          </g>
        )}

        {/* Nodes */}
        {sortedNodes.map(n => {
          const r = n.size * n.proj.depth;
          const isSel = selected === n.id;
          const isHov = hover === n.id;
          const isNeighbor = neighbors.has(n.id);
          const isEdgeEndpoint = selectedEdgeEndpoints.has(n.id);
          const dim = !!selected && !isSel && !isNeighbor && !isEdgeEndpoint && !n.is_self;
          // [PATCH-3] spotlight 时非聚焦节点降到 0.18 + 去饱和
          const inSpot = isNodeInSpot(n.id);
          const spotDim = !!spotlight && !inSpot && !n.is_self;
          const op = spotDim ? 0.18 : (dim ? 0.32 : 1);
          const color = n.color || TIER_COLORS[n.tier] || '#9E9583';
          return (
            <g key={n.id}
               style={{ cursor: 'pointer', filter: spotDim ? 'saturate(0.3)' : undefined }}
               onMouseEnter={() => setHover(n.id)}
               onMouseLeave={() => setHover(null)}
               onClick={(e) => { e.stopPropagation(); onSelect(n.id); }}
               opacity={op}>
              {n.is_self && (
                <circle cx={n.proj.x} cy={n.proj.y} r={r * 4} fill="url(#self-glow)" opacity={0.7} />
              )}
              {isSel && !n.is_self && (
                <circle cx={n.proj.x} cy={n.proj.y} r={r * 3.2} fill="url(#sel-glow)" />
              )}
              {isHov && !isSel && !n.is_self && (
                <circle cx={n.proj.x} cy={n.proj.y} r={r + 6}
                  fill="none" stroke="#FFC857" strokeWidth="2" opacity="0.85" />
              )}
              {isEdgeEndpoint && !n.is_self && (
                <circle cx={n.proj.x} cy={n.proj.y} r={r + 7}
                  fill="none" stroke="#FFC857" strokeWidth="2.4" opacity="0.95" />
              )}
              <circle cx={n.proj.x} cy={n.proj.y} r={r}
                fill={color}
                stroke={dark ? 'rgba(20,24,42,0.6)' : 'rgba(255,255,255,0.7)'}
                strokeWidth={n.proj.depth * 0.6} />
              <circle cx={n.proj.x - r * 0.3} cy={n.proj.y - r * 0.3} r={r * 0.35}
                fill={dark ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.45)'} />
              {!dim && !spotDim && n.tier !== 'E' && (
                <text x={n.proj.x} y={n.proj.y + r + (n.is_self ? 18 : 14)}
                  textAnchor="middle"
                  fontFamily={n.is_self || isSel ? 'var(--et-serif)' : 'var(--et-sans)'}
                  fontSize={n.is_self ? 16 : isSel ? 14 : isHov ? 13 : 11}
                  fontWeight={n.is_self || isSel ? 700 : (n.tier === 'A' || n.tier === 'B') ? 600 : 500}
                  fill={dark ? '#F4ECDA' : '#1A2B4A'}
                  stroke={dark ? 'rgba(11,15,34,0.85)' : 'rgba(247,241,230,0.85)'}
                  strokeWidth={3}
                  paintOrder="stroke fill"
                  style={{ pointerEvents: 'none' }}>
                  {n.is_self ? '你' : displayName(n.id, n.name)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {hover && projById[hover] && hover !== selected && (
        <NodeTooltip node={projById[hover]} dark={dark} />
      )}

      <Legend dark={dark} />
      <OverviewPanel
        stats={data.stats}
        dark={dark}
        onPickCircle={onChangeSpotlight ? () => setPickerKind('circle') : undefined}      // [PATCH-4]
      />

      {/* ── [PATCH-4] Spotlight banner（顶部） ────────────────────────── */}
      {spotlight && onChangeSpotlight && (
        <SpotlightBanner
          spotlight={spotlight}
          data={data}
          dark={dark}
          onClose={() => onChangeSpotlight(null)}
        />
      )}

      {/* ── [PATCH-4] 选择列表弹层 ───────────────────────────────────── */}
      {pickerKind && onChangeSpotlight && (
        <PickerOverlay
          kind={pickerKind}
          data={data}
          dark={dark}
          onPick={(s) => { setPickerKind(null); onChangeSpotlight(s); }}
          onClose={() => setPickerKind(null)}
        />
      )}
      {/* ──────────────────────────────────────────────────────────────── */}

      <div style={{
        position: 'absolute', left: 24, top: 74, display: 'flex', alignItems: 'center', gap: 12,
        color: dark ? 'rgba(244,236,218,0.65)' : 'rgba(26,43,74,0.6)',
        fontFamily: 'var(--et-sans)', fontSize: 11,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#FF6B47',
          animation: 'mr-pulse 2.4s ease-in-out infinite' }} />
        <span>
          <b>拖拽</b>旋转 · <b>Shift+拖拽</b>平移 · <b>滚轮</b>缩放（{Math.round(zoom * 100)}%）
          ·  键盘：<b>↑↓←→</b>转 · <b>WASD</b>移 · <b>+/-</b>放缩 · <b>R</b>重置 · <b>Esc</b>取消选中
        </span>
        {userInteracted && (
          <button onClick={resetView} style={{
            all: 'unset', cursor: 'pointer',
            padding: '3px 10px', borderRadius: 999, fontSize: 10,
            background: dark ? 'rgba(255,107,71,0.2)' : 'var(--et-orange-soft)',
            color: dark ? '#FFB89A' : 'var(--et-orange-2)',
            border: `0.5px solid ${dark ? 'rgba(255,107,71,0.4)' : 'rgba(224,83,46,0.3)'}`,
          }}>重置视角</button>
        )}
      </div>

      <div style={{
        position: 'absolute', left: 24, top: 110,
        display: 'flex', flexDirection: 'column', gap: 6,
        fontFamily: 'var(--et-sans)',
      }}>
        <button onClick={() => setZoom(z => Math.min(4, z + 0.2))}
          title="放大 (键盘 +)"
          style={{
            all: 'unset', cursor: 'pointer',
            width: 36, height: 36, borderRadius: 999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, fontWeight: 300, lineHeight: 1,
            background: dark ? 'rgba(244,236,218,0.10)' : 'rgba(255,255,255,0.85)',
            color: dark ? '#F4ECDA' : 'var(--et-ink)',
            border: `0.5px solid ${dark ? 'rgba(244,236,218,0.25)' : 'rgba(26,43,74,0.18)'}`,
            boxShadow: dark ? '0 2px 6px rgba(0,0,0,0.35)' : '0 2px 6px rgba(26,43,74,0.10)',
            backdropFilter: 'blur(6px)',
          }}>+</button>
        <button onClick={() => setZoom(z => Math.max(0.25, z - 0.2))}
          title="缩小 (键盘 -)"
          style={{
            all: 'unset', cursor: 'pointer',
            width: 36, height: 36, borderRadius: 999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, fontWeight: 300, lineHeight: 1,
            background: dark ? 'rgba(244,236,218,0.10)' : 'rgba(255,255,255,0.85)',
            color: dark ? '#F4ECDA' : 'var(--et-ink)',
            border: `0.5px solid ${dark ? 'rgba(244,236,218,0.25)' : 'rgba(26,43,74,0.18)'}`,
            boxShadow: dark ? '0 2px 6px rgba(0,0,0,0.35)' : '0 2px 6px rgba(26,43,74,0.10)',
            backdropFilter: 'blur(6px)',
          }}>−</button>
      </div>
      <style>{`@keyframes mr-pulse{0%,100%{opacity:.4;transform:scale(1)}50%{opacity:1;transform:scale(1.6)}}`}</style>
    </div>
  );

}

function Starfield() {
  const stars = useMemo(() => {
    const arr: { x: number; y: number; s: number; o: number }[] = [];
    for (let i = 0; i < 72; i++) {
      arr.push({
        x: Math.random() * 100, y: Math.random() * 100,
        s: Math.random() < 0.85 ? 1 : 1.6,
        o: 0.3 + Math.random() * 0.7,
      });
    }
    return arr;
  }, []);
  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      {stars.map((s, i) => (
        <circle key={i} cx={`${s.x}%`} cy={`${s.y}%`} r={s.s} fill="white" opacity={s.o} />
      ))}
    </svg>
  );
}

function NodeTooltip({ node, dark }: { node: Projected; dark: boolean }) {
  const name = displayName(node.id, node.name);
  return (
    <div style={{
      position: 'absolute',
      left: node.proj.x + 12, top: node.proj.y - 30,
      padding: '8px 12px', borderRadius: 10,
      background: dark ? 'rgba(20,24,42,0.92)' : 'rgba(26,43,74,0.92)',
      color: '#F4ECDA',
      fontFamily: 'var(--et-sans)', fontSize: 11,
      boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
      pointerEvents: 'none',
    }}>
      <div style={{ fontWeight: 600, fontSize: 12.5 }}>{name}</div>
      <div style={{ opacity: 0.75, marginTop: 2 }}>
        {node.is_self ? '是你' : `${node.tier} 级 · ${(node.private_msgs || 0).toLocaleString()} 条私聊`}
        {!node.is_self && node.group_msgs ? ` · ${node.group_msgs.toLocaleString()} 条群聊` : ''}
      </div>
    </div>
  );
}

function Legend({ dark }: { dark: boolean }) {
  const tiers = [
    { color: '#FF6B47', label: 'A · 灵魂朋友' },
    { color: '#E8B57A', label: 'B · 常聊朋友' },
    { color: '#5A7A99', label: 'C · 一般联系' },
    { color: '#9E9583', label: 'D · 弱关系' },
    { color: '#C8BFAB', label: 'E · 沉默 / 孤岛' },
  ];
  const bg = dark ? 'rgba(20,24,42,0.7)' : 'rgba(251,246,238,0.85)';
  const border = dark ? 'rgba(244,236,218,0.14)' : 'rgba(26,43,74,0.12)';
  return (
    <div style={{
      position: 'absolute', left: 24, bottom: 24,
      padding: '14px 16px', borderRadius: 14,
      background: bg, border: `0.5px solid ${border}`,
      backdropFilter: 'blur(12px)',
    }}>
      <div style={{ fontFamily: 'var(--et-sans)', fontSize: 10, letterSpacing: '0.18em',
        color: dark ? 'rgba(244,236,218,0.55)' : 'rgba(26,43,74,0.55)', textTransform: 'uppercase' }}>
        关系层级
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {tiers.map(t => (
          <div key={t.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: t.color, boxShadow: 'inset 0 0 2px rgba(255,255,255,0.5)' }} />
            <span style={{ fontFamily: 'var(--et-sans)', fontSize: 11, color: dark ? '#F4ECDA' : '#1A2B4A' }}>{t.label}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `0.5px dashed ${border}` }}>
        <div style={{ fontFamily: 'var(--et-sans)', fontSize: 10, letterSpacing: '0.18em',
          color: dark ? 'rgba(244,236,218,0.5)' : 'rgba(26,43,74,0.5)', textTransform: 'uppercase', marginBottom: 8 }}>
          关系类型
        </div>
        {[
          { stroke: '#FF6B47', dash: null, width: 2.2, label: '你 ↔ 他（私聊）' },
          { stroke: dark ? '#FF6B47' : '#E0532E', dash: null, width: 3, label: '挚友对（朋友间最强）' },
          { stroke: dark ? '#8FA8C4' : '#2C4670', dash: null, width: 1.8, label: '群里互动密切' },
          { stroke: dark ? '#E8B57A' : '#B98643', dash: null, width: 1.4, label: '在你私聊里被一起提到' },
          { stroke: dark ? '#FF8867' : '#D85A37', dash: '4 3', width: 1.4, label: '推测他俩私下也聊（虚线）' },
          { stroke: dark ? '#5A7A99' : '#1A2B4A', dash: '1 3', width: 1, label: '共群（点状）' },
        ].map((e, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
            <svg width="22" height="6" style={{ flexShrink: 0 }}>
              <line x1="0" y1="3" x2="22" y2="3"
                stroke={e.stroke} strokeWidth={e.width}
                strokeDasharray={e.dash || undefined} strokeLinecap="round" />
            </svg>
            <span style={{ fontFamily: 'var(--et-sans)', fontSize: 11, color: dark ? '#F4ECDA' : '#1A2B4A' }}>{e.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── [PATCH-4] OverviewPanel: 两个 Stat 改为可点 ────────────────────────────
function OverviewPanel({ stats, dark, onPickCircle }: {
  stats: GraphData['stats']; dark: boolean;
  onPickCircle?: () => void;
}) {
  const bg = dark ? 'rgba(20,24,42,0.7)' : 'rgba(251,246,238,0.85)';
  const border = dark ? 'rgba(244,236,218,0.14)' : 'rgba(26,43,74,0.12)';
  const tColor = dark ? '#F4ECDA' : '#1A2B4A';
  const mute = dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.6)';
  return (
    <div style={{
      position: 'absolute', right: 24, bottom: 24,
      width: 300, padding: '18px 20px',
      background: bg, border: `0.5px solid ${border}`,
      backdropFilter: 'blur(12px)', borderRadius: 14,
    }}>
      <div style={{ fontFamily: 'var(--et-sans)', fontSize: 10, letterSpacing: '0.18em',
        color: mute, textTransform: 'uppercase' }}>关于这张图</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#FFE6CF', boxShadow: '0 0 8px #FF6B47' }} />
        <span style={{ fontFamily: 'var(--et-serif)', fontSize: 14, fontWeight: 600, color: tColor }}>
          你处在中心
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
        <Stat dark={dark} num={stats.people} label="个节点" />
        <Stat dark={dark} num={stats.ffEdges} label="朋友间互连" />
        <Stat dark={dark} num={stats.clusters} label="个核心圈" onClick={onPickCircle} />
        <Stat dark={dark} num={stats.isolates} label="个孤立点" />
      </div>
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `0.5px dashed ${border}`,
        fontFamily: 'var(--et-serif)', fontSize: 13, lineHeight: 1.6, color: tColor, fontStyle: 'italic' }}>
        “你不在场时，他们也在彼此身上留下痕迹——{stats.ffEdges} 条不经过你的连线。”
      </div>
    </div>
  );
}

function Stat({ dark, num, label, onClick }: {
  dark: boolean; num: number; label: string; onClick?: () => void;
}) {
  const clickable = !!onClick;
  return (
    <button
      onClick={onClick}
      disabled={!clickable}
      style={{
        all: 'unset',
        textAlign: 'left',
        cursor: clickable ? 'pointer' : 'default',
        padding: clickable ? '4px 6px' : 0,
        margin: clickable ? '-4px -6px' : 0,
        borderRadius: 8,
        transition: 'background 160ms ease',
      }}
      onMouseEnter={(e) => { if (clickable) e.currentTarget.style.background = dark ? 'rgba(255,200,87,0.10)' : 'rgba(255,200,87,0.18)'; }}
      onMouseLeave={(e) => { if (clickable) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ fontFamily: 'var(--et-serif)', fontSize: 24, fontWeight: 600,
        color: dark ? '#F4ECDA' : '#1A2B4A', fontVariantNumeric: 'tabular-nums', lineHeight: 1,
        textDecoration: clickable ? 'underline dotted' : 'none', textUnderlineOffset: 4,
        textDecorationColor: clickable ? (dark ? 'rgba(255,200,87,0.5)' : 'rgba(217,119,87,0.5)') : 'transparent',
      }}>
        {num.toLocaleString()}
      </div>
      <div style={{ fontFamily: 'var(--et-sans)', fontSize: 11,
        color: dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.6)', marginTop: 2,
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        {label}{clickable && <span style={{ fontSize: 9 }}>›</span>}
      </div>
    </button>
  );
}

// ── [PATCH-4] Spotlight 顶栏 ───────────────────────────────────────────────
function SpotlightBanner({ spotlight, data, dark, onClose }: {
  spotlight: Spotlight; data: GraphData; dark: boolean; onClose: () => void;
}) {
  if (!spotlight) return null;
  // Cluster labels embed the anchor's real name ("太の 这一圈 (11 人)").
  // maskText routes the anchor name through the privacy alias table that
  // PrivacyIdentityIndex pre-populates for all friends, so toggling 隐私
  // mode swaps "太の" → "朋友 XX" without us re-fetching anything.
  const c = data.clusters.find(x => x.id === spotlight.clusterId);
  const title = maskText(c?.label || '核心圈');
  const sub = `${c?.members?.length || 0} 位成员 · 你不在场时，他们仍在一起说话`;
  const bg = dark ? 'rgba(20,24,42,0.85)' : 'rgba(251,246,238,0.92)';
  const border = dark ? 'rgba(244,236,218,0.18)' : 'rgba(26,43,74,0.16)';
  return (
    <div style={{
      position: 'absolute', top: 18, left: '50%', transform: 'translateX(-50%)',
      padding: '10px 16px 10px 18px', borderRadius: 14,
      background: bg, border: `0.5px solid ${border}`, backdropFilter: 'blur(12px)',
      display: 'flex', alignItems: 'center', gap: 14,
      boxShadow: dark ? '0 12px 32px rgba(0,0,0,0.45)' : '0 12px 32px rgba(26,43,74,0.18)',
      maxWidth: 'calc(100% - 80px)',
    }}>
      <div style={{ fontFamily: 'var(--et-sans)', fontSize: 10, letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: dark ? 'rgba(244,236,218,0.55)' : 'rgba(26,43,74,0.55)' }}>
        聚焦核心圈
      </div>
      <div style={{ width: 1, height: 28, background: border }} />
      <div>
        <div style={{ fontFamily: 'var(--et-serif)', fontSize: 16, fontWeight: 700,
          color: dark ? '#F4ECDA' : '#1A2B4A' }}>{title}</div>
        <div style={{ fontFamily: 'var(--et-sans)', fontSize: 11,
          color: dark ? 'rgba(244,236,218,0.65)' : 'rgba(26,43,74,0.65)', marginTop: 2 }}>{sub}</div>
      </div>
      <button onClick={onClose} style={{
        all: 'unset', cursor: 'pointer', padding: '4px 10px', borderRadius: 999,
        fontSize: 11, marginLeft: 8,
        background: dark ? 'rgba(244,236,218,0.10)' : 'rgba(26,43,74,0.06)',
        color: dark ? '#F4ECDA' : '#1A2B4A',
      }}>退出 · Esc</button>
    </div>
  );
}

// ── [PATCH-4] 列表选择层 ───────────────────────────────────────────────────
function PickerOverlay({ kind, data, dark, onPick, onClose }: {
  kind: 'circle'; data: GraphData; dark: boolean;
  onPick: (s: Spotlight) => void; onClose: () => void;
}) {
  void kind;  // bridge 永久砍掉；保留参数形状方便日后扩展
  const items = data.clusters.map(c => ({
    id: c.id, label: c.label,
    sub: `${c.members?.length || 0} 位成员`,
    size: c.members?.length || 0,
    color: clusterColor(c.id, data.clusters),
  }));
  items.sort((a, b) => b.size - a.size);

  const bg = dark ? 'rgba(11,15,34,0.7)' : 'rgba(26,43,74,0.35)';
  const card = dark ? 'rgba(20,24,42,0.96)' : '#FBF6EE';
  const border = dark ? 'rgba(244,236,218,0.18)' : 'rgba(26,43,74,0.16)';
  return (
    <div onClick={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 200, background: bg,
      backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 480, maxHeight: '70%', display: 'flex', flexDirection: 'column',
        background: card, borderRadius: 16, border: `0.5px solid ${border}`,
        boxShadow: dark ? '0 24px 60px rgba(0,0,0,0.6)' : '0 24px 60px rgba(26,43,74,0.25)',
        overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 20px 12px',
          borderBottom: `0.5px solid ${border}`,
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: 'var(--et-sans)', fontSize: 10, letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: dark ? 'rgba(244,236,218,0.55)' : 'rgba(26,43,74,0.55)' }}>
              选一个
            </div>
            <div style={{ fontFamily: 'var(--et-serif)', fontSize: 18, fontWeight: 700,
              marginTop: 2, color: dark ? '#F4ECDA' : '#1A2B4A' }}>
              {`${items.length} 个核心圈`}
            </div>
          </div>
          <button onClick={onClose} style={{
            all: 'unset', cursor: 'pointer', fontSize: 22,
            color: dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.5)',
          }}>×</button>
        </div>
        <div style={{ padding: '12px 18px 12px 12px', overflow: 'auto', scrollbarGutter: 'stable' }}>
          {items.map(it => (
            <button key={it.id}
              onClick={() => onPick({ kind: 'circle', clusterId: it.id })}
              style={{
                all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center',
                gap: 14, padding: '10px 12px', borderRadius: 10, width: '100%',
                boxSizing: 'border-box', marginBottom: 4,
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = dark ? 'rgba(244,236,218,0.06)' : 'rgba(26,43,74,0.05)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{
                width: 14, height: 14, borderRadius: '50%', background: it.color,
                flexShrink: 0,
                boxShadow: `0 0 12px ${it.color}66`,
              }} />
              <span style={{ flex: 1, fontFamily: 'var(--et-serif)', fontSize: 15, fontWeight: 600,
                color: dark ? '#F4ECDA' : '#1A2B4A',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{maskText(it.label)}</span>
              <span style={{ fontFamily: 'var(--et-sans)', fontSize: 11,
                color: dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.55)' }}>{it.sub}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
