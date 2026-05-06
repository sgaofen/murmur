// app/src/pages/AnnualReport.tsx
//
// Global year-in-review across ALL friends + chats. Inspired by WeFlow's
// AnnualReportData taxonomy: top friends, monthly winners, peak day, longest
// streak, 24×7 heatmap, midnight king, mutual friend, social initiative, top
// phrases, lost friend. Reads from /api/annual-report.

import { useEffect, useState } from 'react';
import { ProfileSwitcher } from '../components/ProfileSwitcher';
import { Postmark } from '../components/Postmark';
import { Ribbon } from '../components/Ribbon';
import {
  getAnnualReport, getAvailableReportYears,
  type AnnualReport, type AnnualReportTopFriend,
} from '../data/api';
import { displayName, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';

interface Props {
  onBack: () => void;
  onOpenFriend?: (wxid: string) => void;
}

export function AnnualReportPage({ onBack, onOpenFriend }: Props) {
  void usePrivacy();
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number | null>(null);
  const [data, setData] = useState<AnnualReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pull available years once
  useEffect(() => {
    getAvailableReportYears()
      .then(r => {
        setYears(r.years);
        // Default to "last completed year" — current year often half-empty.
        const target = r.years.includes(r.default) ? r.default : (r.years[r.years.length - 1] ?? null);
        setYear(target);
      })
      .catch(e => setError(e?.message || String(e)));
  }, []);

  // Pull report once year is chosen
  useEffect(() => {
    if (year == null) return;
    setLoading(true);
    setError(null);
    setData(null);
    getAnnualReport(year)
      .then(setData)
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [year]);

  return (
    <div className="et-root" style={{ background: 'var(--et-bg)', minHeight: '100vh' }}>
      <div style={{
        padding: '14px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '0.5px solid var(--et-line)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer', color: 'var(--et-mute)', fontSize: 13 }}>← 返回</button>
          <ProfileSwitcher />
        </div>
        <div className="et-serif" style={{ fontSize: 14, color: 'var(--et-mute)' }}>年度总览 · 你的所有朋友 + 所有聊天</div>
        <YearSwitcher years={years} value={year} onChange={setYear} />
      </div>

      {loading && (
        <div style={{ padding: 60, textAlign: 'center' }}>
          <div className="et-meta">编织 {year} 年的关系档案中…（首次需要 10-30 秒扫描所有聊天记录）</div>
        </div>
      )}
      {error && (
        <div style={{ padding: 40 }}>
          <div style={{ color: 'var(--et-rose)' }}>加载失败：{maskText(error)}</div>
        </div>
      )}
      {!loading && data && data.total_messages === 0 && (
        <div style={{ padding: 60, textAlign: 'center' }}>
          <div className="et-h2">{year} 年没有聊天记录。</div>
          <div className="et-meta" style={{ marginTop: 8 }}>换个年份看看。</div>
        </div>
      )}
      {!loading && data && data.total_messages > 0 && (
        <Body data={data} onOpenFriend={onOpenFriend} />
      )}
    </div>
  );
}

// ——————————————————————————————————————————————————————————————

function YearSwitcher({ years, value, onChange }: {
  years: number[]; value: number | null; onChange: (y: number) => void;
}) {
  if (!years.length) {
    return <span className="et-meta" style={{ fontSize: 11 }}>无可用年份</span>;
  }
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {years.map(y => (
        <button key={y} onClick={() => onChange(y)} style={{
          all: 'unset', cursor: 'pointer',
          padding: '4px 10px', borderRadius: 6,
          background: value === y ? 'var(--et-orange)' : 'transparent',
          color: value === y ? '#fff' : 'var(--et-ink-soft)',
          border: `0.5px solid ${value === y ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
          fontSize: 12, fontWeight: 600,
          fontFamily: 'var(--et-mono)',
        }}>{y}</button>
      ))}
    </div>
  );
}

function Body({ data, onOpenFriend }: { data: AnnualReport; onOpenFriend?: (wxid: string) => void }) {
  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 28px 60px',
                   display: 'flex', flexDirection: 'column', gap: 22 }}>
      <Hero data={data} />
      {data.top_friends && data.top_friends.length > 0 && (
        <TopFriendsCard friends={data.top_friends} totalMsgs={data.total_messages} onOpenFriend={onOpenFriend} />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        {data.peak_day && <PeakDayCard pd={data.peak_day} />}
        {data.longest_streak && <StreakCard s={data.longest_streak} />}
      </div>
      {data.heatmap_24x7 && data.heatmap_24x7.length === 168 && (
        <HeatmapCard data={data.heatmap_24x7} />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
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
    <section className="et-paper-grain" style={{
      padding: '40px 44px 30px',
      background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
      borderRadius: 'var(--et-r-lg)', boxShadow: 'var(--et-shadow-2)',
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 24, right: 30, transform: 'rotate(-7deg)' }}>
        <Postmark size={92} text1="MURMUR · YEAR" text2="本地年度档" date={String(data.year)} />
      </div>
      <Ribbon color="var(--et-orange)" tone="solid">{data.year} 年度总览</Ribbon>
      <div className="et-display" style={{ marginTop: 22, color: 'var(--et-ink)', maxWidth: 720 }}>
        与 <span style={{ color: 'var(--et-orange)' }}>{data.total_friends_active ?? 0}</span> 个朋友<br />
        共 <span style={{ color: 'var(--et-orange)' }}>{(data.total_messages ?? 0).toLocaleString()}</span> 条消息
      </div>
      <div className="et-meta" style={{ marginTop: 16, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <span>跨度 <b style={{ color: 'var(--et-ink)' }}>{data.first_message_date} → {data.last_message_date}</b></span>
        <span>活跃天数 <b style={{ color: 'var(--et-ink)' }}>{data.active_days ?? 0}</b></span>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {top.map((f, i) => {
          const pct = Math.round((f.count / totalMsgs) * 100);
          const w = Math.max(4, Math.round((f.count / max) * 100));
          return (
            <button
              key={f.wxid}
              onClick={() => onOpenFriend?.(f.wxid)}
              style={{
                all: 'unset', cursor: 'pointer',
                display: 'grid', gridTemplateColumns: '24px 1fr auto', alignItems: 'center', gap: 12,
                padding: '8px 4px', borderRadius: 6,
              }}>
              <span className="et-num" style={{ fontSize: 16, color: i === 0 ? 'var(--et-orange)' : 'var(--et-mute)', fontWeight: 600 }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="et-serif" style={{ fontSize: 14, color: 'var(--et-ink)', fontWeight: 500,
                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayName(f.wxid, f.name)}
                </div>
                <div style={{ marginTop: 4, height: 4, background: 'rgba(26,43,74,0.06)', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{ width: `${w}%`, height: '100%', background: i === 0 ? 'var(--et-orange)' : 'var(--et-ink-soft)', borderRadius: 999 }} />
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="et-num" style={{ fontSize: 14, color: 'var(--et-ink)', fontWeight: 600 }}>
                  {f.count.toLocaleString()}
                </div>
                <div className="et-meta" style={{ fontSize: 10, color: 'var(--et-mute)' }}>
                  {pct}% · 你 {f.self} / 他 {f.other}
                </div>
              </div>
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
      <div className="et-serif" style={{ fontSize: 18, color: 'var(--et-orange)', fontWeight: 600 }}>{pd.date}</div>
      {pd.top_name && (
        <div className="et-meta" style={{ marginTop: 6, fontSize: 12, color: 'var(--et-ink-soft)' }}>
          这一天主要在和 <b style={{ color: 'var(--et-ink)' }}>{displayName(pd.top_wxid || '', pd.top_name)}</b> 聊（{pd.top_count} 条）
        </div>
      )}
    </Card>
  );
}

function StreakCard({ s }: { s: NonNullable<AnnualReport['longest_streak']> }) {
  return (
    <Card eyebrow="连续聊天" title={`${s.days} 天`}>
      <div className="et-meta" style={{ fontSize: 12, color: 'var(--et-ink-soft)' }}>
        {s.start} → {s.end}
      </div>
      <div className="et-meta" style={{ marginTop: 6, fontSize: 11, color: 'var(--et-mute)' }}>
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
      <div style={{ display: 'grid', gridTemplateRows: 'repeat(7, 14px)', gap: 3 }}>
        {days.map((d, w) => (
          <div key={w} style={{ display: 'grid', gridTemplateColumns: '20px repeat(24, 1fr)', gap: 3, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--et-faint)', textAlign: 'right', paddingRight: 4 }}>{d}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = data[w * 24 + h] || 0;
              const a = v / max;
              return (
                <div key={h} title={v ? `周${d} ${h}:00 · ${v} 条` : ''} style={{
                  height: 14, borderRadius: 2,
                  background: a > 0
                    ? `color-mix(in srgb, var(--et-orange) ${10 + a * 80}%, var(--et-paper-2))`
                    : 'rgba(26,43,74,0.04)',
                }} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="et-meta" style={{ marginTop: 10, fontSize: 10, color: 'var(--et-faint)', textAlign: 'right' }}>
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
      <button onClick={() => onOpenFriend?.(m.wxid)} style={{
        all: 'unset', cursor: 'pointer',
        marginTop: 4, fontSize: 18, color: 'var(--et-orange)', fontFamily: 'var(--et-serif)', fontWeight: 600,
      }}>
        {displayName(m.wxid, m.name)}
      </button>
      <div className="et-meta" style={{ marginTop: 6, fontSize: 12, color: 'var(--et-ink-soft)' }}>
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
      <button onClick={() => onOpenFriend?.(m.wxid)} style={{
        all: 'unset', cursor: 'pointer',
        marginTop: 4, fontSize: 18, color: 'var(--et-orange)', fontFamily: 'var(--et-serif)', fontWeight: 600,
      }}>
        {displayName(m.wxid, m.name)}
      </button>
      <div className="et-meta" style={{ marginTop: 6, fontSize: 12, color: 'var(--et-ink-soft)' }}>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {winners.map(w => (
          <button
            key={w.month}
            disabled={!w.wxid}
            onClick={() => w.wxid && onOpenFriend?.(w.wxid)}
            style={{
              all: 'unset', cursor: w.wxid ? 'pointer' : 'default',
              padding: '10px 12px', borderRadius: 8,
              background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
              opacity: w.wxid ? 1 : 0.5,
            }}>
            <div className="et-num" style={{ fontSize: 11, color: 'var(--et-mute)' }}>{w.month}月</div>
            <div className="et-serif" style={{
              fontSize: 13, color: 'var(--et-ink)', fontWeight: 500, marginTop: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {w.name ? displayName(w.wxid || '', w.name) : '—'}
            </div>
            <div className="et-meta" style={{ fontSize: 10, color: 'var(--et-faint)', marginTop: 2 }}>
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
      <div className="et-meta" style={{ fontSize: 12, color: 'var(--et-ink-soft)' }}>
        你 {i.self_starts} 次 · 朋友们 {i.other_starts} 次（按 6 小时间隔切对话窗）
      </div>
      {i.top_initiated_name && i.top_initiated_wxid && (
        <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--et-orange-soft)', borderRadius: 6 }}>
          <div className="et-meta" style={{ fontSize: 10 }}>你今年最爱主动找的人</div>
          <button onClick={() => onOpenFriend?.(i.top_initiated_wxid!)} style={{
            all: 'unset', cursor: 'pointer',
            fontSize: 14, fontFamily: 'var(--et-serif)', fontWeight: 600,
            color: 'var(--et-orange-2)',
          }}>
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
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 14, rowGap: 8 }}>
        {phrases.map((p, i) => {
          const t = 1 - (i / Math.max(1, phrases.length - 1));
          const size = 12 + Math.round(t * 8);
          return (
            <span key={p.phrase} title={`${p.count.toLocaleString()} 次`} style={{
              fontFamily: 'var(--et-serif)', fontSize: size, fontWeight: i < 3 ? 600 : 400,
              color: i < 3 ? 'var(--et-ink)' : 'var(--et-ink-soft)',
              opacity: 0.55 + t * 0.45,
              borderBottom: i === 0 ? '1.5px solid var(--et-orange)' : 'none',
            }}>
              {maskText(p.phrase)}
              <span style={{ fontFamily: 'var(--et-mono)', fontSize: 9, color: 'var(--et-faint)', marginLeft: 4 }}>
                {p.count.toLocaleString()}
              </span>
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
      <button onClick={() => onOpenFriend?.(l.wxid)} style={{
        all: 'unset', cursor: 'pointer',
        marginTop: 4, fontSize: 18, color: 'var(--et-orange)', fontFamily: 'var(--et-serif)', fontWeight: 600,
      }}>
        {displayName(l.wxid, l.name)}
      </button>
      <div className="et-meta" style={{ marginTop: 6, fontSize: 12, color: 'var(--et-ink-soft)' }}>
        前半年 {l.first_half} 条 → 后半年 {l.second_half} 条（少了 <b style={{ color: 'var(--et-orange-2)' }}>{l.drop_pct}%</b>）
      </div>
      <div className="et-meta" style={{ marginTop: 6, fontSize: 11, color: 'var(--et-faint)', fontStyle: 'italic' }}>
        不一定是 ta 的错，也许只是一段时间各忙各的
      </div>
    </Card>
  );
}

// —— Shared card shell ——
function Card({ eyebrow, title, children }: {
  eyebrow: string; title: string; children: React.ReactNode;
}) {
  return (
    <section style={{
      background: 'var(--et-paper)',
      border: '0.5px solid var(--et-line-2)',
      borderRadius: 'var(--et-r)',
      padding: '20px 24px',
    }}>
      <div className="et-eyebrow">{eyebrow}</div>
      <div className="et-h2" style={{ color: 'var(--et-ink)', marginTop: 4 }}>{title}</div>
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}
