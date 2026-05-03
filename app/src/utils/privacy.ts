// Privacy mode — replaces real display names and sensitive text with stable
// anonymous aliases. Used when recording demo videos / taking public screenshots.
//
// Mapping: deterministic by hashing wxid → consistent "朋友 A", "群 1" etc.
// Stored toggle in localStorage so it persists across reloads.

const STORAGE_KEY = 'murmur.privacy';

// Reactive subscribers — anyone calling subscribe() gets re-rendered when toggle flips.
type Listener = (enabled: boolean) => void;
const listeners = new Set<Listener>();
const identityAliases = new Map<string, string>();
const tokenAliases = new Map<string, string>();

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeName(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function isAsciiText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

function shouldMaskName(name: string): boolean {
  const n = normalizeName(name);
  if (!n) return false;
  const lower = n.toLowerCase();
  if ([
    'self', 'me', 'you', 'unknown', 'none', 'null', 'undefined',
    'murmur', 'wechat', 'weixin', 'claude', 'codex', 'chatgpt',
    'friends', 'pairs', 'report', 'reports',
  ].includes(lower)) return false;
  if (n === '你' || n === '我' || n === '自己') return false;
  if (/^(wxid_|gh_|openim_|group_)/i.test(n) || n.endsWith('@chatroom')) return false;
  const ascii = isAsciiText(n);
  const meaningfulChars = n.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '');
  return ascii ? meaningfulChars.length >= 3 : Array.from(meaningfulChars).length >= 2;
}

function nameVariants(name: string): string[] {
  const n = normalizeName(name);
  if (!n) return [];
  const variants = new Set<string>([
    n,
    n.replace(/_/g, ' '),
    n.replace(/\s+/g, '_'),
    n.replace(/[._-]+/g, ' '),
  ]);
  const compact = n.replace(/\s+/g, '');
  if (compact !== n) variants.add(compact);
  return [...variants].map(normalizeName).filter(shouldMaskName);
}

function rememberIdentity(wxid: string | undefined | null, realName: string | undefined | null): boolean {
  const id = wxid || realName || '?';
  const name = realName || '';
  const isGroup = id.endsWith('@chatroom') || name.includes('群');
  const alias = aliasFor(id, isGroup);
  let changed = false;

  if (wxid && identityAliases.get(wxid) !== alias) {
    identityAliases.set(wxid, alias);
    changed = true;
  }
  for (const token of nameVariants(name)) {
    if (tokenAliases.get(token) !== alias) {
      tokenAliases.set(token, alias);
      changed = true;
    }
  }
  return changed;
}

function notifyPrivacySubscribers() {
  for (const l of listeners) l(_enabled);
}

export function registerIdentity(
  wxid: string | undefined | null,
  realName: string | undefined | null,
) {
  if (rememberIdentity(wxid, realName) && _enabled) notifyPrivacySubscribers();
}

export function registerIdentities(
  identities: Array<{ wxid?: string | null; id?: string | null; name?: string | null; realName?: string | null }>,
) {
  let changed = false;
  for (const item of identities) {
    changed = rememberIdentity(item.wxid ?? item.id, item.realName ?? item.name) || changed;
  }
  if (changed && _enabled) notifyPrivacySubscribers();
}

/** Get the display name to show — real if privacy off, alias if on. */
export function displayName(wxid: string | undefined | null, realName: string | undefined | null): string {
  rememberIdentity(wxid, realName);
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

function maskKnownNames(text: string): string {
  let out = text;
  const tokens = [...tokenAliases.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [token, alias] of tokens) {
    const escaped = escapeRegExp(token);
    const ascii = isAsciiText(token);
    if (ascii) {
      out = out.replace(
        new RegExp(`(^|[^A-Za-z0-9])(${escaped})(?=$|[^A-Za-z0-9])`, 'gi'),
        (_m, prefix) => `${prefix}${alias}`,
      );
    } else {
      out = out.replace(new RegExp(escaped, 'g'), alias);
    }
  }
  return out;
}

function maskLocalPaths(text: string): string {
  return text
    .replace(/\/Users\/[^/\s"'<>]+\/[^\s"'<>)]*/g, '~/本机路径')
    .replace(/[A-Z]:\\Users\\[^\\\s"'<>]+\\[^\s"'<>)]*/gi, '本机路径')
    .replace(/[A-Z]:[\\/][^\s"'<>)]*(?:xwechat_files|Documents[\\/]Murmur|Desktop[\\/]Murmur)[^\s"'<>)]*/gi, '本机路径')
    .replace(/(?:~\/)?(?:Desktop|Documents)\/Murmur\/[^\s"'<>)]*/g, 'Murmur/隐藏路径')
    .replace(/(?:agent_reports|decrypted|logs)[\\/][^\s"'<>)]*/g, '隐藏路径');
}

/** Mask any user-visible text: messages, reports, logs, paths, and exports. */
export function maskText(text: string): string {
  if (!_enabled || !text) return text;
  const masked = maskKnownNames(maskLocalPaths(String(text)))
    .replace(/wxid_[a-z0-9]+/g, m => `wxid_${(shortHash(m) % 9999).toString().padStart(4, '0')}`)
    .replace(/(?:gh_|openim_)[a-z0-9_-]+/gi, m => `id_${shortHash(m) % 9999}`)
    .replace(/[a-z0-9_-]+@chatroom/gi, m => `group_${shortHash(m) % 999}`)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, m => `email_${shortHash(m) % 999}`)
    .replace(/\b[a-f0-9]{64}\b/gi, 'key_已隐藏')
    .replace(/(^|[^\d])(\+?\d[\d -]{6,}\d)(?!\d)/g, (_m, prefix, num) => `${prefix}num_${shortHash(num) % 9999}`);
  return masked;
}
