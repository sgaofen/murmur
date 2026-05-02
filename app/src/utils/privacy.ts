// Privacy mode — replaces real display names with stable anonymous aliases.
// Used when recording demo videos / taking public screenshots.
//
// Mapping: deterministic by hashing wxid → consistent "朋友 A", "群 1" etc.
// Stored toggle in localStorage so it persists across reloads.

const STORAGE_KEY = 'murmur.privacy';

// Reactive subscribers — anyone calling subscribe() gets re-rendered when toggle flips.
type Listener = (enabled: boolean) => void;
const listeners = new Set<Listener>();

let _enabled: boolean = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
})();

export function isPrivacyMode(): boolean {
  return _enabled;
}

export function setPrivacyMode(v: boolean) {
  _enabled = v;
  try {
    localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
  } catch {
    // localStorage can be unavailable in hardened/private webview contexts.
  }
  for (const l of listeners) l(v);
}

export function togglePrivacyMode() {
  setPrivacyMode(!_enabled);
}

export function subscribePrivacy(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Stable hash → small int → A-Z+
function shortHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

const FRIEND_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function aliasFor(wxid: string, isGroup: boolean): string {
  const h = shortHash(wxid);
  if (isGroup) return `群 ${(h % 99) + 1}`;
  // Two-letter alias so we have 676 unique slots
  if (wxid === 'self') return '你';
  const a = FRIEND_LETTERS[h % 26];
  const b = FRIEND_LETTERS[Math.floor(h / 26) % 26];
  return `朋友 ${a}${b}`;
}

/** Get the display name to show — real if privacy off, alias if on. */
export function displayName(wxid: string | undefined | null, realName: string | undefined | null): string {
  if (!_enabled) return realName || wxid || '?';
  if (!wxid) return aliasFor(realName || '?', false);
  if (wxid === 'self' || wxid === '你') return '你';
  const isGroup = wxid.endsWith('@chatroom') || (realName || '').includes('群');
  return aliasFor(wxid, isGroup);
}

/** Mask a wxid string itself (for the small "wxid_xxx" badge in panels). */
export function maskedWxid(wxid: string): string {
  if (!_enabled) return wxid;
  if (wxid === 'self') return 'self';
  if (wxid.endsWith('@chatroom')) return `group_${shortHash(wxid) % 999}`;
  return `wxid_${(shortHash(wxid) % 9999).toString().padStart(4, '0')}`;
}

/** Mask a string like a chat message preview: replace any embedded wxid_xxx pattern. */
export function maskText(text: string): string {
  if (!_enabled || !text) return text;
  return text
    .replace(/wxid_[a-z0-9]+/g, m => `wxid_${(shortHash(m) % 9999).toString().padStart(4, '0')}`)
    .replace(/\d{8,11}@chatroom/g, m => `group_${shortHash(m) % 999}`)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, m => `email_${shortHash(m) % 999}`)
    .replace(/(^|[^\d])(\+?\d[\d -]{6,}\d)(?!\d)/g, (_m, prefix, num) => `${prefix}num_${shortHash(num) % 9999}`);
}
