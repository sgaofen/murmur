import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getBatchStatus, startBatch as startBatchApi } from '../../data/api';
import type { BatchStartReq, BatchStatus } from '../../data/api';

const STORAGE_KEY = 'murmur.batch.current';

export interface BatchHandle {
  pid: number;
  log_path: string;
  pids?: number[];
  log_paths?: string[];
  label?: string;
  cli?: string;
  mode?: string;
  started_at?: number;
}

interface BatchTrackerStore {
  batch: BatchHandle | null;
  status: BatchStatus | null;
  startBatchJob: (req: BatchStartReq, meta?: { label?: string }) => Promise<{ ok: boolean; error?: string }>;
  clearBatch: () => void;
  refreshBatch: () => Promise<void>;
}

const Ctx = createContext<BatchTrackerStore | null>(null);

function readStoredBatch(): BatchHandle | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.pid || !parsed?.log_path) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredBatch(batch: BatchHandle | null) {
  try {
    if (batch) localStorage.setItem(STORAGE_KEY, JSON.stringify(batch));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in hardened/private webview contexts.
  }
}

function expectedPairs(req: BatchStartReq): number {
  const pairs = Math.max(0, req.top_pairs ?? 0);
  return req.cli === 'both' ? pairs * 2 : pairs;
}

function expectedFriends(req: BatchStartReq): number {
  if (req.mode === 'pairs-graph') return 0;
  if (req.mode === 'all') return 0;
  return Math.max(0, req.top ?? 0);
}

export function BatchTrackerProvider({ children }: { children: ReactNode }) {
  const [batch, setBatchState] = useState<BatchHandle | null>(() => readStoredBatch());
  const [status, setStatus] = useState<BatchStatus | null>(null);
  const batchRef = useRef<BatchHandle | null>(batch);

  const setBatch = useCallback((next: BatchHandle | null) => {
    batchRef.current = next;
    setBatchState(next);
    writeStoredBatch(next);
    if (!next) setStatus(null);
  }, []);

  const refreshBatch = useCallback(async () => {
    const current = batchRef.current;
    if (!current) return;
    const next = await getBatchStatus(current.pid, current.log_path, current.pids, current.log_paths);
    setStatus(next);
  }, []);

  useEffect(() => {
    batchRef.current = batch;
  }, [batch]);

  useEffect(() => {
    if (!batch) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      if (cancelled || !batchRef.current) return;
      try {
        await refreshBatch();
      } catch {
        // Keep the previous snapshot; startup races and brief backend misses are normal.
      }
      const stillRunning = batchRef.current && (status?.running !== false);
      if (!cancelled && stillRunning) {
        timer = window.setTimeout(tick, 5000);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [batch, refreshBatch, status?.running]);

  const startBatchJob: BatchTrackerStore['startBatchJob'] = useCallback(async (req, meta) => {
    const r = await startBatchApi(req);
    if (!r.ok || !r.pid || !r.log_path) {
      return { ok: false, error: r.error || '启动失败' };
    }
    const next: BatchHandle = {
      pid: r.pid,
      log_path: r.log_path,
      pids: r.pids,
      log_paths: r.log_paths,
      label: meta?.label,
      cli: req.cli,
      mode: req.mode,
      started_at: r.started_at || Date.now() / 1000,
    };
    setBatch(next);
    setStatus({
      running: true,
      n_friends: 0,
      n_pairs: 0,
      friends_done: 0,
      friends_total: expectedFriends(req),
      pairs_done: 0,
      pairs_total: expectedPairs(req),
      log_tail: '启动中…',
    });
    return { ok: true };
  }, [setBatch]);

  const clearBatch = useCallback(() => setBatch(null), [setBatch]);

  const value = useMemo(() => ({
    batch,
    status,
    startBatchJob,
    clearBatch,
    refreshBatch,
  }), [batch, status, startBatchJob, clearBatch, refreshBatch]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBatchTracker(): BatchTrackerStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBatchTracker must be used inside BatchTrackerProvider');
  return v;
}

export function BatchStatusPill({ onOpenReports }: { onOpenReports: () => void }) {
  const { batch, status, clearBatch } = useBatchTracker();
  if (!batch || !status) return null;

  const friendDone = status.friends_done ?? status.n_friends ?? 0;
  const friendTotal = status.friends_total ?? 0;
  const pairDone = status.pairs_done ?? status.n_pairs ?? 0;
  const pairTotal = status.pairs_total ?? 0;
  const totalDone = friendDone + pairDone;
  const total = friendTotal + pairTotal;
  const pct = total > 0 ? Math.max(3, Math.min(100, Math.round((totalDone / total) * 100))) : (status.running ? 12 : 100);
  const title = batch.label || '批量分析';
  const sub = status.running
    ? `朋友 ${friendTotal ? `${friendDone}/${friendTotal}` : friendDone} · 关系 ${pairTotal ? `${pairDone}/${pairTotal}` : pairDone}`
    : `完成 · 朋友 ${friendDone} · 关系 ${pairDone}`;

  return (
    <div style={{
      position: 'fixed', left: 18, bottom: 18, zIndex: 9998,
      width: 300, padding: '11px 12px',
      background: 'var(--et-paper)',
      border: '0.5px solid var(--et-line-2)',
      borderRadius: 10,
      boxShadow: 'var(--et-shadow-3)',
      color: 'var(--et-ink)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onOpenReports} style={{
          all: 'unset', cursor: 'pointer', flex: 1, minWidth: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: status.running ? 'var(--et-orange-2)' : 'var(--et-ink)' }}>
              {status.running ? '正在分析' : '分析完成'}
            </span>
            <span className="et-num" style={{ fontSize: 11, color: 'var(--et-mute)' }}>{pct}%</span>
          </div>
          <div style={{ height: 4, marginTop: 6, background: 'rgba(26,43,74,0.08)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{
              width: `${pct}%`, height: '100%', borderRadius: 999,
              background: status.running ? 'var(--et-orange)' : '#4EB06D',
              transition: 'width .25s ease',
            }} />
          </div>
          <div style={{ marginTop: 5, fontSize: 11, color: 'var(--et-mute)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title} · {sub}
          </div>
        </button>
        {!status.running && (
          <button onClick={clearBatch} title="清除完成状态" style={{
            all: 'unset', cursor: 'pointer',
            width: 24, height: 24, borderRadius: 7,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--et-mute)', border: '0.5px solid var(--et-line-2)',
          }}>×</button>
        )}
      </div>
    </div>
  );
}
