import { useEffect, useMemo, useState } from 'react';
import type { Friend } from '../../data/types';

interface MediaItem {
  md5: string;
  kind: 'img' | 'vid';
  filename: string;
  month: string;          // "2026-04"
  ts: number;             // unix sec
  from?: 'self' | string; // wxid or 'self' (optional, may not be linkable yet)
  url: string;            // /api/media/<md5>
  size?: number;
  duration?: string;      // for video
}

interface MediaGroup {
  month: string;          // "2026 · 4 月"
  items: MediaItem[];
}

interface Props {
  friend: Friend;
}

// Group media by month label
function groupByMonth(items: MediaItem[]): MediaGroup[] {
  const map = new Map<string, MediaItem[]>();
  for (const it of items) {
    const arr = map.get(it.month) || [];
    arr.push(it);
    map.set(it.month, arr);
  }
  return [...map.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([m, items]) => {
      const [y, mo] = m.split('-');
      return { month: `${y} · ${parseInt(mo, 10)} 月`, items };
    });
}

export function MediaGallery({ friend }: Props) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<MediaItem | null>(null);

  useEffect(() => {
    setLoading(true);
    // For v0, we don't have a per-friend media listing endpoint yet.
    // Read the global media-index.json (served via /api/media-list — to be added)
    // Until that exists, we fall back to mock.
    const BASE = (import.meta.env?.VITE_ETCLI_URL as string) || 'http://localhost:9100';
    fetch(BASE + '/api/friend/' + encodeURIComponent(friend.id) + '/media')
      .then(r => r.ok ? r.json() : [])
      .then(d => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [friend.id]);

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(it => (it.filename || '').toLowerCase().includes(q));
  }, [items, search]);

  const groups = useMemo(() => groupByMonth(filtered), [filtered]);
  const imgCount = items.filter(i => i.kind === 'img').length;
  const vidCount = items.filter(i => i.kind === 'vid').length;

  return (
    <div className="et-root" style={{ background: 'var(--et-bg)', minHeight: '100%' }}>
      <style>{`.media-hover-wrap:hover .media-hover { opacity: 1 !important; }`}</style>
      <div style={{ padding: '14px 28px 0', display: 'flex', alignItems: 'center', gap: 14 }}>
        <div className="et-eyebrow">相册 · 你和 {friend.name}</div>
        <div className="et-meta">
          共 <span className="et-num" style={{ color: 'var(--et-ink)', fontWeight: 600 }}>{imgCount}</span> 张图 ·{' '}
          <span className="et-num" style={{ color: 'var(--et-ink)', fontWeight: 600 }}>{vidCount}</span> 条视频
        </div>
        <div style={{
          marginLeft: 'auto',
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 12px', border: '0.5px solid var(--et-line-2)', borderRadius: 999,
          background: 'var(--et-paper)', minWidth: 260,
        }}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="var(--et-mute)" strokeWidth="1.4">
            <circle cx="5.5" cy="5.5" r="4" /><path d="M8.5 8.5l3 3" strokeLinecap="round" />
          </svg>
          <input
            placeholder="搜文件名"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ all: 'unset', flex: 1, fontSize: 12, color: 'var(--et-ink)' }}
          />
        </div>
      </div>

      {loading && <div className="et-meta" style={{ padding: 40, textAlign: 'center' }}>加载中…</div>}
      {!loading && items.length === 0 && (
        <div style={{ padding: '60px 28px', textAlign: 'center' }}>
          <div className="et-h3" style={{ color: 'var(--et-ink)', marginBottom: 8 }}>这里还没有媒体</div>
          <div className="et-meta" style={{ maxWidth: 480, margin: '0 auto' }}>
            视频和图片需要先建立索引。在终端跑：
            <code style={{ display: 'block', marginTop: 10, padding: '8px 12px', background: 'var(--et-paper-2)', borderRadius: 6, fontFamily: 'var(--et-mono)' }}>
              python3 cli/media.py index
            </code>
          </div>
        </div>
      )}

      <div style={{ padding: '18px 28px 36px', display: 'flex', flexDirection: 'column', gap: 28 }}>
        {groups.map((g) => (
          <div key={g.month}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div className="et-serif" style={{ fontSize: 16, fontWeight: 600, color: 'var(--et-ink)' }}>{g.month}</div>
              <div style={{ flex: 1, height: 1, background: 'var(--et-line-2)' }} />
              <div className="et-meta">{g.items.length} 项</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {g.items.map((it) => (
                <Thumb key={it.md5} item={it} onClick={() => setActive(it)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {active && <Lightbox item={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function Thumb({ item, onClick }: { item: MediaItem; onClick: () => void }) {
  return (
    <div
      className="media-hover-wrap"
      onClick={onClick}
      style={{
        position: 'relative', aspectRatio: '1 / 1',
        borderRadius: 8, overflow: 'hidden',
        cursor: 'pointer',
        background: 'var(--et-paper-2)',
        boxShadow: 'inset 0 0 0 0.5px rgba(26,43,74,0.10)',
      }}
    >
      {item.kind === 'img' ? (
        <img src={item.url} alt={item.filename} loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
        />
      ) : (
        <video src={item.url} muted preload="metadata"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}
      {item.kind === 'vid' && (
        <>
          <div style={{
            position: 'absolute', top: 8, left: 8,
            padding: '2px 7px', borderRadius: 4,
            background: 'rgba(20,24,42,0.7)', color: '#fff',
            fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
          }}>视频</div>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'rgba(255,255,255,0.92)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            }}>
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 2v10l9-5z" fill="#1A2B4A" /></svg>
            </div>
          </div>
        </>
      )}
      <div className="media-hover" style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(180deg, rgba(20,24,42,0) 40%, rgba(20,24,42,0.78) 100%)',
        opacity: 0, transition: 'opacity .15s ease',
        display: 'flex', alignItems: 'flex-end', padding: 8,
        color: '#fff', fontSize: 10.5, lineHeight: 1.3,
      }}>
        <div>
          {item.from && <div style={{ fontWeight: 600 }}>{item.from === 'self' ? '你发送' : `${item.from} 发送`}</div>}
          <div style={{ opacity: 0.85 }}>{new Date(item.ts * 1000).toLocaleString()}</div>
        </div>
      </div>
    </div>
  );
}

function Lightbox({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 30, cursor: 'zoom-out',
    }}>
      {item.kind === 'img'
        ? <img src={item.url} alt={item.filename} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        : <video src={item.url} controls autoPlay style={{ maxWidth: '100%', maxHeight: '100%' }} />}
      <button onClick={(e) => { e.stopPropagation(); onClose(); }} style={{
        all: 'unset', cursor: 'pointer',
        position: 'fixed', top: 20, right: 24,
        color: '#fff', fontSize: 24,
      }}>×</button>
    </div>
  );
}
