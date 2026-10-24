import type { CSSProperties } from 'react';
import type { Friend } from '../data/types';
import { useDisplayName } from '../utils/usePrivacy';

interface Props {
  friend: Friend;
  size?: number;
  ring?: boolean;
  frame?: boolean;
  style?: CSSProperties;
}

export function Avatar({ friend, size = 56, ring = false, frame = false, style }: Props) {
  const name = useDisplayName(friend.id, friend.name);
  const grad = `conic-gradient(from ${friend.hue}deg at 60% 40%, hsl(${friend.hue}, 72%, 64%), hsl(${(friend.hue + 40) % 360}, 80%, 56%), hsl(${(friend.hue + 80) % 360}, 68%, 50%), hsl(${friend.hue}, 72%, 64%))`;
  const fs = Math.max(11, Math.round(size * 0.36));
  const glyph = name === '你' ? '你' : name.replace(/^朋友\s*/, '').slice(0, 2) || friend.glyph;
  return (
    <div style={{
      position: 'relative', width: size, height: size, flexShrink: 0,
      borderRadius: frame ? 6 : '50%',
      background: grad,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--media-on-scrim)', fontFamily: 'var(--et-serif)',
      fontWeight: 600, fontSize: fs,
      boxShadow: ring
        ? '0 0 0 2px var(--surface-card), 0 0 0 3.5px var(--accent)'
        : 'var(--shadow-sm)',
      letterSpacing: '0.02em',
      ...style,
    }}>
      <span style={{ textShadow: '0 1px 2px var(--media-scrim)' }}>{glyph}</span>
    </div>
  );
}
