import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Friend } from '../../data/types';
import { errorCode, getFriendMedia, indexMedia } from '../../data/api';
import { lookupError } from '../../data/errorCatalog';
import { useTaskCenter } from '../../components/extras/TaskCenter';
import { displayName, maskText } from '../../utils/privacy';
import { usePrivacy } from '../../utils/usePrivacy';
import { Button, EmptyState, ErrorState, Module, Skeleton } from '../../ui';
import { IconClose, IconPlay, IconSearch, IconSparkle } from '../../ui/icons';
import './MediaGallery.css';

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
  key: string;            // "2026-04"
  month: string;          // "2026-04" (mono header)
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
    .map(([m, items]) => ({ key: m, month: m || '未知月份', items }));
}

export function MediaGallery({ friend }: Props) {
  void usePrivacy();
  const taskCenter = useTaskCenter();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed list request is not "no media yet" — it gets its own error state.
  const [loadError, setLoadError] = useState<unknown>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<MediaItem | null>(null);

  const loadMedia = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    getFriendMedia<MediaItem>(friend.id)
      .then(d => setItems(d))
      .catch(e => { setItems([]); setLoadError(e); })
      .finally(() => setLoading(false));
  }, [friend.id]);

  useEffect(() => {
    loadMedia();
  }, [loadMedia]);

  async function handleIndexMedia() {
    setIndexing(true);
    setIndexError(null);
    const taskId = taskCenter.addTask({
      icon: 'index',
      name: '正在建立媒体索引',
      sub: '扫描微信图片和视频缓存…',
      pct: 10,
      status: 'run',
    });
    const timer = window.setInterval(() => {
      taskCenter.updateTask(taskId, { pct: Math.min(90, 25 + Math.floor(Math.random() * 60)) });
    }, 700);
    try {
      const r = await indexMedia();
      window.clearInterval(timer);
      if (!r.ok) throw new Error(r.error || r.details || '媒体索引失败');
      taskCenter.updateTask(taskId, {
        pct: 100,
        status: 'done',
        sub: `已索引 ${r.indexed ?? r.total ?? 0} 项`,
      });
      loadMedia();
    } catch (e: any) {
      window.clearInterval(timer);
      const msg = e?.message || String(e);
      setIndexError(msg);
      taskCenter.updateTask(taskId, { pct: 100, status: 'error', sub: msg });
    } finally {
      setIndexing(false);
    }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(it => (it.filename || '').toLowerCase().includes(q));
  }, [items, search]);

  const groups = useMemo(() => groupByMonth(filtered), [filtered]);
  const imgCount = items.filter(i => i.kind === 'img').length;
  const vidCount = items.filter(i => i.kind === 'vid').length;

  const name = displayName(friend.id, friend.name);
  const right = items.length > 0 ? (
    <label className="ui-field media-search">
      <span className="ui-field__prompt" aria-hidden="true"><IconSearch size={12} /></span>
      <input
        type="search"
        placeholder="搜文件名"
        aria-label="搜文件名"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
    </label>
  ) : undefined;

  return (
    <div className="media-page">
      <div className="media-rack ui-rack">
        <Module
          title="相册"
          en={loading ? 'MEDIA' : `MEDIA · ${imgCount} IMG · ${vidCount} VID`}
          right={right}
          className="media-mod"
        >
          <div className="media-sub">
            <span className="ui-label">WITH<b>你和 {name}</b></span>
            {!loading && items.length > 0 && (
              <span className="media-sub__count">
                共 <b>{imgCount}</b> 张图 · <b>{vidCount}</b> 条视频
                {search.trim() && <> · 匹配 <b>{filtered.length}</b></>}
              </span>
            )}
          </div>

          {loading && (
            <div className="media-body" aria-busy="true" aria-label="正在加载相册">
              <div className="media-grid">
                {Array.from({ length: 18 }, (_, i) => <Skeleton key={i} height="auto" radius={0} className="media-skel" />)}
              </div>
            </div>
          )}
          {!loading && loadError != null && (
            <div className="media-empty">
              <MediaLoadError error={loadError} onRetry={loadMedia} />
            </div>
          )}
          {!loading && loadError == null && items.length === 0 && (
            <div className="media-empty">
              <EmptyState
                icon={<IconSparkle size={22} />}
                label="NO MEDIA"
                title="这里还没有媒体"
                description="视频和图片需要先建立本地索引，只扫描这台电脑上的微信缓存。"
                actions={(
                  <Button variant="primary" loading={indexing} onClick={handleIndexMedia}>
                    {indexing ? '正在建立索引…' : '一键建立媒体索引'}
                  </Button>
                )}
              />
              {indexError && (
                <div className="media-empty__error" role="alert">
                  {maskText(indexError)}
                </div>
              )}
            </div>
          )}
          {!loading && items.length > 0 && groups.length === 0 && (
            <div className="media-empty">
              <EmptyState
                icon={<IconSearch size={22} />}
                label="NO MATCH"
                title={`没有文件名包含「${maskText(search)}」的媒体`}
                actions={<Button size="sm" onClick={() => setSearch('')}>清除搜索</Button>}
              />
            </div>
          )}

          {!loading && groups.length > 0 && (
            // One contact sheet: each month opens with a slate cell, then its frames.
            <div className="media-body">
              <div className="media-grid">
                {groups.map((g) => [
                  <h3 key={`slate-${g.key}`} className="media-slate">
                    <span className="media-slate__m">{g.month}</span>
                    <span className="media-slate__n">{g.items.length} 项</span>
                  </h3>,
                  ...g.items.map((it) => (
                    <Thumb key={it.md5} item={it} onClick={() => setActive(it)} />
                  )),
                ])}
              </div>
            </div>
          )}
        </Module>
      </div>

      {active && <Lightbox item={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function MediaLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = errorCode(error);
  const entry = lookupError(code);
  const raw = error instanceof Error ? error.message : String(error);
  return (
    <ErrorState
      code={code ?? undefined}
      title={entry?.title ?? '相册没能加载'}
      reason={entry?.reason ?? '读取这个聊天的图片和视频列表时，本地服务返回了错误。媒体索引本身没有丢。'}
      fixes={entry ? [entry.fix] : ['点「重试」再读一次', '还不行就到「设置」里复制诊断信息反馈给我们']}
      onRetry={onRetry}
      details={raw ? <pre>{maskText(raw)}</pre> : undefined}
    />
  );
}

function Thumb({ item, onClick }: { item: MediaItem; onClick: () => void }) {
  void usePrivacy();
  const senderLabel = item.from
    ? item.from === 'self' ? '你' : displayName(item.from, item.from)
    : '';
  // ts is 0 when the index only knows the month (no message link yet).
  const when = item.ts ? new Date(item.ts * 1000).toLocaleString() : item.month;

  return (
    <button type="button" className="media-thumb" onClick={onClick}
      aria-label={`${item.kind === 'vid' ? '视频' : '图片'} · ${senderLabel ? senderLabel + ' 发送 · ' : ''}${when}`}>
      {item.kind === 'img' ? (
        <img src={item.url} alt="" loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).classList.add('is-broken'); }}
        />
      ) : (
        <video src={item.url} muted preload="metadata" />
      )}
      {item.kind === 'vid' && (
        <>
          <span className="media-thumb__badge">视频</span>
          <span className="media-thumb__play" aria-hidden="true"><span><IconPlay size={14} /></span></span>
        </>
      )}
      <span className="media-thumb__info" aria-hidden="true">
        <span>
          {senderLabel && <b>{senderLabel} 发送</b>}
          <span>{when}</span>
        </span>
      </span>
    </button>
  );
}

function Lightbox({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="media-lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label="查看媒体">
      {item.kind === 'img'
        ? <img src={item.url} alt={maskText(item.filename)} />
        : <video src={item.url} controls autoPlay onClick={(e) => e.stopPropagation()} />}
      <button type="button" className="media-lightbox__close" aria-label="关闭" title="关闭"
        onClick={(e) => { e.stopPropagation(); onClose(); }}>
        <IconClose size={16} />
      </button>
    </div>
  );
}
