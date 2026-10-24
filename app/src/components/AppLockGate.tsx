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
import { Button, Module } from '../ui';
import { IconEye, IconEyeOff } from '../ui/icons';
import {
  APP_LOCK_REQUEST_EVENT, APP_LOCK_STATUS_EVENT, APP_LOCKED_EVENT, getAppLockStatus, lockApp, reportActivity,
  resetHint, unlockApp,
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

  // Lock locally first (data disappears immediately), then make sure the
  // backend agrees. If that request fails, keep retrying while the lock
  // screen says so: until the backend is locked, a reload would show data.
  // (The backend also locks itself after idle_minutes without activity, so
  // an idle lock holds even if every retry fails.)
  const [lockSync, setLockSync] = useState<'ok' | 'pending' | 'failed'>('ok');
  const syncing = lockSync !== 'ok';
  const engageLock = useCallback(() => {
    setPhase('locked');
    setLockSync('pending');
  }, []);
  useEffect(() => {
    if (phase !== 'locked' || !syncing) return;
    let cancelled = false;
    let timer = 0;
    const attempt = async () => {
      const r = await lockApp();
      if (cancelled) return;
      if (r.ok && r.lock) {
        setLockSync('ok');
        apply(r.lock);
        return;
      }
      setLockSync('failed');
      timer = window.setTimeout(attempt, 2000);
    };
    attempt();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [phase, syncing, apply]);

  // Changes made in Settings, 423s seen by any request, and "lock now".
  useEffect(() => {
    const onStatus = (e: Event) => {
      const s = (e as CustomEvent<AppLockStatus>).detail;
      setStatus(s);
      // A stale "unlocked" status must not undo a lock still being synced.
      setPhase(p => (s.enabled && s.locked ? 'locked' : p === 'locked' && s.enabled ? p : 'open'));
    };
    const onLocked = () => {
      setPhase('locked');
      getAppLockStatus().then(s => { setStatus(s); if (!s.locked) setLockSync('pending'); }).catch(() => {});
    };
    window.addEventListener(APP_LOCK_STATUS_EVENT, onStatus);
    window.addEventListener(APP_LOCKED_EVENT, onLocked);
    window.addEventListener(APP_LOCK_REQUEST_EVENT, engageLock);
    return () => {
      window.removeEventListener(APP_LOCK_STATUS_EVENT, onStatus);
      window.removeEventListener(APP_LOCKED_EVENT, onLocked);
      window.removeEventListener(APP_LOCK_REQUEST_EVENT, engageLock);
    };
  }, [engageLock]);

  // Idle auto-lock (the backend enforces the same timeout on its own).
  // Checked on an interval and, crucially, the moment the window becomes
  // visible or focused again — after sleep or un-minimizing, the lock goes
  // up before the next interval tick could.
  const lastActive = useRef(Date.now());
  const lastBeat = useRef(0);
  const enabled = !!status?.enabled;
  const idleMinutes = status?.idle_minutes ?? 0;
  useEffect(() => {
    if (phase !== 'open' || !enabled) return;
    lastActive.current = Date.now();
    lastBeat.current = 0;
    const idleExpired = () => idleMinutes > 0 && Date.now() - lastActive.current >= idleMinutes * 60_000;
    const beat = () => {
      // Tell the backend someone is here, at most every 30 s.
      if (Date.now() - lastBeat.current < 30_000) return;
      lastBeat.current = Date.now();
      reportActivity().then(r => { if (r.code === 'APP_LOCKED') window.dispatchEvent(new Event(APP_LOCKED_EVENT)); });
    };
    const check = () => {
      if (idleExpired()) { engageLock(); return; }
      // The backend may have locked on its own (idle, another window, restart).
      getAppLockStatus().then(s => { if (s.enabled && s.locked) { setStatus(s); setPhase('locked'); } }).catch(() => {});
    };
    const bump = () => {
      // Input after the deadline (e.g. the first keypress after wake) must
      // not count as activity before the lock has gone up.
      if (idleExpired()) { engageLock(); return; }
      lastActive.current = Date.now();
      beat();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    beat();
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, bump, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    const tick = window.setInterval(check, 10_000);
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, bump, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
      window.removeEventListener('pageshow', check);
      window.clearInterval(tick);
    };
  }, [phase, enabled, idleMinutes, engageLock]);

  if (phase === 'probing') return <div className="app-lock-blank" />;
  if (phase === 'locked') {
    return (
      <LockScreen
        initialRetry={status?.retry_after ?? 0}
        syncFailed={lockSync === 'failed'}
        onUnlocked={(s) => { setLockSync('ok'); apply(s); }}
      />
    );
  }
  return <>{children}</>;
}

function LockScreen({ initialRetry, syncFailed, onUnlocked }: {
  initialRetry: number;
  syncFailed: boolean;
  onUnlocked: (s: AppLockStatus) => void;
}) {
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
      <header className="app-lock__strip">
        <span className="app-lock__brand">MURMUR<span>微语</span></span>
        <span className="app-lock__crumb">LOCK /<b>已锁定</b></span>
        <span className="app-lock__state"><i className="ui-led ui-led--warn" />LOCKED</span>
      </header>

      <div className="app-lock__stage">
        <LockClock />
        <Module className="app-lock__mod" id="—" title="应用锁" en="APP LOCK" crop="bottom"
          right={<span className="app-lock__auth">{wait > 0 ? `WAIT ${wait} S` : 'AUTH REQUIRED'}</span>}>
          <form className="app-lock__card" onSubmit={submit}>
            <div className="ui-label">STATUS<b>需要密码</b></div>
            <h1 id="app-lock-title" className="app-lock__title">Murmur 已锁定</h1>
            <p className="app-lock__lede">输入应用锁密码继续</p>
            {syncFailed && (
              <p className="app-lock__sync" role="status">还没能通知本地服务上锁，正在重试…</p>
            )}

            <div className="app-lock-field app-lock-field--prompt">
              <span className="app-lock-field__p" aria-hidden="true">PASS</span>
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

            <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!password || wait > 0}>
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
        </Module>
        <p className="app-lock__note">
          应用锁用来防止别人打开 Murmur 翻看，不会加密电脑上已经解密的聊天数据。
        </p>
      </div>
    </div>
  );
}

/** Big wall clock over the lock module — purely decorative, own 1 s tick. */
function LockClock() {
  const [d, setD] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setD(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    <div className="app-lock__clock" aria-hidden="true">
      <div className="ui-big app-lock__time">{p(d.getHours())}:{p(d.getMinutes())}</div>
      <div className="app-lock__date">
        <span>{d.getFullYear()}-{p(d.getMonth() + 1)}-{p(d.getDate())}</span>
        <span>{p(d.getHours())}:{p(d.getMinutes())}:{p(d.getSeconds())}</span>
      </div>
    </div>
  );
}
