import { Avatar } from './Avatar';
import type { Friend } from '../data/types';

interface Props {
  friend: Friend;
  rank?: number;
  big?: boolean;
  onClick?: () => void;
}

export function FriendCard({ friend, rank, big = false, onClick }: Props) {
  return (
    <div onClick={onClick} style={{
      position: 'relative',
      background: 'var(--et-paper)',
      border: '0.5px solid var(--et-line-2)',
      borderRadius: 'var(--et-r)',
      padding: big ? '20px 22px' : '16px 18px',
      display: 'flex', flexDirection: 'column', gap: 12,
      boxShadow: 'var(--et-shadow-1)',
      cursor: 'pointer', transition: 'transform .15s ease, box-shadow .2s ease',
      overflow: 'hidden',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--et-shadow-2)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'var(--et-shadow-1)'; }}
    >
      {rank != null && (
        <>
          <div style={{
            position: 'absolute', top: 0, right: 0,
            width: 34, height: 34,
            background: 'var(--et-paper-2)',
            clipPath: 'polygon(100% 0, 100% 100%, 0 0)',
          }}/>
          <div style={{
            position: 'absolute', top: 4, right: 6,
            fontFamily: 'var(--et-serif)', fontWeight: 600, fontSize: 12, color: 'var(--et-mute)',
            fontVariantNumeric: 'tabular-nums',
          }}>#{String(rank).padStart(2, '0')}</div>
        </>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Avatar friend={friend} size={big ? 52 : 42} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <div className="et-h3" style={{ fontSize: big ? 20 : 17, fontWeight: 600, color: 'var(--et-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{friend.name}</div>
          </div>
          <div className="et-meta" style={{ marginTop: 2 }}>{friend.last} · {friend.knew}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div className="et-num" style={{ fontSize: big ? 28 : 22, fontWeight: 600, color: 'var(--et-ink)', lineHeight: 1 }}>
            {friend.count.toLocaleString()}
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--et-mute)', marginLeft: 4, fontFamily: 'var(--et-sans)' }}>条</span>
          </div>
          <div className="et-meta" style={{ marginTop: 4 }}>{friend.bond}</div>
        </div>
        <span className={`et-chip ${friend.tagKind || ''}`}>{friend.tag}</span>
      </div>
    </div>
  );
}
