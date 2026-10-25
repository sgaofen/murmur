/* 年度 (#/annual) — one year across every chat, on the instrument rack.
 * Reads /api/annual-report/years and /api/annual-report?year=…
 *
 *   35 抬头   the year + six readouts
 *   36 逐月   monthly totals as a 12-column meter, each month's top friend beneath
 *   37 常聊   the year's most-talked-to friends
 *   38 作息   weekday × hour grid
 *   39 记录   busiest day, longest streak, night owl, most even, drifted apart
 *   40 主动   who starts the conversation
 *   41 口头禅  your most repeated phrases
 *
 * Every field the backend sends is optional in practice (an empty year comes
 * back as `{ year, total_messages: 0 }`, older backends omit whole blocks),
 * so the payload goes through normalize() first and the page only ever reads
 * checked values — nothing renders as "undefined" / "NaN". Styles:
 * ./AnnualReport.css (prefix an-). */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { PageHeader } from '../shell/PageHeader';
import { Button, EmptyState, ErrorState, Module, SegmentedControl, Skeleton, cx } from '../ui';
import { IconCalendar } from '../ui/icons';
import { errorCode, getAnnualReport, getAvailableReportYears, type AnnualReport } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import { displayName, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import './AnnualReport.css';

interface Props {
  /** Unused since the app shell's nav replaced the page's own ← 返回. */
  onBack: () => void;
  onOpenFriend?: (wxid: string) => void;
}

// ———————————————————————— safe reads ————————————————————————

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
function numList(v: unknown, len: number): number[] | null {
  if (!Array.isArray(v) || v.length !== len) return null;
  return v.map(x => Math.max(0, num(x) ?? 0));
}

/** Fixed thousands separators ("38,032") whatever the OS locale. */
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
/** "2025-03-14" → "03-14" (the year is on the page already). */
function md(date: string | null): string | null {
  if (!date) return null;
  const m = /^\d{4}-(\d{2}-\d{2})/.exec(date);
  return m ? m[1] : date;
}

interface Person { wxid: string; name: string }
interface TopRow extends Person { count: number; self: number | null; other: number | null }
interface Winner { month: number; person: Person | null; count: number; total: number }
interface Year {
  year: number;
  total: number;
  friends: number | null;
  activeDays: number | null;
  first: string | null;
  last: string | null;
  monthly: number[] | null;
  top: TopRow[];
  winners: Winner[] | null;
  peakDay: { date: string; count: number; top: (Person & { count: number | null }) | null } | null;
  streak: { days: number; start: string | null; end: string | null } | null;
  heat: number[] | null;
  midnight: (Person & { count: number | null; share: number | null }) | null;
  mutual: (Person & { self: number | null; other: number | null; ratio: number | null }) | null;
  initiative: { self: number; other: number; rate: number | null; top: (Person & { count: number | null }) | null } | null;
  replySec: number | null;
  phrases: { phrase: string; count: number }[];
  lost: (Person & { first: number | null; second: number | null; drop: number | null }) | null;
}

function person(o: Record<string, unknown> | null, idKey = 'wxid', nameKey = 'name'): Person | null {
  if (!o) return null;
  const wxid = str(o[idKey]);
  const name = str(o[nameKey]);
  if (!wxid && !name) return null;
  return { wxid: wxid ?? '', name: name ?? wxid ?? '' };
}

function normalize(raw: AnnualReport | null | undefined, fallbackYear: number): Year {
  const r = (obj(raw) ?? {}) as Record<string, unknown>;
  const top: TopRow[] = Array.isArray(r.top_friends)
    ? r.top_friends.map(t => {
      const o = obj(t);
      const p = person(o);
      const count = num(o?.count);
      return p && count != null && count > 0 ? { ...p, count, self: num(o?.self), other: num(o?.other) } : null;
    }).filter((t): t is TopRow => t != null)
    : [];
  const winners: Winner[] | null = Array.isArray(r.monthly_winners) && r.monthly_winners.length === 12
    ? r.monthly_winners.map((w, i) => {
      const o = obj(w);
      return {
        month: num(o?.month) ?? i + 1,
        person: (num(o?.count) ?? 0) > 0 ? person(o) : null,
        count: Math.max(0, num(o?.count) ?? 0),
        total: Math.max(0, num(o?.month_total) ?? 0),
      };
    })
    : null;
  const pd = obj(r.peak_day);
  const pdDate = str(pd?.date);
  const pdCount = num(pd?.count);
  const st = obj(r.longest_streak);
  const stDays = num(st?.days);
  const mk = obj(r.midnight_king);
  const mu = obj(r.mutual_friend);
  const ini = obj(r.initiative);
  const iniSelf = num(ini?.self_starts);
  const iniOther = num(ini?.other_starts);
  const lf = obj(r.lost_friend);
  const phrases = Array.isArray(r.top_phrases)
    ? r.top_phrases.map(p => {
      const o = obj(p);
      const phrase = str(o?.phrase);
      const count = num(o?.count);
      return phrase && count != null ? { phrase, count } : null;
    }).filter((p): p is { phrase: string; count: number } => p != null)
    : [];
  const midnight = person(mk);
  const mutual = person(mu);
  const lost = person(lf);
  const pdTop = person(pd, 'top_wxid', 'top_name');
  const iniTop = person(ini, 'top_initiated_wxid', 'top_initiated_name');
  return {
    year: num(r.year) ?? fallbackYear,
    total: Math.max(0, num(r.total_messages) ?? 0),
    friends: num(r.total_friends_active),
    activeDays: num(r.active_days),
    first: str(r.first_message_date),
    last: str(r.last_message_date),
    monthly: numList(r.monthly_totals, 12),
    top,
    winners,
    peakDay: pdDate && pdCount != null
      ? { date: pdDate, count: pdCount, top: pdTop ? { ...pdTop, count: num(pd?.top_count) } : null }
      : null,
    streak: stDays != null && stDays > 0 ? { days: stDays, start: str(st?.start), end: str(st?.end) } : null,
    heat: numList(r.heatmap_24x7, 168),
    midnight: midnight ? { ...midnight, count: num(mk?.count), share: num(mk?.share) } : null,
    mutual: mutual ? { ...mutual, self: num(mu?.self), other: num(mu?.other), ratio: num(mu?.ratio) } : null,
    initiative: iniSelf != null && iniOther != null && iniSelf + iniOther > 0
      ? {
        self: iniSelf, other: iniOther, rate: num(ini?.self_rate),
        top: iniTop ? { ...iniTop, count: num(ini?.top_initiated_count) } : null,
      }
      : null,
    replySec: num(r.median_reply_sec),
    phrases,
    lost: lost ? { ...lost, first: num(lf?.first_half), second: num(lf?.second_half), drop: num(lf?.drop_pct) } : null,
  };
}

/** 96 → { v: '1.6', u: 'MIN' } */
function duration(sec: number): { v: string; u: string } {
  if (sec < 60) return { v: String(Math.round(sec)), u: 'S' };
  if (sec < 3600) return { v: (sec / 60).toFixed(sec < 600 ? 1 : 0), u: 'MIN' };
  return { v: (sec / 3600).toFixed(1), u: 'H' };
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const Dash = () => <span className="an-dash">—</span>;

// ———————————————————————— page ————————————————————————

export function AnnualReportPage({ onOpenFriend }: Props) {
  void usePrivacy();
  // null until /years answers; [] means there is no year with any message.
  const [years, setYears] = useState<number[] | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [data, setData] = useState<AnnualReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Bumped by the error screen's retry button.
  const [nonce, setNonce] = useState(0);

  // Pull available years once (again after a failed first try)
  useEffect(() => {
    if (years !== null) return;
    let cancelled = false;
    setError(null);
    getAvailableReportYears()
      .then(r => {
        if (cancelled) return;
        const list = Array.isArray(r?.years) ? r.years.filter(y => num(y) != null).sort((a, b) => a - b) : [];
        setYears(list);
        // Default to "last completed year" — current year often half-empty.
        const def = num(r?.default);
        const target = def != null && list.includes(def) ? def : (list[list.length - 1] ?? null);
        setYear(target);
        if (target == null) setLoading(false);
      })
      .catch(e => { if (!cancelled) { setError(e); setLoading(false); } });
    return () => { cancelled = true; };
  }, [years, nonce]);

  // Pull report once year is chosen
  useEffect(() => {
    if (year == null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    getAnnualReport(year)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [year, nonce]);

  const y = useMemo(() => (data && year != null ? normalize(data, year) : null), [data, year]);

  let body: ReactNode;
  if (error) {
    const code = errorCode(error);
    const entry = lookupError(code);
    const raw = error instanceof Error ? error.message : String(error);
    body = (
      <ErrorState
        layout="page"
        code={code ?? undefined}
        title={entry?.title ?? (year != null ? `${year} 年的年度总览没能生成` : '年度总览没能加载')}
        reason={entry?.reason ?? '统计全年聊天时本地服务返回了错误。'}
        fixes={entry ? [entry.fix] : ['点「重试」再算一次', '还不行就到「设置」里复制诊断信息反馈给我们']}
        onRetry={() => setNonce(n => n + 1)}
        details={raw ? <pre>{maskText(raw)}</pre> : undefined}
      />
    );
  } else if (years && years.length === 0) {
    body = (
      <EmptyState
        className="an-empty"
        layout="page"
        icon={<IconCalendar size={24} />}
        label="NO DATA · 00"
        title="还没有可以统计的年份"
        description="解密后的数据里还没有聊天记录。去年代记点「更新数据」，解密完成后这里会按年份出现你的年度总览。"
      />
    );
  } else if (loading || !y) {
    body = <AnnualSkeleton year={year} />;
  } else if (y.total === 0) {
    const others = (years ?? []).filter(v => v !== y.year);
    const nearest = others.length ? others.reduce((a, b) => (Math.abs(b - y.year) < Math.abs(a - y.year) ? b : a)) : null;
    body = (
      <EmptyState
        className="an-empty"
        layout="page"
        icon={<IconCalendar size={24} />}
        label={`NO DATA · ${y.year}`}
        title={`${y.year} 年没有聊天记录`}
        description={nearest != null
          ? '这一年里没有任何一条消息。顶部换个年份看看。'
          : '这一年还没有消息，等聊天多起来再来看。'}
        actions={nearest != null ? <Button variant="primary" onClick={() => setYear(nearest)}>看 {nearest} 年</Button> : undefined}
      />
    );
  } else {
    body = <Body y={y} onOpenFriend={onOpenFriend} />;
  }

  return (
    <div className="an-page">
      <PageHeader title="年度总览" subtitle="你的所有朋友 + 所有聊天">
        <YearSwitcher years={years} pending={!error} value={year} onChange={setYear} />
      </PageHeader>
      {body}
    </div>
  );
}

// ———————————————————————— year switcher ————————————————————————

function YearSwitcher({ years, pending, value, onChange }: {
  years: number[] | null; pending: boolean; value: number | null; onChange: (y: number) => void;
}) {
  if (years === null) return pending ? <Skeleton width={150} height={22} /> : null;
  if (!years.length) return <span className="app-header__label">无可用年份</span>;
  // A handful of years: one key per year. More than that: a stepper, so the
  // strip never fills up with a dozen keys.
  if (years.length <= 6) {
    return (
      <SegmentedControl
        label="选择年份"
        size="sm"
        value={value === null ? '' : String(value)}
        onChange={(v) => onChange(Number(v))}
        options={years.map(y => ({ value: String(y), label: String(y) }))}
      />
    );
  }
  const i = value == null ? -1 : years.indexOf(value);
  return (
    <div className="an-step" role="group" aria-label="选择年份">
      <button type="button" className="an-step__k" disabled={i <= 0}
        onClick={() => i > 0 && onChange(years[i - 1])} aria-label="上一年" title="上一年">‹</button>
      <label className="an-step__sel">
        <span className="an-step__l" aria-hidden="true">YEAR</span>
        <select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))} aria-label="年份">
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </label>
      <button type="button" className="an-step__k" disabled={i < 0 || i >= years.length - 1}
        onClick={() => i >= 0 && i < years.length - 1 && onChange(years[i + 1])} aria-label="下一年" title="下一年">›</button>
    </div>
  );
}

// ———————————————————————— loading ————————————————————————

/** The report's shape while the year is being counted (first run scans every chat). */
function AnnualSkeleton({ year }: { year: number | null }) {
  return (
    <div className="an-rack ui-rack" aria-busy="true">
      <Module as="div" className="an-m35" aria-label="正在统计">
        <div className="an-id" role="status">
          <div className={cx('an-id__code', 'is-scan')} aria-hidden="true">{year ?? '····'}</div>
          <div className="an-id__text">
            <div className="ui-label">SCAN<b>{year != null ? `正在统计 ${year} 年` : '正在读取有聊天的年份'}</b></div>
            <div className="an-scan" aria-hidden="true">
              {Array.from({ length: 30 }, (_, i) => <i key={i} style={{ animationDelay: `${(i * 60) % 1800}ms` }} />)}
            </div>
            <div className="an-id__meta">首次扫描全部聊天约 10–30 秒<br />之后会快很多</div>
          </div>
        </div>
        <div className="an-ros" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="an-ro"><Skeleton width={70} height={10} /><Skeleton width="62%" height={30} /><Skeleton width="48%" height={9} /></div>
          ))}
        </div>
      </Module>
      <Module id="36" title="逐月" en="MONTHLY" className="an-m36" aria-hidden="true">
        <div className="an-mo an-mo--skel">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="an-mo__col"><span className="an-mo__bar"><i style={{ height: `${22 + ((i * 37) % 60)}%` }} /></span></div>
          ))}
        </div>
      </Module>
      {(['37', '38', '39', '40', '41'] as const).map(id => (
        <Module key={id} id={id} title={SKEL_TITLES[id]} className={`an-m${id}`} aria-hidden="true">
          <div className="an-skel">
            {Array.from({ length: id === '37' ? 9 : 5 }, (_, i) => <Skeleton key={i} width={`${86 - ((i * 23) % 40)}%`} height={11} />)}
          </div>
        </Module>
      ))}
    </div>
  );
}
const SKEL_TITLES: Record<string, string> = { '37': '常聊', '38': '作息', '39': '记录', '40': '主动', '41': '口头禅' };

// ———————————————————————— body ————————————————————————

function Body({ y, onOpenFriend }: { y: Year; onOpenFriend?: (wxid: string) => void }) {
  const open = (p: Person | null) => (p?.wxid && onOpenFriend ? () => onOpenFriend(p.wxid) : undefined);
  return (
    <div className="an-rack ui-rack">
      <HeadModule y={y} />
      <MonthsModule y={y} open={open} />
      <TopModule y={y} open={open} />
      <HeatModule heat={y.heat} />
      <RecordsModule y={y} open={open} />
      <InitiativeModule y={y} open={open} />
      <PhrasesModule phrases={y.phrases} />
    </div>
  );
}

type Opener = (p: Person | null) => (() => void) | undefined;

/** A person's name; a button when their profile can be opened. */
function Who({ p, open, className }: { p: Person | null; open: Opener; className?: string }) {
  if (!p) return <Dash />;
  const label = displayName(p.wxid, p.name);
  const onClick = open(p);
  if (!onClick) return <span className={cx('an-who', className)}>{label}</span>;
  return (
    <button type="button" className={cx('an-who', 'is-link', className)} onClick={onClick} title={`打开 ${label} 的档案`}>
      {label}
    </button>
  );
}

// ———————————————————————— 35 抬头 ————————————————————————

function Readout({ en, zh, children, sub }: { en: string; zh: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="an-ro">
      <div className="ui-label an-ro__k">{en}<b>{zh}</b></div>
      <div className="ui-big an-ro__v">{children}</div>
      <div className="an-ro__s">{sub ?? ' '}</div>
    </div>
  );
}

function HeadModule({ y }: { y: Year }) {
  const daysInYear = (y.year % 4 === 0 && y.year % 100 !== 0) || y.year % 400 === 0 ? 366 : 365;
  const peakMonth = y.monthly ? y.monthly.indexOf(Math.max(...y.monthly)) : -1;
  const reply = y.replySec != null && y.replySec > 0 ? duration(y.replySec) : null;
  const span = y.first && y.last ? `${y.first} → ${y.last}` : null;
  return (
    <Module as="div" className="an-m35" aria-label={`${y.year} 年度总览`}>
      <div className="an-id">
        <div className="an-id__code" aria-hidden="true">{y.year}</div>
        <div className="an-id__text">
          <div className="ui-label">YEAR<b>年度总览</b></div>
          <h2 className="an-id__title">
            {y.friends != null
              ? <>和 <span className="ui-num">{fmt(y.friends)}</span> 位朋友，共 <span className="ui-num">{fmt(y.total)}</span> 条消息</>
              : <>一年共 <span className="ui-num">{fmt(y.total)}</span> 条消息</>}
          </h2>
          <div className="an-id__meta">
            {span ? <span>{span}</span> : <span>{y.year}</span>}
            <span>ALL CHATS · LOCAL</span>
          </div>
        </div>
      </div>
      <div className="an-ros">
        <Readout en="MSG" zh="消息" sub={y.monthly ? `月均 ${fmt(y.total / Math.max(1, y.monthly.filter(v => v > 0).length))}` : undefined}>
          {fmt(y.total)}
        </Readout>
        <Readout en="PEOPLE" zh="聊过的朋友" sub={y.top.length ? `前 ${y.top.length} 位占 ${pctOf(sum(y.top.map(t => t.count)), y.total)}%` : undefined}>
          {y.friends != null ? fmt(y.friends) : <Dash />}
        </Readout>
        <Readout en="ACTIVE" zh="有聊天的天数" sub={y.activeDays != null ? `占全年 ${pctOf(y.activeDays, daysInYear)}%` : undefined}>
          {y.activeDays != null ? <>{fmt(y.activeDays)}<small>D</small></> : <Dash />}
        </Readout>
        <Readout en="DAILY" zh="日均" sub={y.activeDays ? '按有聊天的天数算' : undefined}>
          {y.activeDays ? <>{fmt(y.total / y.activeDays)}<small>条</small></> : <Dash />}
        </Readout>
        <Readout en="PEAK" zh="最多的月份" sub={y.monthly && peakMonth >= 0 ? `${fmt(y.monthly[peakMonth])} 条` : undefined}>
          {y.monthly && peakMonth >= 0 ? <>{pad2(peakMonth + 1)}<small>月</small></> : <Dash />}
        </Readout>
        <Readout en="REPLY P50" zh="回复中位" sub={reply ? '你回复朋友' : undefined}>
          {reply ? <>{reply.v}<small>{reply.u}</small></> : <Dash />}
        </Readout>
      </div>
    </Module>
  );
}

function sum(list: number[]): number {
  let s = 0;
  for (const v of list) s += v;
  return s;
}
function pctOf(part: number, whole: number): string {
  if (!whole) return '0';
  const p = (part / whole) * 100;
  return p >= 10 ? p.toFixed(0) : p.toFixed(1);
}

// ———————————————————————— 36 逐月 ————————————————————————

function MonthsModule({ y, open }: { y: Year; open: Opener }) {
  const values = y.monthly;
  const winners = y.winners;
  if (!values && !winners) {
    return (
      <Module id="36" title="逐月" en="MONTHLY" className="an-m36">
        <div className="an-note">这一年的逐月统计还没有算出来，更新数据后再看。</div>
      </Module>
    );
  }
  const vals = values ?? new Array(12).fill(0);
  const max = Math.max(1, ...vals);
  const peak = values ? vals.indexOf(Math.max(...vals)) : -1;
  const live = vals.filter(v => v > 0);
  const low = values && live.length > 1 ? vals.indexOf(Math.min(...live)) : -1;
  return (
    <Module
      id="36" title="逐月" en="MONTHLY · MSG + 当月聊得最多的人" crop="bottom" className="an-m36"
      right={values && peak >= 0 ? (
        <>
          <span className="an-hd-strong">PEAK {pad2(peak + 1)} · {fmt(vals[peak])}</span>
          {low >= 0 && low !== peak && <span className="an-hide-md">LOW {pad2(low + 1)} · {fmt(vals[low])}</span>}
        </>
      ) : undefined}
    >
      <div className="an-mo-wrap">
        <div className="an-mo" role="img"
          aria-label={values && peak >= 0 ? `${y.year} 年每月消息量，${peak + 1} 月最多（${fmt(vals[peak])} 条）` : '每月消息量'}>
          <div className="an-mo__axis" aria-hidden="true">
            <span>{values ? fmt(max) : ''}</span>
            <span>MSG<br />/ 月</span>
            <span>0</span>
          </div>
          {vals.map((v, i) => (
            <div key={i} className={cx('an-mo__col', i === peak && 'is-peak', v === 0 && 'is-empty')}>
              <span className="an-mo__n">{values ? (v > 0 ? fmt(v) : '—') : ''}</span>
              <span className="an-mo__bar" aria-hidden="true">
                {v > 0 && <i style={{ height: `${Math.max(2, (v / max) * 100)}%` }} />}
              </span>
              <span className="an-mo__m">{pad2(i + 1)}{i === peak && <b>PEAK</b>}</span>
            </div>
          ))}
        </div>
        {winners && (
          <table className="an-mt">
            <colgroup><col className="an-mt__k" />{winners.map((_, i) => <col key={i} />)}</colgroup>
            <tbody>
              <tr>
                <th scope="row">TOP<b>当月最常聊</b></th>
                {winners.map((w, i) => (
                  <td key={i} className={cx(i === peak && 'is-peak')}>
                    {w.person ? <Who p={w.person} open={open} className="an-mt__who" /> : <Dash />}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">MSG<b>和 ta</b></th>
                {winners.map((w, i) => (
                  <td key={i} className={cx('an-mt__n', i === peak && 'is-peak')}>{w.person && w.count > 0 ? fmt(w.count) : ''}</td>
                ))}
              </tr>
              <tr>
                <th scope="row">SHARE<b>占当月</b></th>
                {winners.map((w, i) => {
                  const total = w.total || vals[i];
                  return (
                    <td key={i} className="an-mt__n">
                      {w.person && total > 0 ? <>{pctOf(w.count, total)}<small>%</small></> : ''}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </Module>
  );
}

// ———————————————————————— 37 常聊 ————————————————————————

const VU = 30;

function TopModule({ y, open }: { y: Year; open: Opener }) {
  const top = y.top.slice(0, 10);
  const max = top[0]?.count || 1;
  const topSum = sum(top.map(t => t.count));
  return (
    <Module id="37" title="常聊" right={top.length ? `TOP ${pad2(top.length)} · BY MSG` : undefined} className="an-m37">
      {top.length === 0 ? (
        <div className="an-note">这一年没有私聊记录。</div>
      ) : (
        <>
          <ol className="an-vu">
            {top.map((f, i) => {
              const n = Math.max(1, Math.round((f.count / max) * VU));
              const label = displayName(f.wxid, f.name);
              const onClick = open(f);
              const inner = (
                <>
                  <span className="an-vu__top">
                    <span className="an-vu__rk">{pad2(i + 1)}</span>
                    <span className="an-vu__name">{label}</span>
                    <span className="an-vu__pc">{pctOf(f.count, y.total)}%</span>
                    <span className="an-vu__val">{fmt(f.count)}</span>
                  </span>
                  <span className="an-vu__seg" aria-hidden="true">
                    {Array.from({ length: VU }, (_, s) => (
                      <i key={s} className={cx(s < n && (i === 0 && s >= n - 4 ? 'pk' : 'on'))} />
                    ))}
                  </span>
                  {f.self != null && f.other != null && (
                    <span className="an-vu__split">你 {fmt(f.self)} <i>/</i> 对方 {fmt(f.other)}</span>
                  )}
                </>
              );
              return (
                <li key={f.wxid || i}>
                  {onClick
                    ? <button type="button" className="an-vu__row" onClick={onClick} title={`打开 ${label} 的档案`}>{inner}</button>
                    : <div className="an-vu__row">{inner}</div>}
                </li>
              );
            })}
          </ol>
          <div className="an-m37__foot">
            <div className="an-share">
              <span className="ui-label">SHARE<b>前 {top.length} 位占全年消息</b></span>
              <span className="ui-num">{pctOf(topSum, y.total)}%</span>
            </div>
            <div className="an-bar" aria-hidden="true">
              <i style={{ width: `${Math.min(100, (topSum / Math.max(1, y.total)) * 100)}%` }} /><i />
            </div>
          </div>
        </>
      )}
    </Module>
  );
}

// ———————————————————————— 38 作息 ————————————————————————

function HeatModule({ heat }: { heat: number[] | null }) {
  const stats = useMemo(() => {
    if (!heat) return null;
    const total = sum(heat);
    if (!total) return null;
    const max = Math.max(...heat);
    const peakIdx = heat.indexOf(max);
    let night = 0;
    let weekend = 0;
    const hours = new Array(24).fill(0);
    heat.forEach((v, i) => {
      const h = i % 24;
      hours[h] += v;
      if (h >= 23 || h < 5) night += v;
      if (i >= 5 * 24) weekend += v;
    });
    return { total, max, peakIdx, night, weekend, hours, peakHour: hours.indexOf(Math.max(...hours)) };
  }, [heat]);

  if (!heat || !stats) {
    return (
      <Module id="38" title="作息" en="WEEK × HOUR" className="an-m38">
        <div className="an-note">这一年还没有按小时的统计。</div>
      </Module>
    );
  }
  const level = (v: number) => (v <= 0 ? 0 : Math.min(4, 1 + Math.floor((v / stats.max) * 3.999)));
  const pw = Math.floor(stats.peakIdx / 24);
  const ph = stats.peakIdx % 24;
  return (
    <Module id="38" title="作息" en="WEEK × HOUR" right={`PEAK 周${WEEKDAYS[pw]} ${pad2(ph)}:00`} className="an-m38">
      <div className="an-wk" role="img" aria-label={`一周七天 × 二十四小时的消息分布，周${WEEKDAYS[pw]} ${ph} 点最多`}>
        {WEEKDAYS.map((d, w) => (
          <div key={d} className="an-wk__row">
            <span className="an-wk__d">{d}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = heat[w * 24 + h];
              const idx = w * 24 + h;
              return (
                <span key={h} className={cx('an-wk__c', `l${level(v)}`, idx === stats.peakIdx && 'is-peak')}
                  title={`周${d} ${pad2(h)}:00 · ${fmt(v)} 条`} />
              );
            })}
          </div>
        ))}
        <div className="an-wk__row an-wk__ticks" aria-hidden="true">
          <span />
          {Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 3 === 0 ? pad2(h) : ''}</span>)}
        </div>
      </div>
      <div className="an-ro2">
        <div>
          <div className="ui-label">HOUR<b>最常聊的钟点</b></div>
          <div className="an-ro2__v">{pad2(stats.peakHour)}:00<small>–{pad2((stats.peakHour + 1) % 24)}:00</small></div>
        </div>
        <div>
          <div className="ui-label">NIGHT<b>23–5 点</b></div>
          <div className="an-ro2__v">{pctOf(stats.night, stats.total)}<small>%</small></div>
        </div>
        <div>
          <div className="ui-label">WEEKEND<b>周末</b></div>
          <div className="an-ro2__v">{pctOf(stats.weekend, stats.total)}<small>%</small></div>
        </div>
      </div>
    </Module>
  );
}

// ———————————————————————— 39 记录 ————————————————————————

function RecordsModule({ y, open }: { y: Year; open: Opener }) {
  const rows: { k: string; zh: string; v: ReactNode; sub: ReactNode; quiet?: boolean }[] = [];
  if (y.peakDay) {
    const t = y.peakDay.top;
    rows.push({
      k: 'BUSIEST DAY', zh: '最忙的一天',
      v: <>{fmt(y.peakDay.count)}<small>条</small></>,
      sub: <>{y.peakDay.date}{t && <> · 主要和 <Who p={t} open={open} />{t.count != null && <>（{fmt(t.count)} 条）</>}</>}</>,
    });
  }
  if (y.streak) {
    const range = y.streak.start && y.streak.end ? `${md(y.streak.start)} → ${md(y.streak.end)}` : null;
    rows.push({
      k: 'STREAK', zh: '最长连续',
      v: <>{fmt(y.streak.days)}<small>天</small></>,
      sub: <>{range ? `${range} · ` : ''}每天都至少和一个人聊过</>,
    });
  }
  if (y.midnight) {
    const m = y.midnight;
    rows.push({
      k: 'NIGHT OWL', zh: '深夜之王',
      v: <Who p={m} open={open} className="an-rec__who" />,
      sub: <>23–4 点 {m.count != null ? `${fmt(m.count)} 条` : ''}{m.share != null ? ` · 占全部深夜消息 ${m.share}%` : ''}</>,
    });
  }
  if (y.mutual) {
    const m = y.mutual;
    rows.push({
      k: 'MOST EVEN', zh: '最一来一回',
      v: <Who p={m} open={open} className="an-rec__who" />,
      sub: <>你 {m.self != null ? fmt(m.self) : '—'} · 对方 {m.other != null ? fmt(m.other) : '—'}{m.ratio != null ? ` · 比 ${m.ratio.toFixed(2)}` : ''}</>,
    });
  }
  if (y.lost) {
    const l = y.lost;
    rows.push({
      k: 'DRIFTED', zh: '下半年变少',
      v: <Who p={l} open={open} className="an-rec__who" />,
      sub: <>
        上半年 {l.first != null ? fmt(l.first) : '—'} → 下半年 {l.second != null ? fmt(l.second) : '—'}
        {l.drop != null && <> · <b className="an-rec__drop">−{l.drop}%</b></>}
        <span className="an-rec__aside">不一定是谁的错，也许只是各忙各的</span>
      </>,
    });
  }
  return (
    <Module id="39" title="记录" en="RECORDS" right={rows.length ? `${pad2(rows.length)} ITEMS` : undefined} className="an-m39">
      {rows.length === 0 ? (
        <div className="an-note">这一年的消息太少，还排不出记录。</div>
      ) : (
        <ol className="an-rec">
          {rows.map((r, i) => (
            <li key={r.k} className="an-rec__row">
              <span className="an-rec__no">{pad2(i + 1)}</span>
              <span className="an-rec__k"><span className="ui-label">{r.k}</span><span className="an-rec__zh">{r.zh}</span></span>
              <span className="an-rec__v">{r.v}</span>
              <span className="an-rec__sub">{r.sub}</span>
            </li>
          ))}
        </ol>
      )}
    </Module>
  );
}

// ———————————————————————— 40 主动 ————————————————————————

function InitiativeModule({ y, open }: { y: Year; open: Opener }) {
  const ini = y.initiative;
  if (!ini) {
    return (
      <Module id="40" title="主动" en="WHO STARTS" className="an-m40">
        <div className="an-note">这一年还没有足够的对话来判断谁先开口。</div>
      </Module>
    );
  }
  const total = ini.self + ini.other;
  const selfPct = ini.rate != null ? Math.round(ini.rate) : Math.round((ini.self / total) * 100);
  return (
    <Module id="40" title="主动" en="WHO STARTS" right="GAP > 6 H = 新对话" className="an-m40">
      <div className="an-ini">
        <div className="an-ini__ro">
          <div>
            <div className="ui-label">YOU<b>你先开口</b></div>
            <div className="ui-big an-ini__v">{selfPct}<small>%</small></div>
            <div className="an-ini__s">{fmt(ini.self)} 次</div>
          </div>
          <div className="is-r">
            <div className="ui-label">FRIENDS<b>朋友先开口</b></div>
            <div className="ui-big an-ini__v">{100 - selfPct}<small>%</small></div>
            <div className="an-ini__s">{fmt(ini.other)} 次</div>
          </div>
        </div>
        <div className="an-meter" aria-hidden="true">
          <i className="is-you" style={{ width: `${selfPct}%` }} /><i className="is-them" />
        </div>
      </div>
      {ini.top && (
        <div className="an-ini__top">
          <span className="ui-label">MOST SOUGHT<b>你最常主动找的人</b></span>
          <span className="an-ini__who"><Who p={ini.top} open={open} />{ini.top.count != null && <span className="ui-num">{fmt(ini.top.count)} 次</span>}</span>
        </div>
      )}
    </Module>
  );
}

// ———————————————————————— 41 口头禅 ————————————————————————

function PhrasesModule({ phrases }: { phrases: { phrase: string; count: number }[] }) {
  const list = phrases.slice(0, 10);
  const max = list[0]?.count || 1;
  return (
    <Module id="41" title="口头禅" en="YOUR PHRASES" right={list.length ? `TOP ${pad2(list.length)}` : undefined} className="an-m41">
      {list.length === 0 ? (
        <div className="an-note">这一年你发的消息里还找不出常说的话。</div>
      ) : (
        <ol className="an-ph">
          {list.map((p, i) => (
            <li key={p.phrase + i} className={cx('an-ph__row', i === 0 && 'is-first')}>
              <span className="an-ph__no">{pad2(i + 1)}</span>
              <span className="an-ph__t" title={maskText(p.phrase)}>{maskText(p.phrase)}</span>
              <span className="an-ph__bar" aria-hidden="true"><i style={{ width: `${(p.count / max) * 100}%` }} /></span>
              <span className="an-ph__n">{fmt(p.count)}</span>
            </li>
          ))}
        </ol>
      )}
    </Module>
  );
}
