interface Props {
  size?: number;
  label?: string;
  sub?: string;
  color?: string;
}

export function Stamp({ size = 72, label = 'MURMUR · 2025', sub = '本地寄送 · 不上云', color = 'var(--et-orange)' }: Props) {
  return (
    <svg width={size} height={size * 1.12} viewBox="0 0 72 80" style={{ display: 'block' }}>
      <defs>
        <pattern id={`stamp-edge-${size}`} x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="2.5" fill="var(--et-paper)" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="72" height="80" fill={color} />
      <rect x="0" y="0" width="72" height="80" fill={`url(#stamp-edge-${size})`} />
      <rect x="4" y="4" width="64" height="72" fill="var(--et-paper)" stroke={color} strokeWidth="0.5" />
      <g transform="translate(36,30)" stroke={color} strokeWidth="1.2" fill="none">
        <circle r="14" />
        <path d="M-9,2 Q-3,-6 0,-6 Q3,-6 9,2 Q3,7 0,7 Q-3,7 -9,2 Z" />
        <circle r="2" fill={color} />
      </g>
      <text x="36" y="56" textAnchor="middle" fontSize="5.5" fontWeight="700" fill={color} fontFamily="var(--et-sans)" letterSpacing="0.08em">{label}</text>
      <text x="36" y="65" textAnchor="middle" fontSize="4.2" fill={color} opacity="0.7" fontFamily="var(--et-sans)" letterSpacing="0.04em">{sub}</text>
      <g transform="translate(54,14) rotate(-18)" stroke={color} strokeWidth="0.5" fill="none" opacity="0.8">
        <circle r="9" />
        <text x="0" y="1.5" textAnchor="middle" fontSize="3.2" fill={color} fontFamily="var(--et-sans)">2025</text>
      </g>
    </svg>
  );
}
