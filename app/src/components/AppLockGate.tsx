/* App lock gate — wraps the whole app (mounted in main.tsx).
 *
 * While the backend reports the lock as engaged, NOTHING below this gate is
 * mounted: no page, no effect, no request for chat data. The backend refuses
 * those requests anyway (423 APP_LOCKED), so this is not just an overlay.
 * Unlocking remounts the app from scratch.
 *
 * It keeps people at this computer from browsing Murmur; it does not encrypt
 * the decrypted databases on disk. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button } from '../ui';
import { IconEye, IconEyeOff } from '../ui/icons';
import {
  APP_LOCK_STATUS_EVENT, APP_LOCKED_EVENT, getAppLockStatus, lockApp, resetHint, unlockApp,
} from '../data/appLock';
import type { AppLockStatus } from '../data/appLock';
import './AppLock.css';

type Phase = 'probing' | 'open' | 'locked';

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

export function AppLockGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('probing');
  const [status, setStatus] = useState<AppLockStatus | null>(null);

  const apply = useCallback((s: AppLockStatus) => {
    setStatus(s);
    setPhase(s.enabled && s.locked ? 'locked' : 'open');
  }, []);

  // Boot probe. If the backend isn't up yet, show the app (its own
  // "connecting…" UI handles that) and keep asking until it answers.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const firstTry = window.setTimeout(() => { if (!cancelled) setPhase(p => (p === 'probing' ? 'open' : p)); }, 1500);
    const probe = async () => {
      try {
        const s = await getAppLockStatus();
        if (!cancelled) apply(s);
      } catch {
        if (cancelled) return;
        setPhase(p => (p === 'probing' ? 'open' : p));
        timer = window.setTimeout(probe, 1000);
      }
    };
    probe();
    return () => { cancelled = true; window.clearTimeout(timer); window.clearTimeout(firstTry); };
  }, [apply]);

  // Changes made in Settings, and 423s seen by any request.
  useEffect(() => {
    const onStatus = (e: Event) => apply((e as CustomEvent<AppLockStatus>).detail);
    const onLocked = () => { getAppLockStatus().then(apply).catch(() => setPhase('locked')); };
    window.addEventListener(APP_LOCK_STATUS_EVENT, onStatus);
    window.addEventListener(APP_LOCKED_EVENT, onLocked);
    return () => {
      window.removeEventListener(APP_LOCK_STATUS_EVENT, onStatus);
      window.removeEventListener(APP_LOCKED_EVENT, onLocked);
    };
  }, [apply]);

  // Idle auto-lock. Checked on an interval (not a single long timeout) so a
  // laptop waking from sleep past the deadline locks right away.
  const lastActive = useRef(Date.now());
  const enabled = !!status?.enabled;
  const idleMinutes = status?.idle_minutes ?? 0;
  useEffect(() => {
    if (phase !== 'open' || !enabled) return;
    lastActive.current = Date.now();
    const bump = () => { lastActive.current = Date.now(); };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, bump, { passive: true, capture: true });
    const tick = window.setInterval(() => {
      if (idleMinutes > 0 && Date.now() - lastActive.current >= idleMinutes * 60_000) {
        setPhase('locked');  // hide data first, then tell the backend
        lockApp().then(r => { if (r.lock) apply(r.lock); });
        return;
      }
      // Another window (or a restart) may have locked the backend.
      getAppLockStatus().then(s => { if (s.enabled && s.locked) apply(s); }).catch(() => {});
    }, 10_000);
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, bump, { capture: true });
      window.clearInterval(tick);
    };
  }, [phase, enabled, idleMinutes, apply]);

  if (phase === 'probing') return <div className="app-lock-blank" />;
  if (phase === 'locked') return <LockScreen initialRetry={status?.retry_after ?? 0} onUnlocked={apply} />;
  return <>{children}</>;
}

function LockScreen({ initialRetry, onUnlocked }: { initialRetry: number; onUnlocked: (s: AppLockStatus) => void }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(() => (initialRetry > 0 ? Date.now() + initialRetry * 1000 : 0));
  const [now, setNow] = useState(() => Date.now());
  const [forgot, setForgot] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  useEffect(() => {
    if (!waitUntil) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [waitUntil]);
  useEffect(() => {
    if (wait === 0) input.current?.focus();
  }, [wait]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy || wait > 0) return;
    setBusy(true);
    setError(null);
    const r = await unlockApp(password);
    setBusy(false);
    if (r.ok && r.lock) {
      onUnlocked(r.lock);
      return;
    }
    setPassword('');
    if (r.retryAfter > 0) {
      setWaitUntil(Date.now() + r.retryAfter * 1000);
      setNow(Date.now());
    }
    if (r.code === 'APP_LOCK_WRONG_PASSWORD') setError('密码不对');
    else if (r.code === 'APP_LOCK_RATE_LIMITED') setError('尝试次数过多');
    else if (r.code === 'BACKEND_UNREACHABLE') setError('连不上本地服务，稍等几秒再试');
    else setError(r.error || '解锁失败');
    input.current?.focus();
  };

  return (
    <div className="app-lock" role="dialog" aria-modal="true" aria-labelledby="app-lock-title">
      <form className="app-lock__card" onSubmit={submit}>
        <svg className="app-lock__mark" width="40" height="40" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="11" cy="11" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="11" cy="11" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="11" cy="11" r="1.6" fill="currentColor" />
        </svg>
        <h1 id="app-lock-title" className="app-lock__title">Murmur 已锁定</h1>
        <p className="app-lock__lede">输入应用锁密码继续</p>

        <div className="app-lock-field">
          <input
            ref={input}
            className="app-lock-input"
            type={show ? 'text' : 'password'}
            autoFocus
            autoComplete="current-password"
            aria-label="应用锁密码"
            placeholder="密码"
            value={password}
            disabled={wait > 0}
            onChange={e => { setPassword(e.target.value); setError(null); }}
          />
          <button type="button" className="app-lock-field__eye" onClick={() => setShow(v => !v)}
                  aria-label={show ? '隐藏密码' : '显示密码'} title={show ? '隐藏密码' : '显示密码'}>
            {show ? <IconEyeOff size={16} /> : <IconEye size={16} />}
          </button>
        </div>

        <Button type="submit" variant="primary" block loading={busy} disabled={!password || wait > 0}>
          {wait > 0 ? `${wait} 秒后可重试` : '解锁'}
        </Button>
        <div className="app-lock__error" role="status" aria-live="polite">
          {error && (wait > 0 ? `${error}，请 ${wait} 秒后再试` : error)}
        </div>

        <button type="button" className="app-lock__link" onClick={() => setForgot(v => !v)} aria-expanded={forgot}>
          忘记密码？
        </button>
        {forgot && (
          <div className="app-lock__forgot">
            完全退出 Murmur，删除 <code>{resetHint()}</code> 这个文件，再打开 Murmur，应用锁就关闭了，聊天数据不受影响。之后可以在「设置 → 应用锁」重新设置密码。
          </div>
        )}
      </form>
      <p className="app-lock__note">
        应用锁用来防止别人打开 Murmur 翻看，不会加密电脑上已经解密的聊天数据。
      </p>
    </div>
  );
}
