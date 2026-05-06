import { useEffect, useState } from 'react';
import { getYearbook } from '../data/api';
import type { Yearbook, YearData } from '../data/api';
import { displayName, maskedWxid, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { ProfileSwitcher } from '../components/ProfileSwitcher';
import { useActivePlatform } from '../utils/activeProfile';
import { YearbookCover } from './extras/YearbookCover';

interface Props {
  friendId: string;
  onBack: () => void;
}

export function YearbookPage({ friendId, onBack }: Props) {
  void usePrivacy();
  const platform = useActivePlatform();
  const [data, setData] = useState<Yearbook | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    getYearbook(friendId)
      .then(setData)
      .catch(e => setError(e?.message || String(e)));
  }, [friendId]);

  if (error) {
    return (
      <div style={{ padding: 40 }}>
        <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer', color: 'var(--et-mute)' }}>← 返回</button>
        <div style={{ marginTop: 20, color: 'var(--et-rose)' }}>加载失败：{maskText(error)}</div>
      </div>
    );
  }
  if (!data) return <div style={{ padding: 40 }}><div className="et-meta">编织年代记中…</div></div>;
  if (data.years.length === 0) {
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer', color: 'var(--et-mute)' }}>← 返回</button>
        <div className="et-h2" style={{ marginTop: 20 }}>这位朋友消息不够，编不出年代记。</div>
      </div>
    );
  }

  const years = [...data.years].reverse();  // newest first
  const yearMaxMsgs = Math.max(...data.years.map(y => y.msg_count));
  const friendName = displayName(data.wxid, data.name);

  return (
    <div className="et-root" style={{ background: 'var(--et-bg)', minHeight: '100vh' }}>
      <style>{YEARBOOK_KEYWORDS_CSS}</style>
      {/* Top bar */}
      <div style={{
        padding: '14px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '0.5px solid var(--et-line)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer', color: 'var(--et-mute)', fontSize: 13 }}>← 返回</button>
          <ProfileSwitcher />
        </div>
        <div className="et-serif" style={{ fontSize: 14, color: 'var(--et-mute)' }}>双人年代记 · 你 ↔ {friendName}</div>
        <span style={{ fontFamily: 'var(--et-mono)', fontSize: 11, color: 'var(--et-faint)' }}>{maskedWxid(data.wxid)}</span>
      </div>

      {/* Cover */}
      <div className="et-paper-grain" style={{
        margin: '24px 28px', padding: '50px 56px',
        background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
        borderRadius: 'var(--et-r-lg)', boxShadow: 'var(--et-shadow-2)',
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', top: 18, right: 28, padding: '4px 12px',
          borderRadius: 999, background: 'var(--et-orange)', color: '#fff',
          fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>双人年代记</div>
        <div className="et-eyebrow" style={{ color: 'var(--et-mute)' }}>关于「{friendName}」</div>
        <div className="et-display" style={{
          marginTop: 14, fontFamily: 'var(--et-serif)', fontSize: 40, fontWeight: 600,
          color: 'var(--et-ink)', lineHeight: 1.3, maxWidth: 700,
        }}>
          你和 {friendName} 一起<br />走过 {data.active_years} 年
        </div>
        <div style={{ marginTop: 24, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <Stat label="跨度" value={`${data.span_days} 天`} sub={`${data.first_date} → ${data.last_date}`} />
          <Stat label="总消息" value={data.total_msgs.toLocaleString()} sub="含图文/语音" />
          {platform !== 'qq' && (
            <Stat label="朋友圈往来" value={`${data.moments_back_total + data.moments_out_total}`}
              sub={`他赞你 ${data.moments_back_total} · 你赞他 ${data.moments_out_total}`} />
          )}
        </div>
      </div>

      {/* Shareable year cover (Round 2) — fits in a phone screenshot,
          stacks 5 viral data points. Sits above the existing year-by-year
          cards which stay untouched. */}
      <div style={{ padding: '12px 28px 28px', maxWidth: 1080, margin: '0 auto' }}>
        <YearbookCover
          friendId={data.wxid}
          friendName={data.name}
          year={data.years[data.years.length - 1]}
          firstWordsDate={data.first_date}
        />
      </div>

      {/* Year-by-year cards */}
      <div style={{ padding: '12px 28px 60px', maxWidth: 1080, margin: '0 auto',
        display: 'flex', flexDirection: 'column', gap: 22 }}>
        {years.map(y => (
          <YearCard key={y.year} y={y} maxMsgs={yearMaxMsgs} friendName={friendName} />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="et-eyebrow" style={{ fontSize: 10, color: 'var(--et-mute)' }}>{label}</div>
      <div className="et-num" style={{ fontFamily: 'var(--et-serif)', fontSize: 28, fontWeight: 600,
        color: 'var(--et-ink)', marginTop: 4 }}>{value}</div>
      {sub && <div className="et-meta" style={{ marginTop: 2, color: 'var(--et-mute)', fontSize: 11 }}>{sub}</div>}
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
  const accent = tone === 'hot' ? '#FF6B47' : tone === 'warm' ? '#E8B57A' : '#5A7A99';

  const allQuotes: Array<{ kind: string; emoji: string; q: Quote }> = [];
  y.vulnerability_quotes.slice(0, 1).forEach(q => allQuotes.push({ kind: '脆弱表达', emoji: '🫂', q }));
  y.offline_quotes.slice(0, 1).forEach(q => allQuotes.push({ kind: '线下证据', emoji: '🚪', q }));
  y.lifecycle_quotes.slice(0, 1).forEach(q => allQuotes.push({ kind: '人生节点', emoji: '✨', q }));
  y.apology_quotes.slice(0, 1).forEach(q => allQuotes.push({ kind: '冲突修复', emoji: '🌧️', q }));
  y.care_quotes.slice(0, 1).forEach(q => allQuotes.push({ kind: '互相关心', emoji: '☕', q }));

  return (
    <div className="et-paper-grain" style={{
      background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
      borderRadius: 'var(--et-r-lg)', boxShadow: 'var(--et-shadow-1)',
      padding: '28px 32px',
      borderLeft: `4px solid ${accent}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <div className="et-eyebrow" style={{ color: 'var(--et-mute)' }}>YEAR</div>
          <div className="et-display" style={{
            fontFamily: 'var(--et-serif)', fontSize: 56, fontWeight: 600,
            color: accent, lineHeight: 1, marginTop: 4,
          }}>{y.year}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="et-num" style={{ fontSize: 28, fontWeight: 600, color: 'var(--et-ink)' }}>
            {y.msg_count.toLocaleString()}
          </div>
          <div className="et-meta" style={{ fontSize: 11, color: 'var(--et-mute)' }}>
            条消息 · {y.active_days} 天有交流
          </div>
        </div>
      </div>

      {/* Heat bar */}
      <div style={{ marginTop: 18, height: 4, background: 'rgba(26,43,74,0.06)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ width: `${heatPct}%`, height: '100%', background: accent, borderRadius: 999 }} />
      </div>

      {/* Inline stats */}
      <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <Cell label="主导比" value={`你 ${y.self_pct}%`} sub={`${friendName} ${100 - y.self_pct}%`} />
        <Cell label="最热月" value={`${y.busiest_month} 月`} sub={`${y.busiest_month_msgs} 条`} />
        <Cell label="最长沉默" value={y.longest_silence_days > 0 ? `${y.longest_silence_days} 天` : '—'}
          sub={y.silence_from ? `${y.silence_from} 起` : ''} />
        <Cell label="深夜聊天" value={`${y.late_night_pct}%`} sub={`${y.late_night_msgs} 条 23-4 点`} />
      </div>

      <ExtraMetricsRow y={y} friendName={friendName} />

      {y.heatmap_24x7 && y.heatmap_24x7.length === 168 && (
        <HeatmapStrip data={y.heatmap_24x7} accent={accent} />
      )}

      <YearInsightModule year={y} />

      {/* Themed quotes */}
      {allQuotes.length > 0 && (
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {allQuotes.map((bucket, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 18 }}>{bucket.emoji}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: accent, letterSpacing: 0.4 }}>{bucket.kind}</div>
                <div className="et-serif" style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--et-ink-soft)', marginTop: 2 }}>
                  「{maskText(bucket.q.text)}」
                </div>
                <div className="et-meta" style={{ fontSize: 10, color: 'var(--et-faint)', marginTop: 2 }}>
                  {displayName(bucket.q.from_id, bucket.q.from)} · {bucket.q.date}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Calls badge */}
      {y.calls > 0 && (
        <div style={{ marginTop: 14, display: 'inline-flex', padding: '4px 10px', borderRadius: 999,
          background: 'var(--et-orange-soft)', color: 'var(--et-orange-2)', fontSize: 11, fontWeight: 600 }}>
          📞 通话 {y.calls} 次
        </div>
      )}
    </div>
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
        const size = 13 + Math.round(t * 9);
        const weight = i < 2 ? 600 : (i < 4 ? 500 : 400);
        const opacity = 0.55 + t * 0.45;
        return (
          <span
            key={`${w.word}-${i}`}
            className="yb-word"
            title={`出现 ${w.count.toLocaleString()} 次`}
            style={{
              fontSize: size,
              fontWeight: weight,
              opacity,
              color: i < 2 ? 'var(--et-ink)' : 'var(--et-ink-soft)',
              borderBottom: i < 2 ? '1.5px solid var(--et-orange)' : 'none',
              paddingBottom: i < 2 ? 1 : 0,
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
    <div style={{
      padding: '10px 12px', background: 'var(--et-paper-2)',
      border: '0.5px solid var(--et-line-2)', borderRadius: 8,
    }}>
      <div className="et-eyebrow" style={{ fontSize: 9 }}>{label}</div>
      <div className="et-num" style={{ fontSize: 16, fontWeight: 600, color: 'var(--et-ink)', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--et-mute)', marginTop: 2 }}>{sub}</div>}
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
    <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
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

function HeatmapStrip({ data, accent }: { data: number[]; accent: string }) {
  // 168 cells = 7 weekdays × 24 hours. Render as 7 rows of 24 dots, intensity by max-normalized count.
  const max = Math.max(1, ...data);
  const days = ['一', '二', '三', '四', '五', '六', '日'];
  return (
    <div style={{
      marginTop: 16, padding: '12px 14px',
      background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)', borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <div className="et-eyebrow" style={{ fontSize: 9 }}>168 格热力图 · 周×小时</div>
        <div style={{ fontSize: 10, color: 'var(--et-faint)', fontFamily: 'var(--et-mono)' }}>
          0 → 24 时
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateRows: 'repeat(7, 10px)', gap: 2 }}>
        {days.map((d, w) => (
          <div key={w} style={{ display: 'grid', gridTemplateColumns: '14px repeat(24, 1fr)', gap: 2, alignItems: 'center' }}>
            <span style={{ fontSize: 9, color: 'var(--et-faint)', textAlign: 'right', paddingRight: 2 }}>{d}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = data[w * 24 + h] || 0;
              const a = v / max;
              return (
                <div
                  key={h}
                  title={`周${d} ${h}:00 · ${v} 条`}
                  style={{
                    height: 10, borderRadius: 2,
                    background: a > 0
                      ? `color-mix(in srgb, ${accent} ${10 + a * 80}%, var(--et-paper))`
                      : 'rgba(26,43,74,0.04)',
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

const YEARBOOK_KEYWORDS_CSS = `
.yb-keyword-module {
  margin-top: 20px;
  padding: 18px 0 20px;
  border-top: 0.5px solid var(--et-line);
  border-bottom: 0.5px solid var(--et-line);
}
.yb-keyword-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) 1px minmax(0, 1.15fr);
  gap: 24px;
  align-items: stretch;
}
.yb-keyword-grid.single {
  grid-template-columns: 1fr;
}
.yb-keyword-pane {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.yb-module-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.yb-eyebrow {
  font-family: var(--et-sans);
  font-weight: 600;
  font-size: 10px;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--et-faint);
}
.yb-hint {
  font-family: var(--et-sans);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--et-faint);
  white-space: nowrap;
}
.yb-divider-v {
  width: 1px;
  align-self: stretch;
  background: linear-gradient(180deg, transparent, var(--et-line) 18%, var(--et-line) 82%, transparent);
}
.yb-word-cloud {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 14px;
  row-gap: 8px;
}
.yb-word {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-family: var(--et-serif);
  line-height: 1;
  cursor: default;
  transition: color 120ms ease;
}
.yb-word:hover {
  color: var(--et-orange-2) !important;
}
.yb-word-count {
  font-family: var(--et-mono);
  font-size: 10px;
  color: var(--et-faint);
  align-self: flex-end;
  padding-bottom: 2px;
}
.yb-signature {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.yb-signature-text {
  font-family: var(--et-serif);
  font-size: 15.5px;
  line-height: 1.55;
  color: var(--et-ink-soft);
  font-weight: 400;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.yb-quote-mark {
  color: var(--et-orange);
  font-family: var(--et-serif);
  font-weight: 600;
  font-size: 28px;
  line-height: 0;
  vertical-align: -8px;
  margin-right: 4px;
}
.yb-quote-mark.close {
  margin-left: 2px;
  margin-right: 0;
}
.yb-signature-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-family: var(--et-sans);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--et-mute);
}
.yb-meta-name {
  color: var(--et-ink);
  font-weight: 500;
}
.yb-meta-date {
  font-family: var(--et-mono);
}
.yb-meta-dot {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: var(--et-faint);
}
.yb-reason {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--et-mono);
  font-size: 10.5px;
  color: var(--et-ink-soft);
  padding: 3px 8px 3px 6px;
  border-radius: 4px;
  background: rgba(26,43,74,0.045);
  border: 0.5px solid var(--et-line);
}
.yb-reason::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--et-orange);
  flex-shrink: 0;
  box-shadow: 0 0 0 2px rgba(255,107,71,0.18);
}
.yb-reason b {
  font-weight: 600;
  color: var(--et-ink);
}
.yb-term-wrap {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}
.yb-term {
  font-family: var(--et-mono);
  font-size: 10.5px;
  color: var(--et-orange-2);
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255,107,71,0.08);
}
@media (max-width: 780px) {
  .yb-keyword-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .yb-divider-v {
    width: auto;
    height: 1px;
    background: var(--et-line);
  }
  .yb-module-head {
    align-items: flex-start;
  }
  .yb-signature-text {
    font-size: 14.5px;
    -webkit-line-clamp: 2;
  }
}
`;
