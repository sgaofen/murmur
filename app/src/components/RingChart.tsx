interface Props {
  you: number;
  size?: number;
  label?: string;
  sizeLabel?: number;
}

export function RingChart({ you = 52, size = 140, label = '你说得更多', sizeLabel = 12 }: Props) {
  const r = (size - 22) / 2;
  const c = 2 * Math.PI * r;
  const youDash = (you / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(26,43,74,0.10)" strokeWidth="14" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--et-orange)" strokeWidth="14" strokeLinecap="round"
        strokeDasharray={`${youDash} ${c - youDash}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x={size / 2} y={size / 2 - 3} textAnchor="middle" fontFamily="var(--et-serif)" fontSize="22" fontWeight="600" fill="var(--et-ink)">
        {you}<tspan fontSize="11" fill="var(--et-mute)" fontFamily="var(--et-sans)" fontWeight="500"> %</tspan>
      </text>
      <text x={size / 2} y={size / 2 + 14} textAnchor="middle" fontFamily="var(--et-sans)" fontSize={sizeLabel} fill="var(--et-mute)">{label}</text>
    </svg>
  );
}
