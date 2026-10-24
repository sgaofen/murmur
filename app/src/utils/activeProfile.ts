/* activeProfile — small global state mirror for the active platform/account.
 *
 * Source of truth: backend `_MurmurAPIHandler._active_*`. Frontend mirror:
 * `localStorage["murmur.activeProfile"]`. On boot the App reads localStorage
 * and POSTs /api/active-profile to re-pin the backend (handles the case
 * where etcli restarted and forgot which account the user picked last).
 */
import { useEffect, useState } from 'react';
import { getProfiles, setActiveProfile } from '../data/api';
import type { ProfileEntry, ProfilesResponse } from '../data/api';

const STORAGE_KEY = 'murmur.activeProfile';
const CHANGE_EVENT = 'murmur:activeProfileChanged';

export interface ActiveProfile {
  platform: 'wechat' | 'qq';
  id: string;
}

/** QQ NT import works on Windows and macOS (Mac: re-sign QQ.app + lldb).
 * Linux has no QQ NT data layout support yet. */
export function supportsQQOnboarding(): boolean {
  if (typeof navigator === 'undefined') return true;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const s = `${ua} ${platform}`;
  if (/Windows|Win32|Win64|Macintosh|Mac OS|MacIntel/i.test(s)) return true;
  return !/Linux|X11/i.test(s);
}

export function readStoredActive(): ActiveProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && (obj.platform === 'wechat' || obj.platform === 'qq') && typeof obj.id === 'string') {
      return obj;
    }
  } catch {/* ignore */}
  return null;
}

export function writeStoredActive(p: ActiveProfile | null): void {
  if (p) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: p }));
}

/** Sync localStorage's active profile to the backend, retrying while the
 * etcli HTTP server is still coming up. Returns true on success (or no-op
 * when nothing is stored), false if every retry timed out. App.tsx awaits
 * this before /api/info so the bootstrap probe sees the correct store. */
export async function syncActiveToBackend(retries = 40, delayMs = 500): Promise<boolean> {
  const stored = readStoredActive();
  if (!stored) return true;
  if (stored.platform === 'qq' && !supportsQQOnboarding()) {
    writeStoredActive(null);
    return true;
  }
  for (let i = 0; i < retries; i++) {
    try {
      const r = await setActiveProfile(stored.platform, stored.id);
      if (r.ok) return true;
    } catch {/* backend booting — retry */}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

/** Switch active profile, persist, sync backend, then reload. */
export async function switchActiveProfile(p: ActiveProfile): Promise<void> {
  const r = await setActiveProfile(p.platform, p.id);
  // Defensive: backend currently returns HTTP 4xx on failure (so j() throws
  // before we get here), but if that contract ever changes to 200+ok=false
  // we still want to bail BEFORE writing localStorage + reloading into a
  // broken state.
  if (!r.ok) {
    throw new Error(r.error || `setActiveProfile returned ok=false for ${p.platform}/${p.id}`);
  }
  writeStoredActive(p);
  // Reload so every page re-fetches under the new store. Cheaper than a
  // global cache invalidator and matches what users expect when changing
  // accounts.
  setTimeout(() => window.location.reload(), 30);
}

/** Subscribe-able read of which platform's store is currently active.
 * Used by pages to swap WeChat-specific labels (朋友圈) for QQ equivalents
 * (动态) and hide sections that have no QQ counterpart. Returns null while
 * the first /api/profiles fetch is in flight. */
export function useActivePlatform(): 'wechat' | 'qq' | null {
  const [platform, setPlatform] = useState<'wechat' | 'qq' | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const r = await getProfiles();
        if (!cancelled) setPlatform(r.active_platform || null);
      } catch {/* backend booting — useProfiles below will retry */}
    };
    fetch();
    const onChange = () => fetch();
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => { cancelled = true; window.removeEventListener(CHANGE_EVENT, onChange); };
  }, []);
  return platform;
}

const PROFILE_RETRY_ATTEMPTS = 40;
const PROFILE_RETRY_DELAY_MS = 1500;
const PROFILE_NUDGE_MIN_MS = 2000;

export function useProfiles(): {
  profiles: ProfileEntry[] | null;
  active: ActiveProfile | null;
  refresh: () => Promise<void>;
  loading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<ProfilesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      setLoading(true);
      const d = await getProfiles();
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  // The sidebar mounts this once at startup, often before etcli is listening
  // (same boot race as Home.tsx), so keep retrying quietly for about a minute:
  // `loading` stays true and `error` is only reported once we give up.
  // The sidebar never unmounts, so it also re-reads the list when the user
  // navigates (hashchange) or comes back to the window (visibilitychange) —
  // each of those resets the retry budget, so a backend that came up late
  // (or an account added elsewhere) is picked up instead of the sidebar
  // being stuck on 「添加账号」 after the first 40 failures.
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let attempt = 0;
    let hasData = false;
    let inFlight = false;
    let lastStart = 0;
    const load = async (quiet = false) => {
      inFlight = true;
      lastStart = Date.now();
      // A background re-read keeps showing the list it already has.
      if (!quiet || !hasData) setLoading(true);
      try {
        const d = await getProfiles();
        if (disposed) return;
        attempt = 0;
        hasData = true;
        setData(d);
        setError(null);
        setLoading(false);
      } catch (e: any) {
        if (disposed) return;
        if (quiet && hasData) { setLoading(false); return; }  // keep the old list
        if (++attempt < PROFILE_RETRY_ATTEMPTS) {
          timer = window.setTimeout(() => void load(), PROFILE_RETRY_DELAY_MS);
          return;
        }
        setError(e?.message || String(e));
        setLoading(false);
      } finally {
        inFlight = false;
      }
    };
    const restart = (quiet: boolean) => {
      window.clearTimeout(timer);
      attempt = 0;
      void load(quiet);
    };
    void load();
    const onChange = () => restart(false);
    // Navigation / window focus: re-read at most every 2 s, never on top of
    // a request that is still running.
    const onNudge = () => {
      if (inFlight || Date.now() - lastStart < PROFILE_NUDGE_MIN_MS) return;
      restart(true);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') onNudge(); };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('hashchange', onNudge);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('hashchange', onNudge);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const visibleProfiles = data?.profiles
    ? (supportsQQOnboarding() ? data.profiles : data.profiles.filter(p => p.platform !== 'qq'))
    : null;
  const activeProfile = visibleProfiles?.find(p => p.is_active) ?? visibleProfiles?.[0] ?? null;
  const active: ActiveProfile | null = activeProfile
    ? { platform: activeProfile.platform, id: activeProfile.id }
    : null;

  return {
    profiles: visibleProfiles,
    active,
    refresh,
    loading,
    error,
  };
}
