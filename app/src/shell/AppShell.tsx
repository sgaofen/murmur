/* AppShell — the frame every main page sits in: a left nav (pages on top;
 * account, privacy and settings at the bottom) and one sticky top bar that
 * pages fill through <PageHeader>. Styles: ./shell.css.
 *
 * Layout contract for pages (see app/src/ui/README.md → 应用外壳):
 *   - the document still scrolls; the nav is fixed and the top bar sticky
 *   - full-bleed pages use `.app-fill` (fixed, fills the area under the bar)
 *   - `--shell-left` / `--shell-top` / `--shell-vh` describe the content area
 *     for anything else that is fixed-positioned or viewport-tall
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ProfileSwitcher } from '../components/ProfileSwitcher';
import { PrivacyToggle } from '../components/PrivacyToggle';
import { Chip, cx } from '../ui';
import {
  IconCalendar, IconHome, IconNetwork, IconReport, IconSearch, IconSettings,
  IconSidebarCollapse, IconSidebarExpand, IconTable,
} from '../ui/icons';
import { ShellContext } from './context';
import { HeaderBar } from './PageHeader';
import type { PageHeaderProps } from './PageHeader';
import './shell.css';

export type NavKey = 'home' | 'graph' | 'annual' | 'reports' | 'table' | 'search' | 'settings';

interface NavItem {
  key: NavKey;
  label: string;
  /** Same hash forms the app has always used, so bookmarks keep working. */
  href: string;
  icon: ReactNode;
  /** Tooltip while the nav is expanded (collapsed shows the label). */
  hint?: string;
  badge?: string;
}

const ICON = 18;

const MAIN_NAV: NavItem[] = [
  { key: 'home', label: '首页', href: '#', icon: <IconHome size={ICON} />, hint: '年代记：今年最常聊的人和全部朋友' },
  { key: 'graph', label: '关系网', href: '#graph', icon: <IconNetwork size={ICON} />, hint: '一张可旋转的社交星图' },
  { key: 'annual', label: '年度', href: '#annual', icon: <IconCalendar size={ICON} />, hint: '年度总览：所有朋友 + 所有聊天' },
  { key: 'reports', label: '报告', href: '#reports', icon: <IconReport size={ICON} />, hint: 'AI 关系档案' },
  { key: 'table', label: '离线证据表', href: '#table', icon: <IconTable size={ICON} />, hint: '朋友信号矩阵：纯本地统计，无需 AI' },
  { key: 'search', label: '搜索', href: '#search', icon: <IconSearch size={ICON} />, hint: '搜索全部聊天记录（即将推出）', badge: '即将推出' },
];

const SETTINGS_NAV: NavItem = {
  key: 'settings', label: '设置', href: '#settings', icon: <IconSettings size={ICON} />, hint: '外观、隐私、数据目录、本机 AI、关于',
};

/** Below this width the nav is always the icon rail. */
const NARROW_QUERY = '(max-width: 899px)';
const COLLAPSED_KEY = 'murmur.nav.collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;  // storage blocked — start expanded
  }
}

function writeCollapsed(v: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
  } catch {
    /* storage blocked — the choice still applies for this session */
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);  // Safari < 14
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [query]);
  return matches;
}

function MurmurMark() {
  return (
    <svg className="app-nav__mark" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11" cy="11" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11" cy="11" r="1.6" fill="currentColor" />
    </svg>
  );
}

function NavLink({ item, active, collapsed }: { item: NavItem; active: boolean; collapsed: boolean }) {
  return (
    <a
      href={item.href}
      className={cx('app-nav__item', active && 'is-active')}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? (item.badge ? `${item.label}（${item.badge}）` : item.label) : item.hint}
    >
      <span className="app-nav__icon">{item.icon}</span>
      <span className="app-nav__label">{item.label}</span>
      {item.badge && <span className="app-nav__trail"><Chip size="sm">{item.badge}</Chip></span>}
    </a>
  );
}

export interface AppShellProps {
  /** Highlighted nav entry (sub-pages pass their parent, e.g. friend → home). */
  active: NavKey | null;
  /** Top bar content while the page hasn't mounted its own <PageHeader>. */
  fallbackHeader: PageHeaderProps;
  children: ReactNode;
}

export function AppShell({ active, fallbackHeader, children }: AppShellProps) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const [pinnedCollapsed, setPinnedCollapsed] = useState(readCollapsed);
  const collapsed = narrow || pinnedCollapsed;
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  const toggleCollapsed = () => {
    setPinnedCollapsed(c => {
      writeCollapsed(!c);
      return !c;
    });
  };

  return (
    <ShellContext.Provider value={{ headerSlot }}>
      <div className={cx('app-shell', collapsed && 'is-collapsed')}>
        <nav className="app-nav" aria-label="主导航">
          <a href="#" className="app-nav__brand" aria-label="Murmur 微语 · 首页" title={collapsed ? 'Murmur 微语' : undefined}>
            <MurmurMark />
            <span className="app-nav__brand-name">Murmur 微语</span>
          </a>
          <div className="app-nav__list">
            {MAIN_NAV.map(item => (
              <NavLink key={item.key} item={item} active={active === item.key} collapsed={collapsed} />
            ))}
          </div>
          <div className="app-nav__foot">
            <ProfileSwitcher variant="sidebar" collapsed={collapsed} />
            <PrivacyToggle collapsed={collapsed} />
            <div className="app-nav__row">
              <NavLink item={SETTINGS_NAV} active={active === 'settings'} collapsed={collapsed} />
              {!narrow && (
                <button
                  type="button"
                  className="ui-icon-btn app-nav__toggle"
                  onClick={toggleCollapsed}
                  aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
                  title={collapsed ? '展开侧栏' : '收起侧栏'}
                >
                  {collapsed ? <IconSidebarExpand size={17} /> : <IconSidebarCollapse size={17} />}
                </button>
              )}
            </div>
          </div>
        </nav>
        <div className="app-main">
          <header className="app-topbar">
            <div className="app-topbar__slot" ref={setHeaderSlot} />
            <div className="app-topbar__fallback"><HeaderBar {...fallbackHeader} /></div>
          </header>
          <main className="app-content">{children}</main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}
