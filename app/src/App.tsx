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
import { PrivacyToggle } from './components/PrivacyToggle';

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

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
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
    const probe = async <T,>(fn: () => Promise<T>, attempts = 8, delayMs = 750): Promise<T | null> => {
      for (let i = 0; i < attempts; i++) {
        if (cancelled) return null;
        try { return await fn(); } catch { /* retry */ }
        await new Promise(r => setTimeout(r, delayMs));
      }
      return null;
    };
    (async () => {
      const info: any = await probe(() => getInfo());
      if (cancelled) return;
      if (!info) {
        // Backend never came up — leave Home's connection error UI in place.
        return;
      }
      if (info.bootstrap) {
        setOnboarding(true);
        return;
      }
      const d = await probe(() => getDiagnose());
      if (cancelled || !d) return;
      if (d.platform === 'macos' && d.capabilities.tcc_blocked) {
        setOnboarding(true);
        return;
      }
      const noData = d.profiles.every(p => !p.has_decrypted_data);
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
      body = <HomePage dark={dark} onOpenFriend={(id) => go(`friend/${id}`)} />;
  }

  return (
    <TaskCenterProvider>
      {body}
      {DevControls}
      <PrivacyToggle />
      <OnboardingDialog
        open={onboarding}
        onClose={() => { localStorage.setItem(ONBOARDING_SEEN_KEY, '1'); setOnboarding(false); }}
        onDone={() => window.location.reload()}
      />
    </TaskCenterProvider>
  );
}

const chipBtn: React.CSSProperties = {
  all: 'unset', cursor: 'pointer', padding: '4px 10px', borderRadius: 999,
  background: 'transparent', color: 'var(--et-mute)', fontWeight: 500,
};
