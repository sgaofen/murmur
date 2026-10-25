/* 档案 (#/friend/<id>) — one person on the instrument rack.
 *
 *   14 抬头      code, name, tier / tag, six readouts            /api/friend/<id>
 *   15 逐年      you ↑ / them ↓ per year + a per-year table         /api/friend/<id>/yearbook
 *   16 离线证据   relationship_signals as a sourced table + notes    /api/friend/<id>
 *   17 节奏      24h + weekday × hour (yearbook heatmap) + balance   yearbook + stats
 *   18 AI 报告   summary, contents, open / re-run                    aiReport + /api/report/…
 *   19 摘录      auto-picked lines                                   /api/friend/<id>/moments
 *   20 关联      friends of this friend, pair export                 /api/friend/<id>/connections
 *   21 操作      full chat, export, 双人年代记, AI pack
 *
 * The 相册 tab is extras/MediaGallery. Nothing here is estimated: a module
 * whose data didn't come back says so instead of drawing a guess.
 * Styles: ./Friend.css (+ extras/ReportReader.css for the reading view). */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  errorCode, exportFriendChat, getFriend, getFriendConnections, getInvokeStream, getMoments, getReport, getYearbook,
  openFolder,
} from '../data/api';
import type { ExportFormat, ExportReport, FriendConnection, MediaPolicy, Yearbook } from '../data/api';
import type { Friend, FriendStats, Moment } from '../data/types';
import { AIAssistantDrawer, ReportReadyBanner } from './AIAssistantDrawer';
import { MediaGallery } from './extras/MediaGallery';
import { RelationshipReportView } from './extras/RelationshipReportView';
import { PairAnalysisPanel } from './extras/PairAnalysisPanel';
import { ReportReader, parseReport, reportHeadline } from './extras/ReportReader';
import type { ParsedReport } from './extras/ReportReader';
import { displayName, maskedWxid, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { usePageKeys } from '../utils/usePageKeys';
import { PageHeader } from '../shell/PageHeader';
import {
  Button, Dialog, EmptyState, ErrorState, Module, SegmentedControl, Skeleton, cx,
} from '../ui';
import { IconCopy, IconInbox, IconRefresh } from '../ui/icons';
import { lookupError } from '../data/errorCatalog';
import { useActivePlatform } from '../utils/activeProfile';
import './Friend.css';

interface Props {
  friendId: string;
  onBack: () => void;
  onOpenFriend?: (id: string) => void;
}

type FriendTab = 'story' | 'media';

interface Signals {
  tier?: string | null;
  tier_label?: string | null;
  longevity_years?: number;
  resurrections_count?: number;
  vulnerability?: { self_disclose_count?: number; other_disclose_count?: number };
  offline_evidence?: { count?: number };
  mutual_care?: { self_to_other?: number; other_to_self?: number };
  conflict_recovery?: { apology_count?: number };
  calls?: number;
  lifecycle?: { count?: number };
  moments_back?: number;
  moments_out?: number;
  signature_notes?: string[];
}

type FriendDetail = Friend & { stats: FriendStats | null; relationship_signals?: Signals };

// ———————————————————————— helpers ————————————————————————

/** Fixed thousands separators whatever the OS locale. */
function fmt(n: number | null | undefined): string {
  return n == null || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US');
}

/** The big monogram: 「朋友 PB」→ PB, 「群 5」→ 5, otherwise the backend glyph. */
function monogram(name: string, glyph: string): string {
  const m = /^(?:朋友|群)\s*(\S{1,3})$/.exec(name);
  if (m) return m[1];
  return glyph || Array.from(name)[0] || '·';
}

/** The short label for the other person in tables: 「朋友 PB」→ PB. */
function shortName(name: string): string {
  const m = /^朋友\s*(\S{1,3})$/.exec(name);
  return m ? m[1] : name;
}

/** "2分14秒" / "50秒" / "1小时3分" → number + unit pairs for a readout. */
function durationParts(human: string): { v: string; u: string }[] {
  const out: { v: string; u: string }[] = [];
  const rx = /(\d+)\s*(天|小时|分钟|分|秒)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(human))) {
    const u = m[2] === '天' ? 'D' : m[2] === '小时' ? 'H' : m[2] === '秒' ? 'S' : 'MIN';
    out.push({ v: m[1], u });
  }
  return out;
}

function ageOf(mtime: number): { date: string; rel: string } {
  const d = new Date(mtime * 1000);
  const days = Math.floor((Date.now() - mtime * 1000) / 86400000);
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { date, rel: days < 1 ? '今天' : days === 1 ? '昨天' : `${days} 天前` };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '');
}

/** Hours (0–23) summed over every year's weekday × hour grid. */
function hourTotals(yb: Yearbook): number[] | null {
  const out = new Array(24).fill(0);
  let any = false;
  for (const y of yb.years) {
    const h = y.heatmap_24x7;
    if (!h || h.length !== 168) continue;
    any = true;
    for (let i = 0; i < 168; i++) out[i % 24] += h[i];
  }
  return any ? out : null;
}

function weekGrid(yb: Yearbook): number[] | null {
  const out = new Array(168).fill(0);
  let any = false;
  for (const y of yb.years) {
    const h = y.heatmap_24x7;
    if (!h || h.length !== 168) continue;
    any = true;
    for (let i = 0; i < 168; i++) out[i] += h[i];
  }
  return any ? out : null;
}

// ———————————————————————— 14 抬头 ————————————————————————

function Readout({ en, zh, children, sub }: { en: string; zh: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="fr-ro">
      <div className="ui-label fr-ro__k">{en}<b>{zh}</b></div>
      <div className="ui-big fr-ro__v">{children}</div>
      <div className="fr-ro__s">{sub ?? '\u00a0'}</div>
    </div>
  );
}

function HeadModule({ friend, stats, sig, since }: {
  friend: FriendDetail; stats: FriendStats | null; sig: Signals | undefined; since: string | null;
}) {
  const name = displayName(friend.id, friend.name);
  const code = monogram(name, friend.glyph);
  const dur = stats ? durationParts(stats.medianReplyHuman || '') : [];
  const dash = <span className="fr-dash">—</span>;
  return (
    <Module as="div" className="fr-m14" aria-label="人物档案">
      <div className="fr-id">
        <div className={cx('fr-id__code', Array.from(code).length > 2 && 'is-long')} aria-hidden="true">{code}</div>
        <div className="fr-id__text">
          <div className="ui-label">PROFILE<b>人物档案</b></div>
          <h2 className="fr-id__name">{name}</h2>
          <div className="fr-id__chips">
            {sig?.tier && sig.tier !== 'group' && (
              <span className="fr-chip is-signal" title={maskText(sig.tier_label || '')}>TIER {sig.tier}</span>
            )}
            {friend.tag && friend.tag !== '—' && <span className="fr-chip">{friend.tag}</span>}
            {sig?.tier_label && <span className="fr-id__tier">{maskText(sig.tier_label)}</span>}
          </div>
          <div className="fr-id__meta">
            <span>{maskedWxid(friend.id)}</span>
            {since ? <span>SINCE {since}</span> : friend.knew ? <span>{friend.knew}</span> : null}
            <span>LAST {friend.last}</span>
          </div>
        </div>
      </div>
      <div className="fr-ros">
        <Readout en="MSG" zh="消息" sub={stats ? `你 ${stats.selfPct}% · 对方 ${100 - stats.selfPct}%` : undefined}>
          {fmt(friend.count)}
        </Readout>
        <Readout en="SPAN" zh="跨度" sub={stats ? `${fmt(stats.spanDays)} 天` : undefined}>
          {stats ? <>{(stats.spanDays / 365.25).toFixed(1)}<small>Y</small></> : dash}
        </Readout>
        <Readout en="CALLS" zh="通话" sub={sig ? '语音 + 视频' : undefined}>
          {sig ? <>{fmt(sig.calls ?? 0)}<small>次</small></> : dash}
        </Readout>
        <Readout en="SILENCE MAX" zh="最长沉默"
          sub={stats && stats.longestSilenceDays > 0 && /^\d{4}/.test(stats.longestSilenceFrom) ? `从 ${stats.longestSilenceFrom} 起` : undefined}>
          {stats ? <>{fmt(stats.longestSilenceDays)}<small>D</small></> : dash}
        </Readout>
        <Readout en="REPLY P50" zh="回复中位" sub={dur.length ? '你回复对方' : undefined}>
          {dur.length ? dur.map((p, i) => <span key={i}>{p.v}<small>{p.u}</small>{i < dur.length - 1 ? ' ' : ''}</span>) : dash}
        </Readout>
        <Readout en="LATE NIGHT" zh="深夜" sub={stats ? '23:00–04:59' : undefined}>
          {stats ? <>{stats.lateNightPct}<small>%</small></> : dash}
        </Readout>
      </div>
    </Module>
  );
}

// ———————————————————————— 15 逐年 ————————————————————————

function YearsModule({ friend, stats, yb, ybError, onRetry }: {
  friend: FriendDetail; stats: FriendStats | null; yb: Yearbook | null; ybError: unknown; onRetry: () => void;
}) {
  const other = shortName(displayName(friend.id, friend.name));
  const years = yb?.years ?? [];
  const max = Math.max(1, ...years.map(y => Math.max(y.self_count, y.other_count)));
  const peak = years.length ? years.reduce((a, b) => (b.msg_count > a.msg_count ? b : a)) : null;
  const silenceYear = stats && stats.longestSilenceDays > 0 && /^\d{4}/.test(stats.longestSilenceFrom)
    ? Number(stats.longestSilenceFrom.slice(0, 4)) : null;
  const en = yb && years.length ? `YEARLY MSG · ${yb.first_date.slice(0, 7)} → ${yb.last_date.slice(0, 7)}` : 'YEARLY MSG';
  const right = stats ? (
    <>
      <span className="fr-key"><i className="is-you" />YOU {fmt(stats.totalSelf)}</span>
      <span className="fr-key"><i className="is-them" />{other} {fmt(stats.totalOther)}</span>
    </>
  ) : null;
  let body: ReactNode;
  if (ybError != null && !yb) {
    body = (
      <div className="fr-inline-err">
        <span className="ui-led ui-led--error" />
        <span>逐年数据没能读出来（{maskText(errText(ybError)).slice(0, 80)}）</span>
        <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={onRetry}>重试</Button>
      </div>
    );
  } else if (!yb) {
    body = (
      <div className="fr-years fr-years--skel" aria-busy="true" aria-label="正在读取逐年数据">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="fr-yr">
            <div className="fr-yr__up"><Skeleton width="44%" height={20 + ((i * 37) % 50)} /></div>
            <div className="fr-yr__dn"><Skeleton width="44%" height={14 + ((i * 23) % 40)} /></div>
          </div>
        ))}
      </div>
    );
  } else if (!years.length) {
    body = <div className="fr-note">这段对话还没有可以按年份统计的文字消息。</div>;
  } else {
    body = (
      <div className="fr-years-wrap" style={{ '--yn': years.length } as CSSProperties}>
        <div className="fr-years fr-years--axis" role="img"
          aria-label={`逐年消息：${years.map(y => `${y.year} 年 ${y.msg_count} 条`).join('，')}`}>
          <div className="fr-years-axis" aria-hidden="true">
            <span className="fr-years-axis__you">YOU ↑</span>
            <span className="fr-years-axis__them">{other} ↓</span>
          </div>
          {years.map(y => {
            const isPeak = y === peak;
            const isSilence = y.year === silenceYear;
            return (
              <div key={y.year} className={cx('fr-yr', isPeak && 'is-peak', isSilence && 'is-silence')}>
                <div className="fr-yr__flag" title={isSilence && stats ? `${stats.longestSilenceFrom} 起，${stats.longestSilenceDays} 天没有消息` : undefined}>
                  {isSilence && stats ? `SILENCE ${stats.longestSilenceDays}D` : ''}
                </div>
                <div className="fr-yr__up">
                  <i style={{ height: `${(y.self_count / max) * 100}%` }}><span className="fr-yr__n">{fmt(y.self_count)}</span></i>
                </div>
                <div className="fr-yr__dn">
                  <i style={{ height: `${(y.other_count / max) * 100}%` }}><span className="fr-yr__n">{fmt(y.other_count)}</span></i>
                </div>
                <div className="fr-yr__y">{y.year}{isPeak && <b>PEAK</b>}</div>
              </div>
            );
          })}
        </div>
        <table className="fr-ytab">
          <colgroup><col className="fr-ytab__k" />{years.map(y => <col key={y.year} />)}</colgroup>
          <tbody>
            <tr>
              <th scope="row">MSG<b>消息</b></th>
              {years.map(y => <td key={y.year} className={cx(y === peak && 'is-peak')}>{fmt(y.msg_count)}</td>)}
            </tr>
            <tr>
              <th scope="row">DAYS<b>有聊天的天数</b></th>
              {years.map(y => <td key={y.year}>{fmt(y.active_days)}</td>)}
            </tr>
            <tr>
              <th scope="row">LATE<b>23–4 点占比</b></th>
              {years.map(y => <td key={y.year}>{Math.round(y.late_night_pct)}<small>%</small></td>)}
            </tr>
            <tr>
              <th scope="row">GAP<b>年内最长空白</b></th>
              {years.map(y => <td key={y.year}>{fmt(y.longest_silence_days)}<small>D</small></td>)}
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <Module id="15" title="逐年" en={en} right={right} className="fr-m15" crop="bottom">
      {body}
    </Module>
  );
}

// ———————————————————————— 16 离线证据 ————————————————————————

interface EvidenceRow {
  label: string;
  value: number;
  unit: string;
  source: string;
  conf: number;   // 5 = counted from records, 3 = keyword match
}

function evidenceRows(sig: Signals, qq: boolean): EvidenceRow[] {
  const rows: EvidenceRow[] = [
    { label: '有来往的年份', value: sig.longevity_years ?? 0, unit: 'YEAR', source: '每年 ≥30 条的首末年份', conf: 5 },
    { label: '语音与视频通话', value: sig.calls ?? 0, unit: 'TIMES', source: '通话类消息', conf: 5 },
  ];
  if (!qq) {
    rows.push({
      label: '朋友圈互动', value: (sig.moments_back ?? 0) + (sig.moments_out ?? 0), unit: 'TIMES',
      source: `对方→你 ${fmt(sig.moments_back ?? 0)} · 你→对方 ${fmt(sig.moments_out ?? 0)}`, conf: 5,
    });
  }
  rows.push(
    { label: '沉默后重新联系', value: sig.resurrections_count ?? 0, unit: 'TIMES', source: '超过 60 天的空档', conf: 5 },
    { label: '提到线下见面', value: sig.offline_evidence?.count ?? 0, unit: 'MSG', source: '关键词：约、见面、吃饭…', conf: 3 },
    {
      label: '互相关心', value: (sig.mutual_care?.self_to_other ?? 0) + (sig.mutual_care?.other_to_self ?? 0), unit: 'MSG',
      source: `你 ${fmt(sig.mutual_care?.self_to_other ?? 0)} · 对方 ${fmt(sig.mutual_care?.other_to_self ?? 0)}`, conf: 3,
    },
    {
      label: '说出心事', value: (sig.vulnerability?.self_disclose_count ?? 0) + (sig.vulnerability?.other_disclose_count ?? 0),
      unit: 'MSG', source: '关键词：累、难过、压力…', conf: 3,
    },
    { label: '道歉与和解', value: sig.conflict_recovery?.apology_count ?? 0, unit: 'MSG', source: '关键词：对不起、抱歉', conf: 3 },
    { label: '人生节点', value: sig.lifecycle?.count ?? 0, unit: 'MSG', source: '关键词：毕业、入职、搬家', conf: 3 },
  );
  return rows;
}

function Conf({ n }: { n: number }) {
  return (
    <span className="fr-conf" aria-label={`置信 ${n} / 5`}>
      {Array.from({ length: 5 }, (_, i) => <i key={i} className={cx(i < n && 'on')} />)}
    </span>
  );
}

function CallsChart({ yb }: { yb: Yearbook }) {
  const years = yb.years;
  const total = years.reduce((n, y) => n + (y.calls || 0), 0);
  if (!years.length || total === 0) return null;
  const max = Math.max(1, ...years.map(y => y.calls || 0));
  const peak = years.reduce((a, b) => ((b.calls || 0) > (a.calls || 0) ? b : a));
  return (
    <div className="fr-calls">
      <div className="fr-sub">
        <span className="fr-sub__id">—</span>
        <span className="fr-sub__t">通话 · 每年次数</span>
        <span className="fr-sub__r">CALLS / YEAR · Σ {fmt(total)}</span>
      </div>
      <div className="fr-calls__bars" role="img"
        aria-label={`每年通话：${years.map(y => `${y.year} 年 ${y.calls || 0} 次`).join('，')}`}>
        {years.map(y => (
          <div key={y.year} className={cx('fr-calls__col', y === peak && 'is-peak')}>
            <i style={{ height: `${((y.calls || 0) / max) * 100}%` }}>
              {y.calls ? <span className="fr-calls__n">{y.calls}</span> : null}
            </i>
            <span className="fr-calls__y">{String(y.year).slice(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EvidenceModule({ sig, yb }: { sig: Signals | undefined; yb: Yearbook | null }) {
  // QQ keeps no 朋友圈 in the local DB: drop that row rather than show 0.
  const platform = useActivePlatform();
  if (!sig || !sig.tier) {
    return (
      <Module id="16" title="离线证据" en="OFFLINE EVIDENCE" className="fr-m16">
        <div className="fr-note">消息太少，还推断不出聊天之外的证据。</div>
      </Module>
    );
  }
  const rows = evidenceRows(sig, platform === 'qq');
  return (
    <Module id="16" title="离线证据" en="OFFLINE EVIDENCE" right={`${rows.length} SIGNALS`} className="fr-m16">
      <table className="fr-ev">
        <thead>
          <tr>
            <th className="fr-ev__no">#</th>
            <th>项目</th>
            <th className="r">值</th>
            <th className="fr-ev__unit">单位</th>
            <th className="fr-ev__src">来源</th>
            <th className="fr-ev__conf">置信</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.label} className={cx(!r.value && 'is-zero')}>
              <td className="fr-ev__no">{String(i + 1).padStart(2, '0')}</td>
              <td className="fr-ev__k">{r.label}</td>
              <td className="r fr-ev__v">{fmt(r.value)}</td>
              <td className="fr-ev__unit">{r.unit}</td>
              <td className="fr-ev__src">{r.source}</td>
              <td className="fr-ev__conf"><Conf n={r.conf} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {yb && <CallsChart yb={yb} />}
      <p className="fr-foot">
        置信：按记录计数的给满五格；靠关键词扫出来的只给三格——「到了吗」之类的玩笑也会被算进去。全部从本机数据推断，没有联网核实。
        {sig.tier_label && <> 关系层级 {sig.tier}：{maskText(sig.tier_label)}。</>}
      </p>
    </Module>
  );
}

// ———————————————————————— 17 节奏 ————————————————————————

const DOW = ['一', '二', '三', '四', '五', '六', '日'];

function heatLevel(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  const r = v / max;
  return r > 0.75 ? 4 : r > 0.45 ? 3 : r > 0.2 ? 2 : 1;
}

function RhythmModule({ friend, stats, yb, ybError }: {
  friend: FriendDetail; stats: FriendStats | null; yb: Yearbook | null; ybError: unknown;
}) {
  const other = shortName(displayName(friend.id, friend.name));
  const hours = yb ? hourTotals(yb) : null;
  const grid = yb ? weekGrid(yb) : null;
  const hMax = hours ? Math.max(1, ...hours) : 1;
  const peakH = hours ? hours.indexOf(Math.max(...hours)) : -1;
  const gMax = grid ? Math.max(...grid) : 0;
  return (
    <Module
      id="17" title="节奏" en="24H · WEEK × HOUR" className="fr-m17"
      right={peakH >= 0 ? `PEAK ${String(peakH).padStart(2, '0')}:00` : undefined}
    >
      <div className="fr-rh">
        {hours ? (
          <div className="fr-hours" role="img" aria-label={`按小时的消息分布，${peakH} 点最多`}>
            {hours.map((v, h) => (
              <div key={h} className={cx('fr-hours__col', h === peakH && 'is-peak')}>
                <i style={{ height: `${Math.max(v > 0 ? 2 : 0, (v / hMax) * 100)}%` }} />
              </div>
            ))}
            <div className="fr-hours__ticks" aria-hidden="true">
              {[0, 3, 6, 9, 12, 15, 18, 21].map(h => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>)}
            </div>
          </div>
        ) : ybError != null ? (
          <div className="fr-note">按小时的分布没能读出来。</div>
        ) : (
          <div className="fr-hours fr-hours--skel" aria-hidden="true">
            {Array.from({ length: 24 }, (_, h) => <div key={h} className="fr-hours__col"><Skeleton height={`${20 + ((h * 41) % 70)}%`} /></div>)}
          </div>
        )}
        {grid && (
          <div className="fr-wk" role="img" aria-label="星期 × 小时的消息热度">
            {DOW.map((d, w) => (
              <div key={d} className="fr-wk__row">
                <span className="fr-wk__d">{d}</span>
                {Array.from({ length: 24 }, (_, h) => {
                  const v = grid[w * 24 + h];
                  return <i key={h} className={`fr-wk__c l${heatLevel(v, gMax)}`} title={`周${d} ${h} 点 · ${fmt(v)} 条`} />;
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      {stats ? (
        <div className="fr-bal">
          <div className="fr-bal__share">
            <div className="fr-bal__row">
              <span className="ui-label">YOU<b>你说的</b></span>
              <span className="fr-bal__v">{fmt(stats.totalSelf)}<small>{stats.selfPct}%</small></span>
            </div>
            <div className="fr-meter" aria-hidden="true">
              <i className="is-you" style={{ width: `${stats.selfPct}%` }} />
              <i className="is-them" />
            </div>
            <div className="fr-bal__row">
              <span className="ui-label">{other}<b>对方说的</b></span>
              <span className="fr-bal__v">{fmt(stats.totalOther)}<small>{100 - stats.selfPct}%</small></span>
            </div>
          </div>
          <div className="fr-bal__ro">
            <div>
              <div className="ui-label">OPENED<b>先开口</b></div>
              <div className="fr-bal__n">{fmt(stats.initSelf)}<small> / </small>{fmt(stats.initOther)}</div>
              <div className="fr-bal__s">你 / 对方 · 停了 6 小时以上再开聊</div>
            </div>
            <div>
              <div className="ui-label">FAST<b>一分钟内回</b></div>
              <div className="fr-bal__n">{fmt(stats.fastReplies)}<small>次</small></div>
              <div className="fr-bal__s">双方合计</div>
            </div>
            <div>
              <div className="ui-label">BUSY<b>最常聊天</b></div>
              <div className="fr-bal__n fr-bal__n--zh">{stats.busiestHourLabel}</div>
              <div className="fr-bal__s">{stats.busiestHourSub}</div>
            </div>
            <div>
              <div className="ui-label">WORD<b>高频词</b></div>
              <div className="fr-bal__n fr-bal__n--zh">「{maskText(stats.topPhrase)}」</div>
              <div className="fr-bal__s">出现 {fmt(stats.topPhraseCount)} 次</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="fr-note">你们一共 {fmt(friend.count)} 条消息，还算不出谁更主动、回复多快这些数字。</div>
      )}
    </Module>
  );
}

// ———————————————————————— 18 AI 报告 ————————————————————————

type Stream = { output: string; stage: string; elapsed: number };

function ReportModule({ friend, parsed, reportError, stream, streamError, onOpen, onRerun }: {
  friend: FriendDetail;
  parsed: ParsedReport | null;
  reportError: unknown;
  stream: Stream | null;
  streamError: string | null;
  onOpen: (section?: string) => void;
  onRerun: () => void;
}) {
  const name = displayName(friend.id, friend.name);
  const rep = friend.aiReport?.available ? friend.aiReport : null;
  const running = !!stream && !streamError;

  if (running || streamError) {
    const tail = stream?.output?.trim().split('\n').slice(-10).join('\n');
    return (
      <Module
        id="18" title="AI 关系报告" className="fr-m18"
        right={<span className={cx('fr-chip', streamError ? 'is-danger' : 'is-run')}>{streamError ? 'FAILED' : 'RUNNING'}</span>}
      >
        <div className="fr-ai">
          <div className="fr-ai__run">
            <span className={cx('ui-led', streamError ? 'ui-led--error' : 'is-pulse')} />
            <span className="fr-ai__stage">{streamError ? '分析失败' : `${stream?.stage || '运行中'}…`}</span>
            <span className="fr-ai__secs">{String(Math.floor((stream?.elapsed || 0) / 60)).padStart(2, '0')}:{String((stream?.elapsed || 0) % 60).padStart(2, '0')}</span>
          </div>
          {streamError ? (
            <p className="fr-ai__err">{maskText(streamError.slice(0, 240))}</p>
          ) : tail ? (
            <pre className="fr-ai__log">{maskText(tail)}</pre>
          ) : (
            <p className="fr-note fr-note--flush">本机 AI 已启动，等它的第一段输出。可以先去别处看看，后台不会中断。</p>
          )}
        </div>
        {streamError && (
          <div className="fr-ai__keys">
            <Button variant="primary" kbd="G" onClick={onRerun}>重新分析</Button>
          </div>
        )}
      </Module>
    );
  }

  if (!rep) {
    return (
      <Module id="18" title="AI 关系报告" right="NONE" className="fr-m18">
        <EmptyState
          icon={<IconInbox size={22} />}
          label="NO REPORT"
          title="还没有 AI 报告"
          description={`让本机的 AI 读一遍你和 ${name} 的聊天，写一份关系档案；也可以导出成文件，交给你常用的在线 AI。`}
          actions={<Button variant="primary" kbd="G" onClick={onRerun}>生成报告</Button>}
        />
      </Module>
    );
  }

  const age = ageOf(rep.mtime);
  const head = parsed ? reportHeadline(parsed, `关于 ${name}`) : null;
  const fallback = rep.short
    .replace(/^#[^\n]*\n+/, '').replace(/^>[^\n]*\n+/gm, '').replace(/^---+\n+/m, '')
    .replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').trim();
  const summary = head?.summary || fallback.split(/\n\s*\n/)[0] || '';
  return (
    <Module
      id="18" title="AI 关系报告" className="fr-m18"
      right={<span className="fr-chip is-signal">READY</span>}
    >
      <div className="fr-ai">
        <div className="fr-ai__meta">
          {parsed ? <><b>{fmt(parsed.chars)}</b> 字 · {parsed.sections.length} 节 · </> : null}
          {age.date} 生成（{age.rel}） · {(rep.size / 1024).toFixed(1)} KB
        </div>
        <h3 className="fr-ai__title">{maskText(head?.title || `关于 ${name}`)}</h3>
        <p className="fr-ai__sum">{maskText(summary)}</p>
        {reportError != null && !parsed && (
          <p className="fr-note fr-note--flush">完整报告没能读出来，下面只有摘要；点「打开报告」再试一次。</p>
        )}
      </div>
      {parsed && parsed.sections.length > 1 && (
        <ol className="fr-toc">
          {parsed.sections.slice(0, 8).map(s => (
            <li key={s.id}>
              <button type="button" onClick={() => onOpen(s.id)}>
                <span className="fr-toc__no">{s.no}</span>
                <span className="fr-toc__t">{maskText(s.title)}</span>
                <span className="fr-toc__n">{fmt(s.chars)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="fr-ai__keys">
        <Button variant="primary" kbd="R" onClick={() => onOpen()}>打开报告</Button>
        <Button kbd="G" onClick={onRerun}>重新分析</Button>
      </div>
    </Module>
  );
}

// ———————————————————————— 19 摘记 ————————————————————————

function parseNotes(sig: Signals | undefined) {
  return (sig?.signature_notes || []).map(n => {
    const kw = n.startsWith('\u2699');    // ⚙ keyword-derived, needs checking
    const warn = n.startsWith('\u26A0');  // ⚠ lopsided
    return { kw, warn, text: n.replace(/^[\u2699\u26A0]\uFE0F?\s*/u, '') };
  });
}

function NotesModule({ friend, sig, moments, loading }: {
  friend: FriendDetail; sig: Signals | undefined; moments: Moment[]; loading: boolean;
}) {
  const notes = parseNotes(sig);
  return (
    <Module
      id="19" title="摘记" en="NOTES · QUOTES" className="fr-m19"
      right={loading ? undefined : `${notes.length} NOTES · ${moments.length} LINES`}
    >
      {notes.length > 0 && (
        <ol className="fr-notes">
          {notes.map((n, i) => (
            <li key={i}>
              <span className="fr-notes__no">{String(i + 1).padStart(2, '0')}</span>
              <span className="fr-notes__t">{maskText(n.text)}</span>
              {(n.kw || n.warn) && (
                <span className={cx('fr-notes__tag', n.warn && 'is-warn')}
                  title={n.warn ? '双方投入明显不对等' : '靠关键词统计，可能把玩笑也算进去'}>
                  {n.warn ? '不对等' : '待核实'}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="fr-sub">
        <span className="fr-sub__id">—</span>
        <span className="fr-sub__t">原话</span>
        <span className="fr-sub__r">QUOTES · AUTO-PICKED</span>
      </div>
      {loading ? (
        <div className="fr-log" aria-busy="true" aria-label="正在挑选摘录">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="fr-log__row"><Skeleton width={74} height={10} /><Skeleton width={30} height={10} /><Skeleton width={`${50 + i * 9}%`} height={12} /></div>
          ))}
        </div>
      ) : moments.length === 0 ? (
        <div className="fr-note">还没挑出值得回看的话——聊得再多一些，这里会出现你们的原话。</div>
      ) : (
        <div className="fr-log">
          {moments.map((m, i) => {
            const self = m.from_id === 'self' || m.from === '你';
            return (
              <div key={i} className="fr-log__row">
                <span className="fr-log__d">{m.date}</span>
                <span className={cx('fr-log__w', self && 'is-you')}>{self ? '你' : shortName(displayName(m.from_id || friend.id, m.from))}</span>
                <span className="fr-log__t">{maskText(m.text)}</span>
              </div>
            );
          })}
        </div>
      )}
    </Module>
  );
}

// ———————————————————————— 20 关联 ————————————————————————

function edgeLabel(c: FriendConnection): { kind: string; v: string } {
  switch (c.edge_type) {
    case 'mutual_reply': return { kind: '群里互相回复', v: fmt(c.weight) };
    case 'mention': return { kind: '提到对方', v: fmt(c.mention_count ?? c.weight) };
    case 'moments_cross': return { kind: '朋友圈互动', v: fmt(c.moments_cross ?? c.weight) };
    case 'co_group': return { kind: '同在一个群', v: `${fmt(c.shared_group_count ?? c.weight)} 群` };
    case 'private': return { kind: '私聊', v: fmt(c.weight) };
    default: return { kind: '关联', v: fmt(c.weight) };
  }
}

function LinksModule({ friend, onOpen }: { friend: FriendDetail; onOpen: (id: string) => void }) {
  const [conns, setConns] = useState<FriendConnection[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  // The pair export used to hide behind a 📤 chip; it is a plain key now.
  const [peer, setPeer] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setConns(null);
    setFailed(false);
    getFriendConnections(friend.id)
      .then(r => { if (!cancelled) setConns(r.connections); })
      .catch(() => { if (!cancelled) { setConns([]); setFailed(true); } });
    return () => { cancelled = true; };
  }, [friend.id, nonce]);
  const name = displayName(friend.id, friend.name);
  const top = (conns || []).slice(0, 10);
  return (
    <Module
      id="20" title="关联" en="LINKS · FRIENDS OF THIS FRIEND" className="fr-m20"
      right={conns && !failed ? `${conns.length} LINKS` : undefined}
    >
      {!conns ? (
        <div className="fr-links" aria-busy="true" aria-label="正在读取关联朋友">
          {Array.from({ length: 5 }, (_, i) => <div key={i} className="fr-links__row is-skel"><Skeleton width="40%" height={11} /></div>)}
        </div>
      ) : failed ? (
        <div className="fr-inline-err">
          <span className="ui-led ui-led--error" />
          <span>关联朋友没能读出来。</span>
          <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={() => setNonce(n => n + 1)}>重试</Button>
        </div>
      ) : top.length === 0 ? (
        <div className="fr-note">在你的其他聊天里，还没看到 {name} 和别人的交集。</div>
      ) : (
        <>
          <div className="fr-links">
            {top.map(c => {
              const e = edgeLabel(c);
              const cname = displayName(c.wxid, c.name);
              return (
                <div key={c.wxid + c.edge_type} className="fr-links__row">
                  <button type="button" className="fr-links__open" onClick={() => onOpen(c.wxid)} title={`打开 ${cname} 的档案`}>
                    <span className="fr-links__n">{cname}</span>
                    <span className="fr-links__k">{e.kind}</span>
                    <span className="fr-links__v">{e.v}</span>
                  </button>
                  <button
                    type="button" className="fr-links__x"
                    onClick={() => setPeer({ id: c.wxid, name: c.name })}
                    title={`导出 ${name} 和 ${cname} 之间的关系档案`}
                  >
                    导出这对
                  </button>
                </div>
              );
            })}
          </div>
          {(conns?.length ?? 0) > top.length && (
            <div className="fr-links__more">还有 {(conns?.length ?? 0) - top.length} 条更弱的连线</div>
          )}
        </>
      )}
      <Dialog
        open={!!peer}
        onClose={() => setPeer(null)}
        eyebrow="PAIR EXPORT"
        title={peer ? `${name} × ${displayName(peer.id, peer.name)}` : ''}
        description="导出他们俩之间的关系全貌"
        size="md"
      >
        {peer && <PairAnalysisPanel a={friend.id} aName={friend.name} b={peer.id} bName={peer.name} bare />}
      </Dialog>
    </Module>
  );
}

// ———————————————————————— 21 操作 ————————————————————————

const EXPORT_FORMATS: { id: ExportFormat; label: string; sub: string }[] = [
  { id: 'csv', label: 'CSV', sub: 'Excel 表格' },
  { id: 'md', label: 'Markdown', sub: '笔记 / 给 AI' },
  { id: 'chatlab', label: 'ChatLab', sub: '导入 ChatLab' },
  { id: 'html', label: 'HTML', sub: '离线网页' },
  { id: 'json', label: 'JSON', sub: '给脚本' },
  { id: 'txt', label: 'TXT', sub: '纯文本' },
];

const MEDIA_OPTIONS: { id: MediaPolicy; label: string; sub: string }[] = [
  { id: 'none', label: '不带附件', sub: '只导出文字，最快' },
  { id: 'originals', label: '仅原图', sub: '已解密的原图 / 视频' },
  { id: 'best', label: '尽可能', sub: '没有原图就用缩略图' },
];

function ActionsModule({ onChat, onYearbook, onAIPack, onExport, pickerOpen, setPickerOpen }: {
  onChat: () => void;
  onYearbook: () => void;
  onAIPack: () => void;
  onExport: (fmt: ExportFormat, media: MediaPolicy) => Promise<ExportReport | null>;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean | ((o: boolean) => boolean)) => void;
}) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [media, setMedia] = useState<MediaPolicy>('none');
  const [report, setReport] = useState<ExportReport | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  async function pick(f: ExportFormat) {
    setBusy(f);
    setReport(null);
    setExportError(null);
    try {
      const r = await onExport(f, media);
      if (r) setReport(r);
      else setPickerOpen(false);
    } catch (e) {
      setExportError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const keys: { k: string; label: string; sub: string; on: () => void; expanded?: boolean }[] = [
    { k: 'C', label: '完整对话', sub: '逐条浏览，可跳到任意一天', on: onChat },
    { k: 'X', label: '导出聊天', sub: pickerOpen ? '选择附件和格式' : '6 种格式 · 可带附件', on: () => setPickerOpen(o => !o), expanded: pickerOpen },
    { k: 'Y', label: '双人年代记', sub: '按年份的故事时间线', on: onYearbook },
    { k: 'A', label: 'AI 分析包', sub: '打包给本机或在线 AI', on: onAIPack },
  ];

  return (
    <Module id="21" title="操作" en="ACTIONS" className="fr-m21">
      <div className="fr-acts">
        {keys.map(k => (
          <button key={k.k} type="button" className={cx('fr-act', k.expanded && 'is-open')} onClick={k.on}
            aria-expanded={k.expanded}>
            <span className="ui-kbd">{k.k}</span>
            <span className="fr-act__l">{k.label}</span>
            <span className="fr-act__s">{k.sub}</span>
            <span className="fr-act__arrow" aria-hidden="true">{k.expanded === undefined ? '→' : k.expanded ? '−' : '+'}</span>
          </button>
        ))}
      </div>
      {pickerOpen && (
        <div className="fr-exp">
          <div className="ui-label fr-exp__l">MEDIA<b>附件</b></div>
          <div className="fr-exp__media" role="radiogroup" aria-label="附件">
            {MEDIA_OPTIONS.map(o => (
              <button key={o.id} type="button" role="radio" aria-checked={media === o.id} disabled={busy !== null}
                className={cx('fr-exp__opt', media === o.id && 'is-on')}
                onClick={() => { setMedia(o.id); setReport(null); }}>
                <span className="fr-exp__radio" aria-hidden="true" />
                <span className="fr-exp__t">{o.label}</span>
                <span className="fr-exp__s">{o.sub}</span>
              </button>
            ))}
          </div>
          <div className="ui-label fr-exp__l">FORMAT<b>格式 · 点一下就导出</b></div>
          <div className="fr-exp__fmts">
            {EXPORT_FORMATS.map(f => (
              <button key={f.id} type="button" disabled={busy !== null} title={f.sub}
                className={cx('fr-exp__fmt', busy === f.id && 'is-busy')} onClick={() => pick(f.id)}>
                <span className="fr-exp__t">{busy === f.id ? '导出中…' : f.label}</span>
                <span className="fr-exp__s">{f.sub}</span>
              </button>
            ))}
          </div>
          {media !== 'none' && !report && (
            <p className="fr-exp__note">
              带附件时会生成一个文件夹（聊天文件 + media/ 附件 + 导出报告），不走浏览器下载。
              {media === 'originals' ? '只拷已解密的原图和本机已有的视频。' : '原图缺失时用缩略图顶上。'}
              ChatLab 格式没有附件字段，附件只放在 media/ 里。
            </p>
          )}
          {exportError && <p className="fr-exp__err" role="alert">{maskText(exportError)}</p>}
          {report && <ExportReportCard report={report} />}
          <div className="fr-exp__foot">
            <Button size="sm" variant="ghost" onClick={() => { setPickerOpen(false); setReport(null); setExportError(null); }}>收起</Button>
          </div>
        </div>
      )}
    </Module>
  );
}

function ExportReportCard({ report }: { report: ExportReport }) {
  const m = report.media;
  const reasons = Object.entries(m.missing_reasons || {});
  return (
    <div className="fr-exp__rep" role="status">
      <div className="fr-exp__rep-h"><span className="ui-led" /> 已导出 <b>{fmt(report.messages)}</b> 条消息</div>
      <div className="fr-exp__rep-ro">
        <span>媒体消息 <b>{fmt(m.media_messages)}</b></span>
        <span>附件成功 <b>{fmt(m.exported_total)}</b>{m.exported_thumbnail > 0 && <>（缩略图 {fmt(m.exported_thumbnail)}）</>}</span>
        <span className={cx(m.missing_total > 0 && 'is-bad')}>缺失 <b>{fmt(m.missing_total)}</b></span>
      </div>
      {reasons.length > 0 && (
        <ul>
          {reasons.map(([code, n]) => <li key={code}>{m.missing_reason_labels?.[code] || code}：{fmt(n)}</li>)}
        </ul>
      )}
      {m.thumbnail_skipped > 0 && <p>其中 {fmt(m.thumbnail_skipped)} 个有缩略图，换「尽可能」可以导出缩略图。</p>}
      <div className="fr-exp__rep-f">
        <Button size="sm" onClick={() => { void openFolder(report.file); }}>打开文件夹</Button>
        <span>{maskText(report.dir)}</span>
      </div>
    </div>
  );
}

// ———————————————————————— states ————————————————————————

function FriendSkeleton() {
  return (
    <div className="fr-page" aria-busy="true" aria-label="正在读取档案">
      <div className="fr-rack ui-rack">
        <Module as="div" className="fr-m14">
          <div className="fr-id">
            <Skeleton width={110} height={72} />
            <div className="fr-id__text fr-skel-lines">
              <Skeleton width={90} height={10} />
              <Skeleton width={140} height={18} />
              <Skeleton width={120} height={16} />
              <Skeleton width={220} height={10} />
            </div>
          </div>
          <div className="fr-ros">
            {['MSG', 'SPAN', 'CALLS', 'SILENCE MAX', 'REPLY P50', 'LATE NIGHT'].map(k => (
              <div key={k} className="fr-ro">
                <div className="ui-label">{k}</div>
                <div className="fr-ro__v"><Skeleton width="62%" height={34} /></div>
              </div>
            ))}
          </div>
        </Module>
        <Module id="15" title="逐年" en="YEARLY MSG" className="fr-m15">
          <div className="fr-years fr-years--skel">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="fr-yr">
                <div className="fr-yr__up"><Skeleton width="44%" height={24 + ((i * 37) % 50)} /></div>
                <div className="fr-yr__dn"><Skeleton width="44%" height={16 + ((i * 23) % 40)} /></div>
              </div>
            ))}
          </div>
        </Module>
      </div>
    </div>
  );
}

// ———————————————————————— page ————————————————————————

export function FriendPage({ friendId, onBack, onOpenFriend }: Props) {
  void usePrivacy();
  const [friend, setFriend] = useState<FriendDetail | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [momentsLoading, setMomentsLoading] = useState(true);
  const [yb, setYb] = useState<Yearbook | null>(null);
  const [ybError, setYbError] = useState<unknown>(null);
  const [ybNonce, setYbNonce] = useState(0);
  const [reportText, setReportText] = useState<string | null>(null);
  const [reportError, setReportError] = useState<unknown>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Manual-AI pack just generated — ReportReadyBanner (copy / open folder /
  // send online) until dismissed.
  const [readyPack, setReadyPack] = useState<{
    ok: boolean; path: string; size: number; name: string; content: string;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [tab, setTab] = useState<FriendTab>('story');
  const [agentInvoke, setAgentInvoke] = useState<string | null>(null);  // 'claude' | 'codex' …, null = idle
  const [reader, setReader] = useState<{ section: string | null } | null>(null);
  const [analysisStream, setAnalysisStream] = useState<Stream | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // 完整对话 opens the chat page (#/chat/<id>).
  const openChat = useCallback(() => { window.location.hash = `#/chat/${encodeURIComponent(friendId)}`; }, [friendId]);
  const openYearbook = useCallback(() => { window.location.hash = `#yearbook/${friendId}`; }, [friendId]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setFriend(null);
    getFriend(friendId)
      .then(d => { if (!cancelled) setFriend(d as FriendDetail); })
      .catch(e => { if (!cancelled) setError(e); });
    setMomentsLoading(true);
    getMoments(friendId)
      .then(m => { if (!cancelled) setMoments(m); })
      .catch(() => { if (!cancelled) setMoments([]); })
      .finally(() => { if (!cancelled) setMomentsLoading(false); });
    return () => { cancelled = true; };
  }, [friendId, loadNonce]);

  // Year-by-year numbers (15, 17). Only once the friend has messages.
  const hasStats = !!friend?.stats;
  useEffect(() => {
    if (!hasStats) return;
    let cancelled = false;
    setYb(null);
    setYbError(null);
    getYearbook(friendId)
      .then(d => { if (!cancelled) setYb(d); })
      .catch(e => { if (!cancelled) setYbError(e); });
    return () => { cancelled = true; };
  }, [friendId, hasStats, ybNonce]);

  // The full report, for its contents list and the reader.
  const reportPath = friend?.aiReport?.available ? friend.aiReport.path : null;
  const reportMtime = friend?.aiReport?.mtime ?? 0;
  const [reportNonce, setReportNonce] = useState(0);
  useEffect(() => {
    setReportText(null);
    setReportError(null);
    if (!reportPath) return;
    let cancelled = false;
    getReport(reportPath)
      .then(r => { if (!cancelled) setReportText(r.content); })
      .catch(e => { if (!cancelled) setReportError(e); });
    return () => { cancelled = true; };
  }, [reportPath, reportMtime, reportNonce]);

  // A local-agent analysis that is still running (or just failed) for this friend.
  useEffect(() => {
    let cancelled = false;
    let pollId: number | null = null;

    async function refreshFriend() {
      const d = await getFriend(friendId);
      if (!cancelled) setFriend(d as FriendDetail);
    }

    async function tick() {
      try {
        const s = await getInvokeStream(friendId);
        if (cancelled) return;
        if (s.running) {
          setAnalysisError(null);
          setAnalysisStream({ output: s.output || '', stage: s.stage || 'running', elapsed: s.elapsed || 0 });
          return;
        }
        if (s.error) {
          setAnalysisError(s.error);
          setAnalysisStream({ output: s.output || '', stage: s.stage || 'failed', elapsed: s.elapsed || 0 });
          if (pollId != null) window.clearInterval(pollId);
          return;
        }
        if (s.stage === 'saved') await refreshFriend();
        setAnalysisStream(null);
        setAnalysisError(null);
        if (pollId != null) window.clearInterval(pollId);
      } catch {
        // Keep the page usable if the progress endpoint is briefly unavailable.
      }
    }

    getInvokeStream(friendId)
      .then(s => {
        if (cancelled) return;
        if (s.running) {
          setAnalysisError(null);
          setAnalysisStream({ output: s.output || '', stage: s.stage || 'running', elapsed: s.elapsed || 0 });
          pollId = window.setInterval(tick, 2000);
        } else if (s.error) {
          setAnalysisError(s.error);
          setAnalysisStream({ output: s.output || '', stage: s.stage || 'failed', elapsed: s.elapsed || 0 });
        } else if (s.stage === 'saved') {
          refreshFriend().catch(() => {});
        } else {
          setAnalysisStream(null);
          setAnalysisError(null);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (pollId != null) window.clearInterval(pollId);
    };
  }, [friendId]);

  const parsed = useMemo(() => (reportText ? parseReport(maskText(reportText)) : null), [reportText]);

  async function handleExportChat(f: ExportFormat, media: MediaPolicy): Promise<ExportReport | null> {
    if (!friend) return null;
    // cli/exporters.py: full history, raw display names (the export is a
    // personal local archive; privacy mode only masks the screen).
    return exportFriendChat(friend.id, f, media);
  }

  const ready = !!friend && !agentInvoke && tab === 'story';
  const openReader = (section?: string) => {
    if (!friend?.aiReport?.available) return;
    if (!reportText) setReportNonce(n => n + 1);
    setReader({ section: section ?? null });
  };
  usePageKeys({
    r: friend?.aiReport?.available ? () => openReader() : undefined,
    g: () => setExportOpen(true),
    c: openChat,
    x: () => setPickerOpen(o => !o),
    y: openYearbook,
    a: () => setExportOpen(true),
  }, ready && !exportOpen && !reader);

  if (error) {
    const raw = errText(error);
    const code = errorCode(error);
    const entry = lookupError(code);
    return (
      <>
        <PageHeader back={{ label: '年代记', onClick: onBack }} title="档案" />
        <ErrorState
          layout="page"
          title={entry?.title ?? '这位朋友的档案没能加载'}
          code={code ?? undefined}
          reason={entry?.reason ?? '读取这位朋友的资料时出错了。'}
          fixes={entry ? [entry.fix] : ['点「重试」再读一次', '还不行就到「设置」里复制诊断信息反馈给我们']}
          onRetry={() => setLoadNonce(n => n + 1)}
          details={raw ? <pre>{maskText(raw)}</pre> : undefined}
        />
      </>
    );
  }
  if (!friend) {
    return (
      <>
        <PageHeader back={{ label: '年代记', onClick: onBack }} title="档案" subtitle="读取中…" />
        <FriendSkeleton />
      </>
    );
  }

  // A local agent was picked in the drawer: its streaming report replaces the page.
  if (agentInvoke) {
    return <RelationshipReportView friend={friend} cli={agentInvoke} onClose={() => {
      setAgentInvoke(null);
      // Re-fetch so a freshly saved report shows up in 18.
      getFriend(friendId).then(d => setFriend(d as FriendDetail)).catch(() => {});
    }} />;
  }

  const name = displayName(friend.id, friend.name);
  const stats = friend.stats;
  const sig = friend.relationship_signals;
  const since = yb?.first_date || null;
  const rep = friend.aiReport?.available ? friend.aiReport : null;

  return (
    <div className="fr-page">
      <PageHeader back={{ label: '年代记', onClick: onBack }} title={`档案 · ${name}`} subtitle={maskedWxid(friend.id)}>
        <SegmentedControl
          label="档案视图"
          size="sm"
          value={tab}
          onChange={(v) => setTab(v as FriendTab)}
          options={[{ value: 'story', label: '档案' }, { value: 'media', label: '相册' }]}
        />
        <Button size="sm" kbd="C" onClick={openChat}>完整对话</Button>
      </PageHeader>

      {readyPack && (
        <div className="fr-banner">
          <ReportReadyBanner
            pack={readyPack}
            friend={friend}
            onOpenLocation={() => { /* openFolder runs inside the banner */ }}
            onCopy={() => { void navigator.clipboard.writeText(readyPack.content); }}
            onSendOnline={() => {
              // Manual hand-off: the user copies + pastes themselves.
              window.open('https://chat.openai.com/', '_blank');
            }}
            onDismiss={() => setReadyPack(null)}
          />
        </div>
      )}

      {tab === 'media' ? (
        <MediaGallery friend={friend} />
      ) : (
        <div className="fr-rack ui-rack">
          <HeadModule friend={friend} stats={stats} sig={sig} since={since} />
          {stats ? (
            <YearsModule friend={friend} stats={stats} yb={yb} ybError={ybError} onRetry={() => setYbNonce(n => n + 1)} />
          ) : (
            <Module id="15" title="逐年" en="YEARLY MSG" className="fr-m15">
              <EmptyState
                icon={<IconInbox size={22} />}
                label="NOT ENOUGH DATA"
                title="消息太少，还画不出逐年的变化"
                description={`你们一共 ${fmt(friend.count)} 条消息。多聊一阵子，这里会出现每年你说了多少、对方说了多少。`}
              />
            </Module>
          )}
          <EvidenceModule sig={sig} yb={yb} />
          <RhythmModule friend={friend} stats={stats} yb={yb} ybError={ybError} />
          <ReportModule
            friend={friend}
            parsed={parsed}
            reportError={reportError}
            stream={analysisStream}
            streamError={analysisError}
            onOpen={openReader}
            onRerun={() => setExportOpen(true)}
          />
          <NotesModule friend={friend} sig={sig} moments={moments} loading={momentsLoading} />
          <LinksModule friend={friend} onOpen={(id) => onOpenFriend?.(id)} />
          <ActionsModule
            onChat={openChat}
            onYearbook={openYearbook}
            onAIPack={() => setExportOpen(true)}
            onExport={handleExportChat}
            pickerOpen={pickerOpen}
            setPickerOpen={setPickerOpen}
          />
          <div className="fr-sign">只在这台电脑上 · Murmur 不会把任何内容上传到云端</div>
        </div>
      )}

      <AIAssistantDrawer
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        friend={friend}
        onComplete={(pack) => { setReadyPack(pack); setExportOpen(false); }}
        onLocalAgent={(cli) => { setExportOpen(false); setAgentInvoke(cli); }}
      />

      {reader && rep && (
        <ReportReader
          title={parsed?.title ? maskText(parsed.title) : `与 ${name} 的关系档案`}
          meta={(
            <>
              关于 <b>{name}</b> · {ageOf(rep.mtime).date} 生成（{ageOf(rep.mtime).rel}） · {(rep.size / 1024).toFixed(1)} KB
            </>
          )}
          sections={parsed?.sections ?? []}
          raw={!parsed ? (reportError != null ? `报告没能打开：${maskText(errText(reportError))}` : '正在读取报告…') : undefined}
          initial={reader.section}
          onClose={() => setReader(null)}
          actions={parsed ? (
            <Button size="sm" variant="ghost" icon={<IconCopy size={13} />}
              onClick={() => { void navigator.clipboard.writeText(maskText(reportText || '')); }}>
              复制全文
            </Button>
          ) : undefined}
        />
      )}
    </div>
  );
}
