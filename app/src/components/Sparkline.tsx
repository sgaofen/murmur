import { useEffect, useRef, useState } from 'react';

interface Props {
  data: number[];
  months?: string[];
  w?: number;
  h?: number;
  color?: string;
}

const DEFAULT_MONTHS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

export function Sparkline({ data, months = DEFAULT_MONTHS, w = 560, h = 72, color = 'var(--accent)' }: Props) {
  // `w` is the widest the chart gets. It is drawn at the width its card
  // actually has (measured), so on a phone the bars get narrower instead of
  // the whole picture — month labels included — being scaled down.
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState<number | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const cw = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (cw > 0) setBoxW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = Math.max(120, Math.min(w, boxW ?? w));

  const safeData = (data && data.length ? data : Array.from({ length: months.length || 12 }, () => 0))
    .map(v => Number.isFinite(v) && v > 0 ? v : 0);
  const safeMonths = safeData.map((_, i) => months[i] || DEFAULT_MONTHS[i % DEFAULT_MONTHS.length] || '');
  const max = Math.max(...safeData, 0);
  const bw = width / Math.max(safeData.length, 1);
  return (
    <div ref={boxRef} style={{ width: '100%', maxWidth: w }}>
      <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`}
        style={{ display: 'block', width: '100%', height: 'auto' }}>
        {safeData.map((v, i) => {
          const ratio = max > 0 ? v / max : 0;
          const bh = ratio * (h - 22);
          return (
            <g key={i}>
              <rect x={i * bw + bw * 0.18} y={h - bh - 12} width={bw * 0.64} height={bh} rx="2" fill={color} opacity={max > 0 ? 0.25 + 0.55 * ratio : 0.18} />
              <text x={i * bw + bw / 2} y={h - 2} textAnchor="middle" fontSize="9" fill="var(--text-muted)" fontFamily="var(--font-sans)">{safeMonths[i]}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
