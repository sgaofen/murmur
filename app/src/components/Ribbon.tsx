import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  color?: string;
  tone?: 'light' | 'solid';
}

export function Ribbon({ children, color = 'var(--et-orange)', tone = 'light' }: Props) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      padding: '6px 14px 6px 26px', position: 'relative',
      background: tone === 'light' ? 'var(--et-paper)' : color,
      color: tone === 'light' ? color : '#fff',
      border: `0.5px solid ${tone === 'light' ? color : 'transparent'}`,
      fontFamily: 'var(--et-sans)', fontSize: 11, fontWeight: 600,
      letterSpacing: '0.14em', textTransform: 'uppercase',
    }}>
      <span style={{
        position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
        width: 6, height: 6, borderRadius: '50%', background: color,
        boxShadow: `0 0 0 2px ${tone === 'light' ? 'var(--et-paper)' : '#fff'}`,
      }}/>
      {children}
    </div>
  );
}
