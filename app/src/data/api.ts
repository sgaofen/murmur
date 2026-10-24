// Backend bridge — real fetch from etcli serve.
// In production: Tauri shell auto-spawns the bundled etcli.exe on startup.
// In dev: run `python3 cli/etcli.py serve --port 9100` (or `bash start-mac.sh` / `start-windows.bat`).
import type { Friend, FriendStats, HomeSummary, Moment } from './types';

// Use 127.0.0.1 instead of localhost — macOS WKWebView in sandboxed .app context
// treats `localhost` as a "local network" hostname that requires the (new in macOS
// Sequoia) Local Network privacy permission, while a direct IP loopback is exempt.
// Fixes "Could not connect to the server" / "Load failed" in production .app builds.
export const API_BASE = (import.meta.env?.VITE_ETCLI_URL as string) || 'http://127.0.0.1:9100';

/** Error thrown for non-2xx responses (and unreachable backend). `message`
 * keeps the historical `API <path>: <status> <body>` shape so existing
 * string checks keep working; `code` is the stable backend error code
 * (cli/error_codes.py → data/errorCatalog.ts) when the body carried one. */
export class ApiError extends Error {
  code: string | null;
  status: number;
  /** Original `error` text from the JSON body, if any. */
  raw: string | null;
  constructor(message: string, opts: { code?: string | null; status?: number; raw?: string | null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = opts.code ?? null;
    this.status = opts.status ?? 0;
    this.raw = opts.raw ?? null;
  }
}

/** Stable error code from anything a request can throw or return:
 * ApiError, a JSON payload with `code`, or null when unknown. */
export function errorCode(e: unknown): string | null {
  if (!e || typeof e !== 'object') return null;
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' && c ? c : null;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, init);
  } catch (e) {
    // Network-level failure (backend not running / connection refused).
    const msg = e instanceof Error ? e.message : String(e);
    throw new ApiError(`API ${path}: ${msg}`, { code: 'BACKEND_UNREACHABLE', raw: msg });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code: string | null = null;
    let raw: string | null = null;
    try {
      const body = JSON.parse(text);
      if (body && typeof body === 'object') {
        code = typeof body.code === 'string' ? body.code : null;
        raw = typeof body.error === 'string' ? body.error : null;
      }
    } catch {
      // Non-JSON body — leave code/raw empty.
    }
    // The app lock engaged (idle timeout, another window, backend restart):
    // let AppLockGate swap the UI for the lock screen.
    if (res.status === 423 && code === 'APP_LOCKED') {
      window.dispatchEvent(new Event('murmur:app-locked'));
    }
    throw new ApiError(`API ${path}: ${res.status} ${text.slice(0, 200)}`, { code, status: res.status, raw });
  }
  return res.json();
}

export interface InfoResponse {
  data_dir?: string;
  self_wxid?: string;
  account_id?: string;
  platform?: 'wechat' | 'qq';
  active_id?: string | null;
  version?: string;
  bootstrap?: boolean;
  message?: string;
  reason?: string;
  // Last EchoStore/QQStore init exception, surfaced so OnboardingDialog
  // shows the real cause instead of silently looping back to extract-key.
  init_error?: string | null;
  /** Stable code for init_error (see data/errorCatalog.ts). */
  init_error_code?: string | null;
}

// Cross-platform profile listing — drives the ProfileSwitcher.
export interface ProfileEntry {
  id: string;                 // 'wxid_xxx' for WeChat, 'qq:939919010' for QQ
  platform: 'wechat' | 'qq';
  display_id: string;         // already masked: 'wxid_n…97a5' / 'QQ 939…010'
  // Surfaced from xwechat_files/all_users/config/global_config — raw nickname
  // and avatar URL pulled by cli/global_config.py. Empty string when the file
  // doesn't exist or this profile isn't the active account in that file.
  nick_name?: string;
  head_img_url?: string;
  qq_number: string | null;
  n_sessions: number;
  last_active_ts: number | null;
  state: 'ready' | 'needs_decrypt' | 'needs_key' | 'extracting';
  is_active: boolean;
}
export interface ProfilesResponse {
  active_platform: 'wechat' | 'qq';
  active_id: string | null;
  profiles: ProfileEntry[];
}
export async function getProfiles(): Promise<ProfilesResponse> {
  return j('/api/profiles');
}
export async function setActiveProfile(platform: 'wechat' | 'qq', id: string): Promise<{
  ok: boolean; active_platform?: string; active_id?: string; error?: string;
}> {
  return j('/api/active-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, id }),
  });
}

export async function getInfo(): Promise<InfoResponse> {
  return j('/api/info');
}

export interface LogTailResponse {
  logs_dir: string;
  serve: string;
  tauri_shell: string;
}

export async function getLogTail(lines = 80): Promise<LogTailResponse> {
  return j(`/api/log-tail?lines=${encodeURIComponent(String(lines))}`);
}

export async function getTauriLogTail(lines = 80): Promise<LogTailResponse | null> {
  try {
    const invoke = (window as any).__TAURI__?.core?.invoke;
    if (!invoke) return null;
    return await invoke('read_log_tail', { lines });
  } catch {
    return null;
  }
}

export interface Diagnose {
  platform: 'windows' | 'macos' | 'linux';
  python: string;
  capabilities: {
    can_decrypt_db: boolean;
    can_extract_key: boolean;
    can_extract_image_key: boolean;
    has_wechat_installed: boolean;
    has_wechat_data: boolean;
    sip_enabled?: boolean | null;
    weixin_running?: boolean | null;
    wechat_hardened?: boolean | null;
    tcc_blocked?: boolean | null;
  };
  profiles: Array<{
    wxid: string;
    wxid_short: string;
    encrypted_root: string;
    decrypted_root: string;
    has_decrypted_data: boolean;
  }>;
  saved_key: boolean;
  agents_found: number;
  notes: string[];
  wechat_exe: string | null;
  murmur_home: string;
  wechat_search_roots?: string[];
  /** macOS only: CFBundleShortVersionString of WeChat.app, e.g. "4.1.22". */
  wechat_version?: string | null;
  /** macOS only: whether live capture (Frida) is the recommended key path. */
  live_key?: { recommended: boolean; frida: FridaStatus } | null;
  /** macOS only: Frida-free private-copy capture — `available` once the
   * capture dylib (murmur_keycap.dylib) is built / bundled. */
  private_copy?: { available: boolean; copy_exists: boolean } | null;
}

export async function getDiagnose(): Promise<Diagnose> {
  return j('/api/diagnose');
}

/** One-shot pre-formatted markdown for users to paste into a GitHub issue.
 * Includes version, platform, profiles, masked paths, init_error, and the
 * tail of both log files. See cli/etcli.py:_build_diag_bundle for shape. */
export async function getDiagBundle(): Promise<{ markdown: string }> {
  return j('/api/diag-bundle');
}

export interface LocalAgent {
  cli: string;
  name: string;
  vendor: string;
  version: string;
  path: string;
}

export async function getAgents(): Promise<LocalAgent[]> {
  return j('/api/agents');
}

export async function invokeAgent(opts: { cli: string; wxid: string; sample?: number }): Promise<{
  ok: boolean; queued?: boolean; wxid?: string; message?: string; error?: string;
}> {
  return j('/api/agents/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export async function getInvokeStream(wxid: string): Promise<{
  running: boolean; output: string; error: string | null; stage: string; elapsed: number;
}> {
  return j('/api/agents/invoke-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wxid }),
  });
}

export async function getHomeSummary(): Promise<HomeSummary> {
  return j('/api/home-summary');
}

export async function getAllFriends(opts: { kind?: 'all' | 'private' | 'group'; q?: string } = {}): Promise<Friend[]> {
  const params = new URLSearchParams();
  if (opts.kind) params.set('type', opts.kind);
  if (opts.q) params.set('q', opts.q);
  const qs = params.toString();
  return j(`/api/friends${qs ? '?' + qs : ''}`);
}

export async function getFriend(id: string): Promise<Friend & { stats: FriendStats | null }> {
  return j(`/api/friend/${encodeURIComponent(id)}`);
}

export async function getFriendStats(id: string): Promise<FriendStats> {
  const f = await getFriend(id);
  if (!f.stats) throw new Error('No stats: friend has no messages');
  return f.stats;
}

export async function getMoments(id: string, n = 4): Promise<Moment[]> {
  return j(`/api/friend/${encodeURIComponent(id)}/moments?n=${n}`);
}

export interface ChatMessage {
  ts: number;
  time: string;
  from: string;       // human-readable display name ("你" / 备注 / 昵称)
  from_id: string;    // stable wxid identifier ("self" or wxid_xxx)
  text: string;
  type: string;
}

export async function getMessages(id: string, opts: { limit?: number } = {}): Promise<ChatMessage[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  return j(`/api/friend/${encodeURIComponent(id)}/messages${params.toString() ? '?' + params : ''}`);
}

// ---- Global message search (backend: cli/search_index.py, docs/API_SEARCH.md) ----
// Results carry raw names/text: the backend does not apply privacy mode, so
// callers must run names and snippet segments through utils/privacy.

export type SearchIndexMode = 'fts5_trigram' | 'like';

export interface SearchIndexStatus {
  platform: 'wechat' | 'qq';
  account: string;
  mode: SearchIndexMode;
  state: 'empty' | 'building' | 'ready' | 'error';
  phase: '' | 'scanning' | 'indexing' | 'done';
  full_rebuild: boolean;
  done: number;
  total: number;
  percent: number;
  indexed_messages: number;
  sources: number;
  last_built_at: number | null;   // unix seconds
  last_error: string | null;
  short_query_note: string;
  auto_started?: boolean;         // only on GET /api/search/status
}

export interface SearchHit {
  platform: 'wechat' | 'qq';
  chat: string;                   // session username (wxid / xxx@chatroom / QQ uid)
  chat_name: string;
  is_group: boolean;
  sender: string;                 // "self" or wxid / QQ uid
  sender_name: string;
  ts: number;
  time: string;                   // ISO, China time
  type: string;                   // label: text / share / ...
  type_code: number;
  snippet: string;
  segments: { text: string; hit: boolean }[];
  highlights: [number, number][]; // UTF-16 offsets into snippet
  locator: {
    db: string;                   // message_N.db / nt_msg.db
    table: string;                // Msg_<md5> / c2c_msg_table / group_msg_table
    local_id: number;             // WeChat local_id, QQ rowid
    server_id: string | null;     // string to keep int64 precision
  };
}

export interface SearchResponse {
  query: string;
  terms: string[];
  mode: SearchIndexMode;
  match: 'fts' | 'like' | 'fts+like';
  total: number;
  limit: number;
  offset: number;
  results: SearchHit[];
  index: SearchIndexStatus;
}

export interface SearchParams {
  q: string;
  chat?: string | string[];
  sender?: string | string[];
  from?: string | number;         // unix seconds or YYYY-MM-DD
  to?: string | number;           // date-only means end of that day
  type?: string | string[];       // labels (text, share, ...) or numeric codes
  limit?: number;                 // 1..200, default 50
  offset?: number;
}

export async function searchMessages(p: SearchParams): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: p.q });
  const list = (v?: string | string[]) => (Array.isArray(v) ? v.join(',') : v);
  const chat = list(p.chat);
  const sender = list(p.sender);
  const type = list(p.type);
  if (chat) params.set('chat', chat);
  if (sender) params.set('sender', sender);
  if (type) params.set('type', type);
  if (p.from !== undefined && p.from !== '') params.set('from', String(p.from));
  if (p.to !== undefined && p.to !== '') params.set('to', String(p.to));
  if (p.limit) params.set('limit', String(p.limit));
  if (p.offset) params.set('offset', String(p.offset));
  return j(`/api/search?${params}`);
}

export async function getSearchStatus(): Promise<SearchIndexStatus> {
  return j('/api/search/status');
}

export async function rebuildSearchIndex(): Promise<SearchIndexStatus & { ok: boolean; started: boolean; queued: boolean }> {
  return j('/api/search/rebuild', { method: 'POST' });
}

// ---- Optional on-device semantic search (backend: cli/semantic_index.py) ----
// Off by default; needs `pip install -r requirements-semantic.txt` plus a
// one-time model download the user must start explicitly. Never calls a
// cloud API. Same privacy rule as keyword search: apply maskText/displayName.

export type SemanticState =
  | 'not_installed'   // optional Python deps missing → show install_hint
  | 'disabled'        // user hasn't turned it on
  | 'model_missing'   // show model.size_bytes + repo, ask before downloading
  | 'downloading'
  | 'empty'           // ready, but no index built yet
  | 'building'
  | 'ready'
  | 'error';

export interface SemanticMirror {
  id: string;                     // 'huggingface' | 'hf-mirror' | 'custom'
  label: string;
  endpoint: string;
}

export interface SemanticIndexStatus {
  state: 'empty' | 'building' | 'ready' | 'error';
  phase: '' | 'keyword_index' | 'planning' | 'embedding' | 'done';
  full_rebuild: boolean;
  done: number;                   // messages processed in this pass
  total: number;
  percent: number;
  chunks: number;
  indexed_messages: number;
  last_built_at: number | null;   // unix seconds
  last_error: string | null;
  stale: boolean;                 // keyword index rebuilt since; next incremental pass re-embeds
}

export interface SemanticStatus {
  state: SemanticState;
  message: string;                // Chinese, ready to show
  installed: boolean;
  missing_deps: string[];
  install_hint: string;
  enabled: boolean;
  mirror: string;
  mirrors: SemanticMirror[];
  model: {
    id: string;
    name: string;
    repo: string;
    revision: string;
    license: string;
    homepage: string;
    size_bytes: number;
    files: { path: string; size: number; sha256: string }[];
    downloaded: boolean;
    dir: string;
  };
  download: {
    state: 'idle' | 'downloading' | 'done' | 'error';
    mirror: string | null;
    file: string | null;
    done_bytes: number;
    total_bytes: number;
    error: string | null;
    finished_at: number | null;
  };
  local_only: true;
  index: SemanticIndexStatus | null;  // null before decrypted data exists
}

export interface SemanticChunkMessage {
  sender: string;
  sender_name: string;
  ts: number;
  time: string;
  type: string;
  text: string;
  locator: SearchHit['locator'];
}

export interface SemanticSearchHit extends SearchHit {
  score: number;                  // cosine similarity, higher = closer
  chunk: {
    id: number;
    ts_start: number;
    ts_end: number;
    message_count: number;
    anchor_index: number;         // which of `messages` the hit points at
    messages: SemanticChunkMessage[];
  };
}

export interface SemanticSearchResponse extends Omit<SearchResponse, 'mode' | 'match' | 'results' | 'index'> {
  mode: 'semantic';
  match: 'semantic';
  model: string;
  results: SemanticSearchHit[];
  index: SemanticIndexStatus;
}

export interface SemanticSearchParams extends Omit<SearchParams, 'type' | 'limit'> {
  limit?: number;                 // 1..100, default 20
  minScore?: number;
}

/** Thrown when semantic search isn't usable (HTTP 409); carries the status. */
export class SemanticUnavailableError extends Error {
  status: SemanticStatus;
  constructor(message: string, status: SemanticStatus) {
    super(message);
    this.name = 'SemanticUnavailableError';
    this.status = status;
  }
}

async function semanticJ<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, init);
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    if (body && body.status) throw new SemanticUnavailableError(body.message || '语义搜索不可用', body.status);
    throw new Error(`API ${path}: 409`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export async function getSemanticStatus(): Promise<SemanticStatus> {
  return j('/api/search/semantic/status');
}

export async function setSemanticSettings(
  s: { enabled?: boolean; mirror?: string },
): Promise<SemanticStatus & { ok: boolean }> {
  return j('/api/search/semantic/settings', postJson(s));
}

/** Starts the model download — only after the user confirmed size + source. */
export async function downloadSemanticModel(
  mirror?: string,
): Promise<SemanticStatus & { ok: boolean; started: boolean; already_running: boolean }> {
  return semanticJ('/api/search/semantic/download', postJson(mirror ? { mirror } : {}));
}

export async function buildSemanticIndex(
  full = false,
): Promise<SemanticStatus & { ok: boolean; started: boolean; queued: boolean }> {
  return semanticJ('/api/search/semantic/build', postJson({ full }));
}

export async function searchSemantic(p: SemanticSearchParams): Promise<SemanticSearchResponse> {
  const params = new URLSearchParams({ q: p.q, mode: 'semantic' });
  const list = (v?: string | string[]) => (Array.isArray(v) ? v.join(',') : v);
  const chat = list(p.chat);
  const sender = list(p.sender);
  if (chat) params.set('chat', chat);
  if (sender) params.set('sender', sender);
  if (p.from !== undefined && p.from !== '') params.set('from', String(p.from));
  if (p.to !== undefined && p.to !== '') params.set('to', String(p.to));
  if (p.limit) params.set('limit', String(p.limit));
  if (p.offset) params.set('offset', String(p.offset));
  if (p.minScore !== undefined) params.set('min_score', String(p.minScore));
  return semanticJ(`/api/search?${params}`);
}

export async function indexMedia(): Promise<{
  ok: boolean; total?: number; indexed?: number; existing?: number; ms?: number; details?: string; error?: string;
}> {
  return j('/api/media/index', { method: 'POST' });
}

export interface RefreshResult {
  ok: boolean;
  ms: number;
  details: string;
  // Set when the decrypt subprocess returned 0 but the post-decrypt store
  // re-init still threw — caller should treat success+init_error as failure.
  init_error?: string | null;
  /** Stable error code when !ok or init_error is set (data/errorCatalog.ts). */
  code?: string | null;
}

export interface RefreshOpts {
  // Pass --force so the per-account decrypted dir is wiped before decrypt.
  // Used after WeChat schema upgrades; "encrypted database is malformed" etc.
  force?: boolean;
}

export async function refreshData(opts: RefreshOpts = {}): Promise<RefreshResult> {
  return j('/api/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

// 实时同步 (WeChat only): backend polls the encrypted DBs and re-decrypts
// the ones whose .db / -wal changed. Off by default.
export interface LiveSyncStatus {
  enabled: boolean;
  interval: number;           // seconds between polls
  min_interval: number;
  max_interval: number;
  running: boolean;
  syncing: boolean;
  last_check_ts: number | null;
  last_sync_ts: number | null;   // last time a changed DB was re-decrypted
  last_new_messages: number;
  last_synced_dbs: string[];
  last_duration_ms: number | null;
  last_error: string | null;
  total_new_messages: number;
  sync_count: number;
  platforms: string[];
  active_platform: 'wechat' | 'qq';
  available: boolean;            // a decrypted WeChat store exists
}

export async function getLiveSyncStatus(): Promise<LiveSyncStatus> {
  return j('/api/live-sync/status');
}

export async function setLiveSync(opts: { enabled?: boolean; interval?: number }): Promise<LiveSyncStatus & { ok: boolean }> {
  return j('/api/live-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export async function generateAIPack(id: string, opts: { sample?: number } = {}): Promise<{
  ok: boolean; path: string; size: number; name: string; content: string;
}> {
  return j(`/api/friend/${encodeURIComponent(id)}/analyze-pack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export async function extractKey(opts: { autoRestart?: boolean; timeout?: number } = {}): Promise<{
  ok: boolean; key?: string; mac_keys_count?: number; ms?: number; log?: string;
  /** Stable error code when !ok (data/errorCatalog.ts). */
  code?: string | null;
  /** macOS: number of encrypted DBs found on disk. */
  total_dbs?: number;
  /** macOS: memory scan missed some/all DBs — offer live capture (Frida). */
  suggest_live?: boolean;
}> {
  return j('/api/extract-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auto_restart: opts.autoRestart ?? true,
      timeout: opts.timeout ?? 90,
    }),
  });
}

// ---- macOS live key capture (Frida hook on CommonCrypto, WeChat 4.1.9+) ----

export interface FridaStatus {
  installed: boolean;
  version: string | null;
  /** false in the packaged app — frida must be bundled there or run via CLI. */
  installable: boolean;
  frozen: boolean;
}

export type LiveKeyPhase = 'idle' | 'starting' | 'auth' | 'attaching' | 'capturing' | 'waiting-wechat' | 'done' | 'error';

export interface LiveKeyJob {
  running: boolean;
  phase: LiveKeyPhase;
  seconds: number;
  remaining: number | null;
  /** encrypted DBs on disk */
  total: number;
  /** DBs that already had a working key before this round */
  known: number;
  /** known + matched this round */
  matched_count: number;
  /** DBs matched this round (relative paths) */
  new: string[];
  hits: number;
  /** account passphrase seen in CCKeyDerivationPBKDF — every DB key derived from it */
  passphrase_found: boolean;
  elevated: boolean;
  /** 'frida-missing' | 'attach-denied' | 'auth-cancelled' | 'exit-N' | free text */
  error: string | null;
  /** Stable code for `error` (data/errorCatalog.ts). */
  code?: string | null;
  log: string;
  round: number;
}

export interface LiveKeyStatus {
  platform_ok: boolean;
  frida: FridaStatus;
  install: { running: boolean; ok: boolean | null; log: string };
  job: LiveKeyJob;
  /** pending = DBs (relative paths) that still have no working key */
  coverage?: { total: number; known: number; pending?: string[]; error?: string };
}

export async function getLiveKeyStatus(opts: { coverage?: boolean } = {}): Promise<LiveKeyStatus> {
  return j(`/api/live-key/status${opts.coverage ? '?coverage=1' : ''}`);
}

export async function startLiveKey(seconds: number): Promise<{
  ok: boolean; started?: boolean; complete?: boolean; already_running?: boolean; error?: string; code?: string;
}> {
  return j('/api/live-key/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seconds }),
  });
}

export async function cancelLiveKey(): Promise<{ ok: boolean }> {
  return j('/api/live-key/cancel', { method: 'POST' });
}

export async function installFrida(): Promise<{ ok: boolean; started?: boolean; already_running?: boolean; error?: string; code?: string }> {
  return j('/api/live-key/install-frida', { method: 'POST' });
}

// ---- macOS Frida-free / root-free capture (private WeChat copy) ----

export type PrivateCopyPhase =
  | 'idle' | 'starting' | 'copying' | 'launching' | 'capturing' | 'done' | 'error';

export interface PrivateCopyJob {
  running: boolean;
  phase: PrivateCopyPhase;
  seconds: number;
  remaining: number | null;
  total: number;
  known: number;
  matched_count: number;
  new: string[];
  passphrase_found: boolean;
  /** 'no-keys' | free text */
  error: string | null;
  log: string;
  round: number;
  /** a private WeChat copy is on disk (can be deleted) */
  copy_exists: boolean;
  /** the capture dylib was built / bundled */
  dylib_available: boolean;
}

export interface PrivateCopyStatus {
  platform_ok: boolean;
  job: PrivateCopyJob;
  coverage?: { total: number; known: number; pending?: string[]; error?: string };
}

export async function getPrivateCopyStatus(opts: { coverage?: boolean } = {}): Promise<PrivateCopyStatus> {
  return j(`/api/private-copy/status${opts.coverage ? '?coverage=1' : ''}`);
}

export async function startPrivateCopy(seconds: number): Promise<{
  ok: boolean; started?: boolean; complete?: boolean; already_running?: boolean; error?: string;
  /** 'copy-running' | 'original-running' */
  code?: string;
}> {
  return j('/api/private-copy/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seconds }),
  });
}

export async function cancelPrivateCopy(): Promise<{ ok: boolean }> {
  return j('/api/private-copy/cancel', { method: 'POST' });
}

export async function deletePrivateCopy(): Promise<{ ok: boolean; deleted?: boolean; error?: string; pids?: number[] }> {
  return j('/api/private-copy/delete', { method: 'POST' });
}

export async function saveKey(key: string): Promise<{ ok: boolean; path?: string; error?: string; code?: string }> {
  return j('/api/save-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

export async function saveWeChatRoot(path: string): Promise<{
  ok: boolean; saved?: string; error?: string; profiles?: Diagnose['profiles']; wechat_search_roots?: string[];
  /** Stable error code when !ok (data/errorCatalog.ts). */
  code?: string | null;
}> {
  return j('/api/wechat-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

// Disk-scan API — see paths.scan_for_wechat_data_async. The scan is a
// non-admin file-name walk. Typical: 1–60s depending on drive size + dir count.
export interface ScanFound {
  path: string;
  kind: 'xwechat_files' | 'wxid';
}
export interface ScanState {
  running: boolean;
  started_at: number | null;
  finished_at: number | null;
  drives_total: number;
  drives_done: number;
  current_path: string;
  dirs_scanned: number;
  found: ScanFound[];
  error: string | null;
  cancelled: boolean;
}

export async function startDiskScan(opts: { max_depth?: number } = {}): Promise<ScanState & { ok: boolean; started?: boolean; already_running?: boolean }> {
  return j('/api/scan-disks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}
export async function getDiskScanStatus(): Promise<ScanState> {
  return j('/api/scan-disks/status');
}
export async function cancelDiskScan(): Promise<ScanState & { ok: boolean }> {
  return j('/api/scan-disks/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

// ----- QQNT (Tencent QQ NT) — separate platform from WeChat -----

export interface QQProfile {
  qq_number: string;
  encrypted_root: string;
  decrypted_root: string | null;
  has_decrypted_data: boolean;
  has_saved_key: boolean;
}
export interface QQProfilesResponse {
  platform: 'qq';
  supported?: boolean;
  profiles: QQProfile[];
  qq_running: boolean;
  qq_install: string | null;
  error?: string;
  search_roots?: string[];
}
export async function getQQProfiles(): Promise<QQProfilesResponse> {
  return j('/api/qq/profiles');
}

export interface QQScanFound { path: string; qq_numbers: string[]; }
export interface QQScanState {
  running: boolean;
  started_at: number | null;
  finished_at: number | null;
  drives_total: number;
  drives_done: number;
  current_path: string;
  dirs_scanned: number;
  found: QQScanFound[];
  error: string | null;
  cancelled: boolean;
}

export async function saveQQRoot(path: string): Promise<{
  ok: boolean; saved?: string; profiles?: { qq_number: string; encrypted_root: string }[];
  error?: string; search_roots?: string[];
}> {
  return j('/api/qq/save-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

export async function startQQScan(opts: { max_depth?: number } = {}): Promise<QQScanState & { ok: boolean; started?: boolean; already_running?: boolean }> {
  return j('/api/qq/scan-disks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export async function getQQScanStatus(): Promise<QQScanState> {
  return j('/api/qq/scan-disks/status');
}

export async function cancelQQScan(): Promise<{ ok: boolean; cancelled: boolean }> {
  return j('/api/qq/scan-disks/cancel', { method: 'POST' });
}

export async function extractQQKey(timeout = 240, qq?: string): Promise<{ ok: boolean; key: string | null; qq?: string | null; log: string; error: string | null }> {
  return j('/api/qq/extract-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeout, qq }),
  });
}

export async function saveQQKey(qq: string, key: string): Promise<{ ok: boolean; qq?: string; error?: string }> {
  return j('/api/qq/save-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qq, key }),
  });
}

export async function decryptQQ(qq: string, key?: string): Promise<{ ok: boolean; qq: string; decrypted_root?: string; results?: Record<string, string>; error?: string }> {
  return j('/api/qq/decrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qq, key }),
  });
}

export async function resignWechat(opts: { relaunch?: boolean } = {}): Promise<{
  ok: boolean; ms?: number; log?: string[]; error?: string; stderr?: string; next_steps?: string; code?: string;
}> {
  return j('/api/resign-wechat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relaunch: opts.relaunch ?? true }),
  });
}

export async function openFullDiskAccess(): Promise<{ ok: boolean; error?: string }> {
  return j('/api/open-fda', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

export async function getPairPack(a: string, b: string): Promise<{
  pack: string; size: number; a: string; b: string;
}> {
  return j(`/api/friend-pair-pack?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
}

export interface FriendConnection {
  wxid: string;
  name: string;
  edge_type: string;        // private | mutual_reply | mention | co_group | moments_cross
  weight: number;           // raw weight (msgs / replies / mentions / groups / moments)
  mention_count?: number;
  shared_group_count?: number;
  moments_cross?: number;
}

export async function getFriendConnections(wxid: string): Promise<{
  wxid: string; connections: FriendConnection[];
}> {
  return j(`/api/friend/${encodeURIComponent(wxid)}/connections`);
}

export interface YearData {
  year: number;
  msg_count: number;
  self_count: number;
  other_count: number;
  self_pct: number;
  first_date: string;
  last_date: string;
  active_days: number;
  busiest_month: number;
  busiest_month_msgs: number;
  longest_silence_days: number;
  silence_from: string | null;
  late_night_msgs: number;
  late_night_pct: number;
  // New WeFlow-inspired metrics — see cli/etcli.py friend_yearbook.
  midnight_friend_pct?: number;        // among 23-5 messages, % from friend
  longest_streak_days?: number;        // longest run of consecutive active days
  streak_start?: string | null;
  streak_end?: string | null;
  initiative_self_pct?: number;        // who restarts dialogue after >6h gap
  session_starts_self?: number;
  session_starts_other?: number;
  first_half_msgs?: number;            // within-year decay signal
  second_half_msgs?: number;
  median_reply_sec?: number;
  heatmap_24x7?: number[];             // length 168, weekday*24+hour layout
  calls: number;
  vulnerability_quotes: Array<{ date: string; from: string; from_id?: string; text: string }>;
  offline_quotes: Array<{ date: string; from: string; from_id?: string; text: string }>;
  lifecycle_quotes: Array<{ date: string; from: string; from_id?: string; text: string }>;
  apology_quotes: Array<{ date: string; from: string; from_id?: string; text: string }>;
  care_quotes: Array<{ date: string; from: string; from_id?: string; text: string }>;
  top_words?: Array<{ word: string; count: number }>;
  signature: { date: string; from: string; from_id?: string; text: string; reason?: string; terms?: string[] } | null;
}

export interface Yearbook {
  wxid: string;
  name: string;
  total_msgs: number;
  first_date: string;
  last_date: string;
  span_days: number;
  active_years: number;
  moments_back_total: number;
  moments_out_total: number;
  years: YearData[];
}

export async function getYearbook(wxid: string): Promise<Yearbook> {
  return j(`/api/friend/${encodeURIComponent(wxid)}/yearbook`);
}

// ----- Global annual report (year-in-review across ALL friends) -----

export interface AnnualReportTopFriend {
  wxid: string;
  name: string;
  count: number;
  self: number;
  other: number;
  first_date: string | null;
  last_date: string | null;
}

export interface AnnualReportMonthlyWinner {
  month: number;            // 1..12
  wxid: string | null;
  name: string | null;
  count: number;
  month_total: number;
}

export interface AnnualReport {
  year: number;
  total_messages: number;
  total_friends_active?: number;
  active_days?: number;
  first_message_date?: string | null;
  last_message_date?: string | null;
  monthly_totals?: number[];                  // length 12
  top_friends?: AnnualReportTopFriend[];
  monthly_winners?: AnnualReportMonthlyWinner[];
  peak_day?: {
    date: string;
    count: number;
    top_wxid: string | null;
    top_name: string | null;
    top_count: number;
  } | null;
  longest_streak?: {
    days: number;
    start: string | null;
    end: string | null;
  } | null;
  heatmap_24x7?: number[];                     // length 168, weekday*24+hour
  midnight_king?: {
    wxid: string;
    name: string;
    count: number;
    share: number;
  } | null;
  mutual_friend?: {
    wxid: string;
    name: string;
    self: number;
    other: number;
    ratio: number;
  } | null;
  initiative?: {
    self_starts: number;
    other_starts: number;
    self_rate: number;
    top_initiated_wxid: string | null;
    top_initiated_name: string | null;
    top_initiated_count: number;
  } | null;
  median_reply_sec?: number;
  top_phrases?: { phrase: string; count: number }[];
  lost_friend?: {
    wxid: string;
    name: string;
    first_half: number;
    second_half: number;
    drop_pct: number;
  } | null;
}

export async function getAnnualReport(year: number): Promise<AnnualReport> {
  return j(`/api/annual-report?year=${year}`);
}

export async function getAvailableReportYears(): Promise<{
  years: number[];
  default: number;
}> {
  return j('/api/annual-report/years');
}

export type ExportFormat = 'json' | 'html' | 'txt' | 'csv' | 'md' | 'chatlab';
/** Pair export supports a subset: the relationship pack as md/json/html, and
 *  the evidence edges as csv. 'txt' is kept as a legacy alias of 'md'. */
export type PairExportFormat = 'json' | 'html' | 'md' | 'csv' | 'txt';
/** none = text only; originals = only decrypted full-size images / videos;
 *  best = originals, falling back to thumbnails. */
export type MediaPolicy = 'none' | 'originals' | 'best';

export interface ExportMediaSummary {
  policy: MediaPolicy;
  media_messages: number;
  exported_original: number;
  exported_thumbnail: number;
  exported_total: number;
  missing_total: number;
  missing_by_kind: Record<string, number>;
  missing_reasons: Record<string, number>;
  missing_reason_labels: Record<string, string>;
  thumbnail_skipped: number;
}

/** Returned when exporting with attachments (media !== 'none'): the backend
 *  writes a folder (chat file + media/ + 导出报告.md) instead of a download. */
export interface ExportReport {
  ok: boolean;
  chat_id: string;
  name: string;
  format: ExportFormat;
  messages: number;
  exported_at: string;
  dir: string;
  file: string;
  report_file: string;
  media: ExportMediaSummary;
}

async function downloadResponse(res: Response, fallbackName: string): Promise<void> {
  const blob = await res.blob();
  const dispo = res.headers.get('Content-Disposition') || '';
  const m = /filename="([^"]+)"/.exec(dispo);
  const filename = m ? m[1] : fallbackName;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** Export the chat with `wxid`.
 *  media === 'none' → the browser downloads one file (Content-Disposition), returns null.
 *  otherwise        → the backend writes a folder next to the other exports and
 *                     returns its report (counts + missing-attachment reasons). */
export async function exportFriendChat(
  wxid: string,
  format: ExportFormat,
  media: MediaPolicy = 'none',
): Promise<ExportReport | null> {
  // With attachments the backend writes a folder to disk and returns a report;
  // that side effect is POST-only. Plain downloads stay on GET.
  const res = media !== 'none'
    ? await fetch(`${API_BASE}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wxid, format, media }),
      })
    : await fetch(`${API_BASE}/api/export?wxid=${encodeURIComponent(wxid)}&format=${format}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`导出失败：${res.status} ${text.slice(0, 200)}`);
  }
  if (media !== 'none') {
    return (await res.json()) as ExportReport;
  }
  await downloadResponse(res, `murmur_${wxid}.${format === 'chatlab' ? 'chatlab.json' : format}`);
  return null;
}

export interface VoiceItem {
  ts: number;
  name: string;
  size: number;
  url: string;
}

export async function getFriendVoices(wxid: string): Promise<VoiceItem[]> {
  return j(`/api/friend/${encodeURIComponent(wxid)}/voices`);
}

/** Murmur's signature feature (issue #10): export how friend A and friend B
 *  know each other from your vantage point. Bundles direct evidence (mentions
 *  / mutual replies / sns cross-likes) + group co-presence + chat samples.
 *  md yields markdown the user can paste straight into ChatGPT/Claude; csv
 *  lists the evidence edges for spreadsheets. */
export async function exportPairChat(a: string, b: string, format: PairExportFormat): Promise<void> {
  const url = `${API_BASE}/api/pair-export?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&format=${format}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`双人导出失败：${res.status} ${text.slice(0, 200)}`);
  }
  await downloadResponse(res, `murmur_pair_${a}__${b}.${format === 'txt' ? 'md' : format}`);
}

export interface BatchStartReq {
  cli: string;  // a local agent cli (see /api/agents) or 'both' (claude + codex)
  mode: 'top' | 'all' | 'pairs-graph';
  pair_mode?: 'mention' | 'graph';
  top?: number;
  top_pairs?: number;
  sample?: number;
  parallel?: number;
  force?: boolean;
}
export async function startBatch(req: BatchStartReq): Promise<{
  ok: boolean; pid?: number; pids?: number[]; log_path?: string; log_paths?: string[]; started_at?: number; error?: string;
}> {
  return j('/api/agents/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}
export interface BatchStatus {
  running: boolean;
  n_friends: number;
  n_pairs: number;
  log_tail: string;
  reports_root?: string;
  friends_done?: number;
  friends_total?: number;
  pairs_done?: number;
  pairs_total?: number;
  failures?: number;
  skipped?: number;
  last_stage?: string;
  crashed?: boolean;
}

export async function getBatchStatus(
  pid: number,
  log_path: string,
  pids?: number[],
  log_paths?: string[],
): Promise<BatchStatus> {
  return j('/api/agents/batch/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, log_path, pids, log_paths }),
  });
}

export async function findPairReport(a: string, b: string): Promise<{
  available: boolean; path?: string; size?: number; mtime?: number; short?: string;
}> {
  return j(`/api/pair-report?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
}

export async function invokePairAgent(opts: { cli: string; a: string; b: string }): Promise<{
  ok: boolean; queued?: boolean; pair_key?: string; message?: string; error?: string;
}> {
  return j('/api/agents/invoke-pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export async function getPairStream(a: string, b: string): Promise<{
  running: boolean; output: string; error: string | null; stage: string;
  elapsed: number; started_at?: number; finished_at?: number;
}> {
  return j('/api/agents/pair-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ a, b }),
  });
}

export interface ReportEntry {
  path: string;       // relative path under reports root (friends/01_kevin.md)
  name: string;       // basename without .md
  size: number;
  mtime: number;
}
export interface ReportsList {
  friends: ReportEntry[];
  pairs: ReportEntry[];
  root: string;
}

export async function listReports(): Promise<ReportsList> {
  return j('/api/reports');
}

export async function getReport(relPath: string): Promise<{ path: string; content: string; size: number }> {
  return j(`/api/report/${encodeURI(relPath)}`);
}

export async function openFolder(path?: string): Promise<{ ok: boolean; opened?: string; error?: string }> {
  return j('/api/open-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

export const APP_VERSION = 'v0.4.2 · Murmur 微语';
