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
  await setActiveProfile(p.platform, p.id);
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

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const active: ActiveProfile | null = data && data.active_id
    ? { platform: data.active_platform, id: data.active_id }
    : null;

  return {
    profiles: data?.profiles ?? null,
    active,
    refresh,
    loading,
    error,
  };
}
