interface Props {
  data: number[];
  months?: string[];
  w?: number;
  h?: number;
  color?: string;
}

const DEFAULT_MONTHS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

export function Sparkline({ data, months = DEFAULT_MONTHS, w = 560, h = 72, color = 'var(--et-orange)' }: Props) {
  const safeData = (data && data.length ? data : Array.from({ length: months.length || 12 }, () => 0))
    .map(v => Number.isFinite(v) && v > 0 ? v : 0);
  const safeMonths = safeData.map((_, i) => months[i] || DEFAULT_MONTHS[i % DEFAULT_MONTHS.length] || '');
  const max = Math.max(...safeData, 0);
  const bw = w / Math.max(safeData.length, 1);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      {safeData.map((v, i) => {
        const ratio = max > 0 ? v / max : 0;
        const bh = ratio * (h - 22);
        return (
          <g key={i}>
            <rect x={i * bw + bw * 0.18} y={h - bh - 12} width={bw * 0.64} height={bh} rx="2" fill={color} opacity={max > 0 ? 0.25 + 0.55 * ratio : 0.18} />
            <text x={i * bw + bw / 2} y={h - 2} textAnchor="middle" fontSize="9" fill="var(--et-mute)" fontFamily="var(--et-sans)">{safeMonths[i]}</text>
          </g>
        );
      })}
    </svg>
  );
}
