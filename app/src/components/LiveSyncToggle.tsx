import { useCallback, useEffect, useRef, useState } from 'react';
import { getLiveSyncStatus, setLiveSync } from '../data/api';
import type { LiveSyncStatus } from '../data/api';

function relTime(ts: number | null, now: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round(now / 1000 - ts));
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function clock(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * Small switch + status next to「更新数据」. Polls /api/live-sync/status and
 * calls `onSynced` whenever the backend finished a sync that changed data,
 * so the page can re-fetch summary / friend list.
 */
export function LiveSyncToggle({ onSynced, disabled }: { onSynced?: () => void; disabled?: boolean }) {
  const [st, setSt] = useState<LiveSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastSeenSync = useRef<number | null | undefined>(undefined);
  const onSyncedRef = useRef(onSynced);
  useEffect(() => { onSyncedRef.current = onSynced; }, [onSynced]);

  const apply = useCallback((s: LiveSyncStatus) => {
    setSt(s);
    const prev = lastSeenSync.current;
    lastSeenSync.current = s.last_sync_ts;
    // Skip the very first observation — only react to syncs that happen
    // while this page is open.
    if (prev !== undefined && s.last_sync_ts && s.last_sync_ts !== prev) {
      onSyncedRef.current?.();
    }
  }, []);

  // Poll: every interval while enabled (min 3 s), otherwise every 30 s.
  const enabled = !!st?.enabled;
  const interval = st?.interval ?? 3;
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const loop = async () => {
      try {
        const s = await getLiveSyncStatus();
        if (!cancelled) apply(s);
      } catch {
        // Backend restarting / offline — keep the last known state.
      }
      if (!cancelled) {
        timer = window.setTimeout(loop, enabled ? Math.max(3, interval) * 1000 : 30000);
      }
    };
    loop();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [apply, enabled, interval]);

  // Re-render the relative time label.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, []);

  if (!st) return null;

  const qqActive = st.active_platform === 'qq';
  const off = disabled || qqActive || busy;
  const on = st.enabled;

  async function toggle() {
    if (off || !st) return;
    setBusy(true);
    try {
      apply(await setLiveSync({ enabled: !st.enabled }));
    } catch {
      // leave state as is; next poll will resync
    } finally {
      setBusy(false);
    }
  }

  let detail = '';
  if (on) {
    if (st.syncing) detail = '同步中…';
    else if (st.last_error && !st.last_sync_ts) detail = '未就绪';
    else if (st.last_sync_ts) detail = relTime(st.last_sync_ts, now);
    else detail = '等待新消息';
  }

  const title = qqActive
    ? '实时同步目前只支持微信，QQ 请继续用「更新数据」'
    : [
        on
          ? `已开启：每 ${st.interval} 秒检查一次微信数据库，有变化只重新解密变化的库`
          : '开启后，微信里收到的新消息会在几秒内自动出现（只对微信生效，默认关闭）',
        on && st.last_sync_ts
          ? `最后同步 ${clock(st.last_sync_ts)} · 本次新增 ${st.last_new_messages} 条消息`
          : '',
        on && st.last_check_ts ? `最近检查 ${clock(st.last_check_ts)}` : '',
        on && st.last_error ? `提示：${st.last_error}` : '',
      ].filter(Boolean).join('\n');

  return (
    <button
      onClick={toggle}
      disabled={off}
      role="switch"
      aria-checked={on}
      title={title}
      style={{
        all: 'unset', cursor: off ? (busy ? 'wait' : 'not-allowed') : 'pointer',
        // `all: unset` also resets flex-shrink, so in a crowded top bar the
        // label would wrap one character per line; keep it on one line.
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap',
        opacity: qqActive || disabled ? 0.5 : 1,
        color: on ? 'var(--text-secondary)' : 'var(--text-muted)', fontSize: 12, fontWeight: 500,
      }}>
      <span aria-hidden style={{
        position: 'relative', width: 24, height: 14, borderRadius: 999, flexShrink: 0,
        background: on ? 'var(--accent)' : 'var(--border-default)',
        transition: 'background .15s ease',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: on ? 12 : 2, width: 10, height: 10,
          borderRadius: 999, background: 'var(--surface-card)', boxShadow: 'var(--shadow-sm)',
          transition: 'left .15s ease',
        }} />
      </span>
      <span>实时同步</span>
      {detail && (
        <span className="et-meta" style={{
          fontSize: 11, color: st.last_error && !st.syncing ? 'var(--warning-fg)' : 'var(--text-faint)',
        }}>· {detail}</span>
      )}
    </button>
  );
}
