import { useEffect, useState } from 'react';
import { getYearbook } from '../data/api';
import type { Yearbook, YearData } from '../data/api';

interface Props {
  friendId: string;
  onBack: () => void;
}

export function YearbookPage({ friendId, onBack }: Props) {
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
        <div style={{ marginTop: 20, color: 'var(--et-rose)' }}>加载失败：{error}</div>
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

  return (
    <div className="et-root" style={{ background: 'var(--et-bg)', minHeight: '100vh' }}>
      {/* Top bar */}
      <div style={{
        padding: '14px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '0.5px solid var(--et-line)',
      }}>
        <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer', color: 'var(--et-mute)', fontSize: 13 }}>← 返回</button>
        <div className="et-serif" style={{ fontSize: 14, color: 'var(--et-mute)' }}>双人年代记 · 你 ↔ {data.name}</div>
        <span style={{ fontFamily: 'var(--et-mono)', fontSize: 11, color: 'var(--et-faint)' }}>{data.wxid}</span>
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
        <div className="et-eyebrow" style={{ color: 'var(--et-mute)' }}>关于「{data.name}」</div>
        <div className="et-display" style={{
          marginTop: 14, fontFamily: 'var(--et-serif)', fontSize: 40, fontWeight: 600,
          color: 'var(--et-ink)', lineHeight: 1.3, maxWidth: 700,
        }}>
          你和 {data.name} 一起<br />走过 {data.active_years} 年
        </div>
        <div style={{ marginTop: 24, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <Stat label="跨度" value={`${data.span_days} 天`} sub={`${data.first_date} → ${data.last_date}`} />
          <Stat label="总消息" value={data.total_msgs.toLocaleString()} sub="含图文/语音" />
          <Stat label="朋友圈往来" value={`${data.moments_back_total + data.moments_out_total}`}
            sub={`他赞你 ${data.moments_back_total} · 你赞他 ${data.moments_out_total}`} />
        </div>
      </div>

      {/* Year-by-year cards */}
      <div style={{ padding: '12px 28px 60px', maxWidth: 1080, margin: '0 auto',
        display: 'flex', flexDirection: 'column', gap: 22 }}>
        {years.map(y => (
          <YearCard key={y.year} y={y} maxMsgs={yearMaxMsgs} friendName={data.name} />
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

function YearCard({ y, maxMsgs, friendName }: { y: YearData; maxMsgs: number; friendName: string }) {
  const heatPct = Math.round((y.msg_count / maxMsgs) * 100);
  const tone =
    y.msg_count >= maxMsgs * 0.7 ? 'hot'
    : y.msg_count >= maxMsgs * 0.3 ? 'warm'
    : 'cool';
  const accent = tone === 'hot' ? '#FF6B47' : tone === 'warm' ? '#E8B57A' : '#5A7A99';

  const allQuotes: Array<{ kind: string; emoji: string; q: { date: string; from: string; text: string } }> = [];
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

      {/* Signature quote */}
      {y.signature && (
        <div style={{ marginTop: 22, padding: '14px 18px',
          background: 'var(--et-paper-2)', borderLeft: `2px solid ${accent}`,
          borderRadius: '0 8px 8px 0' }}>
          <div className="et-eyebrow" style={{ fontSize: 9, color: accent }}>这一年的代表对话</div>
          <div className="et-serif" style={{ marginTop: 6, fontSize: 14.5, lineHeight: 1.65,
            color: 'var(--et-ink-soft)' }}>
            「{y.signature.text}」
          </div>
          <div className="et-meta" style={{ marginTop: 6, fontSize: 10, color: 'var(--et-faint)' }}>
            — {y.signature.from} · {y.signature.date}
          </div>
        </div>
      )}

      {/* Themed quotes */}
      {allQuotes.length > 0 && (
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {allQuotes.map((bucket, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 18 }}>{bucket.emoji}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: accent, letterSpacing: 0.4 }}>{bucket.kind}</div>
                <div className="et-serif" style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--et-ink-soft)', marginTop: 2 }}>
                  「{bucket.q.text}」
                </div>
                <div className="et-meta" style={{ fontSize: 10, color: 'var(--et-faint)', marginTop: 2 }}>
                  {bucket.q.from} · {bucket.q.date}
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
