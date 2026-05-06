// Privacy mode — replaces real display names and sensitive text with stable
// anonymous aliases. Used when recording demo videos / taking public screenshots.
//
// Mapping: deterministic by hashing wxid → consistent "朋友 A", "群 1" etc.
// Stored toggle in localStorage so it persists across reloads.

const STORAGE_KEY = 'murmur.privacy';

function urlRequestsPrivacy(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('privacy') === '1';
  } catch {
    return false;
  }
}

// Reactive subscribers — anyone calling subscribe() gets re-rendered when toggle flips.
type Listener = (enabled: boolean) => void;
const listeners = new Set<Listener>();
const identityAliases = new Map<string, string>();
const tokenAliases = new Map<string, string>();

let _enabled: boolean = (() => {
  try {
    if (urlRequestsPrivacy()) {
      localStorage.setItem(STORAGE_KEY, '1');
      return true;
    }
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
  // \p{L} = any letter (Latin / \u6c49\u5b57 / \u5e73\u5047 / \u7247\u5047 / \u97e9\u6587 / \u897f\u91cc\u5c14 / \u963f\u62c9\u4f2f\u2026)
  // \p{N} = any number. Previous regex hard-coded `\u4e00-\u9fff` (\u6c49\u5b57 BMP)
  // only, so \u592a\u306e \u8fd9\u79cd hiragana/\u6c49\u5b57\u6df7\u5408\u540d\u53ea\u5269\u300c\u592a\u300d\u4e00\u5b57\uff0cshouldMaskName
  // \u5224\u5b9a\u4e3a\u592a\u77ed\uff0ctoken \u4e0d\u8fdb\u8868\uff0c\u5bfc\u81f4\u6838\u5fc3\u5708\u805a\u7126 banner \u6f0f mask \u771f\u540d\u3002
  const meaningfulChars = n.replace(/[^\p{L}\p{N}]/gu, '');
  // ASCII threshold lowered 3 \u2192 2 so short pinyin / English names like
  // "Om", "Li", "Tu", "Yi" can register and get masked. False positives are
  // bounded by the maskKnownNames `(^|[^A-Za-z0-9])X(?=$|[^A-Za-z0-9])`
  // word-boundary regex \u2014 "Om" inside "Compute" still won't be replaced.
  return ascii ? meaningfulChars.length >= 2 : Array.from(meaningfulChars).length >= 2;
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

function rememberIdentity(
  wxid: string | undefined | null,
  realName: string | undefined | null,
  explicitIsGroup?: boolean,
): boolean {
  const id = wxid || realName || '?';
  const name = realName || '';
  // explicit flag (from Friend.isGroup) wins; fallback heuristic catches the
  // legacy callers that don't pass it.
  const isGroup = explicitIsGroup ?? (id.endsWith('@chatroom') || name.includes('群'));
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
  identities: Array<{ wxid?: string | null; id?: string | null; name?: string | null; realName?: string | null; isGroup?: boolean }>,
) {
  let changed = false;
  for (const item of identities) {
    changed = rememberIdentity(
      item.wxid ?? item.id,
      item.realName ?? item.name,
      item.isGroup,
    ) || changed;
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
  let masked = maskKnownNames(maskLocalPaths(String(text)))
    .replace(/wxid_[a-z0-9]+/g, m => `wxid_${(shortHash(m) % 9999).toString().padStart(4, '0')}`)
    .replace(/(?:gh_|openim_)[a-z0-9_-]+/gi, m => `id_${shortHash(m) % 9999}`)
    .replace(/[a-z0-9_-]+@chatroom/gi, m => `group_${shortHash(m) % 999}`)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, m => `email_${shortHash(m) % 999}`)
    .replace(/\b[a-f0-9]{64}\b/gi, 'key_已隐藏')
    // Chinese ID card (18-digit, last char may be X)
    .replace(/\b\d{17}[\dXx]\b/g, m => `id卡_${shortHash(m) % 999}`)
    // Bank card / long digit string (15-19 digits, common credit/debit lengths)
    .replace(/\b\d{15,19}\b/g, m => `卡号_${shortHash(m) % 999}`)
    .replace(/(^|[^\d])(\+?\d[\d -]{6,}\d)(?!\d)/g, (_m, prefix, num) => `${prefix}num_${shortHash(num) % 9999}`);

  // AI 报告里经常引用「未注册的人名」 — 朋友的家人、朋友的朋友、对话里
  // 提到的第三方等。这些名字不在你的 WeChat 好友列表，所以 maskKnownNames
  // 找不到。下面两条规则用「引号 + 短长度」做启发式 mask：
  //   - 「2-4 个汉字」→ 人名_NN（hash 稳定，相同名同 alias）
  //   - 「短英文/拼音名」→ 同样
  // 只针对引号包裹的短串，避免把 "「我有一句话很长很长…」" 这种长引文也炸掉。
  masked = masked.replace(/「([^」]{2,4})」/g, (m, inner) => {
    // 仅当 inner 看起来是名字（纯汉字 OR 首字母大写英文）且不含标点
    if (/[。？！，、；：…]/.test(inner)) return m;
    if (/^[一-鿿]{2,4}$/.test(inner)) return `「人名_${shortHash(inner) % 99}」`;
    if (/^[A-Z][a-zA-Z]{1,3}(?:\s[A-Z][a-zA-Z]+)?$/.test(inner)) return `「人名_${shortHash(inner) % 99}」`;
    return m;
  });
  return masked;
}
