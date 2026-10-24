import { lazy, Suspense, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { HomePage } from './pages/Home';
import { FriendPage } from './pages/Friend';
import { LoadingPage } from './pages/Loading';
import { OnboardingDialog } from './pages/OnboardingDialog';
import { GraphPage } from './pages/Graph';
import { OfflineSignalsTable } from './pages/OfflineSignalsTable';
import { ReportsPage } from './pages/Reports';
import { YearbookPage } from './pages/Yearbook';
import { AnnualReportPage } from './pages/AnnualReport';
import { getDiagnose, getInfo } from './data/api';
import { TaskCenterProvider } from './components/extras/TaskCenter';
import { BatchStatusPill, BatchTrackerProvider } from './components/extras/BatchTracker';
import { PrivacyIdentityIndex } from './components/extras/PrivacyIdentityIndex';
import { QQOnboardingDialog } from './pages/QQOnboardingDialog';
import { SettingsPage } from './pages/Settings';
import { SearchPage } from './pages/Search';
import { ChatPage } from './pages/Chat';
import { supportsQQOnboarding, syncActiveToBackend } from './utils/activeProfile';
import { searchBackPath } from './utils/searchLinks';
import { useTheme } from './ui';
import { AppShell } from './shell/AppShell';
import type { NavKey } from './shell/AppShell';
import type { PageHeaderProps } from './shell/PageHeader';

// Component gallery (#/ui-gallery) — not linked from the app; loaded on demand.
const UiGalleryPage = lazy(() => import('./pages/UiGallery'));

type Route =
  | { name: 'loading' }
  | { name: 'home' }
  | { name: 'friend'; id: string }
  | { name: 'yearbook'; id: string }
  | { name: 'graph' }
  | { name: 'table' }
  | { name: 'reports' }
  | { name: 'annual' }
  | { name: 'search'; query: string }
  | { name: 'chat'; id: string; query: string }
  | { name: 'settings' }
  | { name: 'ui-gallery' };

// Accepts both `#graph` and `#/graph`; existing links and bookmarks keep working.
// `search` and `chat/<id>` may carry a `?query` that the page reads itself.
function parseHash(h: string): Route {
  const full = h.replace(/^#\/?/, '');
  const qi = full.indexOf('?');
  const s = qi < 0 ? full : full.slice(0, qi);
  const query = qi < 0 ? '' : full.slice(qi + 1);
  if (!s) return { name: 'home' };
  if (s === 'loading') return { name: 'loading' };
  if (s === 'graph') return { name: 'graph' };
  if (s === 'table') return { name: 'table' };
  if (s === 'reports') return { name: 'reports' };
  if (s === 'annual') return { name: 'annual' };
  if (s === 'search') return { name: 'search', query };
  if (s === 'settings') return { name: 'settings' };
  if (s === 'ui-gallery') return { name: 'ui-gallery' };
  if (s.startsWith('yearbook/')) return { name: 'yearbook', id: s.slice('yearbook/'.length) };
  if (s.startsWith('friend/')) return { name: 'friend', id: s.slice('friend/'.length) };
  if (s.startsWith('chat/')) return { name: 'chat', id: safeDecode(s.slice('chat/'.length)), query };
  return { name: 'home' };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Which key is lit, and what the status strip says until the page mounts
 * its own <PageHeader> (loading / error states). */
function shellFor(route: Route, go: (path: string) => void): { active: NavKey | null; header: PageHeaderProps } {
  switch (route.name) {
    case 'friend':
      return { active: 'profile', header: { title: '档案', back: { label: '年代记', onClick: () => go('') } } };
    case 'yearbook':
      return {
        active: 'profile',
        header: { title: '双人年代记', back: { label: '朋友页', onClick: () => go(`friend/${route.id}`) } },
      };
    case 'graph':
      return { active: 'graph', header: { title: '关系网' } };
    case 'annual':
      return { active: 'annual', header: { title: '年度总览' } };
    case 'reports':
      return { active: 'reports', header: { title: 'AI 关系档案' } };
    case 'table':
      return { active: 'table', header: { title: '离线证据表' } };
    case 'search':
      return { active: 'search', header: { title: '检索' } };
    case 'chat': {
      const params = new URLSearchParams(route.query);
      if (params.get('from') === 'search') {
        return { active: 'chat', header: { title: '对话', back: { label: '检索', onClick: () => go(searchBackPath(params)) } } };
      }
      // Same rule as the page's own header: groups have no friend page.
      return route.id.endsWith('@chatroom')
        ? { active: 'chat', header: { title: '对话', back: { label: '年代记', onClick: () => go('') } } }
        : { active: 'chat', header: { title: '对话', back: { label: '朋友页', onClick: () => go(`friend/${route.id}`) } } };
    }
    case 'settings':
      return { active: 'settings', header: { title: '设置' } };
    default:
      return { active: 'home', header: { title: '年代记' } };
  }
}

/** The last person / chat opened this session, for the 3 档案 / 4 对话 keys.
 * Memory only: nothing about who you looked at is written to disk. */
function lastOpened(route: Route, prev: { friend: string | null; chat: string | null }) {
  if (route.name === 'friend' || route.name === 'yearbook') return { ...prev, friend: route.id };
  if (route.name === 'chat') {
    return { friend: route.id.endsWith('@chatroom') ? prev.friend : route.id, chat: route.id };
  }
  return prev;
}

const ONBOARDING_SEEN_KEY = 'murmur.onboarding.seen';

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [recent, setRecent] = useState(() => lastOpened(parseHash(window.location.hash), { friend: null, chat: null }));
  const { resolved: theme, toggle: toggleTheme } = useTheme();
  const [onboarding, setOnboarding] = useState(false);
  const [qqOnboarding, setQQOnboarding] = useState(false);
  // Set when /api/info reports bootstrap=true with a non-null init_error.
  // OnboardingDialog renders a "stuck data" banner with this so users see
  // WHY they're back at onboarding instead of silently re-looping.
  const [bootstrapInitError, setBootstrapInitError] = useState<string | null>(null);
  const showDevControls = import.meta.env.VITE_SHOW_DEV_CONTROLS === '1';
  const qqSupported = supportsQQOnboarding();

  useEffect(() => {
    const onHash = () => {
      const next = parseHash(window.location.hash);
      setRoute(next);
      setRecent(prev => lastOpened(next, prev));
      // The document scrolls (not the content pane), so a new page would
      // otherwise open at the previous page's scroll offset.
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The sidebar's ProfileSwitcher (and the settings page) ask to open
  // onboarding via this event instead of prop-drilling a callback.
  useEffect(() => {
    const onReq = (e: Event) => {
      const platform = (e as CustomEvent<{ platform: 'wechat' | 'qq' }>).detail?.platform;
      if (platform === 'qq' && qqSupported) setQQOnboarding(true);
      else setOnboarding(true);
    };
    window.addEventListener('murmur:requestOnboarding', onReq);
    return () => window.removeEventListener('murmur:requestOnboarding', onReq);
  }, [qqSupported]);

  function go(path: string) {
    window.location.hash = path;
  }

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
      if (initialRoute.name === 'loading' || initialRoute.name === 'ui-gallery') {
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
      position: 'fixed', bottom: 'calc(var(--shell-bottom, 0px) + 12px)', right: 12, zIndex: 9999,
      display: 'flex', gap: 4, padding: 4,
      background: 'var(--surface-raised)', border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', fontSize: 11,
      fontFamily: 'var(--font-mono)',
    }}>
      <button onClick={() => { localStorage.removeItem(ONBOARDING_SEEN_KEY); setOnboarding(true); }}
              title="重新打开首次引导"
              style={chipBtn}>引导</button>
      <button onClick={() => go('loading')} style={chipBtn}>加载</button>
      <button onClick={() => go('')} style={chipBtn}>首页</button>
      <button onClick={toggleTheme} style={{
        ...chipBtn, background: 'var(--surface-inverse)', color: 'var(--text-inverse)',
      }}>{theme === 'dark' ? '亮' : '暗'}</button>
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
    case 'annual':
      body = <AnnualReportPage onBack={() => go('')} onOpenFriend={(id) => go(`friend/${id}`)} />;
      break;
    case 'search':
      body = <SearchPage query={route.query} navigate={go} />;
      break;
    case 'chat':
      body = <ChatPage key={`${route.id}?${route.query}`} chatId={route.id} query={route.query} navigate={go} />;
      break;
    case 'settings':
      body = <SettingsPage />;
      break;
    case 'ui-gallery':
      body = <Suspense fallback={null}><UiGalleryPage onBack={() => go('')} /></Suspense>;
      break;
    default:
      body = <HomePage
        onOpenFriend={(id) => go(`friend/${id}`)}
        onOpenOnboarding={() => setOnboarding(true)}
        onOpenQQ={qqSupported ? () => setQQOnboarding(true) : undefined}
      />;
  }

  // The splash (#loading) and the component gallery are full-screen dev
  // routes; everything else lives inside the app shell.
  const bare = route.name === 'loading' || route.name === 'ui-gallery';
  const shell = shellFor(route, go);

  return (
    <TaskCenterProvider>
      <BatchTrackerProvider>
        <PrivacyIdentityIndex />
        {bare ? body : (
          <AppShell active={shell.active} fallbackHeader={shell.header}
            profileHref={recent.friend ? `#friend/${recent.friend}` : null}
            chatHref={recent.chat ? `#chat/${encodeURIComponent(recent.chat)}` : null}>
            {body}
            <BatchStatusPill onOpenReports={() => go('reports')} />
          </AppShell>
        )}
        {showDevControls && DevControls}
        <OnboardingDialog
          open={onboarding}
          onClose={() => { localStorage.setItem(ONBOARDING_SEEN_KEY, '1'); setOnboarding(false); setBootstrapInitError(null); }}
          onDone={() => window.location.reload()}
          onPickQQ={qqSupported ? () => { setOnboarding(false); setQQOnboarding(true); } : undefined}
          initError={bootstrapInitError}
        />
        {qqSupported && (
          <QQOnboardingDialog
            open={qqOnboarding}
            onClose={() => setQQOnboarding(false)}
            onDone={() => { setQQOnboarding(false); /* dialog reloads the page itself */ }}
          />
        )}
      </BatchTrackerProvider>
    </TaskCenterProvider>
  );
}

const chipBtn: CSSProperties = {
  all: 'unset', cursor: 'pointer', padding: '4px 9px', borderRadius: 'var(--radius-xs)',
  background: 'transparent', color: 'var(--text-muted)', fontWeight: 500,
};
