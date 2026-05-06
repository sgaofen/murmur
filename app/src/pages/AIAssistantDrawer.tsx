// AIAssistantDrawer — drawer-based AI analysis entry point.
// Adopted from Claude Design's round-1 output but with Murmur-correct imports
// and real API wiring. The CD original assumed `usePrivacy()` returns
// `{ displayName }` (it doesn't — returns a boolean), bundled lucide-react
// (off-budget per the brief), and used a mock Friend type. All those are
// fixed here. Keeps the architectural moves: slide-in drawer, single-row
// chrome, in-line ProgressPanel instead of step-2 modal.
//
// The companion `RelationshipReportView` handles the local-AI streaming flow;
// this drawer fires `onLocalAgent` and lets the parent route to that view.

import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import {
  IconArrowRight, IconCheck, IconCopy, IconFolder, IconShield, IconX,
  iconForCli,
} from '../utils/icons';
import {
  generateAIPack, getAgents, openFolder,
  type LocalAgent,
} from '../data/api';
import type { Friend } from '../data/types';
import { displayName, isPrivacyMode, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';

type Phase = 'idle' | 'running' | 'error';
type Range = 'year' | 'all' | 'cust';
type AgentChoice = string | 'manual' | null;

type FocusKey = 'qual' | 'rhythm' | 'persona' | 'emotion' | 'topics' | 'advice';
type FocusState = Partial<Record<FocusKey, boolean>>;

interface GeneratedPack {
  ok: boolean;
  path: string;
  size: number;
  name: string;
  content: string;
}

interface AIAssistantDrawerProps {
  open: boolean;
  onClose: () => void;
  friend: Friend;
  onComplete?: (pack: GeneratedPack) => void;
  onLocalAgent?: (cli: string) => void;
}

interface ReportReadyBannerProps {
  pack: GeneratedPack;
  friend: Friend;
  onOpenLocation: () => void;
  onCopy: () => void;
  onSendOnline: () => void;
  onDismiss?: () => void;
}

const STAGES = [
  { key: 'read',     label: '读取消息',     hint: '把历史聊天按窗口切片' },
  { key: 'extract',  label: '提取关键时刻', hint: '夜聊、道歉、人生节点…' },
  { key: 'evidence', label: '提取相处证据', hint: '通话、共群、朋友圈交叉' },
  { key: 'portrait', label: '生成画像',     hint: '关系定性 + 人物素描' },
  { key: 'forecast', label: '关系走向',     hint: '给出可执行的下一步' },
] as const;

const FOCUSES: { k: FocusKey; label: string; hint: string }[] = [
  { k: 'qual',    label: '关系定性', hint: '我们到底是什么关系' },
  { k: 'rhythm',  label: '互动节奏', hint: '谁更主动 / 回应速度' },
  { k: 'persona', label: '人物画像', hint: '对方大概是怎样一个人' },
  { k: 'emotion', label: '情感曲线', hint: '热度有没有变化' },
  { k: 'topics',  label: '话题演变', hint: '我们最近在聊什么' },
  { k: 'advice',  label: '具体建议', hint: '下一步可以做什么' },
];

export function AIAssistantDrawer({
  open, onClose, friend, onLocalAgent, onComplete,
}: AIAssistantDrawerProps) {
  void usePrivacy(); // re-render when toggle flips so DrawerChrome's name updates

  const [agents, setAgents] = useState<LocalAgent[] | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentChoice>(null);
  const [range, setRange] = useState<Range>('year');
  const [focusKeys, setFocusKeys] = useState<FocusState>({
    qual: true, rhythm: true, persona: true,
  });

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stageIdx, setStageIdx] = useState(0);
  const [secs, setSecs] = useState(0);

  // Reset state on open
  useEffect(() => {
    if (open) {
      setPhase('idle');
      setError(null);
      setStageIdx(0);
      setSecs(0);
    }
  }, [open]);

  // Probe local AI agents — once per open
  useEffect(() => {
    if (!open) return;
    getAgents().then(setAgents).catch(() => setAgents([]));
  }, [open]);

  // Auto-pick first local AI when discovered; fall back to manual export
  useEffect(() => {
    if (agents && selectedAgent == null) {
      setSelectedAgent(agents.length > 0 ? agents[0].cli : 'manual');
    }
  }, [agents, selectedAgent]);

  // Tick the seconds counter while running
  useEffect(() => {
    if (phase !== 'running') return;
    const t = setInterval(() => setSecs(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Advance the stage indicator on a fixed cadence — when we wire to real
  // server-side stages later, replace this with a prop / hook subscription.
  useEffect(() => {
    if (phase !== 'running') return;
    const t = setInterval(() => {
      setStageIdx(i => Math.min(STAGES.length - 1, i + 1));
    }, 1600);
    return () => clearInterval(t);
  }, [phase]);

  // Esc closes the drawer unless we're mid-generation (don't lose work)
  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'running') onClose();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [open, phase, onClose]);

  async function handleGenerate() {
    setPhase('running');
    setError(null);
    try {
      const sample = range === 'all' ? 120 : range === 'year' ? 80 : 60;

      // Local-AI path: parent will route to RelationshipReportView, which
      // owns the actual streaming. Drawer just hands off the cli choice
      // after letting the user see all stages flash by once.
      if (selectedAgent && selectedAgent !== 'manual') {
        await new Promise(r => setTimeout(r, 1600 * STAGES.length + 400));
        onLocalAgent?.(selectedAgent);
        return;
      }

      // Manual / general AI path: generate the offline pack, parent surfaces
      // the ReportReadyBanner with copy/open-folder/send-online links.
      const pack = await generateAIPack(friend.id, { sample });
      onComplete?.(pack as GeneratedPack);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase('error');
    }
  }

  return (
    <DrawerShell open={open} onClose={phase === 'running' ? null : onClose}>
      <DrawerChrome friend={friend} onClose={phase === 'running' ? null : onClose} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 12px' }}>
        <SectionHeading idx="一" title="选谁来读这一段" />
        <AgentGrid
          agents={agents}
          value={selectedAgent}
          onChange={setSelectedAgent}
          disabled={phase === 'running'}
        />

        <SectionHeading idx="二" title="读多远的事" />
        <RangePills value={range} onChange={setRange} disabled={phase === 'running'} />

        <SectionHeading idx="三" title="想让它特别留意" hint="可多选" />
        <FocusChips
          focusKeys={focusKeys}
          onChange={setFocusKeys}
          disabled={phase === 'running'}
        />

        {(phase === 'running' || phase === 'error') && (
          <ProgressPanel
            phase={phase}
            stageIdx={stageIdx}
            secs={secs}
            error={error}
          />
        )}
      </div>

      <DrawerFooter
        phase={phase}
        canStart={selectedAgent != null}
        agentLabel={agentDisplayLabel(selectedAgent, agents)}
        onCancel={onClose}
        onGenerate={handleGenerate}
      />
    </DrawerShell>
  );
}

// ——————————————————————————————————————————————————————————————

function DrawerShell({
  open, onClose, children,
}: {
  open: boolean;
  onClose: (() => void) | null;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two RAFs so the browser actually commits translateX(100%) before
      // we transition to 0 — otherwise the slide animation never plays.
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    } else {
      setShown(false);
      const t = setTimeout(() => setMounted(false), 320);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!mounted) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      pointerEvents: shown ? 'auto' : 'none',
    }}>
      <div
        onClick={onClose ?? undefined}
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(20, 24, 42, 0.32)',
          opacity: shown ? 1 : 0,
          transition: 'opacity 280ms cubic-bezier(.4, 0, .2, 1)',
          cursor: onClose ? 'pointer' : 'default',
        }}
      />
      <aside
        className="et-paper-grain"
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0,
          width: 480, maxWidth: '92vw',
          background: 'var(--et-paper)',
          borderLeft: '0.5px solid var(--et-line-2)',
          boxShadow: '-18px 0 48px rgba(26,43,74,0.16), -1px 0 0 rgba(26,43,74,0.06)',
          transform: shown ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 320ms cubic-bezier(.32, .72, .24, 1)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {children}
      </aside>
    </div>
  );
}

function DrawerChrome({
  friend, onClose,
}: {
  friend: Friend;
  onClose: (() => void) | null;
}) {
  const name = displayName(friend.id, friend.name);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '18px 22px 16px',
      borderBottom: '0.5px solid var(--et-line)',
    }}>
      <Avatar friend={friend} size={36} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="et-eyebrow" style={{ fontSize: 9.5, color: 'var(--et-mute)' }}>
          AI 分析 · 给 <span style={{ color: 'var(--et-orange)' }}>{name}</span> 写一份关系档案
        </div>
        <div className="et-serif" style={{
          fontSize: 17, fontWeight: 500, color: 'var(--et-ink)',
          marginTop: 2, lineHeight: 1.2, whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {maskText(friend.bond)}
        </div>
      </div>
      {onClose && (
        <IconButton onClick={onClose} title="关闭 (Esc)">
          <IconX size={14} />
        </IconButton>
      )}
    </div>
  );
}

function SectionHeading({
  idx, title, hint,
}: {
  idx: string;
  title: string;
  hint?: string;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 10,
      marginTop: 22, marginBottom: 12,
    }}>
      <span className="et-serif" style={{
        fontSize: 13, color: 'var(--et-orange)', fontWeight: 500,
        fontVariantNumeric: 'tabular-nums', minWidth: 16,
      }}>{idx}</span>
      <span className="et-eyebrow" style={{ fontSize: 10.5, color: 'var(--et-ink)' }}>
        {title}
      </span>
      {hint && (
        <span className="et-meta" style={{ fontSize: 10, color: 'var(--et-faint)', marginLeft: 4 }}>
          · {hint}
        </span>
      )}
      <div style={{ flex: 1, height: 1, background: 'var(--et-line)', marginLeft: 6 }} />
    </div>
  );
}

function AgentGrid({
  agents, value, onChange, disabled,
}: {
  agents: LocalAgent[] | null;
  value: AgentChoice;
  onChange: (v: AgentChoice) => void;
  disabled: boolean;
}) {
  if (agents == null) {
    return (
      <div className="et-meta" style={{
        padding: '14px 16px', color: 'var(--et-mute)',
        background: 'var(--et-paper-2)', borderRadius: 12,
        border: '0.5px dashed var(--et-line-2)',
      }}>正在检测本机 AI…</div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      {agents.map(a => (
        <AgentCard
          key={a.cli}
          icon={a.cli}
          title={a.name}
          subtitle={`本机 · ${a.vendor}`}
          mono={a.version}
          local
          active={value === a.cli}
          disabled={disabled}
          onClick={() => onChange(a.cli)}
        />
      ))}
      <AgentCard
        icon="manual"
        title="导出文件 · 拷给在线 AI"
        subtitle="ChatGPT / 豆包 / Kimi 都行"
        mono="无 CLI"
        local={false}
        active={value === 'manual'}
        disabled={disabled}
        onClick={() => onChange('manual')}
        spanFull={agents.length % 2 === 0}
      />
    </div>
  );
}

function AgentCard({
  icon, title, subtitle, mono, local, active, disabled, onClick, spanFull,
}: {
  icon: string;
  title: string;
  subtitle: string;
  mono: string;
  local: boolean;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  spanFull?: boolean;
}) {
  const Ico = iconForCli(icon);
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        all: 'unset', cursor: disabled ? 'not-allowed' : 'pointer',
        padding: '14px 14px 12px', borderRadius: 12,
        background: active ? 'var(--et-paper)' : 'var(--et-paper-2)',
        border: `0.5px solid ${active ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
        boxShadow: active
          ? '0 0 0 3px rgba(255,107,71,0.12), 0 1px 0 rgba(26,43,74,0.04)'
          : '0 1px 0 rgba(26,43,74,0.03)',
        opacity: disabled ? 0.55 : 1,
        gridColumn: spanFull ? 'span 2' : 'auto',
        display: 'flex', flexDirection: 'column', gap: 8,
        transition: 'background 160ms, border-color 160ms, box-shadow 160ms',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 32, height: 32, borderRadius: 8,
          background: active ? 'var(--et-orange-soft)' : 'rgba(26,43,74,0.05)',
          color: active ? 'var(--et-orange)' : 'var(--et-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Ico size={17} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="et-serif" style={{
            fontSize: 14, fontWeight: 500, color: 'var(--et-ink)',
            lineHeight: 1.2, overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{title}</div>
          <div className="et-meta" style={{ fontSize: 11, color: 'var(--et-mute)', marginTop: 2 }}>
            {subtitle}
          </div>
        </div>
        {active && (
          <span style={{
            color: 'var(--et-orange)', display: 'flex', alignItems: 'center', flexShrink: 0,
          }}>
            <IconCheck size={14} />
          </span>
        )}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 6, borderTop: '0.5px dashed var(--et-line)',
        fontFamily: 'var(--et-mono)', fontSize: 10.5, color: 'var(--et-faint)',
      }}>
        <span>{mono}</span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          color: local ? 'var(--et-sage)' : 'var(--et-faint)',
        }}>
          {local && <IconShield size={11} />}
          {local ? '不联网调用' : '需要你拷过去'}
        </span>
      </div>
    </button>
  );
}

function agentDisplayLabel(value: AgentChoice, agents: LocalAgent[] | null): string {
  if (value === 'manual') return '生成分析包';
  const a = (agents ?? []).find(x => x.cli === value);
  return a ? `让 ${a.name} 开始分析` : '生成 AI 分析包';
}

function RangePills({
  value, onChange, disabled,
}: {
  value: Range;
  onChange: (v: Range) => void;
  disabled: boolean;
}) {
  const opts: { id: Range; label: string; sub: string; locked?: boolean }[] = [
    { id: 'year', label: '最近一年', sub: '推荐 · 平衡' },
    { id: 'all',  label: '全部记录', sub: '完整 · 包大' },
    { id: 'cust', label: '自定义',   sub: '即将支持', locked: true },
  ];
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {opts.map(o => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            onClick={(disabled || o.locked) ? undefined : () => onChange(o.id)}
            disabled={disabled || o.locked}
            style={{
              all: 'unset', cursor: (disabled || o.locked) ? 'not-allowed' : 'pointer',
              flex: 1, textAlign: 'center',
              padding: '10px 12px', borderRadius: 10,
              background: active ? 'var(--et-ink)' : 'transparent',
              color: active ? 'var(--et-paper)' : 'var(--et-ink)',
              border: `0.5px solid ${active ? 'var(--et-ink)' : 'var(--et-line-2)'}`,
              opacity: o.locked ? 0.4 : (disabled ? 0.55 : 1),
              transition: 'background 160ms, color 160ms',
            }}
          >
            <div className="et-serif" style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.1 }}>
              {o.label}
            </div>
            <div style={{
              fontSize: 10, marginTop: 4, letterSpacing: '0.04em',
              color: active ? 'rgba(251, 246, 238, 0.6)' : 'var(--et-mute)',
            }}>
              {o.sub}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function FocusChips({
  focusKeys, onChange, disabled,
}: {
  focusKeys: FocusState;
  onChange: (next: FocusState) => void;
  disabled: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {FOCUSES.map(f => {
        const on = !!focusKeys[f.k];
        return (
          <button
            key={f.k}
            onClick={disabled ? undefined : () => onChange({ ...focusKeys, [f.k]: !on })}
            disabled={disabled}
            title={f.hint}
            style={{
              all: 'unset', cursor: disabled ? 'not-allowed' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 999,
              fontSize: 12, fontWeight: 500,
              background: on ? 'var(--et-orange-soft)' : 'transparent',
              color: on ? 'var(--et-orange-2)' : 'var(--et-ink-soft)',
              border: `0.5px solid ${on ? 'rgba(224,83,46,0.32)' : 'var(--et-line-2)'}`,
              transition: 'background 140ms, border-color 140ms, color 140ms',
            }}
          >
            {on && (
              <span style={{ display: 'inline-flex', color: 'var(--et-orange)' }}>
                <IconCheck size={11} />
              </span>
            )}
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function ProgressPanel({
  phase, stageIdx, secs, error,
}: {
  phase: Phase;
  stageIdx: number;
  secs: number;
  error: string | null;
}) {
  const cur = STAGES[Math.min(stageIdx, STAGES.length - 1)];

  return (
    <div style={{
      marginTop: 28, padding: '18px 18px 16px',
      background: 'var(--et-paper-2)',
      border: '0.5px solid var(--et-line-2)',
      borderRadius: 'var(--et-r)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: phase === 'error' ? 'var(--et-rose)' : 'var(--et-orange)',
          animation: phase === 'running' ? 'et-pulse 1.4s ease-in-out infinite' : 'none',
          flexShrink: 0,
        }} />
        <span className="et-eyebrow" style={{ fontSize: 10, color: 'var(--et-ink)' }}>
          {phase === 'error' ? '失败' : '正在生成'}
        </span>
        <span style={{
          marginLeft: 'auto', fontSize: 12, color: 'var(--et-mute)',
          fontFamily: 'var(--et-mono)',
        }}>
          {String(Math.floor(secs / 60)).padStart(2, '0')}:{String(secs % 60).padStart(2, '0')}
        </span>
      </div>

      {phase === 'running' && (
        <StageText key={cur.key} primary={cur.label} hint={cur.hint} />
      )}
      {phase === 'error' && (
        <div className="et-serif" style={{
          fontSize: 13.5, color: 'var(--et-rose)', lineHeight: 1.6, padding: '8px 0',
        }}>
          {maskText(error || '未知错误')}
        </div>
      )}

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
        {STAGES.map((s, i) => {
          const done = i < stageIdx;
          const active = i === stageIdx && phase === 'running';
          return (
            <span key={s.key} style={{ display: 'contents' }}>
              <span style={{
                width: 16, height: 16, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: done ? 'var(--et-orange)' : (active ? 'var(--et-paper)' : 'transparent'),
                border: `1px solid ${done || active ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
                color: done ? '#fff' : 'var(--et-orange)',
                flexShrink: 0,
                boxShadow: active ? '0 0 0 4px rgba(255,107,71,0.16)' : 'none',
              }}>
                {done && <IconCheck size={10} />}
                {active && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--et-orange)' }} />}
              </span>
              {i < STAGES.length - 1 && (
                <span style={{
                  flex: 1, height: 1,
                  background: i < stageIdx ? 'var(--et-orange)' : 'var(--et-line-2)',
                }} />
              )}
            </span>
          );
        })}
      </div>

      {phase === 'running' && (
        <div style={{
          marginTop: 16, height: 3, borderRadius: 999,
          background: 'rgba(26,43,74,0.06)', overflow: 'hidden',
          position: 'relative',
        }}>
          <div className="ai-shimmer" style={{
            position: 'absolute', top: 0, bottom: 0, width: '40%',
            background: 'linear-gradient(90deg, transparent, var(--et-orange) 50%, transparent)',
            opacity: 0.6,
          }} />
        </div>
      )}
    </div>
  );
}

function StageText({ primary, hint }: { primary: string; hint: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.style.opacity = '0';
    ref.current.style.transform = 'translateY(4px)';
    requestAnimationFrame(() => {
      if (!ref.current) return;
      ref.current.style.transition = 'opacity 420ms ease, transform 420ms ease';
      ref.current.style.opacity = '1';
      ref.current.style.transform = 'translateY(0)';
    });
  }, [primary]);
  return (
    <div ref={ref} style={{ minHeight: 48 }}>
      <div className="et-serif" style={{
        fontSize: 16, fontWeight: 500, color: 'var(--et-ink)', lineHeight: 1.35,
      }}>
        {primary}
        <span style={{
          display: 'inline-block', width: 6, height: 14,
          background: 'var(--et-orange)', marginLeft: 4,
          verticalAlign: '-2px', animation: 'et-blink 1s steps(1) infinite',
        }} />
      </div>
      <div className="et-meta" style={{ fontSize: 11.5, color: 'var(--et-mute)', marginTop: 4 }}>
        {hint}
      </div>
    </div>
  );
}

function DrawerFooter({
  phase, canStart, agentLabel, onCancel, onGenerate,
}: {
  phase: Phase;
  canStart: boolean;
  agentLabel: string;
  onCancel: () => void;
  onGenerate: () => void;
}) {
  const running = phase === 'running';
  return (
    <div style={{
      borderTop: '0.5px solid var(--et-line)',
      padding: '14px 22px 18px',
      background: 'var(--et-paper)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onCancel} disabled={running} style={{
          all: 'unset', cursor: running ? 'not-allowed' : 'pointer',
          padding: '11px 18px', borderRadius: 10,
          fontSize: 13, fontWeight: 500, color: 'var(--et-mute)',
          opacity: running ? 0.4 : 1,
        }}>
          {running ? '取消' : '关闭'}
        </button>
        <button
          onClick={onGenerate}
          disabled={!canStart || running}
          style={{
            all: 'unset', cursor: (!canStart || running) ? 'not-allowed' : 'pointer',
            flex: 1, textAlign: 'center',
            padding: '13px 18px', borderRadius: 10,
            background: 'var(--et-ink)', color: 'var(--et-paper)',
            fontSize: 13.5, fontWeight: 600, letterSpacing: '0.02em',
            opacity: (!canStart || running) ? 0.55 : 1,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            transition: 'background 160ms, opacity 160ms',
          }}>
          {running ? '正在生成…' : (
            <>
              {agentLabel}
              <IconArrowRight size={14} />
            </>
          )}
        </button>
      </div>
      <div className="et-meta" style={{
        fontSize: 10.5, color: 'var(--et-faint)', textAlign: 'center',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      }}>
        <IconShield size={11} />
        分析样本只在你电脑里。本机 AI 不上网；通用 AI 由你自己拷过去。
      </div>
    </div>
  );
}

function IconButton({
  children, onClick, title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button onClick={onClick} title={title} style={{
      all: 'unset', cursor: 'pointer',
      width: 28, height: 28, borderRadius: 8,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--et-mute)',
    }}
    onMouseEnter={e => {
      e.currentTarget.style.background = 'rgba(26,43,74,0.05)';
      e.currentTarget.style.color = 'var(--et-ink)';
    }}
    onMouseLeave={e => {
      e.currentTarget.style.background = 'transparent';
      e.currentTarget.style.color = 'var(--et-mute)';
    }}
    >{children}</button>
  );
}

export function ReportReadyBanner({
  pack, friend, onOpenLocation, onCopy, onSendOnline, onDismiss,
}: ReportReadyBannerProps) {
  void usePrivacy();
  const [copied, setCopied] = useState(false);
  const sizeKB = (pack.size / 1024).toFixed(1);
  const privacy = isPrivacyMode();
  const displayPack = privacy ? `${displayName(friend.id, friend.name)}_AI分析包.md` : pack.name;
  return (
    <div style={{
      margin: '14px 28px 0',
      padding: '14px 22px 14px 24px',
      background: 'var(--et-paper)',
      border: '0.5px solid rgba(224, 83, 46, 0.32)',
      borderLeft: '3px solid var(--et-orange)',
      borderRadius: 'var(--et-r)',
      boxShadow: 'var(--et-shadow-1)',
      display: 'flex', alignItems: 'center', gap: 18,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        background: 'var(--et-orange-soft)', color: 'var(--et-orange)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <IconCheck size={14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="et-serif" style={{ fontSize: 14, color: 'var(--et-ink)', lineHeight: 1.4 }}>
          给 <b style={{ fontWeight: 600 }}>{displayName(friend.id, friend.name)}</b> 的关系档案已就绪
          <span className="et-meta" style={{
            marginLeft: 10, fontSize: 11, color: 'var(--et-mute)', fontFamily: 'var(--et-mono)',
          }}>
            {sizeKB} KB · {displayPack}
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <TextLink onClick={() => { void openFolder(pack.path); onOpenLocation(); }} icon={<IconFolder size={12} />}>打开文件位置</TextLink>
        <span style={{ width: 1, height: 12, background: 'var(--et-line-2)' }} />
        <TextLink
          onClick={() => { onCopy(); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
          icon={<IconCopy size={12} />}
        >
          {copied ? '已复制' : '复制全文'}
        </TextLink>
        <span style={{ width: 1, height: 12, background: 'var(--et-line-2)' }} />
        <TextLink onClick={onSendOnline} icon={<IconArrowRight size={12} />}>让 AI 直接分析</TextLink>
      </div>
      {onDismiss && (
        <IconButton onClick={onDismiss} title="收起这条提示">
          <IconX size={12} />
        </IconButton>
      )}
    </div>
  );
}

function TextLink({
  children, onClick, icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        all: 'unset', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '4px 10px', borderRadius: 6,
        fontSize: 12, fontWeight: 500,
        color: hover ? 'var(--et-orange-2)' : 'var(--et-ink)',
        textDecoration: 'underline',
        textDecorationColor: hover ? 'var(--et-orange)' : 'var(--et-line-2)',
        textUnderlineOffset: 3,
      }}>
      {icon}{children}
    </button>
  );
}
