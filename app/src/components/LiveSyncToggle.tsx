import { useEffect, useRef, useState } from 'react';
import { clockTime, relTime, toggleLiveSync, useLiveSync } from '../utils/liveSync';
import { cx } from '../ui';
import './LiveSyncToggle.css';

/**
 * 实时同步 switch + status. Reads the shared live-sync store (one poller for
 * the whole app, see utils/liveSync.ts) and calls `onSynced` whenever the
 * backend finished a sync that changed data while this control is mounted,
 * so the page can re-fetch what it shows.
 */
export function LiveSyncToggle({ onSynced, disabled, className }: {
  onSynced?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const { status: st, busy } = useLiveSync();
  const [now, setNow] = useState(() => Date.now());
  const lastSeenSync = useRef<number | null | undefined>(undefined);
  const onSyncedRef = useRef(onSynced);
  useEffect(() => { onSyncedRef.current = onSynced; }, [onSynced]);

  // Skip the very first observation — only react to syncs that happen while
  // this control is on screen.
  const lastSync = st?.last_sync_ts ?? null;
  useEffect(() => {
    if (st == null) return;
    const prev = lastSeenSync.current;
    lastSeenSync.current = lastSync;
    if (prev !== undefined && lastSync && lastSync !== prev) onSyncedRef.current?.();
  }, [st, lastSync]);

  // Re-render the relative time label.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, []);

  if (!st) return null;

  const qqActive = st.active_platform === 'qq';
  const off = disabled || qqActive || busy;
  const on = st.enabled;

  const detail = qqActive ? '仅微信'
    : !on ? '关闭'
    : st.syncing ? '同步中…'
    : st.last_error && !st.last_sync_ts ? '未就绪'
    : st.last_sync_ts ? relTime(st.last_sync_ts, now)
    : '等待新消息';

  const title = qqActive
    ? '实时同步目前只支持微信，QQ 请继续用「更新数据」'
    : [
        on
          ? `已开启：每 ${st.interval} 秒检查一次微信数据库，有变化只重新解密变化的库`
          : '开启后，微信里收到的新消息会在几秒内自动出现（只对微信生效，默认关闭）',
        on && st.last_sync_ts
          ? `最后同步 ${clockTime(st.last_sync_ts)} · 本次新增 ${st.last_new_messages} 条消息`
          : '',
        on && st.last_check_ts ? `最近检查 ${clockTime(st.last_check_ts)}` : '',
        on && st.last_error ? `提示：${st.last_error}` : '',
      ].filter(Boolean).join('\n');

  const warn = on && !!st.last_error && !st.syncing;

  return (
    <button
      type="button"
      onClick={() => { if (!off) void toggleLiveSync(); }}
      disabled={off}
      role="switch"
      aria-checked={on}
      title={title}
      className={cx('ls-toggle', on && 'is-on', busy && 'is-busy', className)}
    >
      <span className={cx('ui-switch', on && 'is-on')} aria-hidden="true" />
      <span className="ls-toggle__label">实时同步</span>
      <span className={cx('ls-toggle__detail', warn && 'is-warn')}>{detail}</span>
    </button>
  );
}
