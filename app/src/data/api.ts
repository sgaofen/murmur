// Backend bridge — real fetch from etcli serve.
// In production: Tauri shell auto-spawns the bundled etcli.exe on startup.
// In dev: run `python3 cli/etcli.py serve --port 9100` (or `bash start-mac.sh` / `start-windows.bat`).
import type { Friend, FriendStats, HomeSummary, Moment } from './types';

// Use 127.0.0.1 instead of localhost — macOS WKWebView in sandboxed .app context
// treats `localhost` as a "local network" hostname that requires the (new in macOS
// Sequoia) Local Network privacy permission, while a direct IP loopback is exempt.
// Fixes "Could not connect to the server" / "Load failed" in production .app builds.
const BASE = (import.meta.env?.VITE_ETCLI_URL as string) || 'http://127.0.0.1:9100';

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function getInfo(): Promise<{ data_dir: string; self_wxid: string; version: string }> {
  return j('/api/info');
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
  ok: boolean; key?: string; ms?: number; log?: string;
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
  vulnerability_quotes: Array<{ date: string; from: string; text: string }>;
  offline_quotes: Array<{ date: string; from: string; text: string }>;
  lifecycle_quotes: Array<{ date: string; from: string; text: string }>;
  apology_quotes: Array<{ date: string; from: string; text: string }>;
  care_quotes: Array<{ date: string; from: string; text: string }>;
  signature: { date: string; from: string; text: string } | null;
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
  cli: 'claude' | 'codex';
  mode: 'top' | 'all' | 'pairs-graph';
  top?: number;
  top_pairs?: number;
  force?: boolean;
}
export async function startBatch(req: BatchStartReq): Promise<{
  ok: boolean; pid?: number; log_path?: string; error?: string;
}> {
  return j('/api/agents/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}
export async function getBatchStatus(pid: number, log_path: string): Promise<{
  running: boolean; n_friends: number; n_pairs: number; log_tail: string;
}> {
  return j('/api/agents/batch/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, log_path }),
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

export const APP_VERSION = 'v0.1 · Murmur 微语';
