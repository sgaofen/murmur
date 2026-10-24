/* Theme — light / dark / follow-system.
 *
 * The user's choice (`mode`) is persisted in localStorage; the effective theme
 * (`resolved`) is applied to <html> as the `.et-dark` class plus a
 * `data-theme` attribute, which flips every token in tokens.css.
 *
 *   main.tsx      initTheme() before the first render (no light flash)
 *   App root      <ThemeProvider> listens to the OS setting + other windows
 *   components    const { mode, resolved, setMode, toggle } = useTheme()
 */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'murmur.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export const THEME_MODES: ReadonlyArray<{ mode: ThemeMode; label: string }> = [
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
  { mode: 'system', label: '跟随系统' },
];

function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system';
}

function readStoredMode(): ThemeMode {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(v) ? v : 'system';
  } catch {
    return 'system';  // storage blocked (private mode, sandbox) — default
  }
}

function writeStoredMode(mode: ThemeMode) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* storage blocked — the choice still applies for this session */
  }
}

function darkQuery(): MediaQueryList | null {
  try {
    return window.matchMedia?.(DARK_QUERY) ?? null;
  } catch {
    return null;
  }
}

function readSystemDark(): boolean {
  return darkQuery()?.matches ?? false;
}

/** Pure: which theme a mode ends up as, given the OS setting. */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}

// ——— tiny external store (shared by the provider and any hook caller) ———

interface Snapshot { mode: ThemeMode; systemDark: boolean }

let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): Snapshot {
  if (!snapshot) snapshot = { mode: readStoredMode(), systemDark: readSystemDark() };
  return snapshot;
}

function update(next: Partial<Snapshot>) {
  const cur = getSnapshot();
  const merged = { ...cur, ...next };
  if (merged.mode === cur.mode && merged.systemDark === cur.systemDark) return;
  snapshot = merged;
  listeners.forEach(l => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Set the user's choice (persists). Safe to call outside React. */
export function setThemeMode(mode: ThemeMode) {
  writeStoredMode(mode);
  update({ mode });
}

function applyToDocument(resolved: ResolvedTheme) {
  const el = document.documentElement;
  el.classList.toggle('et-dark', resolved === 'dark');
  el.dataset.theme = resolved;
}

/** Apply the stored theme synchronously. Call once before the first render. */
export function initTheme() {
  const s = getSnapshot();
  applyToDocument(resolveTheme(s.mode, s.systemDark));
}

// ——— React API ———

export interface ThemeContextValue {
  /** What the user picked: 'light' | 'dark' | 'system'. */
  mode: ThemeMode;
  /** What is actually showing right now. */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** Flip between light and dark (leaves 'system'). */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const resolved = resolveTheme(s.mode, s.systemDark);

  useLayoutEffect(() => { applyToDocument(resolved); }, [resolved]);

  // Follow the OS appearance while mode === 'system' (tracked always, so the
  // switch back to 'system' is instant and correct).
  useEffect(() => {
    const mq = darkQuery();
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => update({ systemDark: e.matches });
    update({ systemDark: mq.matches });
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);  // Safari < 14
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  // Keep several windows / tabs in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) update({ mode: isThemeMode(e.newValue) ? e.newValue : 'system' });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    mode: s.mode,
    resolved,
    setMode: setThemeMode,
    toggle: () => setThemeMode(resolved === 'dark' ? 'light' : 'dark'),
  }), [s.mode, resolved]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme() must be used inside <ThemeProvider>');
  return ctx;
}
