interface Props {
  size?: number;
}

export function ScanFrame({ size = 220 }: Props) {
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <style>{`
        @keyframes et-scan { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
        @keyframes et-pulse { 0%,100%{opacity:.4;transform:scale(.96)} 50%{opacity:.85;transform:scale(1)} }
      `}</style>
      <svg width={size} height={size} viewBox="0 0 220 220" style={{ position: 'absolute', inset: 0 }}>
        {[40, 70, 100].map((r, i) => (
          <circle key={i} cx="110" cy="110" r={r} fill="none" stroke="var(--et-line-2)" strokeWidth="0.6" strokeDasharray="2 4" />
        ))}
        {Array.from({ length: 36 }).map((_, i) => {
          const a = (i / 36) * Math.PI * 2;
          const x1 = 110 + Math.cos(a) * 96, y1 = 110 + Math.sin(a) * 96;
          const x2 = 110 + Math.cos(a) * 102, y2 = 110 + Math.sin(a) * 102;
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--et-line-2)" strokeWidth="0.5" />;
        })}
        {[
          [60, 72, 1.2], [150, 55, 0.9], [170, 140, 1.4], [80, 160, 1.0], [112, 95, 1.6],
          [135, 110, 1.1], [52, 118, 0.8], [160, 90, 1.0], [90, 130, 0.9],
        ].map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={(r as number) * 1.4} fill="var(--et-orange)" opacity={0.85}
            style={{ animation: `et-pulse 2s ease-in-out ${i * 0.18}s infinite` }} />
        ))}
        <g transform="translate(110,110)">
          <path d="M0,5 C-6,-2 -10,-2 -10,-6 C-10,-10 -6,-12 -3,-10 C-1.5,-9 0,-7 0,-7 C0,-7 1.5,-9 3,-10 C6,-12 10,-10 10,-6 C10,-2 6,-2 0,5 Z" fill="var(--et-orange)" opacity="0.9" />
        </g>
      </svg>
      <div style={{ position: 'absolute', inset: 0, animation: 'et-scan 5s linear infinite' }}>
        <svg width={size} height={size} viewBox="0 0 220 220">
          <defs>
            <linearGradient id={`scan-fade-${size}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--et-orange)" stopOpacity="0" />
              <stop offset="100%" stopColor="var(--et-orange)" stopOpacity="0.5" />
            </linearGradient>
          </defs>
          <path d="M110,110 L110,12 A98,98 0 0 1 200,84 Z" fill={`url(#scan-fade-${size})`} />
        </svg>
      </div>
    </div>
  );
}
