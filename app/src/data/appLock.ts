// App lock — client for /api/app-lock/* (cli/app_lock.py).
//
// The backend owns the lock: while it is locked every other endpoint answers
// 423 APP_LOCKED, so the lock screen is not just an overlay. It is protection
// against someone else opening Murmur on this computer, NOT encryption: the
// decrypted databases on disk stay as readable as before.
import { API_BASE } from './api';

export interface AppLockStatus {
  enabled: boolean;
  locked: boolean;
  /** 0 = never auto-lock. */
  idle_minutes: number;
  idle_choices: number[];
  /** Seconds until another unlock attempt is accepted (0 = now). */
  retry_after: number;
  failed_attempts: number;
  /** Always false for now — see docs/app-lock.md. */
  touch_id: boolean;
  /** Where the hash lives; deleting it is the documented reset. */
  lock_file: string;
}

export interface AppLockResult {
  ok: boolean;
  status: number;
  code: string | null;
  error: string | null;
  retryAfter: number;
  lock: AppLockStatus | null;
}

/** Fired with the fresh status whenever this tab changes the lock. */
export const APP_LOCK_STATUS_EVENT = 'murmur:app-lock-status';
/** Fired by api.ts when any request comes back 423 APP_LOCKED. */
export const APP_LOCKED_EVENT = 'murmur:app-locked';

export function publishLockStatus(s: AppLockStatus): void {
  window.dispatchEvent(new CustomEvent<AppLockStatus>(APP_LOCK_STATUS_EVENT, { detail: s }));
}

/** Throws only when the backend is unreachable. */
export async function getAppLockStatus(): Promise<AppLockStatus> {
  const res = await fetch(API_BASE + '/api/app-lock/status');
  if (!res.ok) throw new Error(`app-lock status: ${res.status}`);
  return res.json();
}

async function post(path: string, body: object): Promise<AppLockResult> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false, status: 0, code: 'BACKEND_UNREACHABLE',
      error: e instanceof Error ? e.message : String(e), retryAfter: 0, lock: null,
    };
  }
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  const ok = res.ok && data.ok !== false;
  const result: AppLockResult = {
    ok,
    status: res.status,
    code: typeof data.code === 'string' ? data.code : null,
    error: typeof data.error === 'string' ? data.error : (ok ? null : `HTTP ${res.status}`),
    retryAfter: typeof data.retry_after === 'number' ? data.retry_after : 0,
    lock: ok ? (data as unknown as AppLockStatus) : null,
  };
  if (result.lock) publishLockStatus(result.lock);
  return result;
}

export const unlockApp = (password: string) => post('/api/app-lock/unlock', { password });
export const lockApp = () => post('/api/app-lock/lock', {});
export const setAppLockPassword = (password: string, currentPassword?: string, idleMinutes?: number) =>
  post('/api/app-lock/set', { password, current_password: currentPassword, idle_minutes: idleMinutes });
export const disableAppLock = (currentPassword: string) =>
  post('/api/app-lock/disable', { current_password: currentPassword });
export const setAppLockIdle = (idleMinutes: number) => post('/api/app-lock/idle', { idle_minutes: idleMinutes });

export const IDLE_LABEL: Record<number, string> = { 5: '5 分钟', 15: '15 分钟', 30: '30 分钟', 0: '从不' };

/** Where to delete the lock file, phrased for the user's OS. */
export function resetHint(lockFile?: string | null): string {
  if (lockFile) return lockFile;
  return /Windows/i.test(navigator.userAgent)
    ? '%USERPROFILE%\\.murmur\\app_lock.json'
    : '~/.murmur/app_lock.json';
}
