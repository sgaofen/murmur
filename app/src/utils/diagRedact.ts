// Scrub personal identifiers out of diagnostics text before the user copies
// it into a public GitHub issue. Always on — independent of privacy mode.
//
// Front-end port of cli/diag_redact.py (same rule set and placeholders, minus
// the home-dir lookup: the webview doesn't know $HOME, so every user-name
// path segment is replaced instead). Shared cases live in
// tests/fixtures/diag_redact_cases.json and are checked against both
// implementations by tests/test_diag_redact_frontend.py.
//
// Pure, synchronous, dependency-free and erasable-syntax-only so the test can
// load it with `node --experimental-strip-types` / `bun`. No regex
// lookbehind: older WKWebView (Safari < 16.4) throws on it at parse time.

export interface RedactOptions {
  /** Extra literal strings (nicknames, remarks) to blank out wherever they appear. */
  names?: Iterable<string>;
}

/** Short stable tag so the same id maps to the same placeholder within and
 * across bundles without revealing it (FNV-1a 32-bit, 4 hex chars). */
function tag(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 4);
}

// Order matters: hex first (a 64-hex key inside a path is gone before the
// path rules run), then ids, then free-form numbers.
const HEX_RE = /(^|[^0-9A-Za-z])(?:0x)?([0-9a-fA-F]{32,})(?![0-9A-Za-z])/g;
const WXID_RE = /wxid_[A-Za-z0-9_-]+/g;
const CHATROOM_RE = /\b(\d{5,})@chatroom\b/g;
const ACCT_DIR_RE = /((?:xwechat_files|WeChat Files)[\\/]+)([^\\/\s`'"]+)/g;
const TENCENT_QQ_RE = /(Tencent Files[\\/]+)(\d{5,12})/g;
const QQ_PREFIX_RE = /\b(qq[:_ ]?|QQ ?)(\d{5,12})\b/gi;
const PHONE_RE = /(^|\D)(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const NICK_FIELD_RE = /(["']?(?:nick_?name|nickname|remark|display_name|昵称|备注)["']?\s*[:=：]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}\]）)]+)/gi;
// Secrets logged as fields: key=…, "passphrase": "…", password: …
const SECRET_FIELD_RE = /(["']?\b(?:key|db_key|passphrase|password|passwd|token|secret)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}\]）)]+)/gi;
// User-name segment of absolute paths. Windows names may contain spaces
// ("C:\Users\Alice Zhang\…"), so there take everything up to the next
// separator when one follows; otherwise stop at whitespace.
const USER_PATH_RES: RegExp[] = [
  /(\/Users\/)([^/\s`'"]+)/g,
  /(\/home\/)([^/\s`'"]+)/g,
  /([A-Za-z]:\\+Users\\+)([^\\\n`'":]+?(?=\\)|[^\\\s`'"]+)/gi,
  /([A-Za-z]:\/Users\/)([^/\n`'":]+?(?=\/)|[^/\s`'"]+)/gi,
];
const KEEP_USERS = new Set(['shared', 'public', 'default', 'all users', '<user>', '~']);

function maskQuotedValue(key: string, v: string, placeholder: (inner: string) => string): string {
  const q = v[0] === '"' || v[0] === "'" ? v[0] : '';
  const inner = q ? v.slice(1, -1) : v;
  if (inner === '' || inner === '-' || inner.startsWith('<')) return key + v;
  return `${key}${q}${placeholder(inner)}${q}`;
}

/** Return `text` with personal identifiers replaced by placeholders. Idempotent. */
export function redactDiagnostics(text: string, opts: RedactOptions = {}): string {
  if (!text) return text;
  let out = String(text);

  // 1. Caller-supplied literal names (longest first so substrings don't win).
  const names = [...new Set([...(opts.names ?? [])].map(n => (n || '').trim()).filter(n => n.length >= 2))]
    .sort((a, b) => b.length - a.length);
  for (const n of names) out = out.split(n).join(`<name#${tag(n)}>`);

  // 2. Long hex (keys / salts / md5s).
  out = out.replace(HEX_RE, (_m, pre: string, hex: string) => `${pre}<hex${hex.length}>`);

  // 3. User-name path segments.
  for (const rx of USER_PATH_RES) {
    out = out.replace(rx, (_m, pre: string, user: string) =>
      pre + (KEEP_USERS.has(user.toLowerCase()) ? user : '<user>'));
  }

  // 4. WeChat / QQ identifiers.
  out = out.replace(ACCT_DIR_RE, (_m, pre: string, acct: string) =>
    pre + (acct.startsWith('<') || acct.startsWith('all_users') ? acct : `<acct#${tag(acct)}>`));
  out = out.replace(WXID_RE, m => `wxid_<${tag(m)}>`);
  out = out.replace(CHATROOM_RE, m => `<room#${tag(m)}>@chatroom`);
  out = out.replace(TENCENT_QQ_RE, (_m, pre: string, qq: string) => `${pre}<qq#${tag(qq)}>`);
  out = out.replace(QQ_PREFIX_RE, (_m, pre: string, qq: string) => `${pre}<qq#${tag(qq)}>`);

  // 5. Contact info, then secret- and nickname-ish fields.
  out = out.replace(EMAIL_RE, '<email>');
  out = out.replace(PHONE_RE, (_m, pre: string) => `${pre}<phone>`);
  out = out.replace(SECRET_FIELD_RE, (_m, k: string, v: string) => maskQuotedValue(k, v, () => '<secret>'));
  out = out.replace(NICK_FIELD_RE, (_m, k: string, v: string) => maskQuotedValue(k, v, inner => `<name#${tag(inner)}>`));
  return out;
}
