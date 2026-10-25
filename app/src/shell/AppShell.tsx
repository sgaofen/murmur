/* AppShell — the instrument chassis every main page sits in:
 *
 *   status strip (top)   MURMUR 微语 · CH 01 / 年代记 · page actions · LOCAL · SYNC · PRIV · clock
 *   content              the page (document scrolls)
 *   key bar (bottom)     1 年代记 2 关系网 3 档案 4 对话 5 检索 · ⌘K 命令 · 6 年度 7 报告 8 证据表
 *                        ··· account · ⌘, 设置
 *
 * Number keys 1–8 switch pages (when focus is not in a text field), ⌘K / Ctrl K
 * opens the command palette, ⌘, / Ctrl , opens 设置.
 *
 * Layout contract for pages (see app/src/ui/README.md → 应用外壳):
 *   - the document scrolls; the strip is sticky, the key bar fixed
 *   - full-bleed pages use `.app-fill` (fixed, fills the area between them)
 *   - `--shell-top` / `--shell-bottom` / `--shell-left` / `--shell-vh` describe
 *     the content area for anything fixed-positioned or viewport-tall
 * Styles: ./shell.css.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { API_BASE } from '../data/api';
import { ProfileSwitcher } from '../components/ProfileSwitcher';
import { PrivacyToggle } from '../components/PrivacyToggle';
import { useLiveSync } from '../utils/liveSync';
import { cx } from '../ui';
import { ShellContext } from './context';
import { HeaderBar } from './PageHeader';
import type { PageHeaderProps } from './PageHeader';
import { CommandPalette } from './CommandPalette';
import type { PaletteMode, PaletteNavItem } from './CommandPalette';
import './shell.css';

export type NavKey =
  | 'home' | 'graph' | 'profile' | 'chat' | 'search'
  | 'annual' | 'reports' | 'table' | 'settings';

interface KeyDef {
  key: NavKey;
  no: string;
  label: string;
  hint: string;
  /** Fixed hash; profile / chat get theirs from the last opened person. */
  href?: string;
}

const PRIMARY: KeyDef[] = [
  { key: 'home', no: '1', label: '年代记', href: '#', hint: '联系人读数、月度热度、常聊和名录' },
  { key: 'graph', no: '2', label: '关系网', href: '#graph', hint: '你和朋友、朋友之间的连线' },
  { key: 'profile', no: '3', label: '档案', hint: '最近打开的人；还没打开过就先选一个' },
  { key: 'chat', no: '4', label: '对话', hint: '最近打开的聊天；还没打开过就先选一个' },
  { key: 'search', no: '5', label: '检索', href: '#search', hint: '搜索全部聊天记录，点结果跳到原消息' },
];

const SECONDARY: KeyDef[] = [
  { key: 'annual', no: '6', label: '年度', href: '#annual', hint: '一年里的所有朋友和所有聊天' },
  { key: 'reports', no: '7', label: '报告', href: '#reports', hint: '本机 AI 写的关系档案' },
  { key: 'table', no: '8', label: '证据表', href: '#table', hint: '纯本地统计的朋友信号矩阵，无需 AI' },
];

const SETTINGS: KeyDef = { key: 'settings', no: '⌘,', label: '设置', href: '#settings', hint: '外观、隐私、应用锁、数据目录、本机 AI、关于' };

/** Chapter code shown before the page title in the strip. */
const CHAPTER: Record<NavKey, string> = {
  home: 'CH 01', graph: 'CH 02', profile: 'CH 03', chat: 'CH 04', search: 'CH 05',
  annual: 'CH 06', reports: 'CH 07', table: 'CH 08', settings: 'SYS',
};

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl ';

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

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color'].includes(type);
  }
  return false;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function Clock({ withDate }: { withDate: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Tick on the second boundary so the readout never skips a digit.
    let t: number;
    const tick = () => {
      setNow(new Date());
      t = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    };
    t = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    return () => window.clearTimeout(t);
  }, []);
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return (
    <time className="app-strip__clock" dateTime={now.toISOString()}>
      {withDate && <span>{date}</span>}<span>{time}</span>
    </time>
  );
}

/** LOCAL + SYNC LEDs, fed by the shared live-sync poll (utils/liveSync.ts). */
function BackendStats({ compact }: { compact: boolean }) {
  const { status, reachable } = useLiveSync();
  const host = API_BASE.replace(/^https?:\/\//, '');
  const localTitle = reachable === false
    ? `本地服务没有响应（${host}）。Murmur 会自动重连`
    : reachable ? `本地服务在线：${host}。所有数据只在这台电脑上读写` : `正在连接本地服务 ${host}`;

  let syncLed = 'is-off';
  let syncValue = 'OFF';
  let syncTitle = '实时同步关闭：在年代记 06 数据源里打开';
  if (status) {
    if (status.active_platform === 'qq' || !status.available) {
      syncValue = '—';
      syncTitle = status.active_platform === 'qq'
        ? '实时同步只支持微信'
        : '实时同步不可用：还没有解密好的微信数据';
    } else if (status.enabled) {
      syncLed = status.syncing ? 'is-pulse' : '';
      syncValue = status.syncing ? 'SYNCING' : `${status.interval}S`;
      syncTitle = `实时同步已开启：每 ${status.interval} 秒检查一次微信数据库`;
      if (status.last_error) { syncLed = 'ui-led--warn'; syncTitle += `\n提示：${status.last_error}`; }
    }
  } else if (reachable === false) {
    syncValue = '—';
  }

  return (
    <>
      <span className="app-strip__stat" title={localTitle} role="status">
        <i className={cx('ui-led', reachable === false && 'ui-led--error', reachable == null && 'is-pulse')} aria-hidden="true" />
        <span>{reachable === false ? 'OFFLINE' : 'LOCAL'}</span>
      </span>
      <span className="app-strip__stat" title={syncTitle}>
        <i className={cx('ui-led', syncLed)} aria-hidden="true" />
        <span>SYNC</span>
        {!compact && <span className="app-strip__stat-v">{syncValue}</span>}
      </span>
    </>
  );
}

function ShellKey({ def, active, href, onClick, className }: {
  def: KeyDef; active: boolean; href?: string | null; onClick?: () => void; className?: string;
}) {
  const cls = cx('app-key', active && 'is-on', className);
  const inner = (
    <>
      <kbd className="ui-kbd" aria-hidden="true">{def.no}</kbd>
      <span className="app-key__label">{def.label}</span>
    </>
  );
  if (href) {
    return (
      <a href={href} className={cls} aria-current={active ? 'page' : undefined} title={`${def.label} · ${def.hint}`}
        aria-label={def.label}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick} title={`${def.label} · ${def.hint}`} aria-label={def.label}
      aria-current={active ? 'page' : undefined}>
      {inner}
    </button>
  );
}

export interface AppShellProps {
  /** Lit key (sub-pages pass their parent, e.g. yearbook → profile). */
  active: NavKey | null;
  /** Strip content while the page hasn't mounted its own <PageHeader>. */
  fallbackHeader: PageHeaderProps;
  /** Hash of the last opened person's profile (`#friend/<id>`), if any. */
  profileHref?: string | null;
  /** Hash of the last opened chat (`#chat/<id>`), if any. */
  chatHref?: string | null;
  children: ReactNode;
}

export function AppShell({ active, fallbackHeader, profileHref, chatHref, children }: AppShellProps) {
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const compactStrip = useMediaQuery('(max-width: 899px)');
  // Below this the LOCAL / SYNC / PRIV readouts drop their values and keep
  // only the LEDs. Above it PRIV always says ON / OFF: a bare "PRIV" read as
  // a cut-off label at ~820px.
  const tinyStrip = useMediaQuery('(max-width: 767px)');
  const clockDate = !useMediaQuery('(max-width: 1099px)');
  const compactAccount = useMediaQuery('(max-width: 1099px)');

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash.replace(/^#/, '');
  }, []);

  const hrefFor = useCallback((def: KeyDef): string | null => {
    if (def.key === 'profile') return profileHref ?? null;
    if (def.key === 'chat') return chatHref ?? null;
    return def.href ?? null;
  }, [profileHref, chatHref]);

  const openKey = useCallback((def: KeyDef) => {
    const href = hrefFor(def);
    if (href) navigate(href);
    else setPalette(def.key === 'chat' ? 'chat' : 'profile');
  }, [hrefFor, navigate]);

  // Keyboard: 1–8 pages, ⌘K palette, ⌘, settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPalette(p => (p ? null : 'all'));
        return;
      }
      if (mod && !e.altKey && e.key === ',') {
        e.preventDefault();
        navigate(SETTINGS.href as string);
        return;
      }
      if (mod || e.altKey || e.shiftKey) return;
      if (palette || isEditable(e.target)) return;
      // A modal (dialog, palette, lock screen) owns the keyboard.
      if (document.querySelector('[aria-modal="true"]')) return;
      const def = [...PRIMARY, ...SECONDARY].find(d => d.no === e.key);
      if (!def) return;
      e.preventDefault();
      openKey(def);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, openKey, palette]);

  const paletteNav = useMemo<PaletteNavItem[]>(
    () => [...PRIMARY, ...SECONDARY, SETTINGS].map(d => ({
      key: d.key, no: d.no === '⌘,' ? `${MOD},` : d.no, label: d.label, hint: d.hint, href: hrefFor(d),
    })),
    [hrefFor],
  );

  const shellValue = useMemo(
    () => ({ headerSlot, chapter: active ? CHAPTER[active] : null }),
    [headerSlot, active],
  );

  return (
    <ShellContext.Provider value={shellValue}>
      <div className="app-shell">
        <header className="app-strip">
          <a href="#" className="app-strip__brand" aria-label="Murmur 微语 · 年代记" title="Murmur 微语">
            MURMUR<span>微语</span>
          </a>
          <div className="app-strip__slot" ref={setHeaderSlot} />
          <div className="app-strip__fallback"><HeaderBar {...fallbackHeader} /></div>
          <div className="app-strip__status">
            <BackendStats compact={tinyStrip} />
            <PrivacyToggle compact={tinyStrip} />
            {!compactStrip && <Clock withDate={clockDate} />}
          </div>
        </header>

        <main className="app-content">{children}</main>

        <nav className="app-keys" aria-label="主导航">
          <div className="app-keys__group">
            {PRIMARY.map(def => (
              <ShellKey key={def.key} def={def} active={active === def.key}
                href={hrefFor(def)} onClick={() => openKey(def)} />
            ))}
          </div>
          <button type="button" className={cx('app-key', 'app-key--cmd', palette && 'is-open')}
            onClick={() => setPalette('all')} title={`命令面板（${MOD}K）：前往任意页面、找人、切换外观`}
            aria-label="命令面板" aria-haspopup="dialog">
            <kbd className="ui-kbd" aria-hidden="true">{MOD}K</kbd>
            <span className="app-key__label">命令</span>
          </button>
          <div className="app-keys__group app-keys__group--more">
            {SECONDARY.map(def => (
              <ShellKey key={def.key} def={def} active={active === def.key} href={def.href} />
            ))}
          </div>
          <div className="app-keys__right">
            <ProfileSwitcher variant="bar" compact={compactAccount} />
            <ShellKey def={{ ...SETTINGS, no: `${MOD},` }} active={active === 'settings'} href={SETTINGS.href}
              className="app-key--settings" />
          </div>
        </nav>
      </div>
      <CommandPalette
        open={palette != null}
        mode={palette ?? 'all'}
        onClose={() => setPalette(null)}
        nav={paletteNav}
        navigate={navigate}
        onRequestOnboarding={() => window.dispatchEvent(new CustomEvent('murmur:requestOnboarding', { detail: { platform: 'wechat' } }))}
      />
    </ShellContext.Provider>
  );
}
