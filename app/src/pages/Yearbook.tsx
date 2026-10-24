import { useEffect, useState } from 'react';
import { errorCode, getYearbook } from '../data/api';
import type { Yearbook, YearData } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import { displayName, maskedWxid, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { PageHeader } from '../shell/PageHeader';
import { useActivePlatform } from '../utils/activeProfile';
import { Button, EmptyState, ErrorState, Skeleton, SkeletonText, cx } from '../ui';
import { IconCalendar } from '../ui/icons';
import { YearbookCover } from './extras/YearbookCover';
import './Yearbook.css';

interface Props {
  friendId: string;
  onBack: () => void;
}

export function YearbookPage({ friendId, onBack }: Props) {
  void usePrivacy();
  const platform = useActivePlatform();
  const [data, setData] = useState<Yearbook | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    getYearbook(friendId)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e); });
    return () => { cancelled = true; };
  }, [friendId, nonce]);

  const back = { label: '朋友页', onClick: onBack };

  if (error) {
    const code = errorCode(error);
    const entry = lookupError(code);
    const raw = error instanceof Error ? error.message : String(error);
    return (
      <div className="yb-page et-root">
        <PageHeader back={back} title="双人年代记" />
        <ErrorState
          layout="page"
          code={code ?? undefined}
          title={entry?.title ?? '年代记没能编出来'}
          reason={entry?.reason ?? '按年份整理你们的聊天时，本地服务返回了错误。'}
          fixes={entry ? [entry.fix] : ['点「重试」再编一次', '还不行就到「设置」里复制诊断信息反馈给我们']}
          onRetry={() => setNonce(n => n + 1)}
          details={raw ? <pre>{maskText(raw)}</pre> : undefined}
        />
      </div>
    );
  }
  if (!data) return <YearbookSkeleton back={back} />;

  const friendName = displayName(data.wxid, data.name);
  if (data.years.length === 0) {
    return (
      <div className="yb-page et-root">
        <PageHeader back={back} title={`双人年代记 · 你 ↔ ${friendName}`} />
        <EmptyState
          layout="page"
          icon={<IconCalendar size={26} />}
          title="消息还不够编成年代记"
          description={`你和 ${friendName} 目前有 ${data.total_msgs.toLocaleString()} 条消息。等你们聊满一段日子，这里会按年份排出你们的故事。`}
          actions={<Button onClick={onBack}>回到朋友页</Button>}
        />
      </div>
    );
  }

  const years = [...data.years].reverse();  // newest first
  const yearMaxMsgs = Math.max(...data.years.map(y => y.msg_count));

  return (
    <div className="yb-page et-root">
      <PageHeader
        back={back}
        title={`双人年代记 · 你 ↔ ${friendName}`}
        subtitle={<span className="et-mono">{maskedWxid(data.wxid)}</span>}
      />

      {/* Cover */}
      <section className="yb-cover et-paper-grain">
        <div className="yb-cover__badge">双人年代记</div>
        <div className="et-eyebrow">关于「{friendName}」</div>
        <h2 className="yb-cover__title">
          你和 {friendName} 一起<br />走过 {data.active_years} 年
        </h2>
        <div className="yb-cover__stats">
          <Stat label="跨度" value={`${data.span_days} 天`} sub={`${data.first_date} → ${data.last_date}`} />
          <Stat label="总消息" value={data.total_msgs.toLocaleString()} sub="含图文/语音" />
          {platform !== 'qq' && (
            <Stat label="朋友圈往来" value={`${data.moments_back_total + data.moments_out_total}`}
              sub={`他赞你 ${data.moments_back_total} · 你赞他 ${data.moments_out_total}`} />
          )}
        </div>
      </section>

      {/* Shareable year cover (Round 2) — fits in a phone screenshot,
          stacks 5 viral data points. Sits above the existing year-by-year
          cards which stay untouched. */}
      <div className="yb-column">
        <YearbookCover
          friendId={data.wxid}
          friendName={data.name}
          year={data.years[data.years.length - 1]}
          firstWordsDate={data.first_date}
        />
      </div>

      {/* Year-by-year cards */}
      <div className="yb-column yb-years">
        {years.map(y => (
          <YearCard key={y.year} y={y} maxMsgs={yearMaxMsgs} friendName={friendName} />
        ))}
      </div>
    </div>
  );
}

function YearbookSkeleton({ back }: { back: { label: string; onClick: () => void } }) {
  return (
    <div className="yb-page et-root" aria-busy="true">
      <PageHeader back={back} title="双人年代记" />
      <section className="yb-cover yb-skel-cover" aria-label="正在编织年代记">
        <Skeleton width={110} height={11} />
        <Skeleton width="52%" height={36} />
        <Skeleton width="34%" height={36} />
        <div className="yb-skel-stats">
          {[0, 1, 2].map(i => (
            <div key={i} className="yb-skel-stat"><SkeletonText lines={3} lastLineWidth="80%" /></div>
          ))}
        </div>
      </section>
      <div className="yb-column yb-years" aria-hidden="true">
        {[0, 1].map(i => (
          <div key={i} className="yb-year">
            <Skeleton width={120} height={48} />
            <div className="yb-cells">
              {[0, 1, 2, 3].map(k => <Skeleton key={k} height={58} radius={8} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="et-eyebrow yb-stat__label">{label}</div>
      <div className="et-num yb-stat__value">{value}</div>
      {sub && <div className="et-meta yb-stat__sub">{sub}</div>}
    </div>
  );
}

type Quote = { date: string; from: string; from_id?: string; text: string };

function YearCard({ y, maxMsgs, friendName }: { y: YearData; maxMsgs: number; friendName: string }) {
  void usePrivacy();
  const heatPct = Math.round((y.msg_count / maxMsgs) * 100);
  const tone =
    y.msg_count >= maxMsgs * 0.7 ? 'hot'
    : y.msg_count >= maxMsgs * 0.3 ? 'warm'
    : 'cool';

  const allQuotes: Array<{ kind: string; emoji: string; q: Quote }> = [];
  y.vulnerability_quotes.slice(0, 1).forEach(q => allQuotes.push({ kind: '脆弱表达', emoji: '🫂', q }));
  y.offline_quotes.slice(0, 1).forEach(q => allQuotes.push({ kind: '线下证据', emoji: '🚪', q }));
  y.lifecycle_quotes.slice(0, 1).forEach(q => allQuotes.push({ kind: '人生节点', emoji: '✨', q }));
  y.apology_quotes.slice(0, 1).forEach(q => allQuotes.push({ kind: '冲突修复', emoji: '🌧️', q }));
  y.care_quotes.slice(0, 1).forEach(q => allQuotes.push({ kind: '互相关心', emoji: '☕', q }));

  return (
    <section className={cx('yb-year et-paper-grain', `is-${tone}`)} aria-label={`${y.year} 年`}>
      <div className="yb-year__head">
        <div>
          <div className="et-eyebrow">YEAR</div>
          <div className="yb-year__num">{y.year}</div>
        </div>
        <div className="yb-year__total">
          <div className="et-num yb-year__count">
            {y.msg_count.toLocaleString()}
          </div>
          <div className="et-meta yb-year__days">
            条消息 · {y.active_days} 天有交流
          </div>
        </div>
      </div>

      {/* Heat bar */}
      <div className="yb-year__bar">
        <span style={{ width: `${heatPct}%` }} />
      </div>

      {/* Inline stats */}
      <div className="yb-cells">
        <Cell label="主导比" value={`你 ${y.self_pct}%`} sub={`${friendName} ${100 - y.self_pct}%`} />
        <Cell label="最热月" value={`${y.busiest_month} 月`} sub={`${y.busiest_month_msgs} 条`} />
        <Cell label="最长沉默" value={y.longest_silence_days > 0 ? `${y.longest_silence_days} 天` : '—'}
          sub={y.silence_from ? `${y.silence_from} 起` : ''} />
        <Cell label="深夜聊天" value={`${y.late_night_pct}%`} sub={`${y.late_night_msgs} 条 23-4 点`} />
      </div>

      <ExtraMetricsRow y={y} friendName={friendName} />

      {y.heatmap_24x7 && y.heatmap_24x7.length === 168 && (
        <HeatmapStrip data={y.heatmap_24x7} />
      )}

      <YearInsightModule year={y} />

      {/* Themed quotes */}
      {allQuotes.length > 0 && (
        <div className="yb-quotes">
          {allQuotes.map((bucket, i) => (
            <div key={i} className="yb-quote">
              <span className="yb-quote__emoji" aria-hidden="true">{bucket.emoji}</span>
              <div className="yb-quote__body">
                <div className="yb-quote__kind">{bucket.kind}</div>
                <div className="yb-quote__text">
                  「{maskText(bucket.q.text)}」
                </div>
                <div className="et-meta yb-quote__meta">
                  {displayName(bucket.q.from_id, bucket.q.from)} · {bucket.q.date}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Calls badge */}
      {y.calls > 0 && (
        <div className="yb-calls">
          📞 通话 {y.calls} 次
        </div>
      )}
    </section>
  );
}

function YearInsightModule({ year }: { year: YearData }) {
  const hasWords = !!year.top_words?.length;
  const hasSignature = !!year.signature;
  if (!hasWords && !hasSignature) return null;
  const both = hasWords && hasSignature;
  return (
    <section className="yb-keyword-module">
      <div className={`yb-keyword-grid ${both ? '' : 'single'}`}>
        {hasWords && (
          <div className="yb-keyword-pane">
            <div className="yb-module-head">
              <div className="yb-eyebrow">这一年常聊</div>
              <div className="yb-hint">top 8 · 词频</div>
            </div>
            <WordCloud words={year.top_words || []} />
          </div>
        )}
        {both && <div className="yb-divider-v" />}
        {hasSignature && (
          <div className="yb-keyword-pane">
            <div className="yb-module-head">
              <div className="yb-eyebrow">算法选中的片段</div>
              <div className="yb-hint">可复核，不当作全部</div>
            </div>
            <SignatureBlock sig={year.signature} />
          </div>
        )}
      </div>
    </section>
  );
}

function WordCloud({ words }: { words: Array<{ word: string; count: number }> }) {
  const top = words.slice(0, 8);
  if (!top.length) return null;
  return (
    <div className="yb-word-cloud">
      {top.map((w, i) => {
        const t = 1 - (i / Math.max(top.length - 1, 1));
        // Size, weight and fade come from the word's rank, so they stay inline.
        return (
          <span
            key={`${w.word}-${i}`}
            className={cx('yb-word', i < 2 && 'is-top')}
            title={`出现 ${w.count.toLocaleString()} 次`}
            style={{
              fontSize: 13 + Math.round(t * 9),
              fontWeight: i < 2 ? 600 : (i < 4 ? 500 : 400),
              opacity: 0.55 + t * 0.45,
            }}
          >
            {w.word}
            <span className="yb-word-count">{w.count.toLocaleString()}</span>
          </span>
        );
      })}
    </div>
  );
}

function SignatureBlock({ sig }: {
  sig: { date: string; from: string; from_id?: string; text: string; reason?: string; terms?: string[] } | null;
}) {
  if (!sig) return null;
  return (
    <div className="yb-signature">
      <div className="yb-signature-text">
        <span className="yb-quote-mark">「</span>{maskText(sig.text)}<span className="yb-quote-mark close">」</span>
      </div>
      <div className="yb-signature-meta">
        <span className="yb-meta-name">{displayName(sig.from_id, sig.from)}</span>
        <span className="yb-meta-dot" />
        <span className="yb-meta-date">{sig.date}</span>
        {sig.reason && (
          <>
            <span className="yb-meta-dot" />
            <span className="yb-reason">依据 · <b>{maskText(sig.reason)}</b></span>
          </>
        )}
        {!!sig.terms?.length && (
          <span className="yb-term-wrap">
            {sig.terms.slice(0, 3).map((t, i) => <span key={`${t}-${i}`} className="yb-term">{maskText(t)}</span>)}
          </span>
        )}
      </div>
    </div>
  );
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="yb-cell">
      <div className="et-eyebrow yb-cell__label">{label}</div>
      <div className="et-num yb-cell__value">{value}</div>
      {sub && <div className="yb-cell__sub">{sub}</div>}
    </div>
  );
}

function ExtraMetricsRow({ y, friendName }: { y: YearData; friendName: string }) {
  const hasStreak = (y.longest_streak_days || 0) > 0;
  const hasInitiative = (y.session_starts_self || 0) + (y.session_starts_other || 0) > 0;
  const hasMidnightSplit = (y.late_night_msgs || 0) >= 6 && y.midnight_friend_pct != null;
  const hasReply = (y.median_reply_sec || 0) > 0;
  const hasDecay = (y.first_half_msgs || 0) + (y.second_half_msgs || 0) > 0;
  if (!hasStreak && !hasInitiative && !hasMidnightSplit && !hasReply && !hasDecay) return null;

  const streakSub = hasStreak && y.streak_start && y.streak_end
    ? `${y.streak_start} → ${y.streak_end}` : '';
  const initiativeValue = hasInitiative
    ? `你 ${y.initiative_self_pct ?? 0}%`
    : '—';
  const initiativeSub = hasInitiative
    ? `你 ${y.session_starts_self} 次 · ${friendName} ${y.session_starts_other} 次` : '';
  const midnightValue = hasMidnightSplit
    ? `${friendName.slice(0, 8)} ${y.midnight_friend_pct}%` : '—';
  const midnightSub = hasMidnightSplit
    ? `深夜里他/她说话占比` : '';

  // reply latency is folded into the AI report's data fingerprint section;
  // we don't render it here to keep the row width balanced with 4 cells.
  void hasReply;

  let decayValue = '—';
  let decaySub = '';
  if (hasDecay) {
    const f = y.first_half_msgs || 0;
    const s = y.second_half_msgs || 0;
    const total = f + s;
    const trend = s > f * 1.2 ? '↑ 增长' : f > s * 1.2 ? '↓ 减弱' : '→ 平稳';
    decayValue = trend;
    decaySub = `前段 ${Math.round(f / total * 100)}% · 后段 ${Math.round(s / total * 100)}%`;
  }

  return (
    <div className="yb-cells yb-cells--extra">
      <Cell
        label="最长连聊"
        value={hasStreak ? `${y.longest_streak_days} 天` : '—'}
        sub={streakSub}
      />
      <Cell label="谁先开聊" value={initiativeValue} sub={initiativeSub} />
      <Cell label="深夜偏向" value={midnightValue} sub={midnightSub} />
      <Cell label="全年趋势" value={decayValue} sub={decaySub} />
    </div>
  );
}

function HeatmapStrip({ data }: { data: number[] }) {
  // 168 cells = 7 weekdays × 24 hours. Render as 7 rows of 24 dots, intensity
  // by max-normalized count, tinted with the year card's --yb-accent.
  const max = Math.max(1, ...data);
  const days = ['一', '二', '三', '四', '五', '六', '日'];
  return (
    <div className="yb-heat">
      <div className="yb-heat__head">
        <div className="et-eyebrow yb-cell__label">168 格热力图 · 周×小时</div>
        <div className="yb-heat__axis">0 → 24 时</div>
      </div>
      <div className="yb-heat__grid" role="img" aria-label="一周七天 × 二十四小时的消息分布">
        {days.map((d, w) => (
          <div key={w} className="yb-heat__row">
            <span className="yb-heat__day">{d}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = data[w * 24 + h] || 0;
              const a = v / max;
              return (
                <div
                  key={h}
                  className="yb-heat__cell"
                  title={`周${d} ${h}:00 · ${v} 条`}
                  style={a > 0
                    ? { background: `color-mix(in srgb, var(--yb-accent) ${10 + a * 80}%, var(--surface-card))` }
                    : undefined}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
