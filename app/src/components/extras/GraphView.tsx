/* GraphView —— 关系网页中间的 10 号模块「关系网 SOCIAL SCOPE · 3D」。
 *
 * 一张 canvas 画整个三维场景（引擎在 ../graph3d/engine.ts），React 只管外壳：模块抬头的视角键、
 * 四角读数、悬停提示和扇区弹层。视角（yaw / pitch / zoom / pan）放在 ref 里，拖动时不触发 React 渲染；
 * 每次需要重画都合并到下一帧 requestAnimationFrame，读数直接改 DOM 文本。
 *
 * 交互：拖动旋转 · Shift / 右键拖动平移 · 滚轮缩放 · 单击选中 · 单击选中者的连线看这一对 ·
 * 双击聚焦他所在的核心圈 · 悬停扇区看人数、单击扇区把里面的人展开成方框。
 * 键盘：← → 转向 · ↑ ↓ 俯仰 · + − 缩放 · W A S D 平移 · R 复位。
 * 样式：./GraphView.css（类名前缀 gxv-，节点 / 连线配色 --gx-* 也在那里，浅色铝 / 深色石墨各一套）。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import {
  DEF_VIEW, PITCH_MAX, PITCH_MIN, Scene, ZOOM_MAX, ZOOM_MIN, kfmt, summarize,
} from '../graph3d/engine';
import type { HoverTarget, Layout, Palette, SceneState, SectorInfo, Tier, View } from '../graph3d/engine';
import { cx } from '../../ui';
import './GraphView.css';

export type { Layout, SceneState, Tier } from '../graph3d/engine';

export interface NodeInfo {
  code: string;
  name: string;
  tier: Tier;
  msgs: number;
  circle: string | null;
}

export interface GraphViewProps {
  layout: Layout;
  state: SceneState;
  autoRotate: boolean;
  onAutoRotateChange: (on: boolean) => void;
  describe: (id: string) => NodeInfo | null;
  describeEdge: (a: string, b: string) => string | null;
  onSelect: (id: string | null) => void;
  onSelectEdge: (a: string, b: string) => void;
  onFocusNode: (id: string) => void;
  onToggleSector: (s: number) => void;
  /** Extra control at the start of the module head (the left-panel toggle). */
  leading?: ReactNode;
  /** A new top-N is loading; the old graph stays on screen meanwhile. */
  busy?: ReactNode;
  /** Two lines that explain the picture (hidden on short windows). */
  notes?: [ReactNode, ReactNode];
}

type Mode = 'orbit' | 'top' | 'side';
const MODES: Mode[] = ['orbit', 'top', 'side'];
const PRESET: Record<Mode, number> = { orbit: DEF_VIEW.pitch, top: 86, side: 3 };
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const norm360 = (a: number) => ((a % 360) + 360) % 360;
const fmtDeg = (a: number) => a.toFixed(1).padStart(5, '0') + '°';

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color'].includes((el as HTMLInputElement).type);
  return false;
}

function readPalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    panel: v('--surface-card'), tx: v('--text-primary'), tx2: v('--text-secondary'), tx3: v('--text-faint'),
    sig: v('--signal'), sigInk: v('--signal-ink'), onSig: v('--text-on-signal'),
    line: v('--border-subtle'), line2: v('--border-default'),
    aFill: v('--gx-a-fill'), aText: v('--gx-a-text'), aSub: v('--gx-a-sub'),
    bStroke: v('--gx-b-stroke'), bText: v('--gx-b-text'), cStroke: v('--gx-c-stroke'), cText: v('--gx-c-text'),
    eBase: v('--gx-e-base'), eFaint: v('--gx-e-faint'), eSel: v('--gx-e-sel'), eCore: v('--gx-e-core'), eHot: v('--gx-e-hot'),
    coreFill: v('--gx-core-fill'), coreStroke: v('--gx-core-stroke'), hullFill: v('--gx-hull-fill'), hullStroke: v('--gx-hull-stroke'),
    selStroke: v('--gx-sel-stroke'), selSub: v('--gx-sel-sub'), selHalo: v('--gx-sel-halo'),
    ring: v('--gx-ring'), rim: v('--gx-rim'), c2: v('--gx-c2'), c3: v('--gx-c3'),
    cloudD: v('--text-secondary'), cloudE: v('--text-faint'),
    mono: v('--font-mono') || 'monospace', sans: v('--font-sans') || 'sans-serif',
  };
}

/** Dev builds only: frame timings for the perf check (window.__murmurGraphPerf). */
interface PerfLog { render: number[]; gap: number[]; last: number; layoutMs: number; scene: Scene }
declare global { interface Window { __murmurGraphPerf?: PerfLog } }

export function GraphView(props: GraphViewProps) {
  const { layout, state, autoRotate, leading, busy, notes } = props;
  const hostRef = useRef<HTMLElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const secCardRef = useRef<HTMLDivElement>(null);
  const yawRef = useRef<HTMLSpanElement>(null);
  const pitchRef = useRef<HTMLSpanElement>(null);
  const zoomRef = useRef<HTMLSpanElement>(null);
  const chipRefs = useRef<Partial<Record<Mode, HTMLButtonElement | null>>>({});
  const obsRefs = useRef<(HTMLElement | null)[]>([]);
  const sceneRef = useRef<Scene | null>(null);
  if (!sceneRef.current) sceneRef.current = new Scene();
  const propsRef = useRef(props);
  propsRef.current = props;
  const scheduleRef = useRef<() => void>(() => {});
  const obstaclesRef = useRef<() => void>(() => {});
  const tweenRef = useRef<{ from: View; to: View; t0: number; ms: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; v: View; pan: boolean; moved: boolean; id: number } | null>(null);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const summary = useMemo(() => summarize(layout, state), [layout, state]);

  // ——— the frame loop (one rAF at a time; everything reads refs) ———
  useEffect(() => {
    const scene = sceneRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d');
    let raf = 0;
    let lastT = 0;
    let lastMode: Mode | null = null;
    let lastQuiet = false;
    const perf: PerfLog = { render: [], gap: [], last: 0, layoutMs: 0, scene };
    if (import.meta.env.DEV) window.__murmurGraphPerf = perf;

    const frame = (t: number) => {
      raf = 0;
      if (!ctx) return;
      const dt = lastT ? Math.min(64, t - lastT) : 16;
      lastT = t;
      const v = scene.view;
      const tw = tweenRef.current;
      const spinning = propsRef.current.autoRotate && !dragRef.current;
      if (tw) {
        const k = clamp((t - tw.t0) / tw.ms, 0, 1), e = 1 - Math.pow(1 - k, 3);
        const dy = (((tw.to.yaw - tw.from.yaw) % 360) + 540) % 360 - 180;
        v.yaw = norm360(tw.from.yaw + dy * e);
        v.pitch = tw.from.pitch + (tw.to.pitch - tw.from.pitch) * e;
        v.zoom = tw.from.zoom + (tw.to.zoom - tw.from.zoom) * e;
        v.panX = tw.from.panX + (tw.to.panX - tw.from.panX) * e;
        v.panY = tw.from.panY + (tw.to.panY - tw.from.panY) * e;
        if (k >= 1) tweenRef.current = null;
      } else if (spinning) {
        v.yaw = norm360(v.yaw + dt * 0.005);
      }
      const r0 = performance.now();
      const stats = scene.render(ctx);
      if (stats) {
        perf.render.push(performance.now() - r0);
        if (perf.last) perf.gap.push(t - perf.last);
        perf.last = t;
        if (perf.render.length > 900) { perf.render.splice(0, 300); perf.gap.splice(0, 300); }
      }
      if (yawRef.current) yawRef.current.textContent = fmtDeg(norm360(v.yaw));
      if (pitchRef.current) pitchRef.current.textContent = fmtDeg(v.pitch);
      if (zoomRef.current) zoomRef.current.textContent = v.zoom.toFixed(2) + '×';
      const mode: Mode = v.pitch >= 80 ? 'top' : v.pitch <= 6 ? 'side' : 'orbit';
      if (mode !== lastMode) {
        lastMode = mode;
        for (const m of MODES) {
          const el = chipRefs.current[m];
          if (el) { el.classList.toggle('is-on', m === mode); el.setAttribute('aria-pressed', String(m === mode)); }
        }
      }
      // looking down from high up, the ground disc reaches the notes: fade them out instead of printing over it
      const quiet = v.pitch > 50;
      if (quiet !== lastQuiet) { lastQuiet = quiet; obsRefs.current[2]?.classList.toggle('is-quiet', quiet); }
      if (tweenRef.current || (propsRef.current.autoRotate && !dragRef.current)) schedule();
      else lastT = 0;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };
    scheduleRef.current = schedule;

    // size + the DOM readouts the labels must keep clear of
    const wrap = wrapRef.current!;
    const measure = () => {
      const r = wrap.getBoundingClientRect();
      const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      scene.resize(W, H, dpr);
      obstacles();
      setBox(b => (b.w === W && b.h === H ? b : { w: W, h: H }));
      schedule();
    };
    const obstacles = () => {
      const r = wrap.getBoundingClientRect();
      scene.obstacles = obsRefs.current.filter((el): el is HTMLElement => !!el).map(el => {
        const b = el.getBoundingClientRect();
        return { x0: b.left - r.left - 4, y0: b.top - r.top - 4, x1: b.right - r.left + 4, y1: b.bottom - r.top + 4 };
      }).filter(o => o.x1 > o.x0 + 8 && o.y1 > o.y0 + 8);
      scene.obstacles.push({ x0: r.width - 92, y0: r.height - 92, x1: r.width - 6, y1: r.height - 14 });   // axis gizmo
      schedule();
    };
    obstaclesRef.current = obstacles;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();

    // theme: the palette lives in CSS variables; re-read when <html> switches .et-dark
    const host = hostRef.current!;
    const repaint = () => { scene.pal = readPalette(host); schedule(); };
    repaint();
    const mo = new MutationObserver(repaint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    // fonts: label widths are measured once per string — redo after the mono face arrives
    const fonts = document.fonts;
    const onFonts = () => { scene.resetMeasure(); schedule(); };
    fonts?.ready.then(onFonts).catch(() => {});
    fonts?.addEventListener?.('loadingdone', onFonts);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      fonts?.removeEventListener?.('loadingdone', onFonts);
      scheduleRef.current = () => {};
      obstaclesRef.current = () => {};
      if (import.meta.env.DEV && window.__murmurGraphPerf === perf) delete window.__murmurGraphPerf;
    };
  }, []);

  // data / state → scene
  useEffect(() => {
    sceneRef.current!.setLayout(layout);
    if (import.meta.env.DEV && window.__murmurGraphPerf) window.__murmurGraphPerf.layoutMs = layout.ms;
    scheduleRef.current();
  }, [layout]);
  useEffect(() => {
    sceneRef.current!.st = state;
    scheduleRef.current();
  }, [state]);
  useEffect(() => { if (autoRotate) scheduleRef.current(); }, [autoRotate]);
  // the readouts change size (the LOADING line, the LINKED count): keep labels clear of them
  const hasNotes = !!notes;
  useEffect(() => { obstaclesRef.current(); }, [busy, hasNotes, state.selected]);

  // ——— view helpers ———
  const tweenTo = (to: Partial<View>, ms = 320) => {
    const v = sceneRef.current!.view;
    tweenRef.current = { from: { ...v }, to: { ...v, ...to }, t0: performance.now(), ms };
    scheduleRef.current();
  };
  const setMode = (m: Mode) => tweenTo({ pitch: PRESET[m] });
  const reset = () => tweenTo({ ...DEF_VIEW });
  const resetRef = useRef(reset);
  resetRef.current = reset;

  // ——— pointer ———
  const hoverKey = (h: HoverTarget | null) => (h ? (h.kind === 'node' ? 'n' + h.id : h.kind === 'edge' ? 'e' + h.key : 's' + h.s) : '');
  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const applyHover = (h: HoverTarget | null, p: { x: number; y: number } | null) => {
    const scene = sceneRef.current!;
    if (hoverKey(h) !== hoverKey(scene.hover)) {
      scene.hover = h;
      setHover(h);
      if (!h || h.kind !== 'sector') scene.sectorAnchor = null;
      scheduleRef.current();
    }
    setTipPos(h ? p : null);
    if (canvasRef.current) canvasRef.current.style.cursor = h ? 'pointer' : '';
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.button !== 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    tweenRef.current = null;
    const p = local(e);
    dragRef.current = { x: p.x, y: p.y, v: { ...sceneRef.current!.view }, pan: e.button === 2 || e.shiftKey, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    const d = dragRef.current;
    if (d && d.id === e.pointerId) {
      const dx = p.x - d.x, dy = p.y - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) {
        d.moved = true;
        applyHover(null, null);
        if (canvasRef.current) canvasRef.current.style.cursor = d.pan ? 'move' : 'grabbing';
        if (propsRef.current.autoRotate) propsRef.current.onAutoRotateChange(false);
      }
      const v = sceneRef.current!.view;
      if (d.pan) { v.panX = d.v.panX + dx; v.panY = d.v.panY + dy; }
      else { v.yaw = norm360(d.v.yaw - dx * 0.35); v.pitch = clamp(d.v.pitch + dy * 0.3, PITCH_MIN, PITCH_MAX); }
      scheduleRef.current();
      return;
    }
    applyHover(sceneRef.current!.hitTest(p.x, p.y), p);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = '';
    if (d.moved) { scheduleRef.current(); return; }
    if (e.button !== 0) return;
    const p = local(e);
    const h = sceneRef.current!.hitTest(p.x, p.y);
    const P = propsRef.current;
    if (!h) P.onSelect(null);
    else if (h.kind === 'node') P.onSelect(h.id);
    else if (h.kind === 'edge') P.onSelectEdge(h.a, h.b);
    else P.onToggleSector(h.s);
  };
  const onDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const p = local(e);
    const h = sceneRef.current!.hitTest(p.x, p.y);
    if (h?.kind === 'node') propsRef.current.onFocusNode(h.id);
  };

  // wheel needs a non-passive listener to keep the page from scrolling
  useEffect(() => {
    const c = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      tweenRef.current = null;
      const v = sceneRef.current!.view;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      v.zoom = clamp(v.zoom * Math.exp(-dy * 0.0012), ZOOM_MIN, ZOOM_MAX);
      scheduleRef.current();
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, []);

  // keyboard: R anywhere on the page; arrows / + − / WASD while nothing else has focus
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement;
      if (isEditable(ae)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const v = sceneRef.current!.view;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === 'r') { e.preventDefault(); resetRef.current(); return; }
      const ours = !ae || ae === document.body || !!hostRef.current?.contains(ae);
      if (!ours) return;
      let used = true;
      if (k === 'ArrowLeft') v.yaw = norm360(v.yaw + 6);
      else if (k === 'ArrowRight') v.yaw = norm360(v.yaw - 6);
      else if (k === 'ArrowUp') v.pitch = clamp(v.pitch + 4, PITCH_MIN, PITCH_MAX);
      else if (k === 'ArrowDown') v.pitch = clamp(v.pitch - 4, PITCH_MIN, PITCH_MAX);
      else if (k === '+' || k === '=') v.zoom = clamp(v.zoom * 1.15, ZOOM_MIN, ZOOM_MAX);
      else if (k === '-' || k === '_') v.zoom = clamp(v.zoom / 1.15, ZOOM_MIN, ZOOM_MAX);
      else if (k === 'w') v.panY += 30;
      else if (k === 's') v.panY -= 30;
      else if (k === 'a') v.panX += 30;
      else if (k === 'd') v.panX -= 30;
      else used = false;
      if (!used) return;
      e.preventDefault();
      tweenRef.current = null;
      if (propsRef.current.autoRotate && k.startsWith('Arrow')) propsRef.current.onAutoRotateChange(false);
      scheduleRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ——— hover card / sector card ———
  let tip: ReactNode = null;
  let sector: SectorInfo | null = null;
  if (hover?.kind === 'node') {
    const n = props.describe(hover.id);
    if (n) {
      tip = (
        <>
          <div className="gxv-tip__row">
            <span className={cx('gxv-tip__code', `is-${n.tier.toLowerCase()}`)}>{n.code}</span>
            <span className="gxv-tip__name">{n.name}</span>
          </div>
          <div className="gxv-tip__meta">
            <span>TIER {n.tier}</span>
            <span>私聊 {kfmt(n.msgs)}</span>
            {n.circle && <span>{n.circle}</span>}
          </div>
          <div className="gxv-tip__hint">单击选中{n.circle ? ' · 双击聚焦这一圈' : ''}</div>
        </>
      );
    }
  } else if (hover?.kind === 'edge') {
    const label = props.describeEdge(hover.a, hover.b);
    tip = (
      <>
        <div className="gxv-tip__row"><span className="gxv-tip__name">{label}</span></div>
        <div className="gxv-tip__hint">单击看这两个人之间</div>
      </>
    );
  } else if (hover?.kind === 'sector') {
    sector = sceneRef.current.sectorInfo(hover.s, state.codes);
  }

  // the engine draws the sector card's leader line to the card's lower-left corner
  useEffect(() => {
    const scene = sceneRef.current!;
    if (hover?.kind !== 'sector' || !secCardRef.current || !wrapRef.current) {
      if (scene.sectorAnchor) { scene.sectorAnchor = null; scheduleRef.current(); }
      return;
    }
    const r = wrapRef.current.getBoundingClientRect(), b = secCardRef.current.getBoundingClientRect();
    const px = tipPos?.x ?? 0, py = tipPos?.y ?? 0;
    const L = b.left - r.left, R = b.right - r.left, T = b.top - r.top, B = b.bottom - r.top;
    const a = { x: px < L ? L : px > R ? R : L, y: py < T ? T : B };
    if (!scene.sectorAnchor || Math.abs(scene.sectorAnchor.x - a.x) > 0.5 || Math.abs(scene.sectorAnchor.y - a.y) > 0.5) {
      scene.sectorAnchor = a;
      scheduleRef.current();
    }
  });

  const tipStyle = (w: number, h: number): CSSProperties | undefined => {
    if (!tipPos) return undefined;
    let x = tipPos.x + 16, y = tipPos.y + 18;
    if (x + w > box.w - 8) x = tipPos.x - 16 - w;
    if (y + h > box.h - 8) y = tipPos.y - 18 - h;
    return { left: Math.max(8, x), top: Math.max(8, y) };
  };
  const secStyle = (): CSSProperties | undefined => {
    if (!tipPos) return undefined;
    // below the bar when there is room (that is rim and floor, not people), otherwise above it
    const w = 214, h = 132;
    let x = tipPos.x + 26, y = tipPos.y + 34;
    if (x + w > box.w - 8) x = tipPos.x - 26 - w;
    if (y + h > box.h - 8) y = tipPos.y - 34 - h;
    return { left: Math.max(8, x), top: Math.min(Math.max(8, y), box.h - h - 8) };
  };

  const v0 = sceneRef.current.view;
  return (
    <section ref={hostRef} className="ui-mod gxv" aria-label="三维关系网">
      <header className="ui-mod__head gxv__head">
        {leading}
        <span className="ui-mod__id">10</span>
        <span className="ui-mod__title">关系网</span>
        <span className="ui-mod__en gxv__en">SOCIAL SCOPE · 3D</span>
        <span className="ui-mod__right gxv__views" role="group" aria-label="视角">
          {MODES.map(m => (
            <button key={m} type="button" ref={el => { chipRefs.current[m] = el; }}
              className={cx('gxv-chip', m === 'orbit' && 'is-on')} aria-pressed={m === 'orbit'}
              title={m === 'orbit' ? '斜俯视（默认）' : m === 'top' ? '从正上方往下看' : '贴着赤道面平视'}
              onClick={() => setMode(m)}>
              {m.toUpperCase()}
            </button>
          ))}
          <button type="button" className="gxv-chip gxv-chip--reset" onClick={reset} title="回到默认视角（R）">
            RESET<kbd>R</kbd>
          </button>
        </span>
      </header>
      <div ref={wrapRef} className="gxv__wrap">
        <canvas
          ref={canvasRef}
          className="gxv__canvas"
          role="img"
          aria-label={`三维关系网：${summary.total} 人，单独画出 ${summary.shown} 人，${summary.edges} 条朋友间连线。右侧面板列出同样的信息。`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { dragRef.current = null; }}
          onPointerLeave={() => { if (!dragRef.current) applyHover(null, null); }}
          onDoubleClick={onDoubleClick}
          onContextMenu={e => e.preventDefault()}
        />
        <div className="gxv-ro gxv-ro--tl" ref={el => { obsRefs.current[0] = el; }}>
          <div>YAW<span ref={yawRef}>{fmtDeg(norm360(v0.yaw))}</span></div>
          <div>PITCH<span ref={pitchRef}>{fmtDeg(v0.pitch)}</span></div>
          <div>ZOOM<span ref={zoomRef}>{v0.zoom.toFixed(2)}×</span></div>
        </div>
        <div className="gxv-ro gxv-ro--tr" ref={el => { obsRefs.current[1] = el; }}>
          {busy && <div className="gxv-ro__busy"><span className="ui-led is-pulse" />{busy}</div>}
          <div>SHOWN<span>{summary.shown} / {summary.total}</span></div>
          <div>MERGED D·E<span>{summary.merged}</span></div>
          <div>EDGES<span>{summary.edges}{state.selected ? <> · <em>{summary.linked} LINKED</em></> : null}</span></div>
        </div>
        <div className="gxv-foot" ref={el => { obsRefs.current[2] = el; }}>
          {notes && (
            <div className="gxv-notes">
              <p>{notes[0]}</p>
              <p>{notes[1]}</p>
            </div>
          )}
          <div className="gxv-hint">
            拖动旋转<b>·</b><b>滚轮缩放</b><b>·</b><b>单击选中</b><b>·</b><b>双击聚焦核心圈</b>
            <span className="gxv-hint__x"><b>·</b><b>悬停扇区展开</b></span>
          </div>
        </div>
        <span className="ui-crop" aria-hidden="true" />
        {tip && tipPos && <div className="gxv-tip" style={tipStyle(232, 76)} role="tooltip">{tip}</div>}
        {sector && tipPos && (
          <div ref={secCardRef} className="gxv-sec" style={secStyle()} role="tooltip">
            <div className="gxv-sec__head">
              <span>扇区 {String(sector.s * 10).padStart(3, '0')}°–{String(sector.s * 10 + 10).padStart(3, '0')}°</span>
              <b>{sector.nD + sector.nE} 人</b>
            </div>
            <div className="gxv-sec__row"><i className="is-d" />D 偶尔<span>{sector.nD}</span></div>
            <div className="gxv-sec__row"><i className="is-e" />E 疏远<span>{sector.nE}</span></div>
            {sector.d.length + sector.e.length > 0 && (
              <div className="gxv-sec__codes">
                {[...sector.d, ...sector.e].slice(0, 14).join(' ')}{sector.d.length + sector.e.length > 14 ? ' …' : ''}
              </div>
            )}
            <div className="gxv-sec__hint">{state.expanded.has(sector.s) ? '单击收起' : '单击把这些人展开成方框'}</div>
          </div>
        )}
      </div>
    </section>
  );
}
