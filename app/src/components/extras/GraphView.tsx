// 3D 关系网络 — 拖拽旋转 / 滚轮缩放 / 投影。底层 SVG，无外部 force-graph 依赖。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { displayName } from '../../utils/privacy';
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
  // Visual positioning fields are optional — we currently only render cluster
  // membership via per-node halos (clusterColor) + names in OverviewPanel,
  // not as 3D bubbles. Backend's _compute_friend_topology emits id/label only.
  cx?: number; cy?: number; cz?: number;
  color?: string;
  n?: number;
  members?: string[];
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

const TIER_COLORS: Record<string, string> = {
  self: '#FFE6CF',
  A: '#FF6B47',
  B: '#E8B57A',
  C: '#5A7A99',
  D: '#9E9583',
  E: '#C8BFAB',
};

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
}

/** Map a cluster id (e.g., "core_3") to a stable pastel HSL color. Different
 *  clusters get visually distinct hues so members can be grouped at a glance,
 *  but lightness is high to keep the rings calm next to tier colors. */
function clusterColor(clusterId: string | null | undefined): string {
  if (!clusterId) return 'rgba(0,0,0,0)';
  // Hash the id to a hue. djb2 is fine — short ids, no collisions in practice.
  let h = 5381;
  for (let i = 0; i < clusterId.length; i++) {
    h = ((h * 33) ^ clusterId.charCodeAt(i)) | 0;
  }
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 65%, 70%)`;
}

/** Pure HSL hue from a cluster id — handy for generating stroke/fill variants
 *  without re-hashing. Returns just the integer 0-359. */
function clusterHue(clusterId: string): number {
  let h = 5381;
  for (let i = 0; i < clusterId.length; i++) {
    h = ((h * 33) ^ clusterId.charCodeAt(i)) | 0;
  }
  return ((h % 360) + 360) % 360;
}

/** Andrew's monotone-chain convex hull. Returns hull vertices in CCW order.
 *  For ≤ 2 points, returns the input as-is. */
function convexHull(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  if (pts.length < 3) return pts.slice();
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
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
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Build a smooth, organic, closed wrap-path around `points`. Inflates each
 *  hull vertex outward from the centroid by `margin` so nodes sit comfortably
 *  inside, then connects vertices with cubic Beziers (Catmull-Rom equiv,
 *  uniform tension 1/6). Result reads as an irregular blob, not a circle —
 *  that's the user's "立体建模连线把关系网包裹起来" requirement. */
function smoothHullPath(points: { x: number; y: number; r?: number }[], margin = 28): string {
  const hull = convexHull(points);
  if (hull.length < 3) return '';
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  const expanded = hull.map((p, i) => {
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    // Per-vertex margin — node radius (if known) plus the requested margin.
    // Picking original points to match indices: hull might reorder, so use the
    // original point's r when available (defaults to 0).
    const rNode = (points[i] && points[i].r) ? points[i].r! : 0;
    const m = margin + rNode * 0.5;
    return { x: p.x + (dx / d) * m, y: p.y + (dy / d) * m };
  });
  const n = expanded.length;
  const path: string[] = [];
  path.push(`M${expanded[0].x.toFixed(1)},${expanded[0].y.toFixed(1)}`);
  for (let i = 0; i < n; i++) {
    const p0 = expanded[(i - 1 + n) % n];
    const p1 = expanded[i];
    const p2 = expanded[(i + 1) % n];
    const p3 = expanded[(i + 2) % n];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    path.push(`C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`);
  }
  path.push('Z');
  return path.join(' ');
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
  // Spotlight: explicit "show me ONLY this cluster" / "show me how this bridge
  // connects everyone" mode. Triggered from OverviewPanel chips. Dims everything
  // outside the spotlight set; doesn't change selection.
  const [spotlight, setSpotlight] = useState<{ kind: 'cluster' | 'bridge'; id: string } | null>(null);

  const pauseAutoRotateForUser = useCallback(() => {
    setUserInteracted(true);
    onAutoRotatePause?.();
  }, [onAutoRotatePause]);

  useEffect(() => {
    setUserInteracted(false);
    setDragging(false);
    dragRef.current = null;
  }, [autoRotateResumeSignal]);

  // Auto-rotate (paused when user interacts OR a panel is open — so the edge/node
  // they clicked doesn't drift away while reading the side panel)
  useEffect(() => {
    if (!autoRotate || userInteracted || selected || selectedEdge) return;
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
  }, [autoRotate, userInteracted, selected, selectedEdge]);

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
          onSelect(null);
          if (onSelectEdge) onSelectEdge(null);
          setSpotlight(null);
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
  }, [onSelect, onSelectEdge, pauseAutoRotateForUser]);

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
    // Once a person is selected, labels should not steal edge clicks. The
    // user is usually inspecting the selected person's relation lines here.
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
      // In selected mode, favor relation lines unless the pointer is clearly on
      // the side of a node rather than the line. This makes line endpoints much
      // easier to click while keeping small circle targets usable.
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
    // Right-click or shift = pan; else rotate
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
    // Not dragging — update node/edge hover preview so user can SEE what their
    // click would select before committing. Hit-tested in screen coords using
    // the same logic as handlePointerUp.
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

    // 1. Try nearest node first in full-graph mode. In selected mode this uses
    // tighter node cores so relation lines do not get swallowed by halos/labels.
    const bestNode = selectedHit?.node || findNodeHit(sx, sy, true);
    const bestNodeId = bestNode?.id || null;
    if (bestNodeId !== hover) setHover(bestNodeId);

    // 2. If no node hovered, find nearest edge.
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
      // Detect "click vs drag": <5px movement = click → resolve which node was clicked
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      const wasClick = (dx * dx + dy * dy) < 256;
      if (wasClick) {
        // Find nearest visible node within hit radius (manually — pointer capture
        // breaks the natural click bubbling, so we resolve the hit ourselves)
        const { x: sx, y: sy } = svgPoint(e);
        const hit = selected ? selectedModeHit(sx, sy) : { node: findNodeHit(sx, sy, true), edge: null };
        if (hit.edge && onSelectEdge && !hit.node) {
          onSelectEdge(hit.edge);
        } else if (hit.node) {
          onSelect(hit.node.id);
        } else if (onSelectEdge) {
          // No node hit — try to resolve nearest visible edge.
          const bestEdge = selected && !isNearAnyNode(sx, sy, 2, true) ? findEdgeHit(sx, sy, 11) : null;
          if (bestEdge) onSelectEdge(bestEdge);
          // Else: keep current selection (user clicked empty space — don't auto-close).
          // To dismiss, user must press Esc or click the panel's × button.
        }
        // Same: clicking empty space when no node hit doesn't close. Stickier UX.
      }
      dragRef.current = null;
    }
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  }
  function handleWheel(e: ReactWheelEvent<SVGSVGElement>) {
    // Windows trackpad pinch sends ctrl+wheel; two-finger scroll sends plain
    // wheel with small deltaY; mouse wheel sends large deltaY in line units.
    // Normalize all three to a smooth exponential zoom.
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

  /** When spotlighting a bridge, return up to 2 clusters (by member count of
   *  bridge's neighbors that fall in each cluster) — these are the groups the
   *  bridge actually stitches together. `<2` clusters means the bridge is
   *  internal to one cluster (uncommon for true betweenness winners). */
  const bridgeClusters = useMemo(() => {
    if (!spotlight || spotlight.kind !== 'bridge') return [] as string[];
    const counts = new Map<string, number>();
    data.edges.forEach(e => {
      const otherId = e.source === spotlight.id ? e.target
                  : e.target === spotlight.id ? e.source : null;
      if (!otherId || otherId === 'self') return;
      const other = data.nodes.find(n => n.id === otherId);
      if (!other?.cluster) return;
      counts.set(other.cluster, (counts.get(other.cluster) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([cid]) => cid);
  }, [spotlight, data]);

  /** Hulls to render: array of { clusterId, members[] } for each focal cluster.
   *  - cluster spotlight: 1 hull (the spotlit cluster)
   *  - bridge spotlight: 2 hulls (top 2 clusters bridge connects) */
  const spotlightHulls = useMemo(() => {
    if (!spotlight) return [] as { id: string; memberIds: string[] }[];
    const clustersToWrap = spotlight.kind === 'cluster'
      ? [spotlight.id]
      : bridgeClusters;
    return clustersToWrap.map(cid => ({
      id: cid,
      memberIds: data.nodes
        .filter(n => n.cluster === cid && !n.is_self)
        .map(n => n.id),
    })).filter(h => h.memberIds.length >= 3);
  }, [spotlight, bridgeClusters, data.nodes]);

  // Spotlight set: which nodes should be considered "in focus". Kept separate
  // from `neighbors` (which is selection-driven) so a user can pin a cluster
  // OR a bridge while still selecting+inspecting individual nodes inside it.
  const spotlightSet = useMemo(() => {
    if (!spotlight) return null;
    const s = new Set<string>(['self']);  // always keep self in view
    if (spotlight.kind === 'cluster') {
      const c = data.clusters.find(c => c.id === spotlight.id);
      if (c) (c.members || []).forEach(m => s.add(m));
      data.nodes.forEach(n => { if (n.cluster === spotlight.id) s.add(n.id); });
    } else {
      // bridge: include the bridge + ALL members of the top-2 clusters it
      // connects (so the "wrap two groups" visual lands on real cluster
      // members, not just the bridge's direct neighbors).
      s.add(spotlight.id);
      const bridgeClusterSet = new Set(bridgeClusters);
      data.nodes.forEach(n => {
        if (n.cluster && bridgeClusterSet.has(n.cluster)) s.add(n.id);
      });
      // Also keep direct neighbors that don't fall in those clusters — they
      // shouldn't drop to invisible just because they're outliers.
      data.edges.forEach(e => {
        if (e.source === spotlight.id) s.add(e.target);
        if (e.target === spotlight.id) s.add(e.source);
      });
    }
    return s;
  }, [spotlight, bridgeClusters, data.clusters, data.nodes, data.edges]);

  const sortedEdges = useMemo(
    () => [...data.edges].sort((a, b) => {
      const aSelected = selectedEdgeKey && edgeKey(a) === selectedEdgeKey;
      const bSelected = selectedEdgeKey && edgeKey(b) === selectedEdgeKey;
      if (aSelected !== bSelected) return aSelected ? 1 : -1;
      return (EDGE_ORDER[a.type] ?? 0) - (EDGE_ORDER[b.type] ?? 0);
    }),
    [data.edges, selectedEdgeKey]
  );

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
        </defs>

        {/* Legacy cluster halos (cx/cy/cz path) — only renders for backend
            payloads that ship explicit centroids. Current backend uses the
            spotlight-hull path below instead. */}
        {data.clusters.filter(c => typeof c.cx === 'number').map(c => {
          const center = project({ x: c.cx!, y: c.cy!, z: c.cz! }, rotY, rotX, zoom, pan.x, pan.y, W, H);
          const r = 80 + (c.n || 0) * 1.8;
          return (
            <g key={c.id}>
              <circle cx={center.x} cy={center.y} r={r * center.depth}
                fill={c.color} opacity={dark ? 0.08 : 0.06} />
              <circle cx={center.x} cy={center.y} r={r * center.depth}
                fill="none" stroke={c.color} strokeOpacity={dark ? 0.32 : 0.25} strokeWidth="0.5" strokeDasharray="3 4" />
              <text x={center.x} y={center.y - r * center.depth - 6}
                fontFamily="var(--et-sans)" fontSize="10.5" fontWeight="600"
                letterSpacing="0.18em" textAnchor="middle"
                fill={dark ? 'rgba(244,236,218,0.55)' : 'rgba(26,43,74,0.55)'}>
                {c.label.length > 14 ? c.label.slice(0, 14) + '…' : c.label}
              </text>
            </g>
          );
        })}

        {/* Spotlight hulls — organic blob wrap around the focal cluster(s). For
            cluster spotlight: 1 hull. For bridge spotlight: 2 hulls (the two
            groups the bridge stitches together) so the user sees what's being
            bridged. Path is convex-hull → expanded outward → smoothed via
            Catmull-Rom Bezier. Drawn behind edges so connections still read on top. */}
        {spotlight && spotlightHulls.map(hull => {
          const pts = hull.memberIds
            .map(id => projById[id])
            .filter(Boolean)
            .map(n => ({ x: n.proj.x, y: n.proj.y, r: n.size * n.proj.depth }));
          if (pts.length < 3) return null;
          const d = smoothHullPath(pts, 32);
          if (!d) return null;
          const hue = clusterHue(hull.id);
          return (
            <g key={`hull-${hull.id}`}>
              {/* Outer halo glow — softer, larger */}
              <path d={smoothHullPath(pts, 56)}
                fill={`hsl(${hue}, 65%, 70%)`} fillOpacity={0.04}
                stroke="none" />
              {/* Inner blob — fill + dashed wireframe stroke */}
              <path d={d}
                fill={`hsl(${hue}, 65%, 70%)`}
                fillOpacity={dark ? 0.16 : 0.12}
                stroke={`hsl(${hue}, 70%, 55%)`}
                strokeOpacity={0.85}
                strokeWidth={1.5}
                strokeDasharray="6 4"
                style={{ filter: `drop-shadow(0 0 6px hsla(${hue}, 70%, 55%, 0.4))` }} />
            </g>
          );
        })}

        {/* Bridge connecting beams — when spotlighting a bridge, draw thick
            animated lines from the bridge to ONE representative member of
            each connected cluster (the one with the strongest edge). Reads
            literally as "this person bridges THESE two groups". */}
        {spotlight?.kind === 'bridge' && bridgeClusters.length >= 1 && (() => {
          const bridgeNode = projById[spotlight.id];
          if (!bridgeNode) return null;
          // For each connected cluster, find the bridge's strongest edge into it
          const beams: { tx: number; ty: number; hue: number; weight: number }[] = [];
          bridgeClusters.forEach(cid => {
            const cands = data.edges
              .map(e => {
                const otherId = e.source === spotlight.id ? e.target
                            : e.target === spotlight.id ? e.source : null;
                if (!otherId || otherId === 'self') return null;
                const other = data.nodes.find(n => n.id === otherId);
                if (other?.cluster !== cid) return null;
                return { otherId, weight: e.weight };
              })
              .filter((x): x is { otherId: string; weight: number } => !!x)
              .sort((a, b) => b.weight - a.weight);
            if (!cands.length) return;
            const top = cands[0];
            const otherProj = projById[top.otherId];
            if (!otherProj) return;
            beams.push({ tx: otherProj.proj.x, ty: otherProj.proj.y, hue: clusterHue(cid), weight: top.weight });
          });
          return (
            <>
              {beams.map((b, i) => (
                <line key={`beam-${i}`}
                  x1={bridgeNode.proj.x} y1={bridgeNode.proj.y}
                  x2={b.tx} y2={b.ty}
                  stroke={`hsl(${b.hue}, 75%, 60%)`}
                  strokeWidth={3.5}
                  strokeOpacity={0.85}
                  strokeLinecap="round"
                  strokeDasharray="8 5">
                  <animate attributeName="stroke-dashoffset"
                    from="0" to="-26" dur="1.4s" repeatCount="indefinite" />
                </line>
              ))}
            </>
          );
        })()}

        {/* Edges */}
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
          // When a node is selected, drop non-related edges to a faint hint level
          // (was previously hidden entirely — user couldn't hover to compare).
          // Hovered edges always pop above the dim layer.
          let op = isSelectedEdge ? 1 : (isHoverEdge ? 1 : (isHighlight ? Math.min(1, baseOp * 2.5) : baseOp));
          if (selected && !isHighlight && !isHoverEdge) op = baseOp * 0.18;
          // Spotlight: when active, only edges whose BOTH endpoints are in
          // the spotlight set keep full visibility. Bridge spotlight thus
          // shows the bridge's actual connecting lines popping; cluster
          // spotlight shows the inter-cluster traffic.
          if (spotlightSet) {
            const inSpot = spotlightSet.has(e.source) && spotlightSet.has(e.target);
            if (!inSpot && !isSelectedEdge && !isHoverEdge) op = Math.min(op, 0.06);
          }
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
          // Curve for friend-friend edges
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

        {/* Self ping ripples */}
        {!selected && !selectedEdge && (
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
          const inSpotlight = !spotlightSet || spotlightSet.has(n.id);
          const dim = (!!selected && !isSel && !isNeighbor && !isEdgeEndpoint && !n.is_self)
                   || (!!spotlightSet && !inSpotlight && !n.is_self);
          const op = dim ? 0.32 : 1;
          const color = n.color || TIER_COLORS[n.tier] || '#9E9583';
          return (
            <g key={n.id}
               style={{ cursor: 'pointer' }}
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
              {/* Cluster halo — soft pastel ring colored by cluster id, sits BEHIND
                  the tier-color node fill so it reads as group membership without
                  competing with tier color. */}
              {n.cluster && !n.is_self && (
                <circle cx={n.proj.x} cy={n.proj.y} r={r + 8}
                  fill="none" stroke={clusterColor(n.cluster)}
                  strokeWidth="3.5" opacity="0.5" />
              )}
              {/* Bridge marker — bold dashed orange ring + animated pulse glow.
                  Three nodes max (top-betweenness), so making them unmistakable
                  is fine; it's the structural backbone of the user's network. */}
              {n.bridge && !n.is_self && (
                <>
                  <circle cx={n.proj.x} cy={n.proj.y} r={r + 14}
                    fill="none" stroke="#FF6B47" strokeWidth="2.5"
                    strokeDasharray="4 3" opacity="0.95">
                    <animate attributeName="r"
                      values={`${r + 12};${r + 18};${r + 12}`}
                      dur="2.4s" repeatCount="indefinite" />
                    <animate attributeName="opacity"
                      values="0.95;0.4;0.95" dur="2.4s" repeatCount="indefinite" />
                  </circle>
                </>
              )}
              <circle cx={n.proj.x} cy={n.proj.y} r={r}
                fill={color}
                stroke={dark ? 'rgba(20,24,42,0.6)' : 'rgba(255,255,255,0.7)'}
                strokeWidth={n.proj.depth * 0.6} />
              <circle cx={n.proj.x - r * 0.3} cy={n.proj.y - r * 0.3} r={r * 0.35}
                fill={dark ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.45)'} />
              {/* Show label for everyone except E-tier weakest (and only if not dimmed away) */}
              {!dim && n.tier !== 'E' && (
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
              {/* "桥" pill below the name for bridge nodes — extra-explicit so the
                  user can spot the structural backbone at a glance. */}
              {n.bridge && !n.is_self && !dim && (
                <text x={n.proj.x} y={n.proj.y + r + 28}
                  textAnchor="middle"
                  fontFamily="var(--et-sans)"
                  fontSize={10} fontWeight={700}
                  fill="#FF6B47"
                  stroke={dark ? 'rgba(11,15,34,0.85)' : 'rgba(247,241,230,0.95)'}
                  strokeWidth={3} paintOrder="stroke fill"
                  style={{ pointerEvents: 'none' }}>
                  ✦ 桥梁
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
      <OverviewPanel data={data} dark={dark}
                     spotlight={spotlight}
                     onSpotlight={setSpotlight}
                     onSelect={onSelect} />

      {/* Spotlight banner — shown only when a cluster or bridge is pinned.
          Provides explicit "exit spotlight" affordance + names what's in focus. */}
      {spotlight && (
        <div style={{
          position: 'absolute', left: '50%', top: 24,
          transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '8px 14px 8px 16px', borderRadius: 999,
          background: dark ? 'rgba(20,24,42,0.85)' : 'rgba(251,246,238,0.95)',
          border: `0.5px solid ${dark ? 'rgba(244,236,218,0.2)' : 'rgba(26,43,74,0.18)'}`,
          boxShadow: '0 4px 16px rgba(20,24,42,0.18)',
          backdropFilter: 'blur(10px)',
          fontFamily: 'var(--et-sans)',
          color: dark ? '#F4ECDA' : '#1A2B4A',
          zIndex: 50,
        }}>
          {spotlight.kind === 'cluster' ? (
            <>
              <span style={{ width: 10, height: 10, borderRadius: '50%',
                background: clusterColor(spotlight.id) }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                聚焦：{(data.clusters.find(c => c.id === spotlight.id)?.label) || spotlight.id}
              </span>
            </>
          ) : (
            <>
              <span style={{ color: '#FF6B47', fontSize: 14 }}>✦</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                聚焦桥梁：{displayName(spotlight.id,
                  data.nodes.find(n => n.id === spotlight.id)?.name || spotlight.id)}
                <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, opacity: 0.7 }}>
                  （{(spotlightSet?.size || 1) - 1} 人通过 ta 相连）
                </span>
              </span>
            </>
          )}
          <button onClick={() => setSpotlight(null)}
            title="退出聚焦 (Esc)"
            style={{
              all: 'unset', cursor: 'pointer',
              width: 22, height: 22, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, color: dark ? '#F4ECDA' : '#1A2B4A',
              opacity: 0.5,
            }}>×</button>
        </div>
      )}

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

      {/* Zoom controls — visible buttons for trackpad / no-wheel users.
          Top-LEFT below the hint bar so they don't collide with:
            - PrivacyToggle (fixed bottom-right, z=9999)
            - OverviewPanel (absolute bottom-right within graph)
            - the 460px side panel that slides in from the right on selection. */}
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

function OverviewPanel({
  data, dark, spotlight, onSpotlight, onSelect,
}: {
  data: GraphData; dark: boolean;
  spotlight: { kind: 'cluster' | 'bridge'; id: string } | null;
  onSpotlight: (s: { kind: 'cluster' | 'bridge'; id: string } | null) => void;
  onSelect: (id: string | null) => void;
}) {
  const stats = data.stats;
  // Anchor of a cluster = highest-degree (combined_score) member. Used to
  // auto-select someone when the user opens a cluster, so the side panel
  // pops with that person's profile.
  const clusterAnchor = (clusterId: string): string | null => {
    const candidates = data.nodes.filter(n => n.cluster === clusterId && !n.is_self);
    if (!candidates.length) return null;
    return candidates.reduce((best, n) =>
      ((n.combined_score || 0) > (best.combined_score || 0)) ? n : best
    ).id;
  };
  const bg = dark ? 'rgba(20,24,42,0.7)' : 'rgba(251,246,238,0.85)';
  const border = dark ? 'rgba(244,236,218,0.14)' : 'rgba(26,43,74,0.12)';
  const tColor = dark ? '#F4ECDA' : '#1A2B4A';
  const mute = dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.6)';
  const bridgeNodes = data.nodes.filter(n => n.bridge && !n.is_self);
  // Show top 3 clusters (largest first) by member count
  const topClusters = (data.clusters || []).slice(0, 3);
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
        <Stat dark={dark} num={stats.clusters} label="个核心圈" />
        <Stat dark={dark} num={stats.bridges} label="个桥梁人物" />
      </div>
      {topClusters.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontFamily: 'var(--et-sans)', fontSize: 10, letterSpacing: '0.1em',
            color: mute, marginBottom: 6 }}>
            核心圈（点击聚焦，最大 {Math.min(3, topClusters.length)} 个）
          </div>
          {topClusters.map(c => {
            const isActive = spotlight?.kind === 'cluster' && spotlight.id === c.id;
            return (
              <button key={c.id}
                onClick={() => {
                  if (isActive) {
                    onSpotlight(null);
                  } else {
                    onSpotlight({ kind: 'cluster', id: c.id });
                    const anchor = clusterAnchor(c.id);
                    if (anchor) onSelect(anchor);
                  }
                }}
                style={{
                  all: 'unset', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3,
                  width: '100%',
                  padding: '4px 6px', borderRadius: 6,
                  background: isActive
                    ? (dark ? 'rgba(255,107,71,0.18)' : 'rgba(255,107,71,0.10)')
                    : 'transparent',
                  border: isActive
                    ? '0.5px solid rgba(255,107,71,0.45)'
                    : '0.5px solid transparent',
                  fontFamily: 'var(--et-sans)', fontSize: 11, color: tColor,
                }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%',
                  background: clusterColor(c.id), flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayName(c.id, c.label || c.id)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {bridgeNodes.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontFamily: 'var(--et-sans)', fontSize: 10, letterSpacing: '0.1em',
            color: mute, marginBottom: 6 }}>桥梁人物（点击看 ta 怎么连）</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {bridgeNodes.map(n => {
              const isActive = spotlight?.kind === 'bridge' && spotlight.id === n.id;
              return (
                <button key={n.id}
                  onClick={() => {
                    if (isActive) {
                      onSpotlight(null);
                    } else {
                      onSpotlight({ kind: 'bridge', id: n.id });
                      onSelect(n.id);
                    }
                  }}
                  style={{
                    all: 'unset', cursor: 'pointer',
                    fontFamily: 'var(--et-sans)', fontSize: 10, fontWeight: 600,
                    color: '#FF6B47', padding: '2px 8px', borderRadius: 999,
                    border: '0.5px solid rgba(255,107,71,0.4)',
                    background: isActive
                      ? (dark ? 'rgba(255,107,71,0.30)' : 'rgba(255,107,71,0.20)')
                      : (dark ? 'rgba(255,107,71,0.15)' : 'rgba(255,107,71,0.08)'),
                    boxShadow: isActive ? '0 0 0 1.5px rgba(255,107,71,0.6)' : 'none',
                  }}>
                  ✦ {displayName(n.id, n.name)}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `0.5px dashed ${border}`,
        fontFamily: 'var(--et-serif)', fontSize: 13, lineHeight: 1.6, color: tColor, fontStyle: 'italic' }}>
        “你不在场时，他们也在彼此身上留下痕迹——{stats.ffEdges} 条不经过你的连线。”
      </div>
    </div>
  );
}

function Stat({ dark, num, label }: { dark: boolean; num: number; label: string }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--et-serif)', fontSize: 24, fontWeight: 600,
        color: dark ? '#F4ECDA' : '#1A2B4A', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
        {num.toLocaleString()}
      </div>
      <div style={{ fontFamily: 'var(--et-sans)', fontSize: 11,
        color: dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.6)', marginTop: 2 }}>{label}</div>
    </div>
  );
}
