interface Props {
  data: number[];
  months?: string[];
  w?: number;
  h?: number;
  color?: string;
}

const DEFAULT_MONTHS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

export function Sparkline({ data, months = DEFAULT_MONTHS, w = 560, h = 72, color = 'var(--et-orange)' }: Props) {
  const max = Math.max(...data);
  const bw = w / data.length;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      {data.map((v, i) => {
        const bh = (v / max) * (h - 22);
        return (
          <g key={i}>
            <rect x={i * bw + bw * 0.18} y={h - bh - 12} width={bw * 0.64} height={bh} rx="2" fill={color} opacity={0.25 + 0.55 * (v / max)} />
            <text x={i * bw + bw / 2} y={h - 2} textAnchor="middle" fontSize="9" fill="var(--et-mute)" fontFamily="var(--et-sans)">{months[i]}</text>
          </g>
        );
      })}
    </svg>
  );
}
