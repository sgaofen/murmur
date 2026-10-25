// 实时同步 status, shared by everything that shows it (the shell's status
// strip LEDs and Home's 数据源 module) so there is exactly one poller.
//
// GET /api/live-sync/status is cheap, has no side effects and works before
// any data is decrypted, so it doubles as the "is the local backend up?"
// probe behind the strip's LOCAL LED. It is not user activity: polling never
// keeps the app lock (cli/app_lock.py) from timing out.
import { useSyncExternalStore } from 'react';
import { getLiveSyncStatus, setLiveSync } from '../data/api';
import type { LiveSyncStatus } from '../data/api';

export interface LiveSyncState {
  status: LiveSyncStatus | null;
  /** null until the first answer; false when the backend did not answer. */
  reachable: boolean | null;
  /** A toggle request is in flight. */
  busy: boolean;
}

let state: LiveSyncState = { status: null, reachable: null, busy: false };
const listeners = new Set<() => void>();
let timer: number | undefined;
let inflight = false;

function emit(next: Partial<LiveSyncState>) {
  state = { ...state, ...next };
  listeners.forEach(l => l());
}

function schedule() {
  window.clearTimeout(timer);
  if (listeners.size === 0) return;
  const s = state.status;
  // While enabled, follow the backend's own interval (min 3 s); otherwise
  // every 30 s — and every 5 s while the backend is still coming up.
  const delay = state.reachable === false ? 5000
    : s?.enabled ? Math.max(3, s.interval) * 1000
    : 30000;
  timer = window.setTimeout(poll, delay);
}

async function poll() {
  if (inflight) return;
  inflight = true;
  try {
    const s = await getLiveSyncStatus();
    emit({ status: s, reachable: true });
  } catch {
    // Backend restarting / offline — keep the last known status.
    emit({ reachable: false });
  } finally {
    inflight = false;
    schedule();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) void poll();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.clearTimeout(timer);
  };
}

function getSnapshot(): LiveSyncState {
  return state;
}

export function useLiveSync(): LiveSyncState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Flip 实时同步 on / off. No-op while a request is in flight. */
export async function toggleLiveSync(): Promise<void> {
  const cur = state.status;
  if (!cur || state.busy) return;
  emit({ busy: true });
  try {
    const s = await setLiveSync({ enabled: !cur.enabled });
    emit({ status: s, reachable: true });
  } catch {
    // leave the state as is; the next poll resyncs
  } finally {
    emit({ busy: false });
    schedule();
  }
}

/** Ask for a fresh status now (e.g. right after 「更新数据」). */
export function pollLiveSyncNow(): void {
  void poll();
}

/** "刚刚" / "3 分钟前" for a unix-seconds timestamp. */
export function relTime(ts: number | null, nowMs: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round(nowMs / 1000 - ts));
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** HH:MM:SS for a unix-seconds timestamp, or "—". */
export function clockTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
}
