import { useEffect, useMemo, useState } from 'react';
import type { Friend } from '../data/types';
import { errorCode, getAllFriends, getFriend } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import { displayName, maskedWxid, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { PageHeader } from '../shell/PageHeader';
import { Button, Chip, EmptyState, ErrorState, Skeleton, cx } from '../ui';
import type { ChipTone } from '../ui';
import { IconClose, IconInbox, IconSearch } from '../ui/icons';
import { signalsOutcome } from '../utils/pageStates';
import type { SignalsOutcome } from '../utils/pageStates';
import './OfflineSignalsTable.css';

interface SignalRow {
  id: string;
  name: string;
  tier: string;
  msg_count: number;
  span_days: number;
  longevity_years: number | null;
  longest_silence: number;
  offline_evidence: number;
  vuln_total: number;
  call_count: number;
  apology_count: number;
  lifecycle_count: number;
  moments_in: number;
  moments_out: number;
  last_active: string;
  signature_summary: string;  // condensed bullet list
}

const TIER_PRIORITY: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, '—': 99 };

/** Card-tag colour → tier, for friends without computed relationship signals. */
function tierFromTag(tagKind: string): string {
  return tagKind === 'orange' ? 'A' : tagKind === 'amber' ? 'B' : tagKind === 'sage' ? 'C' : 'D';
}

const COLUMNS: Array<{ k: keyof SignalRow; l: string; w: number }> = [
  { k: 'name', l: '朋友', w: 140 },
  { k: 'tier', l: '层级', w: 60 },
  { k: 'msg_count', l: '消息数', w: 80 },
  { k: 'span_days', l: '跨度(天)', w: 80 },
  { k: 'longevity_years', l: '持续年', w: 70 },
  { k: 'longest_silence', l: '最长沉默', w: 80 },
  { k: 'offline_evidence', l: '线下证据', w: 80 },
  { k: 'vuln_total', l: '脆弱表达', w: 80 },
  { k: 'call_count', l: '通话', w: 60 },
  { k: 'apology_count', l: '道歉', w: 60 },
  { k: 'lifecycle_count', l: '人生节点', w: 80 },
  { k: 'last_active', l: '最近', w: 100 },
  { k: 'signature_summary', l: '特征摘要', w: 280 },
];

interface Props {
  /** Unused since the app shell's nav replaced the page's own ← 返回. */
  onBack: () => void;
  onOpenFriend: (id: string) => void;
}

export function OfflineSignalsTable({ onOpenFriend }: Props) {
  void usePrivacy();
  const [rows, setRows] = useState<SignalRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  // How collecting ended: an empty table must not hide "every request failed".
  const [outcome, setOutcome] = useState<SignalsOutcome | null>(null);
  const [nonce, setNonce] = useState(0);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<keyof SignalRow>('msg_count');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRows(null);
    setOutcome(null);
    setProgress(0);
    setTotal(null);
    (async () => {
      try {
        const all: Friend[] = await getAllFriends({ kind: 'private' });
        // Cap to top 100 (matches the relationship graph). Each friend = 1 API call.
        const targets = all.slice(0, 100);
        if (!cancelled) setTotal(targets.length);
        const collected: SignalRow[] = [];
        let failed = 0;
        let firstFailure: unknown = null;
        for (let i = 0; i < targets.length; i++) {
          if (cancelled) return;
          const f = targets[i];
          try {
            const detail = await getFriend(f.id);
            const stats = (detail as any).stats;
            const sig = (detail as any).relationship_signals;
            collected.push({
              id: f.id,
              name: f.name,
              // The computed tier wins; the tag colour is only a fallback.
              tier: sig?.tier || tierFromTag(f.tagKind),
              msg_count: f.count,
              span_days: stats?.spanDays || 0,
              longevity_years: sig?.longevity_years || 0,
              longest_silence: stats?.longestSilenceDays || 0,
              offline_evidence: sig?.offline_evidence?.count || 0,
              vuln_total: (sig?.vulnerability?.self_disclose_count || 0) + (sig?.vulnerability?.other_disclose_count || 0),
              call_count: sig?.calls || 0,
              apology_count: sig?.conflict_recovery?.apology_count || 0,
              lifecycle_count: sig?.lifecycle?.count || 0,
              moments_in: sig?.moments_back || 0,
              moments_out: sig?.moments_out || 0,
              last_active: f.last,
              signature_summary: (sig?.signature_notes || []).slice(0, 3).join(' · ') || '—',
            });
          } catch (e) {
            // Skip friends that fail — but count them, see signalsOutcome().
            failed += 1;
            if (firstFailure === null) firstFailure = e;
          }
          if (!cancelled) setProgress(((i + 1) / targets.length) * 100);
        }
        if (cancelled) return;
        const out = signalsOutcome(targets.length, collected.length, failed);
        setOutcome(out);
        if (out.kind === 'all-failed') setError(firstFailure ?? new Error('all friend requests failed'));
        else setRows(collected);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => { cancelled = true; };
  }, [nonce]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const filtered = filter
      ? rows.filter(r => r.name.toLowerCase().includes(filter.toLowerCase())
                     || r.id.toLowerCase().includes(filter.toLowerCase()))
      : rows;
    return [...filtered].sort((a, b) => {
      let av: any = a[sortKey], bv: any = b[sortKey];
      if (sortKey === 'tier') {
        av = TIER_PRIORITY[a.tier] || 99;
        bv = TIER_PRIORITY[b.tier] || 99;
      }
      if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
      return ((av || 0) - (bv || 0)) * sortDir;
    });
  }, [rows, sortKey, sortDir, filter]);

  function exportCSV() {
    if (!rows) return;
    const headers = ['name', 'wxid', 'tier', 'msg_count', 'span_days', 'longevity_years',
      'longest_silence_days', 'offline_evidence', 'vuln_total', 'calls', 'apologies',
      'lifecycle_events', 'last_active', 'signature_notes'];
    const csv = [
      headers.join(','),
      ...rows.map(r => [
        JSON.stringify(displayName(r.id, r.name)), maskedWxid(r.id), r.tier, r.msg_count, r.span_days, r.longevity_years || 0,
        r.longest_silence, r.offline_evidence, r.vuln_total, r.call_count, r.apology_count,
        r.lifecycle_count, JSON.stringify(r.last_active), JSON.stringify(maskText(r.signature_summary)),
      ].join(','))
    ].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'murmur_friends_signals.csv';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function sortBy(k: keyof SignalRow) {
    if (sortKey === k) setSortDir(d => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(-1); }
  }

  const header = (
    <PageHeader title="离线证据表" subtitle="朋友信号矩阵 · 纯本地统计，无需 AI · 给不会用 agent 的人">
      <Button variant="primary" size="sm" onClick={exportCSV} disabled={!rows || rows.length === 0}>导出 CSV</Button>
    </PageHeader>
  );

  if (error) {
    const allFailed = outcome?.kind === 'all-failed';
    const code = errorCode(error);
    const entry = lookupError(code);
    const raw = error instanceof Error ? error.message : String(error);
    return (
      <div className="signals-page et-root">
        {header}
        <ErrorState
          layout="page"
          code={code ?? undefined}
          // "Every friend failed" leads with that fact, so it never reads as
          // an empty account; the error code's own advice still follows.
          title={allFailed ? '朋友详情全部读取失败' : (entry?.title ?? '离线证据表没能生成')}
          reason={allFailed
            ? `${outcome.failed} 位朋友的详情都没读出来，所以表是空的——这不代表你没有朋友。${entry ? entry.reason : ''}`
            : (entry?.reason ?? '读取朋友列表时本地服务返回了错误。')}
          fixes={entry ? [entry.fix] : ['点「重试」再收集一次', '还不行就到「设置」里复制诊断信息反馈给我们']}
          onRetry={() => setNonce(n => n + 1)}
          details={raw ? <pre>{maskText(raw)}</pre> : undefined}
        />
      </div>
    );
  }

  if (rows && rows.length === 0) {
    return (
      <div className="signals-page et-root">
        {header}
        <EmptyState
          layout="page"
          icon={<IconInbox size={26} />}
          title="还没有可以统计的朋友"
          description="解密后的数据里还没有私聊记录。去首页点「更新数据」，解密完成后这里会列出前 100 位朋友的线下证据、通话、道歉等硬信号。"
        />
      </div>
    );
  }

  return (
    <div className="signals-page et-root">
      {header}

      {!sorted && (
        <div aria-busy="true">
          <div className="signals-progress" role="status">
            <h2 className="et-h3 signals-progress__title">
              正在收集{total != null ? ` ${total} 个` : ''}朋友的全部信号…
            </h2>
            <div className="et-meta signals-progress__meta">{Math.round(progress)}% · 大约 50 秒</div>
            <div className="signals-progress__track" role="progressbar" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(progress)} aria-label="收集进度">
              <div className="signals-progress__fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <div className="signals-skel" aria-hidden="true">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="signals-skel__row">
                <Skeleton height={12} width={`${80 - (i % 3) * 15}%`} />
                <Skeleton height={16} radius={4} />
                {Array.from({ length: 5 }, (_, k) => <Skeleton key={k} height={11} width={`${60 - ((i + k) % 3) * 15}%`} />)}
              </div>
            ))}
          </div>
        </div>
      )}

      {sorted && (
        <>
          <div className="signals-toolbar">
            <label className="signals-search">
              <IconSearch size={13} />
              <input
                type="search"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="搜索名字 / wxid"
                aria-label="按名字或 wxid 筛选"
              />
              {filter && (
                <button type="button" className="ui-icon-btn" aria-label="清除搜索" title="清除搜索" onClick={() => setFilter('')}>
                  <IconClose size={12} />
                </button>
              )}
            </label>
            <span className="et-meta">共 {sorted.length} 行 · 点击列头排序 · 点击行进入个人档案</span>
          </div>

          {sorted.length === 0 ? (
            <div className="signals-empty">
              <EmptyState
                icon={<IconSearch size={24} />}
                title={`没有名字或 wxid 包含「${maskText(filter)}」的朋友`}
                actions={<Button size="sm" onClick={() => setFilter('')}>清除搜索</Button>}
              />
            </div>
          ) : (
            <div className="signals-scroll">
              <table className="signals-table">
                <thead>
                  <tr>
                    {COLUMNS.map(col => (
                      <th key={col.k} style={{ width: col.w }}
                        aria-sort={sortKey === col.k ? (sortDir === -1 ? 'descending' : 'ascending') : 'none'}>
                        <button type="button" className="signals-sort" onClick={() => sortBy(col.k)}>
                          {col.l}
                          {sortKey === col.k && <span className="signals-sort__dir" aria-hidden="true">{sortDir === -1 ? '↓' : '↑'}</span>}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(r => (
                    <tr key={r.id}
                      tabIndex={0}
                      onClick={() => onOpenFriend(r.id)}
                      onKeyDown={e => { if (e.key === 'Enter') onOpenFriend(r.id); }}>
                      <td>{displayName(r.id, r.name)}</td>
                      <td><Chip size="sm" tone={tierTone(r.tier)}>{r.tier}</Chip></td>
                      <td className="et-num">{r.msg_count.toLocaleString()}</td>
                      <td className="et-num">{r.span_days}</td>
                      <td className={cx('et-num signals-num', (r.longevity_years || 0) >= 3 && 'is-strong')}>{r.longevity_years || 0}</td>
                      <td className="et-num">{r.longest_silence}</td>
                      <td className={cx('et-num signals-num', r.offline_evidence >= 50 && 'is-strong')}>{r.offline_evidence}</td>
                      <td className={cx('et-num signals-num', r.vuln_total >= 5 && 'is-strong')}>{r.vuln_total}</td>
                      <td className="et-num">{r.call_count}</td>
                      <td className="et-num">{r.apology_count}</td>
                      <td className="et-num">{r.lifecycle_count}</td>
                      <td className="signals-muted">{r.last_active}</td>
                      <td className="signals-summary" title={maskText(r.signature_summary)}>
                        <span>{maskText(r.signature_summary)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {outcome?.kind === 'rows' && outcome.failed > 0 && (
            <div className="et-meta signals-foot" role="status">
              另有 {outcome.failed} 位朋友的详情读取失败，没有列进表里 ·{' '}
              <button type="button" className="signals-retry" onClick={() => setNonce(n => n + 1)}>重新收集</button>
            </div>
          )}
          <div className="et-meta signals-foot">只统计消息最多的前 100 位私聊朋友 · 全部在本机计算</div>
        </>
      )}
    </div>
  );
}

function tierTone(t: string): ChipTone {
  return ({ A: 'accent', B: 'warning', C: 'info' } as Record<string, ChipTone>)[t] || 'neutral';
}
