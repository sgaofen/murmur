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
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-subtle)" strokeWidth="14" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--accent)" strokeWidth="14" strokeLinecap="round"
        strokeDasharray={`${youDash} ${c - youDash}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x={size / 2} y={size / 2 - 3} textAnchor="middle" fontFamily="var(--font-serif)" fontSize="22" fontWeight="600" fill="var(--text-primary)">
        {you}<tspan fontSize="11" fill="var(--text-muted)" fontFamily="var(--font-sans)" fontWeight="500"> %</tspan>
      </text>
      <text x={size / 2} y={size / 2 + 14} textAnchor="middle" fontFamily="var(--font-sans)" fontSize={sizeLabel} fill="var(--text-muted)">{label}</text>
    </svg>
  );
}
