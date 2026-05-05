// Backend bridge — real fetch from etcli serve.
// In production: Tauri shell auto-spawns the bundled etcli.exe on startup.
// In dev: run `python3 cli/etcli.py serve --port 9100` (or `bash start-mac.sh` / `start-windows.bat`).
import type { Friend, FriendStats, HomeSummary, Moment } from './types';

// Use 127.0.0.1 instead of localhost — macOS WKWebView in sandboxed .app context
// treats `localhost` as a "local network" hostname that requires the (new in macOS
// Sequoia) Local Network privacy permission, while a direct IP loopback is exempt.
// Fixes "Could not connect to the server" / "Load failed" in production .app builds.
export const API_BASE = (import.meta.env?.VITE_ETCLI_URL as string) || 'http://127.0.0.1:9100';

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path}: ${res.status} ${text.slice(0, 200)}`);
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
}

// Cross-platform profile listing — drives the ProfileSwitcher.
export interface ProfileEntry {
  id: string;                 // 'wxid_xxx' for WeChat, 'qq:939919010' for QQ
  platform: 'wechat' | 'qq';
  display_id: string;         // already masked: 'wxid_n…97a5' / 'QQ 939…010'
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
}

export async function getDiagnose(): Promise<Diagnose> {
  return j('/api/diagnose');
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

export async function indexMedia(): Promise<{
  ok: boolean; total?: number; indexed?: number; existing?: number; ms?: number; details?: string; error?: string;
}> {
  return j('/api/media/index', { method: 'POST' });
}

export async function refreshData(): Promise<{ ok: boolean; ms: number; details: string }> {
  return j('/api/refresh', { method: 'POST' });
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

export async function saveKey(key: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  return j('/api/save-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

export async function saveWeChatRoot(path: string): Promise<{
  ok: boolean; saved?: string; error?: string; profiles?: Diagnose['profiles']; wechat_search_roots?: string[];
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
}
export async function getQQProfiles(): Promise<QQProfilesResponse> {
  return j('/api/qq/profiles');
}

export async function extractQQKey(timeout = 240): Promise<{ ok: boolean; key: string | null; log: string; error: string | null }> {
  return j('/api/qq/extract-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeout }),
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
  ok: boolean; ms?: number; log?: string[]; error?: string; stderr?: string; next_steps?: string;
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

export interface BatchStartReq {
  cli: 'claude' | 'codex' | 'both';
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

export const APP_VERSION = 'v0.3.8 · Murmur 微语';
