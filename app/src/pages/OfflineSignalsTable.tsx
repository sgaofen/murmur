import { useEffect, useMemo, useState } from 'react';
import type { Friend } from '../data/types';
import { getAllFriends, getFriend } from '../data/api';

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

interface Props {
  onBack: () => void;
  onOpenFriend: (id: string) => void;
}

export function OfflineSignalsTable({ onBack, onOpenFriend }: Props) {
  const [rows, setRows] = useState<SignalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [sortKey, setSortKey] = useState<keyof SignalRow>('msg_count');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all: Friend[] = await getAllFriends({ kind: 'private' });
        // Cap to top 100 (matches the relationship graph). Each friend = 1 API call.
        const targets = all.slice(0, 100);
        const collected: SignalRow[] = [];
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
              tier: sig?.tier || f.tagKind === 'orange' ? 'A' : f.tagKind === 'amber' ? 'B' : f.tagKind === 'sage' ? 'C' : 'D',
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
          } catch {
            // skip friends that fail
          }
          setProgress(((i + 1) / targets.length) * 100);
        }
        if (!cancelled) setRows(collected);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
        JSON.stringify(r.name), r.id, r.tier, r.msg_count, r.span_days, r.longevity_years || 0,
        r.longest_silence, r.offline_evidence, r.vuln_total, r.call_count, r.apology_count,
        r.lifecycle_count, JSON.stringify(r.last_active), JSON.stringify(r.signature_summary),
      ].join(','))
    ].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'murmur_friends_signals.csv';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  if (error) {
    return <div style={{ padding: 40, color: 'var(--et-rose)' }}>加载失败：{error}</div>;
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--et-bg)' }}>
      {/* Top bar */}
      <div style={{ padding: '14px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '0.5px solid var(--et-line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer',
            color: 'var(--et-mute)', fontSize: 13 }}>← 返回</button>
          <div className="et-serif" style={{ fontSize: 18, fontWeight: 600, color: 'var(--et-ink)' }}>
            朋友信号矩阵 · 离线表格视图
          </div>
          <span className="et-meta" style={{ fontSize: 11 }}>
            纯本地统计，无需 AI · 给不会用 agent 的人
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="搜索名字 / wxid"
            style={{
              all: 'unset', padding: '6px 12px', borderRadius: 999,
              border: '0.5px solid var(--et-line-2)', background: 'var(--et-paper)',
              fontSize: 12, color: 'var(--et-ink)', minWidth: 200,
            }}
          />
          <button onClick={exportCSV} disabled={!rows} style={{
            all: 'unset', cursor: rows ? 'pointer' : 'not-allowed',
            padding: '7px 14px', borderRadius: 8,
            background: 'var(--et-orange)', color: '#fff',
            fontSize: 12, fontWeight: 600,
            opacity: rows ? 1 : 0.4,
          }}>导出 CSV</button>
        </div>
      </div>

      {!rows && (
        <div style={{ padding: 60, textAlign: 'center' }}>
          <div className="et-h3">正在收集 100 个朋友的全部信号…</div>
          <div className="et-meta" style={{ marginTop: 8 }}>{Math.round(progress)}% · 大约 50 秒</div>
          <div style={{ height: 6, background: 'rgba(26,43,74,0.08)', borderRadius: 999,
            overflow: 'hidden', marginTop: 14, maxWidth: 400, marginLeft: 'auto', marginRight: 'auto' }}>
            <div style={{ width: `${progress}%`, height: '100%',
              background: 'var(--et-orange)', transition: 'width .3s' }}/>
          </div>
        </div>
      )}

      {sorted && (
        <div style={{ padding: 16, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12,
            fontFamily: 'var(--et-sans)', minWidth: 1200 }}>
            <thead>
              <tr style={{ background: 'var(--et-paper)', borderBottom: '0.5px solid var(--et-line-2)' }}>
                {([
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
                ] as Array<{ k: keyof SignalRow; l: string; w: number }>).map(col => (
                  <th key={col.k}
                      onClick={() => {
                        if (sortKey === col.k) setSortDir(d => (d === 1 ? -1 : 1));
                        else { setSortKey(col.k); setSortDir(-1); }
                      }}
                      style={{
                        padding: '10px 8px', textAlign: 'left', cursor: 'pointer',
                        fontWeight: 600, color: 'var(--et-ink-soft)',
                        borderRight: '0.5px solid var(--et-line)',
                        width: col.w, fontSize: 11,
                        userSelect: 'none',
                      }}>
                    {col.l} {sortKey === col.k && (sortDir === -1 ? '↓' : '↑')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={r.id}
                    onClick={() => onOpenFriend(r.id)}
                    style={{ cursor: 'pointer', borderBottom: '0.5px solid var(--et-line)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--et-paper-2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '8px', fontWeight: 600, color: 'var(--et-ink)' }}>{r.name}</td>
                  <td style={{ padding: '8px' }}>
                    <span style={{
                      padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                      background: tierBg(r.tier), color: tierFg(r.tier),
                    }}>{r.tier}</span>
                  </td>
                  <td className="et-num" style={{ padding: '8px' }}>{r.msg_count.toLocaleString()}</td>
                  <td className="et-num" style={{ padding: '8px' }}>{r.span_days}</td>
                  <td className="et-num" style={{ padding: '8px',
                    color: (r.longevity_years || 0) >= 3 ? 'var(--et-orange)' : 'inherit',
                    fontWeight: (r.longevity_years || 0) >= 3 ? 600 : 400 }}>{r.longevity_years || 0}</td>
                  <td className="et-num" style={{ padding: '8px' }}>{r.longest_silence}</td>
                  <td className="et-num" style={{ padding: '8px',
                    color: r.offline_evidence >= 50 ? 'var(--et-orange)' : 'inherit' }}>{r.offline_evidence}</td>
                  <td className="et-num" style={{ padding: '8px',
                    color: r.vuln_total >= 5 ? 'var(--et-orange)' : 'inherit' }}>{r.vuln_total}</td>
                  <td className="et-num" style={{ padding: '8px' }}>{r.call_count}</td>
                  <td className="et-num" style={{ padding: '8px' }}>{r.apology_count}</td>
                  <td className="et-num" style={{ padding: '8px' }}>{r.lifecycle_count}</td>
                  <td style={{ padding: '8px', color: 'var(--et-mute)', fontSize: 11 }}>{r.last_active}</td>
                  <td style={{ padding: '8px', color: 'var(--et-ink-soft)', fontSize: 11 }}>
                    {r.signature_summary}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="et-meta" style={{ padding: '14px 0', textAlign: 'center', color: 'var(--et-faint)' }}>
            共 {sorted.length} 行 · 点击列头排序 · 点击行进入个人档案
          </div>
        </div>
      )}
    </div>
  );
}

function tierBg(t: string): string {
  return ({ A: 'rgba(255,107,71,0.18)', B: 'rgba(232,181,122,0.20)',
            C: 'rgba(90,122,153,0.18)', D: 'rgba(158,149,131,0.18)',
            E: 'rgba(200,191,171,0.18)' } as Record<string, string>)[t] || 'rgba(0,0,0,0.06)';
}
function tierFg(t: string): string {
  return ({ A: '#E0532E', B: '#8a5a1c', C: '#3E5773', D: '#5C5747', E: '#7A7561' } as Record<string, string>)[t] || '#3a4862';
}
