import type { CSSProperties } from 'react';
import type { Friend } from '../data/types';

interface Props {
  friend: Friend;
  size?: number;
  ring?: boolean;
  frame?: boolean;
  style?: CSSProperties;
}

export function Avatar({ friend, size = 56, ring = false, frame = false, style }: Props) {
  const grad = `conic-gradient(from ${friend.hue}deg at 60% 40%, hsl(${friend.hue}, 72%, 64%), hsl(${(friend.hue + 40) % 360}, 80%, 56%), hsl(${(friend.hue + 80) % 360}, 68%, 50%), hsl(${friend.hue}, 72%, 64%))`;
  const fs = Math.max(11, Math.round(size * 0.36));
  return (
    <div style={{
      position: 'relative', width: size, height: size, flexShrink: 0,
      borderRadius: frame ? 6 : '50%',
      background: grad,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'rgba(255,255,255,0.95)', fontFamily: 'var(--et-serif)',
      fontWeight: 600, fontSize: fs,
      boxShadow: ring
        ? '0 0 0 2px var(--et-paper), 0 0 0 3.5px var(--et-orange)'
        : 'inset 0 -1px 2px rgba(0,0,0,0.10), 0 1px 2px rgba(26,43,74,0.10)',
      letterSpacing: '0.02em',
      ...style,
    }}>
      <span style={{ textShadow: '0 1px 2px rgba(0,0,0,0.18)' }}>{friend.glyph}</span>
    </div>
  );
}
