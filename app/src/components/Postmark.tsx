interface Props {
  size?: number;
  text1?: string;
  text2?: string;
  date?: string;
  color?: string;
}

export function Postmark({ size = 92, text1 = 'MURMUR 微语', text2 = '本地寄送 · 不上云', date = '2026·04·30', color = 'var(--et-postmark)' }: Props) {
  const r1 = size / 2 - 1;
  const r2 = r1 - 6;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
      <defs>
        <path id={`pm-arc-${size}`} d={`M ${size/2} ${size/2-r1+3} A ${r1-3} ${r1-3} 0 1 1 ${size/2-0.01} ${size/2-r1+3}`} fill="none"/>
        <path id={`pm-arc2-${size}`} d={`M ${size/2-r2+3} ${size/2} A ${r2-3} ${r2-3} 0 0 0 ${size/2+r2-3} ${size/2}`} fill="none"/>
      </defs>
      <circle cx={size/2} cy={size/2} r={r1} fill="none" stroke={color} strokeWidth="1.2" opacity="0.9" />
      <circle cx={size/2} cy={size/2} r={r2} fill="none" stroke={color} strokeWidth="0.6" opacity="0.7" />
      <text fontSize={size*0.10} fontFamily="var(--et-sans)" fontWeight="700" fill={color} letterSpacing="0.2em">
        <textPath href={`#pm-arc-${size}`} startOffset="50%" textAnchor="middle">{text1}</textPath>
      </text>
      <text fontSize={size*0.075} fontFamily="var(--et-sans)" fill={color} letterSpacing="0.1em" opacity="0.85">
        <textPath href={`#pm-arc2-${size}`} startOffset="50%" textAnchor="middle">{text2}</textPath>
      </text>
      <text x={size/2} y={size/2+2} textAnchor="middle" fontSize={size*0.13} fontFamily="var(--et-serif)" fontWeight="600" fill={color}>{date}</text>
      <line x1={size*0.28} y1={size/2+8} x2={size*0.72} y2={size/2+8} stroke={color} strokeWidth="0.6" opacity="0.6" />
    </svg>
  );
}
