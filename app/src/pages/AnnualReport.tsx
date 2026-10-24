// app/src/pages/AnnualReport.tsx
//
// Global year-in-review across ALL friends + chats. Inspired by WeFlow's
// AnnualReportData taxonomy: top friends, monthly winners, peak day, longest
// streak, 24×7 heatmap, midnight king, mutual friend, social initiative, top
// phrases, lost friend. Reads from /api/annual-report.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { PageHeader } from '../shell/PageHeader';
import { EmptyState, ErrorState, SegmentedControl, Skeleton, SkeletonText, cx } from '../ui';
import { IconCalendar } from '../ui/icons';
import { Postmark } from '../components/Postmark';
import { Ribbon } from '../components/Ribbon';
import {
  errorCode, getAnnualReport, getAvailableReportYears,
  type AnnualReport, type AnnualReportTopFriend,
} from '../data/api';
import { lookupError } from '../data/errorCatalog';
import { displayName, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import './AnnualReport.css';

interface Props {
  /** Unused since the app shell's nav replaced the page's own ← 返回. */
  onBack: () => void;
  onOpenFriend?: (wxid: string) => void;
}

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
        setYears(r.years);
        // Default to "last completed year" — current year often half-empty.
        const target = r.years.includes(r.default) ? r.default : (r.years[r.years.length - 1] ?? null);
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
        layout="page"
        icon={<IconCalendar size={26} />}
        title="还没有可以统计的年份"
        description="解密后的数据里还没有聊天记录。去首页点「更新数据」，解密完成后这里会按年份出现你的年度总览。"
      />
    );
  } else if (loading || !data) {
    body = <AnnualSkeleton year={year} />;
  } else if (data.total_messages === 0) {
    body = (
      <EmptyState
        layout="page"
        icon={<IconCalendar size={26} />}
        title={`${data.year} 年没有聊天记录`}
        description={years && years.length > 1 ? '右上角换个年份看看。' : '这一年还没有消息，等聊天多起来再来看。'}
      />
    );
  } else {
    body = <Body data={data} onOpenFriend={onOpenFriend} />;
  }

  return (
    <div className="annual-page et-root">
      <PageHeader title="年度总览" subtitle="你的所有朋友 + 所有聊天">
        <YearSwitcher years={years} pending={!error} value={year} onChange={setYear} />
      </PageHeader>
      {body}
    </div>
  );
}

// ——————————————————————————————————————————————————————————————

function YearSwitcher({ years, pending, value, onChange }: {
  years: number[] | null; pending: boolean; value: number | null; onChange: (y: number) => void;
}) {
  if (years === null) return pending ? <Skeleton width={120} height={26} radius={999} /> : null;
  if (!years.length) {
    return <span className="et-meta">无可用年份</span>;
  }
  // Same control as the graph page's "显示 top" picker, so the shell top bar
  // reads as one system.
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

/** The report's shape while the year is being counted (first run scans every chat). */
function AnnualSkeleton({ year }: { year: number | null }) {
  return (
    <div className="annual-body" aria-busy="true">
      <div className="annual-status" role="status">
        <span className="ui-spinner" aria-hidden="true" />
        <span>{year != null ? `编织 ${year} 年的关系档案中…` : '正在读取有聊天的年份…'}（首次需要 10-30 秒扫描所有聊天记录）</span>
      </div>
      <section className="annual-hero annual-hero--skeleton" aria-hidden="true">
        <Skeleton width={150} height={26} radius={4} />
        <Skeleton width="58%" height={44} />
        <Skeleton width="44%" height={44} />
        <Skeleton width="36%" height={12} />
      </section>
      <section className="annual-card" aria-hidden="true">
        <Skeleton width={80} height={11} />
        <div className="annual-card__body"><SkeletonText lines={5} lastLineWidth="70%" /></div>
      </section>
      <div className="annual-pair" aria-hidden="true">
        {[0, 1].map(i => (
          <section key={i} className="annual-card">
            <Skeleton width={70} height={11} />
            <div className="annual-card__body"><Skeleton width="40%" height={24} /></div>
            <div className="annual-card__body"><Skeleton width="70%" height={12} /></div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Body({ data, onOpenFriend }: { data: AnnualReport; onOpenFriend?: (wxid: string) => void }) {
  return (
    <div className="annual-body">
      <Hero data={data} />
      {data.top_friends && data.top_friends.length > 0 && (
        <TopFriendsCard friends={data.top_friends} totalMsgs={data.total_messages} onOpenFriend={onOpenFriend} />
      )}
      <div className="annual-pair">
        {data.peak_day && <PeakDayCard pd={data.peak_day} />}
        {data.longest_streak && <StreakCard s={data.longest_streak} />}
      </div>
      {data.heatmap_24x7 && data.heatmap_24x7.length === 168 && (
        <HeatmapCard data={data.heatmap_24x7} />
      )}
      <div className="annual-pair">
        {data.midnight_king && <MidnightKingCard m={data.midnight_king} onOpenFriend={onOpenFriend} />}
        {data.mutual_friend && <MutualFriendCard m={data.mutual_friend} onOpenFriend={onOpenFriend} />}
      </div>
      {data.monthly_winners && data.monthly_winners.length === 12 && (
        <MonthlyWinnersCard winners={data.monthly_winners} onOpenFriend={onOpenFriend} />
      )}
      {data.initiative && <InitiativeCard i={data.initiative} onOpenFriend={onOpenFriend} />}
      {data.top_phrases && data.top_phrases.length > 0 && (
        <TopPhrasesCard phrases={data.top_phrases} />
      )}
      {data.lost_friend && <LostFriendCard l={data.lost_friend} onOpenFriend={onOpenFriend} />}
    </div>
  );
}

// —— Hero ——
function Hero({ data }: { data: AnnualReport }) {
  return (
    <section className="annual-hero et-paper-grain">
      <div className="annual-hero__postmark" aria-hidden="true">
        <Postmark size={92} text1="MURMUR · YEAR" text2="本地年度档" date={String(data.year)} />
      </div>
      <Ribbon color="var(--accent-solid)" tone="solid">{data.year} 年度总览</Ribbon>
      <h2 className="annual-hero__title">
        与 <em className="et-num">{data.total_friends_active ?? 0}</em> 个朋友<br />
        共 <em className="et-num">{(data.total_messages ?? 0).toLocaleString()}</em> 条消息
      </h2>
      <div className="et-meta annual-hero__meta">
        <span>跨度 <b>{data.first_message_date} → {data.last_message_date}</b></span>
        <span>活跃天数 <b>{data.active_days ?? 0}</b></span>
      </div>
    </section>
  );
}

// —— Top friends podium ——
function TopFriendsCard({ friends, totalMsgs, onOpenFriend }: {
  friends: AnnualReportTopFriend[]; totalMsgs: number; onOpenFriend?: (id: string) => void;
}) {
  const top = friends.slice(0, 5);
  const max = top[0]?.count || 1;
  return (
    <Card eyebrow="最常聊的人" title="今年的聊天 Top 5">
      <div className="annual-top">
        {top.map((f, i) => {
          const pct = Math.round((f.count / totalMsgs) * 100);
          const w = Math.max(4, Math.round((f.count / max) * 100));
          return (
            <button
              key={f.wxid}
              type="button"
              className={cx('annual-top__row', i === 0 && 'is-first')}
              onClick={() => onOpenFriend?.(f.wxid)}>
              <span className="et-num annual-top__rank">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="annual-top__main">
                <span className="annual-top__name">
                  {displayName(f.wxid, f.name)}
                </span>
                <span className="annual-top__track">
                  <span className="annual-top__fill" style={{ width: `${w}%` }} />
                </span>
              </span>
              <span>
                <span className="et-num annual-top__count">
                  {f.count.toLocaleString()}
                </span>
                <span className="et-meta annual-top__split">
                  {pct}% · 你 {f.self} / 他 {f.other}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function PeakDayCard({ pd }: { pd: NonNullable<AnnualReport['peak_day']> }) {
  return (
    <Card eyebrow="最忙的一天" title={`${pd.count.toLocaleString()} 条`}>
      <div className="annual-big">{pd.date}</div>
      {pd.top_name && (
        <div className="et-meta annual-note">
          这一天主要在和 <b>{displayName(pd.top_wxid || '', pd.top_name)}</b> 聊（{pd.top_count} 条）
        </div>
      )}
    </Card>
  );
}

function StreakCard({ s }: { s: NonNullable<AnnualReport['longest_streak']> }) {
  return (
    <Card eyebrow="连续聊天" title={`${s.days} 天`}>
      <div className="et-meta annual-note annual-note--lead">
        {s.start} → {s.end}
      </div>
      <div className="et-meta annual-hint">
        每天至少跟一个人有交流的最长连续天数
      </div>
    </Card>
  );
}

function HeatmapCard({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const days = ['一', '二', '三', '四', '五', '六', '日'];
  return (
    <Card eyebrow="活跃热力图 · 168 格 · 周 × 小时" title="你的一年作息">
      <div className="annual-heat" role="img" aria-label="一周七天 × 二十四小时的消息分布">
        {days.map((d, w) => (
          <div key={w} className="annual-heat__row">
            <span className="annual-heat__day">{d}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = data[w * 24 + h] || 0;
              const a = v / max;
              return (
                <div key={h} className="annual-heat__cell" title={v ? `周${d} ${h}:00 · ${v} 条` : ''}
                  style={a > 0
                    ? { background: `color-mix(in srgb, var(--accent) ${10 + a * 80}%, var(--surface-sunken))` }
                    : undefined} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="et-meta annual-heat__axis">
        0 → 24 时
      </div>
    </Card>
  );
}

function MidnightKingCard({ m, onOpenFriend }: {
  m: NonNullable<AnnualReport['midnight_king']>; onOpenFriend?: (id: string) => void;
}) {
  return (
    <Card eyebrow="深夜之王 · 23-4 点" title="他陪你过最多深夜">
      <button type="button" className="annual-link" onClick={() => onOpenFriend?.(m.wxid)}>
        {displayName(m.wxid, m.name)}
      </button>
      <div className="et-meta annual-note">
        深夜 {m.count} 条消息，占总深夜的 {m.share}%
      </div>
    </Card>
  );
}

function MutualFriendCard({ m, onOpenFriend }: {
  m: NonNullable<AnnualReport['mutual_friend']>; onOpenFriend?: (id: string) => void;
}) {
  return (
    <Card eyebrow="最对等的关系" title="谁和你说话最一来一回">
      <button type="button" className="annual-link" onClick={() => onOpenFriend?.(m.wxid)}>
        {displayName(m.wxid, m.name)}
      </button>
      <div className="et-meta annual-note">
        你 {m.self} · 他 {m.other} · 比 {m.ratio}
      </div>
    </Card>
  );
}

function MonthlyWinnersCard({ winners, onOpenFriend }: {
  winners: NonNullable<AnnualReport['monthly_winners']>; onOpenFriend?: (id: string) => void;
}) {
  return (
    <Card eyebrow="月度冠军" title="每个月聊得最多的人">
      <div className="annual-months">
        {winners.map(w => (
          <button
            key={w.month}
            type="button"
            className="annual-month"
            disabled={!w.wxid}
            onClick={() => w.wxid && onOpenFriend?.(w.wxid)}>
            <div className="et-num annual-month__label">{w.month}月</div>
            <div className="annual-month__name">
              {w.name ? displayName(w.wxid || '', w.name) : '—'}
            </div>
            <div className="et-meta annual-month__count">
              {w.count > 0 ? `${w.count} 条` : '无活跃'}
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

function InitiativeCard({ i, onOpenFriend }: {
  i: NonNullable<AnnualReport['initiative']>; onOpenFriend?: (id: string) => void;
}) {
  return (
    <Card eyebrow="谁先开聊" title={i.self_rate >= 50 ? `你先开聊 ${i.self_rate}%` : `朋友先开聊 ${100 - i.self_rate}%`}>
      <div className="et-meta annual-note annual-note--lead">
        你 {i.self_starts} 次 · 朋友们 {i.other_starts} 次（按 6 小时间隔切对话窗）
      </div>
      {i.top_initiated_name && i.top_initiated_wxid && (
        <div className="annual-callout">
          <div className="et-meta annual-callout__label">你今年最爱主动找的人</div>
          <button type="button" className="annual-link" onClick={() => onOpenFriend?.(i.top_initiated_wxid!)}>
            {displayName(i.top_initiated_wxid, i.top_initiated_name)} —— {i.top_initiated_count} 次
          </button>
        </div>
      )}
    </Card>
  );
}

function TopPhrasesCard({ phrases }: { phrases: NonNullable<AnnualReport['top_phrases']> }) {
  return (
    <Card eyebrow="你的口头禅" title="今年你说得最多的话">
      <div className="annual-phrases">
        {phrases.map((p, i) => {
          const t = 1 - (i / Math.max(1, phrases.length - 1));
          // Size and fade are data (rank), so they stay inline.
          return (
            <span key={p.phrase} title={`${p.count.toLocaleString()} 次`}
              className={cx('annual-phrase', i < 3 && 'is-top', i === 0 && 'is-first')}
              style={{ fontSize: 12 + Math.round(t * 8), opacity: 0.55 + t * 0.45 }}>
              {maskText(p.phrase)}
              <span className="annual-phrase__n">{p.count.toLocaleString()}</span>
            </span>
          );
        })}
      </div>
    </Card>
  );
}

function LostFriendCard({ l, onOpenFriend }: {
  l: NonNullable<AnnualReport['lost_friend']>; onOpenFriend?: (id: string) => void;
}) {
  return (
    <Card eyebrow="今年走丢的人" title="前后差距最大">
      <button type="button" className="annual-link" onClick={() => onOpenFriend?.(l.wxid)}>
        {displayName(l.wxid, l.name)}
      </button>
      <div className="et-meta annual-note">
        前半年 {l.first_half} 条 → 后半年 {l.second_half} 条（少了 <b className="is-accent">{l.drop_pct}%</b>）
      </div>
      <div className="et-meta annual-hint annual-hint--quiet">
        不一定是 ta 的错，也许只是一段时间各忙各的
      </div>
    </Card>
  );
}

// —— Shared card shell ——
function Card({ eyebrow, title, children }: {
  eyebrow: string; title: string; children: ReactNode;
}) {
  return (
    <section className="annual-card">
      <div className="et-eyebrow">{eyebrow}</div>
      <h3 className="et-h2 annual-card__title">{title}</h3>
      <div className="annual-card__body">{children}</div>
    </section>
  );
}
