// app/src/pages/extras/RelationshipReportView.tsx
//
// The local-agent run for one friend, started from the AI drawer. It replaces
// the profile page while it runs:
//   running — what the agent has printed so far (real getInvokeStream
//             polling), elapsed time, and four numbers from the latest
//             yearbook year so there is something true to look at meanwhile
//   error   — ErrorState with the raw message
//   done    — the shared long-form reader (extras/ReportReader)
// Nothing here estimates progress: agents don't report a percentage.
// Styles: ./RelationshipReportView.css (prefix rrv-) + ./ReportReader.css.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { invokeAgent, getInvokeStream, getYearbook, type YearData } from '../../data/api';
import type { Friend } from '../../data/types';
import { displayName, isPrivacyMode, maskText } from '../../utils/privacy';
import { usePrivacy } from '../../utils/usePrivacy';
import { agentDisplayName as agentNameFor } from '../../utils/agents';
import { PageHeader } from '../../shell/PageHeader';
import { Button, ErrorState, Module, cx } from '../../ui';
import { IconCopy, IconRefresh } from '../../ui/icons';
import { ReportReader, parseReport } from './ReportReader';
import './RelationshipReportView.css';

interface Props {
  friend: Friend;
  cli: string;          // 'claude' | 'codex' | ...
  onClose: () => void;
}

interface Evidence {
  year: number | null;
  longestStreakDays: number | null;
  initiativeSelfPct: number | null;     // 0..100, "你主导"
  midnightFriendPct: number | null;     // 0..100, share of midnight msgs from THEM
  trendDirection: 'up' | 'down' | 'flat' | null;
}

function deriveEvidence(year: YearData | null): Evidence {
  if (!year) return { year: null, longestStreakDays: null, initiativeSelfPct: null, midnightFriendPct: null, trendDirection: null };
  // Trend from the first / second half of the year (real yearbook fields).
  let trend: Evidence['trendDirection'] = null;
  const f = year.first_half_msgs ?? 0;
  const s = year.second_half_msgs ?? 0;
  if (f + s > 0) {
    const ratio = f === 0 ? 99 : s / f;
    trend = ratio > 1.15 ? 'up' : ratio < 0.85 ? 'down' : 'flat';
  }
  return {
    year: year.year,
    longestStreakDays: year.longest_streak_days ?? null,
    initiativeSelfPct: year.initiative_self_pct ?? null,
    midnightFriendPct: year.midnight_friend_pct ?? null,
    trendDirection: trend,
  };
}

function evidenceItems(e: Evidence, friendName: string): { k: string; zh: string; v: string }[] {
  const out: { k: string; zh: string; v: string }[] = [];
  if (e.longestStreakDays != null) out.push({ k: 'STREAK', zh: '最长连聊', v: `${e.longestStreakDays} 天` });
  if (e.initiativeSelfPct != null) {
    const p = Math.round(e.initiativeSelfPct);
    out.push({ k: 'OPENED', zh: p >= 50 ? '你先开口' : `${friendName} 先开口`, v: `${p >= 50 ? p : 100 - p}%` });
  }
  if (e.midnightFriendPct != null) out.push({ k: 'MIDNIGHT', zh: '深夜消息来自对方', v: `${Math.round(e.midnightFriendPct)}%` });
  if (e.trendDirection) {
    const word = e.trendDirection === 'up' ? '下半年更多' : e.trendDirection === 'down' ? '下半年变少' : '上下半年持平';
    out.push({ k: 'TREND', zh: '年内走势', v: word });
  }
  return out;
}

function clock(secs: number): string {
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
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
  const [run, setRun] = useState(0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    const t = setInterval(() => setSecs(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [run]);

  // Something true to show while waiting: the latest yearbook year.
  useEffect(() => {
    let cancelled = false;
    getYearbook(friend.id)
      .then(yb => {
        if (cancelled) return;
        const years = yb.years || [];
        setYear(years.length ? years[years.length - 1] : null);
      })
      .catch(() => { /* silent — the readouts just don't render */ });
    return () => { cancelled = true; };
  }, [friend.id]);

  // Real polling — same protocol as the profile page's progress module.
  useEffect(() => {
    let pollId: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    startedAt.current = Date.now();
    setPhase('running');
    setStreamed('');
    setOutput('');
    setError(null);
    setSecs(0);
    setStage('queueing');
    invokeAgent({ cli, wxid: friend.id })
      .then(r => {
        if (cancelled) return;
        if (!r.ok) { setError(r.error || 'failed to queue'); setPhase('error'); return; }
        setStage('running');
        pollId = setInterval(async () => {
          try {
            const s = await getInvokeStream(friend.id);
            if (cancelled) return;
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
  }, [cli, friend.id, run]);

  const parsed = useMemo(() => (output ? parseReport(maskText(output)) : null), [output]);
  const agentName = agentNameFor(cli);
  const friendName = displayName(friend.id, friend.name);
  const evidence = evidenceItems(deriveEvidence(year), friendName);
  const yearNo = year?.year ?? null;

  const header = (
    <PageHeader
      back={{ label: '档案', onClick: onClose }}
      title={`与 ${friendName} 的关系画像`}
      subtitle={phase === 'running' ? `${agentName} 正在分析 · ${clock(secs)}`
        : phase === 'error' ? `${agentName} · 分析失败`
          : `${agentName} · 已生成 · 用时 ${secs} 秒`}
    />
  );

  if (phase === 'error') {
    return (
      <>
        {header}
        <ErrorState
          layout="page"
          title="分析失败"
          reason={`${agentName} 没有完成这次分析。`}
          details={<pre>{maskText(error || '')}</pre>}
          detailsLabel="错误信息"
          onRetry={() => setRun(n => n + 1)}
          retryLabel="再试一次"
          actions={<Button onClick={onClose}>回到档案</Button>}
        />
      </>
    );
  }

  if (phase === 'done') {
    return (
      <>
        {header}
        <ReportReader
          id="18"
          label="AI 关系报告"
          modal={false}
          title={`与 ${friendName} 的关系画像`}
          meta={(
            <>
              由 <b>{agentName}</b> 在本机撰写 · 用时 {secs} 秒
              {evidence.length > 0 && yearNo != null && (
                <><br />{yearNo} 年：{evidence.map(e => `${e.zh} ${e.v}`).join(' · ')}</>
              )}
            </>
          )}
          sections={parsed?.sections ?? []}
          raw={parsed && parsed.sections.length ? undefined : maskText(output)}
          onClose={onClose}
          actions={(
            <>
              <Button size="sm" variant="ghost" icon={<IconCopy size={13} />}
                onClick={() => navigator.clipboard.writeText(isPrivacyMode() ? maskText(output) : output)}>
                复制全文
              </Button>
              <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={() => setRun(n => n + 1)}>
                再来一次
              </Button>
            </>
          )}
        />
      </>
    );
  }

  const text = streamed.trim();
  return (
    <Running
      header={header} agentName={agentName} friendName={friendName} stage={stage} secs={secs}
      text={text} evidence={evidence} yearNo={yearNo} onClose={onClose}
    />
  );
}

function Running({ header, agentName, friendName, stage, secs, text, evidence, yearNo, onClose }: {
  header: ReactNode; agentName: string; friendName: string; stage: string; secs: number; text: string;
  evidence: { k: string; zh: string; v: string }[]; yearNo: number | null; onClose: () => void;
}) {
  // Follow the output while the reader is at the bottom of it.
  const outRef = useRef<HTMLPreElement | null>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = outRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <>
      {header}
      <div className="rrv">
        <div className="rrv__rack ui-rack">
          <Module
            id="18" title="AI 关系报告" en={`LOCAL AGENT · ${agentName.toUpperCase()}`} className="rrv__stream"
            right={<span className="rrv__run"><span className="ui-led is-pulse" />RUNNING {clock(secs)}</span>}
          >
            <div className="rrv__lead">
              <div className="ui-label">SUBJECT<b>{friendName}</b></div>
              <h2 className="rrv__h">{agentName} 正在读你和 {friendName} 的聊天</h2>
              <div className="rrv__lead-row">
                <p className="rrv__p">
                  {stage === 'queueing' ? '正在排队并准备分析资料…'
                    : secs >= 120 ? `资料已经交给 ${agentName}。部分 CLI 会到结束时才一次性输出；可以先返回继续浏览，后台分析不会被取消。`
                      : secs >= 30 ? `${agentName} 已启动，正在等待第一段输出。模型响应慢时，这里可能会安静一会儿。`
                        : '可以先返回继续浏览，后台继续跑；回到档案页会看到进度。'}
                </p>
                <Button size="sm" onClick={onClose}>先回档案，后台继续</Button>
              </div>
            </div>
            <div className="rrv__log" aria-live="polite">
              <div className="rrv__log-h">
                <span className="ui-label">STDOUT<b>助手输出</b></span>
                <span className="rrv__stage">{stage}</span>
              </div>
              <pre
                ref={outRef}
                className={cx('rrv__out', !text && 'is-empty')}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
                }}
              >
                {text ? maskText(text) : '（还没有输出）'}
                <span className="rrv__cursor" aria-hidden="true" />
              </pre>
            </div>
            <div className="rrv__track" aria-hidden="true"><i /></div>
          </Module>
          {evidence.length > 0 && (
            <Module id="—" title="同期数据" en={yearNo != null ? `${yearNo} · FROM YEARBOOK` : 'FROM YEARBOOK'} className="rrv__ev">
              <div className="rrv__ros">
                {evidence.map(e => (
                  <div key={e.k} className="rrv__ro">
                    <div className="ui-label">{e.k}<b>{e.zh}</b></div>
                    <div className="rrv__ro-v">{e.v}</div>
                  </div>
                ))}
              </div>
            </Module>
          )}
        </div>
      </div>
    </>
  );
}
