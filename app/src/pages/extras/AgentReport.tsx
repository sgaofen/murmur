import { useEffect, useRef, useState } from 'react';
import { Postmark } from '../../components/Postmark';
import { Ribbon } from '../../components/Ribbon';
import { MessageCard } from '../../components/MessageCard';
import { invokeAgent, getInvokeStream } from '../../data/api';
import type { Friend } from '../../data/types';
import { displayName } from '../../utils/privacy';
import { usePrivacy } from '../../utils/usePrivacy';

interface Props {
  friend: Friend;
  cli: string;        // 'claude' | 'codex' | ...
  onClose: () => void;
}

interface Chapter {
  num: string;
  title: string;
  body: string;
}

// Parse the agent's markdown output into chapter cards.
// Looks for headings like "1. **关系定性**" or "## 1. 关系定性" or "### 关系定性"
function parseChapters(md: string): Chapter[] {
  const lines = md.split('\n');
  const chapters: Chapter[] = [];
  let cur: Chapter | null = null;
  const headingPat = /^\s*(?:#{1,4}\s*)?(?:(\d+)[.、:]?\s*)?\*?\*?(关系定性|互动节奏|关键时刻|人物画像|关系走向)\*?\*?/;
  for (const line of lines) {
    const m = line.match(headingPat);
    if (m) {
      if (cur) chapters.push(cur);
      cur = { num: m[1] ? m[1].padStart(2, '0') : String(chapters.length + 1).padStart(2, '0'), title: m[2], body: '' };
      continue;
    }
    if (cur) cur.body += (cur.body ? '\n' : '') + line;
  }
  if (cur) chapters.push(cur);
  return chapters
    .map(c => ({ ...c, body: c.body.replace(/^\s*\n+/, '').trim() }))
    .filter(c => c.body.length > 8);
}

export function AgentReport({ friend, cli, onClose }: Props) {
  void usePrivacy();
  const [phase, setPhase] = useState<'running' | 'done' | 'error'>('running');
  const [streamed, setStreamed] = useState<string>('');
  const [output, setOutput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const [stage, setStage] = useState('queueing');
  const startedAt = useRef(Date.now());

  useEffect(() => {
    const t = setInterval(() => setSecs(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => clearInterval(t);
  }, []);

  // Async invoke + live polling for real claude/codex output
  useEffect(() => {
    let pollId: any = null;
    let cancelled = false;
    invokeAgent({ cli, wxid: friend.id })
      .then(r => {
        if (cancelled) return;
        if (!r.ok) {
          setError(r.error || 'failed to queue');
          setPhase('error');
          return;
        }
        setStage('running');
        // Poll the live stream every 2s
        pollId = setInterval(async () => {
          try {
            const s = await getInvokeStream(friend.id);
            setStreamed(s.output);
            setStage(s.stage);
            if (!s.running) {
              clearInterval(pollId);
              if (s.error) {
                setError(s.error);
                setPhase('error');
              } else if (!s.output?.trim() && s.stage === 'no job') {
                setError('没有找到正在运行的单人分析任务。可能是页面刷新后任务状态丢失，或分析已经结束。请返回人物页查看已生成报告，或重新点击分析。');
                setPhase('error');
              } else {
                setOutput(s.output);
                setPhase('done');
              }
            }
          } catch {
            // Keep polling; the stream endpoint can briefly race with process startup.
          }
        }, 2000);
      })
      .catch(e => {
        if (!cancelled) {
          setError(e?.message || String(e));
          setPhase('error');
        }
      });
    return () => { cancelled = true; if (pollId) clearInterval(pollId); };
  }, [cli, friend.id]);

  const chapters = output ? parseChapters(output) : [];
  const agentDisplayName = cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex CLI' : cli;
  const friendName = displayName(friend.id, friend.name);

  if (phase === 'running') {
    return <Streaming friend={friend} agentName={agentDisplayName}
                       text={streamed || waitingText(agentDisplayName, stage, secs)}
                       secs={secs} onClose={onClose} />;
  }
  if (phase === 'error') {
    return (
      <div style={{ padding: 28 }}>
        <button onClick={onClose} style={{ all: 'unset', cursor: 'pointer', color: 'var(--et-mute)' }}>← 返回</button>
        <div className="et-h2" style={{ marginTop: 18, color: 'var(--et-rose)' }}>分析失败</div>
        <pre style={{ marginTop: 12, padding: 12, background: 'var(--et-paper-2)', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap' }}>{error}</pre>
      </div>
    );
  }

  return (
    <div className="et-root" style={{ background: 'var(--et-bg)', minHeight: '100%' }}>
      <div style={{ padding: '28px 28px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onClose} style={{ all: 'unset', cursor: 'pointer', fontSize: 13, color: 'var(--et-mute)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2L3 7l5 5" strokeLinecap="round" /></svg>
          返回
        </button>
        <div className="et-meta" style={{ marginLeft: 'auto' }}>已生成 · 用时 {secs} 秒</div>
      </div>
      {/* hero / cover */}
      <div className="et-paper-grain" style={{
        margin: '18px 28px 0', padding: '40px 44px',
        background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
        borderRadius: 'var(--et-r-lg)', boxShadow: 'var(--et-shadow-2)', position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', inset: 14, border: '0.5px solid var(--et-line)', borderRadius: 14, pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', top: 24, right: 30, transform: 'rotate(-7deg)' }}>
          <Postmark size={92} text1={agentDisplayName.toUpperCase()} text2="本地分析 · 私人专用" date={new Date().toISOString().slice(0, 10).replace(/-/g, '·')} />
        </div>
        <Ribbon color="var(--et-orange)" tone="solid">精装分析报告 · {agentDisplayName}</Ribbon>
        <div className="et-display" style={{ marginTop: 22, color: 'var(--et-ink)', maxWidth: 760 }}>
          与 {friendName} 的<br />关系画像
        </div>
        <div className="et-meta" style={{ marginTop: 14, fontSize: 13 }}>
          由 <b style={{ color: 'var(--et-ink)' }}>{agentDisplayName}</b> 撰写 · 用时 {secs} 秒
        </div>
      </div>
      {/* chapters */}
      <div style={{ padding: '24px 28px 32px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1180, margin: '0 auto' }}>
        {chapters.length > 0 ? chapters.map((c) => (
          <ReportChapter key={c.num} num={c.num} title={c.title} body={c.body} />
        )) : (
          <div style={{
            background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
            borderRadius: 'var(--et-r)', padding: '24px 28px',
            whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.78, color: 'var(--et-ink-soft)',
          }}>
            {output}
          </div>
        )}
      </div>
      {/* dock */}
      <div style={{ margin: '0 28px 32px', display: 'flex', gap: 10, justifyContent: 'center' }}>
        <ReportBtn label="拷贝全文" icon="⎘" onClick={() => navigator.clipboard.writeText(output)} />
        <ReportBtn label="再来一次" icon="↻" onClick={() => window.location.reload()} />
        <ReportBtn label="关闭" icon="×" onClick={onClose} />
      </div>
    </div>
  );
}

function waitingText(agentName: string, stage: string, secs: number) {
  if (stage === 'queueing') return '正在排队并准备分析资料...';
  if (secs >= 120) {
    return `资料已经交给 ${agentName}。它可能正在排队或完整思考，部分 CLI 会到结束时才一次性输出内容；你可以先返回继续浏览，后台分析不会被取消。`;
  }
  if (secs >= 30) {
    return `${agentName} 已启动，正在等待第一段输出。批量任务或模型响应慢时，这里可能会安静一会儿。`;
  }
  return `(${stage}...)`;
}

function Streaming({ friend, agentName, text, secs, onClose }: { friend: Friend; agentName: string; text: string; secs: number; onClose: () => void }) {
  void usePrivacy();
  const friendName = displayName(friend.id, friend.name);
  return (
    <div className="et-root" style={{ background: 'var(--et-bg)', minHeight: '100%', padding: '28px 28px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button onClick={onClose} style={{ all: 'unset', cursor: 'pointer', fontSize: 13, color: 'var(--et-mute)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2L3 7l5 5" strokeLinecap="round" /></svg>
          返回
        </button>
        <span style={{
          width: 10, height: 10, borderRadius: '50%', background: 'var(--et-orange)',
          animation: 'et-pulse 1.4s ease-in-out infinite',
        }} />
        <div className="et-h2" style={{ color: 'var(--et-ink)' }}>{agentName} 正在分析 与 {friendName} 的关系</div>
      </div>
      <style>{`@keyframes et-pulse{0%,100%{opacity:.4}50%{opacity:1}} @keyframes et-blink{50%{opacity:0}}`}</style>
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
          {text}
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

function ReportChapter({ num, title, body }: Chapter) {
  // Look for a quote-like section in body (lines starting with > or 「)
  const quoteMatch = body.match(/[「"]([^」"]{8,80})[」"]/);
  const quote = quoteMatch ? quoteMatch[1] : null;
  const cleanBody = body.replace(/[「"][^」"]{8,80}[」"]/, '').replace(/\n{2,}/g, '\n').trim();
  return (
    <div style={{
      background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
      borderRadius: 'var(--et-r)', padding: '24px 28px', display: 'grid',
      gridTemplateColumns: '56px 1fr', gap: 18,
    }}>
      <div className="et-serif" style={{ fontSize: 32, fontWeight: 600, color: 'var(--et-orange)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{num}</div>
      <div>
        <div className="et-h2" style={{ color: 'var(--et-ink)' }}>{title}</div>
        <div className="et-body" style={{ marginTop: 10, fontSize: 14.5, lineHeight: 1.78, color: 'var(--et-ink-soft)', maxWidth: 720, whiteSpace: 'pre-wrap' }}>{cleanBody}</div>
        {quote && (
          <div style={{ marginTop: 14 }}>
            <MessageCard text={quote} />
          </div>
        )}
      </div>
    </div>
  );
}

function ReportBtn({ label, icon, onClick }: { label: string; icon: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} style={{
      all: 'unset', cursor: 'pointer',
      padding: '10px 18px', borderRadius: 10,
      background: 'var(--et-paper)',
      color: 'var(--et-ink)',
      border: '0.5px solid var(--et-line-2)',
      fontSize: 13, fontWeight: 600,
      display: 'inline-flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ opacity: 0.9 }}>{icon}</span>{label}
    </button>
  );
}
