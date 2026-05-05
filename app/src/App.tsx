import { useEffect, useState } from 'react';
import { HomePage } from './pages/Home';
import { FriendPage } from './pages/Friend';
import { LoadingPage } from './pages/Loading';
import { OnboardingDialog } from './pages/OnboardingDialog';
import { GraphPage } from './pages/Graph';
import { OfflineSignalsTable } from './pages/OfflineSignalsTable';
import { ReportsPage } from './pages/Reports';
import { YearbookPage } from './pages/Yearbook';
import { getDiagnose, getInfo } from './data/api';
import { TaskCenterProvider } from './components/extras/TaskCenter';
import { BatchStatusPill, BatchTrackerProvider } from './components/extras/BatchTracker';
import { PrivacyToggle } from './components/PrivacyToggle';
import { PrivacyIdentityIndex } from './components/extras/PrivacyIdentityIndex';
import { QQOnboardingDialog } from './pages/QQOnboardingDialog';
import { syncActiveToBackend } from './utils/activeProfile';

type Route =
  | { name: 'loading' }
  | { name: 'home' }
  | { name: 'friend'; id: string }
  | { name: 'yearbook'; id: string }
  | { name: 'graph' }
  | { name: 'table' }
  | { name: 'reports' };

function parseHash(h: string): Route {
  const s = h.replace(/^#\/?/, '');
  if (!s) return { name: 'home' };
  if (s === 'loading') return { name: 'loading' };
  if (s === 'graph') return { name: 'graph' };
  if (s === 'table') return { name: 'table' };
  if (s === 'reports') return { name: 'reports' };
  if (s.startsWith('yearbook/')) return { name: 'yearbook', id: s.slice('yearbook/'.length) };
  if (s.startsWith('friend/')) return { name: 'friend', id: s.slice('friend/'.length) };
  return { name: 'home' };
}

const ONBOARDING_SEEN_KEY = 'murmur.onboarding.seen';

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [dark, setDark] = useState<boolean>(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  );
  const [onboarding, setOnboarding] = useState(false);
  const [qqOnboarding, setQQOnboarding] = useState(false);
  // Set when /api/info reports bootstrap=true with a non-null init_error.
  // OnboardingDialog renders a "stuck data" banner with this so users see
  // WHY they're back at onboarding instead of silently re-looping.
  const [bootstrapInitError, setBootstrapInitError] = useState<string | null>(null);
  const showDevControls = import.meta.env.VITE_SHOW_DEV_CONTROLS === '1';

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Any ProfileSwitcher (mounted on any chrome bar) can ask to open onboarding
  // via this event — avoids prop-drilling onAddNew through every page that has
  // a chrome bar (Friend / Graph / Reports / Yearbook / Table).
  useEffect(() => {
    const onReq = (e: Event) => {
      const platform = (e as CustomEvent<{ platform: 'wechat' | 'qq' }>).detail?.platform;
      if (platform === 'qq') setQQOnboarding(true);
      else setOnboarding(true);
    };
    window.addEventListener('murmur:requestOnboarding', onReq);
    return () => window.removeEventListener('murmur:requestOnboarding', onReq);
  }, []);

  function go(path: string) {
    window.location.hash = path;
  }

  // Apply dark class on root
  useEffect(() => {
    document.documentElement.classList.toggle('et-dark', dark);
  }, [dark]);

  // Auto-show onboarding when data isn't ready. Three triggers:
  //   1. Backend in bootstrap mode (no decrypted data) — ALWAYS show, regardless
  //      of `seen` flag. This fires when TCC blocked the boot-time discover or
  //      the user is on a fresh install.
  //   2. macOS + TCC blocked at request time — show FDA grant flow.
  //   3. First-launch heuristic (legacy): fresh user with WeChat installed but
  //      no key yet, only if onboarding has never been completed (`seen`).
  useEffect(() => {
    let cancelled = false;
    const seen = localStorage.getItem(ONBOARDING_SEEN_KEY);
    // Retry the boot probe — same boot race as in Home.tsx (Tauri webview
    // mounts seconds before etcli is listening). Without retry, /api/info
    // fails once, we silently bail, and onboarding never opens even though
    // the user is on a fresh install that needs it.
    const probe = async <T,>(fn: () => Promise<T>, attempts = 80, delayMs = 750): Promise<T | null> => {
      for (let i = 0; i < attempts; i++) {
        if (cancelled) return null;
        try { return await fn(); } catch { /* retry */ }
        await new Promise(r => setTimeout(r, delayMs));
      }
      return null;
    };
    (async () => {
      // Re-pin the active profile from localStorage BEFORE probing /api/info.
      // After a window reload (e.g. just-finished QQ onboarding) the etcli
      // process may not yet know which account is active; if /api/info fires
      // first, it returns bootstrap=true and re-pops WeChat onboarding even
      // though QQ is happily decrypted. Awaiting sync closes that race.
      await syncActiveToBackend();

      // #loading is a deliberate dev route — don't auto-pop the onboarding.
      const initialRoute = parseHash(window.location.hash);
      if (initialRoute.name === 'loading') {
        return;
      }
      const info = await probe(() => getInfo());
      if (cancelled) return;
      if (!info) {
        // Backend never came up — leave Home's connection error UI in place.
        return;
      }
      if (info.bootstrap) {
        // If backend reports a specific init_error (e.g. session.db missing
        // SessionTable, file is not a database, etc.) DON'T just loop the user
        // back into the same onboarding that won't fix the underlying broken
        // decrypted dir. Surface it via the dialog's banner so they can act.
        if (info.init_error) {
          setBootstrapInitError(info.init_error);
        }
        setOnboarding(true);
        return;
      }
      const hasRuntimeData = Boolean(info.data_dir);
      const d = await probe(() => getDiagnose());
      if (cancelled || !d) return;
      if (d.platform === 'macos' && d.capabilities.tcc_blocked && !hasRuntimeData) {
        setOnboarding(true);
        return;
      }
      const noData = !hasRuntimeData && d.profiles.every(p => !p.has_decrypted_data);
      const noKey = !d.saved_key;
      const isMacWithoutData = d.platform === 'macos' && noData;
      const isWinFirstRun = d.platform === 'windows' && noData && noKey;
      if (!seen && (isMacWithoutData || isWinFirstRun)) {
        setOnboarding(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Floating dev/utility controls — bottom right
  const DevControls = (
    <div style={{
      position: 'fixed', bottom: 16, right: 16, zIndex: 9999,
      display: 'flex', gap: 6, padding: 6,
      background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
      borderRadius: 999, boxShadow: 'var(--et-shadow-2)', fontSize: 11,
    }}>
      <button onClick={() => { localStorage.removeItem(ONBOARDING_SEEN_KEY); setOnboarding(true); }}
              title="重新打开首次引导"
              style={{
                all: 'unset', cursor: 'pointer', padding: '4px 10px', borderRadius: 999,
                background: 'transparent', color: 'var(--et-mute)', fontWeight: 500,
              }}>引导</button>
      <button onClick={() => go('loading')} style={chipBtn}>加载</button>
      <button onClick={() => go('')} style={chipBtn}>首页</button>
      <button onClick={() => setDark(d => !d)} style={{
        all: 'unset', cursor: 'pointer', padding: '4px 10px', borderRadius: 999,
        background: 'var(--et-ink)', color: 'var(--et-paper)', fontWeight: 500,
      }}>{dark ? '亮' : '暗'}</button>
    </div>
  );

  let body;
  switch (route.name) {
    case 'loading':
      body = <LoadingPage onDone={() => go('')} />;
      break;
    case 'friend':
      body = <FriendPage friendId={route.id} onBack={() => go('')}
                          onOpenFriend={(id) => go(`friend/${id}`)} />;
      break;
    case 'graph':
      body = <GraphPage onBack={() => go('')} onOpenFriend={(id) => go(`friend/${id}`)} />;
      break;
    case 'table':
      body = <OfflineSignalsTable onBack={() => go('')} onOpenFriend={(id) => go(`friend/${id}`)} />;
      break;
    case 'reports':
      body = <ReportsPage onBack={() => go('')} />;
      break;
    case 'yearbook':
      body = <YearbookPage friendId={route.id} onBack={() => go(`friend/${route.id}`)} />;
      break;
    default:
      body = <HomePage
        dark={dark}
        onOpenFriend={(id) => go(`friend/${id}`)}
        onOpenOnboarding={() => setOnboarding(true)}
        onOpenQQ={() => setQQOnboarding(true)}
      />;
  }

  return (
    <TaskCenterProvider>
      <BatchTrackerProvider>
        <PrivacyIdentityIndex />
        {body}
        <BatchStatusPill onOpenReports={() => go('reports')} />
        {showDevControls && DevControls}
        <PrivacyToggle position={showDevControls ? 'top-right' : 'bottom-right'} />
        <OnboardingDialog
          open={onboarding}
          onClose={() => { localStorage.setItem(ONBOARDING_SEEN_KEY, '1'); setOnboarding(false); setBootstrapInitError(null); }}
          onDone={() => window.location.reload()}
          onPickQQ={() => { setOnboarding(false); setQQOnboarding(true); }}
          initError={bootstrapInitError}
        />
        <QQOnboardingDialog
          open={qqOnboarding}
          onClose={() => setQQOnboarding(false)}
          onDone={() => { setQQOnboarding(false); /* dialog reloads the page itself */ }}
        />
      </BatchTrackerProvider>
    </TaskCenterProvider>
  );
}

const chipBtn: React.CSSProperties = {
  all: 'unset', cursor: 'pointer', padding: '4px 10px', borderRadius: 999,
  background: 'transparent', color: 'var(--et-mute)', fontWeight: 500,
};
