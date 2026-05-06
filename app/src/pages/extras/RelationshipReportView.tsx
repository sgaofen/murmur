// app/src/pages/extras/RelationshipReportView.tsx
//
// Round 2 — replaces extras/AgentReport.tsx as the real polling renderer for
// the AI Assistant Drawer. Two-column layout (chapter rail + reading column),
// hard-evidence bar pinned under the hero, real getInvokeStream polling.
//
// Adapted from Claude Design's Round 2 deliverable with these reality-fixes:
//   - YearStat → YearData (the actual exported type)
//   - field renames: total/messages → msg_count
//   - trend derivation uses first_half_msgs / second_half_msgs (real fields)
//     instead of a non-existent `monthly` array

import { useEffect, useMemo, useRef, useState } from 'react';
import { Postmark } from '../../components/Postmark';
import { Ribbon } from '../../components/Ribbon';
import { MessageCard } from '../../components/MessageCard';
import { invokeAgent, getInvokeStream, getYearbook, type YearData } from '../../data/api';
import type { Friend } from '../../data/types';
import { displayName, isPrivacyMode, maskText } from '../../utils/privacy';
import { usePrivacy } from '../../utils/usePrivacy';
import { ArrowLeft, Copy, Refresh, Close, Quote } from '../../utils/icons';

interface Props {
  friend: Friend;
  cli: string;          // 'claude' | 'codex' | ...
  onClose: () => void;
}

interface Chapter {
  num: string;
  title: string;
  body: string;
}

function parseChapters(md: string): Chapter[] {
  const lines = md.split('\n');
  const out: Chapter[] = [];
  let cur: Chapter | null = null;
  const headingPat = /^\s*(?:#{1,4}\s*)?(?:(\d+)[.、:]?\s*)?\*?\*?(关系定性|互动节奏|关键时刻|人物画像|关系走向)\*?\*?/;
  for (const line of lines) {
    const m = line.match(headingPat);
    if (m) {
      if (cur) out.push(cur);
      cur = {
        num: m[1] ? m[1].padStart(2, '0') : String(out.length + 1).padStart(2, '0'),
        title: m[2],
        body: '',
      };
      continue;
    }
    if (cur) cur.body += (cur.body ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out
    .map(c => ({ ...c, body: c.body.replace(/^\s*\n+/, '').trim() }))
    .filter(c => c.body.length > 8);
}

interface Evidence {
  longestStreakDays: number | null;
  initiativeSelfPct: number | null;     // 0..100, "你主导"
  midnightFriendPct: number | null;     // 0..100, share of midnight msgs from THEM
  trendDirection: 'up' | 'down' | 'flat' | null;
  totalMessages: number | null;
  activeDays: number | null;
}

function deriveEvidence(year: YearData | null): Evidence {
  if (!year) return {
    longestStreakDays: null, initiativeSelfPct: null, midnightFriendPct: null,
    trendDirection: null, totalMessages: null, activeDays: null,
  };
  // Trend uses the real first_half_msgs / second_half_msgs fields the
  // backend already emits; skip the non-existent `monthly[]` Claude Design
  // hallucinated.
  let trend: 'up' | 'down' | 'flat' | null = null;
  const f = year.first_half_msgs ?? 0;
  const s = year.second_half_msgs ?? 0;
  if (f + s > 0) {
    const ratio = f === 0 ? 99 : s / f;
    trend = ratio > 1.15 ? 'up' : ratio < 0.85 ? 'down' : 'flat';
  }
  return {
    longestStreakDays: year.longest_streak_days ?? null,
    initiativeSelfPct: year.initiative_self_pct ?? null,
    midnightFriendPct: year.midnight_friend_pct ?? null,
    trendDirection: trend,
    totalMessages: year.msg_count ?? null,
    activeDays: year.active_days ?? null,
  };
}

export function RelationshipReportView({ friend, cli, onClose }: Props) {
  void usePrivacy();
  const [phase, setPhase] = useState<'running' | 'done' | 'error'>('running');
  const [streamed, setStreamed] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const [stage, setStage] = useState('queueing');
  const [year, setYear] = useState<YearData | null>(null);
  const startedAt = useRef(Date.now());
  const [activeChapter, setActiveChapter] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setSecs(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => clearInterval(t);
  }, []);

  // Hard-evidence: pull yearbook in parallel. Latest year only.
  useEffect(() => {
    let cancelled = false;
    getYearbook(friend.id)
      .then(yb => {
        if (cancelled) return;
        const years = yb.years || [];
        setYear(years.length ? years[years.length - 1] : null);
      })
      .catch(() => { /* silent — evidence bar just doesn't render */ });
    return () => { cancelled = true; };
  }, [friend.id]);

  // Real polling — same protocol as AgentReport
  useEffect(() => {
    let pollId: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    invokeAgent({ cli, wxid: friend.id })
      .then(r => {
        if (cancelled) return;
        if (!r.ok) { setError(r.error || 'failed to queue'); setPhase('error'); return; }
        setStage('running');
        pollId = setInterval(async () => {
          try {
            const s = await getInvokeStream(friend.id);
            setStreamed(s.output);
            setStage(s.stage);
            if (!s.running) {
              if (pollId) clearInterval(pollId);
              if (s.error) { setError(s.error); setPhase('error'); }
              else if (!s.output?.trim() && s.stage === 'no job') {
                setError('没有找到正在运行的单人分析任务。可能是页面刷新后任务状态丢失，或分析已经结束。请返回人物页查看已生成报告，或重新点击分析。');
                setPhase('error');
              } else { setOutput(s.output); setPhase('done'); }
            }
          } catch { /* keep polling — endpoint can race startup */ }
        }, 2000);
      })
      .catch(e => { if (!cancelled) { setError(e?.message || String(e)); setPhase('error'); } });
    return () => { cancelled = true; if (pollId) clearInterval(pollId); };
  }, [cli, friend.id]);

  const chapters = useMemo(() => (output ? parseChapters(output) : []), [output]);
  const agentDisplayName = cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex CLI' : cli;
  const friendName = displayName(friend.id, friend.name);
  const evidence = deriveEvidence(year);

  if (phase === 'running') {
    return (
      <Streaming
        friend={friend}
        agentName={agentDisplayName}
        text={streamed || waitingText(agentDisplayName, stage, secs)}
        secs={secs}
        evidence={evidence}
        onClose={onClose}
      />
    );
  }
  if (phase === 'error') {
    return (
      <div style={{ padding: 28 }}>
        <BackBtn onClose={onClose} />
        <div className="et-h2" style={{ marginTop: 18, color: 'var(--et-rose)' }}>分析失败</div>
        <pre style={{ marginTop: 12, padding: 12, background: 'var(--et-paper-2)', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap' }}>
          {maskText(error || '')}
        </pre>
      </div>
    );
  }

  return (
    <div className="et-root" style={{ background: 'var(--et-bg)', minHeight: '100%' }}>
      <header style={{ padding: '24px 28px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
        <BackBtn onClose={onClose} />
        <div className="et-meta" style={{ marginLeft: 'auto' }}>已生成 · 用时 {secs} 秒</div>
      </header>

      <section
        className="et-paper-grain"
        style={{
          margin: '18px 28px 0',
          padding: '40px 44px 28px',
          background: 'var(--et-paper)',
          border: '0.5px solid var(--et-line-2)',
          borderRadius: 'var(--et-r-lg)',
          boxShadow: 'var(--et-shadow-2)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div style={{ position: 'absolute', inset: 14, border: '0.5px solid var(--et-line)', borderRadius: 14, pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', top: 24, right: 30, transform: 'rotate(-7deg)' }}>
          <Postmark
            size={92}
            text1={agentDisplayName.toUpperCase()}
            text2="本地分析 · 私人专用"
            date={new Date().toISOString().slice(0, 10).replace(/-/g, '·')}
          />
        </div>
        <Ribbon color="var(--et-orange)" tone="solid">精装分析报告 · {agentDisplayName}</Ribbon>
        <div className="et-display" style={{ marginTop: 22, color: 'var(--et-ink)', maxWidth: 760 }}>
          与 {friendName} 的<br />关系画像
        </div>
        <div className="et-meta" style={{ marginTop: 14, fontSize: 13 }}>
          由 <b style={{ color: 'var(--et-ink)' }}>{agentDisplayName}</b> 撰写 · 用时 {secs} 秒 · 共 {chapters.length || '—'} 章
        </div>
      </section>

      <EvidenceBar evidence={evidence} friendName={friendName} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '180px 1fr',
          gap: 32,
          maxWidth: 1180,
          margin: '0 auto',
          padding: '24px 28px 32px',
        }}
      >
        <ChapterRail chapters={chapters} active={activeChapter} onPick={setActiveChapter} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
          {chapters.length > 0 ? chapters.map(c => (
            <ReportChapter
              key={c.num}
              num={c.num}
              title={c.title}
              body={c.body}
              onIntersect={() => setActiveChapter(c.num)}
            />
          )) : (
            <div
              style={{
                background: 'var(--et-paper)',
                border: '0.5px solid var(--et-line-2)',
                borderRadius: 'var(--et-r)',
                padding: '24px 28px',
                whiteSpace: 'pre-wrap',
                fontSize: 14,
                lineHeight: 1.78,
                color: 'var(--et-ink-soft)',
              }}
            >
              {maskText(output)}
            </div>
          )}
        </div>
      </div>

      <div style={{ margin: '0 28px 32px', display: 'flex', gap: 10, justifyContent: 'center' }}>
        <ReportBtn
          label="拷贝全文"
          icon={<Copy size={14} />}
          onClick={() => navigator.clipboard.writeText(isPrivacyMode() ? maskText(output) : output)}
        />
        <ReportBtn label="再来一次" icon={<Refresh size={14} />} onClick={() => window.location.reload()} />
        <ReportBtn label="关闭" icon={<Close size={14} />} onClick={onClose} />
      </div>
    </div>
  );
}

function EvidenceBar({ evidence, friendName }: { evidence: Evidence; friendName: string }) {
  const items: { num: string; label: string; tone?: 'ink' | 'orange' }[] = [];
  if (evidence.longestStreakDays != null) {
    items.push({ num: `${evidence.longestStreakDays} 天`, label: '最长连聊', tone: 'ink' });
  }
  if (evidence.initiativeSelfPct != null) {
    const p = Math.round(evidence.initiativeSelfPct);
    items.push({ num: `${p}%`, label: p >= 50 ? '你主导' : `${friendName} 主导`, tone: 'ink' });
  }
  if (evidence.midnightFriendPct != null) {
    const p = Math.round(evidence.midnightFriendPct);
    items.push({ num: `${p}%`, label: '深夜偏向他', tone: 'ink' });
  }
  if (evidence.trendDirection) {
    const arrow = evidence.trendDirection === 'up' ? '↑' : evidence.trendDirection === 'down' ? '↓' : '→';
    const word = evidence.trendDirection === 'up' ? '越聊越多' : evidence.trendDirection === 'down' ? '渐渐稀疏' : '全年平稳';
    items.push({ num: `全年 ${arrow}`, label: word, tone: 'orange' });
  }
  if (items.length === 0) return null;

  return (
    <section
      aria-label="hard evidence"
      style={{
        margin: '14px 28px 0',
        padding: '14px 22px',
        background: 'var(--et-paper)',
        border: '0.5px solid var(--et-line-2)',
        borderRadius: 'var(--et-r)',
        boxShadow: 'var(--et-shadow-1)',
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        flexWrap: 'wrap',
      }}
    >
      <div className="et-eyebrow" style={{ paddingRight: 18, borderRight: '0.5px solid var(--et-line)' }}>
        硬证据 · 数据指纹
      </div>
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            padding: '0 22px',
            borderRight: i === items.length - 1 ? 'none' : '0.5px solid var(--et-line)',
          }}
        >
          <span
            className="et-num"
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: it.tone === 'orange' ? 'var(--et-orange)' : 'var(--et-ink)',
              letterSpacing: '-0.01em',
            }}
          >
            {it.num}
          </span>
          <span className="et-serif" style={{ fontSize: 13, color: 'var(--et-ink-soft)' }}>
            {it.label}
          </span>
        </div>
      ))}
    </section>
  );
}

function ChapterRail({
  chapters, active, onPick,
}: {
  chapters: Chapter[];
  active: string | null;
  onPick: (n: string) => void;
}) {
  if (chapters.length === 0) return <div />;
  return (
    <nav
      aria-label="chapters"
      style={{
        position: 'sticky',
        top: 24,
        alignSelf: 'start',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        paddingTop: 6,
      }}
    >
      <div className="et-eyebrow" style={{ marginBottom: 12 }}>目录</div>
      {chapters.map(c => {
        const isActive = active === c.num;
        return (
          <button
            key={c.num}
            onClick={() => {
              onPick(c.num);
              const el = document.getElementById(`chapter-${c.num}`);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            style={{
              all: 'unset',
              cursor: 'pointer',
              display: 'grid',
              gridTemplateColumns: '32px 1fr',
              alignItems: 'baseline',
              gap: 8,
              padding: '8px 0 8px 4px',
              borderLeft: isActive ? '2px solid var(--et-orange)' : '2px solid transparent',
              paddingLeft: 10,
              transition: 'border-color .2s',
            }}
          >
            <span
              className="et-num"
              style={{
                fontSize: 13,
                color: isActive ? 'var(--et-orange)' : 'var(--et-mute)',
                fontWeight: 600,
              }}
            >
              {c.num}
            </span>
            <span
              className="et-serif"
              style={{
                fontSize: 14,
                color: isActive ? 'var(--et-ink)' : 'var(--et-ink-soft)',
                lineHeight: 1.4,
                fontWeight: isActive ? 600 : 500,
              }}
            >
              {c.title}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function ReportChapter({
  num, title, body, onIntersect,
}: Chapter & { onIntersect?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !onIntersect) return;
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio > 0.4) onIntersect();
        }
      },
      { threshold: [0, 0.4, 1] }
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [onIntersect]);

  const quoteMatch = body.match(/[「"]([^」"]{8,80})[」"]/);
  const quote = quoteMatch ? quoteMatch[1] : null;
  const cleanBody = body.replace(/[「"][^」"]{8,80}[」"]/, '').replace(/\n{2,}/g, '\n').trim();

  return (
    <article
      ref={ref}
      id={`chapter-${num}`}
      style={{
        background: 'var(--et-paper)',
        border: '0.5px solid var(--et-line-2)',
        borderRadius: 'var(--et-r)',
        padding: '26px 30px',
        display: 'grid',
        gridTemplateColumns: '64px 1fr',
        gap: 20,
        scrollMarginTop: 24,
      }}
    >
      <div
        className="et-serif"
        style={{
          fontSize: 36,
          fontWeight: 600,
          color: 'var(--et-orange)',
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {num}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="et-h2" style={{ color: 'var(--et-ink)' }}>{title}</div>
        <div
          className="et-body"
          style={{
            marginTop: 12,
            fontSize: 14.5,
            lineHeight: 1.78,
            color: 'var(--et-ink-soft)',
            maxWidth: 720,
            whiteSpace: 'pre-wrap',
          }}
        >
          {maskText(cleanBody)}
        </div>
        {quote && (
          <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ paddingTop: 4, color: 'var(--et-orange)' }}><Quote size={16} /></div>
            <MessageCard text={maskText(quote)} />
          </div>
        )}
      </div>
    </article>
  );
}

function Streaming({
  friend, agentName, text, secs, evidence, onClose,
}: {
  friend: Friend; agentName: string; text: string; secs: number;
  evidence: Evidence; onClose: () => void;
}) {
  void usePrivacy();
  const friendName = displayName(friend.id, friend.name);
  return (
    <div className="et-root" style={{ background: 'var(--et-bg)', minHeight: '100%', padding: '24px 28px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <BackBtn onClose={onClose} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--et-orange)', animation: 'et-pulse 1.4s ease-in-out infinite' }} />
        <div className="et-h2" style={{ color: 'var(--et-ink)' }}>
          {agentName} 正在分析 与 {friendName} 的关系
        </div>
      </div>

      <div style={{ margin: '0 -28px 14px' }}>
        <EvidenceBar evidence={evidence} friendName={friendName} />
      </div>

      <div className="et-paper-grain" style={{
        background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
        borderRadius: 'var(--et-r-lg)', padding: '22px 26px',
        boxShadow: 'var(--et-shadow-1)', position: 'relative', minHeight: 280,
      }}>
        <div style={{ position: 'absolute', top: 18, right: 22 }}>
          <span className="et-chip">{agentName} · 流式输出</span>
        </div>
        <div className="et-eyebrow">助手发言</div>
        <div className="et-serif" style={{ marginTop: 14, fontSize: 15, lineHeight: 1.85, color: 'var(--et-ink)', whiteSpace: 'pre-wrap' }}>
          {maskText(text)}
          <span style={{ display: 'inline-block', width: 8, height: 16, background: 'var(--et-orange)', marginLeft: 2, verticalAlign: 'middle', animation: 'et-blink 1s steps(1) infinite' }} />
        </div>
        <div style={{ marginTop: 22, paddingTop: 16, borderTop: '0.5px solid var(--et-line)', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div className="et-meta">已用时 <span className="et-num" style={{ color: 'var(--et-ink)', fontWeight: 600 }}>{secs}s</span></div>
          <div className="et-meta">· 可以返回浏览，后台继续跑</div>
          <div style={{ flex: 1, height: 4, background: 'rgba(26,43,74,0.08)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(95, secs * 2)}%`, height: '100%', background: 'var(--et-orange)', borderRadius: 999, transition: 'width .3s' }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function waitingText(agentName: string, stage: string, secs: number) {
  if (stage === 'queueing') return '正在排队并准备分析资料...';
  if (secs >= 120) return `资料已经交给 ${agentName}。它可能正在排队或完整思考，部分 CLI 会到结束时才一次性输出内容；你可以先返回继续浏览，后台分析不会被取消。`;
  if (secs >= 30)  return `${agentName} 已启动，正在等待第一段输出。批量任务或模型响应慢时，这里可能会安静一会儿。`;
  return `(${stage}...)`;
}

function BackBtn({ onClose }: { onClose: () => void }) {
  return (
    <button onClick={onClose} style={{
      all: 'unset', cursor: 'pointer', fontSize: 13, color: 'var(--et-mute)',
      display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>
      <ArrowLeft size={14} /> 返回
    </button>
  );
}

function ReportBtn({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} style={{
      all: 'unset', cursor: 'pointer',
      padding: '10px 18px', borderRadius: 10,
      background: 'var(--et-paper)', color: 'var(--et-ink)',
      border: '0.5px solid var(--et-line-2)',
      fontSize: 13, fontWeight: 600,
      display: 'inline-flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ opacity: 0.9, display: 'inline-flex' }}>{icon}</span>{label}
    </button>
  );
}
