// AIAssistantDrawer — the AI analysis entry point on the profile page (G / A).
//
// A side panel in the instrument style: 01 who reads (a local agent CLI, or
// "export a pack for an online AI"), 02 how far back, 03 what to look for.
// Picking a local agent hands straight over to RelationshipReportView, which
// shows the agent's real stream; the manual path generates the pack here and
// the parent shows ReportReadyBanner. No staged "progress" is simulated: the
// only progress shown is elapsed time while the pack request is in flight.
//
// Styles: ./AIAssistantDrawer.css (prefix aid-).

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { iconForCli } from '../utils/icons';
import {
  generateAIPack, getAgents, openFolder,
  type LocalAgent,
} from '../data/api';
import type { Friend } from '../data/types';
import { displayName, isPrivacyMode, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { Button, cx } from '../ui';
import { IconClose, IconCopy, IconFolder } from '../ui/icons';
import './AIAssistantDrawer.css';

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

const FOCUSES: { k: FocusKey; label: string; hint: string }[] = [
  { k: 'qual',    label: '关系定性', hint: '我们到底是什么关系' },
  { k: 'rhythm',  label: '互动节奏', hint: '谁更主动 / 回应速度' },
  { k: 'persona', label: '人物画像', hint: '对方大概是怎样一个人' },
  { k: 'emotion', label: '情感曲线', hint: '热度有没有变化' },
  { k: 'topics',  label: '话题演变', hint: '我们最近在聊什么' },
  { k: 'advice',  label: '具体建议', hint: '下一步可以做什么' },
];

const RANGES: { id: Range; label: string; sub: string; locked?: boolean }[] = [
  { id: 'year', label: '最近一年', sub: '推荐 · 平衡' },
  { id: 'all',  label: '全部记录', sub: '完整 · 包大' },
  { id: 'cust', label: '自定义',   sub: '即将支持', locked: true },
];

export function AIAssistantDrawer({
  open, onClose, friend, onLocalAgent, onComplete,
}: AIAssistantDrawerProps) {
  void usePrivacy(); // re-render when the toggle flips so the name updates

  const [agents, setAgents] = useState<LocalAgent[] | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentChoice>(null);
  const [range, setRange] = useState<Range>('year');
  const [focusKeys, setFocusKeys] = useState<FocusState>({
    qual: true, rhythm: true, persona: true,
  });

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);

  // Reset state on open
  useEffect(() => {
    if (open) {
      setPhase('idle');
      setError(null);
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
    // Local-AI path: the parent routes to RelationshipReportView, which owns
    // the actual streaming and shows its real output.
    if (selectedAgent && selectedAgent !== 'manual') {
      onLocalAgent?.(selectedAgent);
      return;
    }
    setPhase('running');
    setError(null);
    setSecs(0);
    try {
      const sample = range === 'all' ? 120 : range === 'year' ? 80 : 60;
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

  const running = phase === 'running';
  const name = displayName(friend.id, friend.name);
  return (
    <DrawerShell open={open} onClose={running ? null : onClose} label={`给 ${name} 写一份关系档案`}>
      <header className="aid__bar">
        <span className="aid__id">AI</span>
        <span className="aid__title">AI 分析</span>
        <span className="aid__en">RELATIONSHIP REPORT</span>
        {!running && (
          <button type="button" className="ui-icon-btn aid__x" onClick={onClose} title="关闭 (Esc)" aria-label="关闭">
            <IconClose size={14} />
          </button>
        )}
      </header>

      <div className="aid__body">
        <div className="aid__intro">
          <div className="ui-label">SUBJECT<b>{name}</b></div>
          <h2 className="aid__h">给 {name} 写一份关系档案</h2>
          {friend.bond && <p className="aid__bond">{maskText(friend.bond)}</p>}
        </div>

        <Section no="01" title="选谁来读" hint="本机 AI 不联网；在线 AI 由你自己拷过去">
          <AgentList agents={agents} value={selectedAgent} onChange={setSelectedAgent} disabled={running} />
        </Section>

        <Section no="02" title="读多远的事">
          <div className="aid__ranges" role="radiogroup" aria-label="读多远的事">
            {RANGES.map(o => {
              const on = range === o.id;
              return (
                <button
                  key={o.id} type="button" role="radio" aria-checked={on}
                  className={cx('aid__range', on && 'is-on')}
                  disabled={running || o.locked}
                  onClick={() => setRange(o.id)}
                >
                  <span className="aid__range-l">{o.label}</span>
                  <span className="aid__range-s">{o.sub}</span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section no="03" title="想让它特别留意" hint="可多选">
          <div className="aid__focus">
            {FOCUSES.map(f => {
              const on = !!focusKeys[f.k];
              return (
                <button
                  key={f.k} type="button" role="checkbox" aria-checked={on}
                  className={cx('aid__chk', on && 'is-on')}
                  disabled={running}
                  onClick={() => setFocusKeys({ ...focusKeys, [f.k]: !on })}
                >
                  <span className="aid__box" aria-hidden="true" />
                  <span className="aid__chk-l">{f.label}</span>
                  <span className="aid__chk-s">{f.hint}</span>
                </button>
              );
            })}
          </div>
        </Section>

        {(running || phase === 'error') && (
          <div className={cx('aid__status', phase === 'error' && 'is-error')} role="status">
            <div className="aid__status-h">
              <span className={cx('ui-led', phase === 'error' ? 'ui-led--error' : 'is-pulse')} />
              <span>{phase === 'error' ? '没能生成分析包' : '正在生成分析包…'}</span>
              <span className="aid__secs">
                {String(Math.floor(secs / 60)).padStart(2, '0')}:{String(secs % 60).padStart(2, '0')}
              </span>
            </div>
            {phase === 'error'
              ? <p className="aid__err">{maskText(error || '未知错误')}</p>
              : <div className="aid__track" aria-hidden="true"><i /></div>}
          </div>
        )}
      </div>

      <footer className="aid__foot">
        <div className="aid__foot-row">
          <Button variant="ghost" onClick={onClose} disabled={running}>关闭</Button>
          <Button
            variant="primary" block
            onClick={handleGenerate}
            disabled={selectedAgent == null || running}
            loading={running}
          >
            {running ? '正在生成…' : agentDisplayLabel(selectedAgent, agents)}
          </Button>
        </div>
        <p className="aid__note">分析样本只在你电脑里。本机 AI 不上网；通用 AI 由你自己拷过去。</p>
      </footer>
    </DrawerShell>
  );
}

// ——————————————————————————————————————————————————————————————

function DrawerShell({
  open, onClose, label, children,
}: {
  open: boolean;
  onClose: (() => void) | null;
  label: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two RAFs so the browser commits the off-screen position before the
      // transition — otherwise the slide never plays.
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    } else {
      setShown(false);
      const t = setTimeout(() => setMounted(false), 260);
      return () => clearTimeout(t);
    }
  }, [open]);
  useEffect(() => {
    if (!shown) return;
    const before = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => { before?.focus?.({ preventScroll: true }); };
  }, [shown]);

  if (!mounted) return null;

  return (
    <div className={cx('aid', shown && 'is-shown')}>
      <div className="aid__scrim" onClick={onClose ?? undefined} />
      <aside
        ref={panelRef}
        className="aid__panel"
        role="dialog"
        aria-modal={open || undefined}
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </aside>
    </div>
  );
}

function Section({ no, title, hint, children }: { no: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="aid__sec">
      <div className="aid__sec-h">
        <span className="aid__sec-no">{no}</span>
        <span className="aid__sec-t">{title}</span>
        {hint && <span className="aid__sec-hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function AgentList({
  agents, value, onChange, disabled,
}: {
  agents: LocalAgent[] | null;
  value: AgentChoice;
  onChange: (v: AgentChoice) => void;
  disabled: boolean;
}) {
  if (agents == null) {
    return (
      <div className="aid__probe" aria-busy="true">
        <span className="ui-spinner" aria-hidden="true" />
        正在检测本机 AI…
      </div>
    );
  }
  return (
    <div className="aid__agents" role="radiogroup" aria-label="选谁来读">
      {agents.map(a => (
        <AgentRow
          key={a.cli}
          icon={a.cli}
          title={a.name}
          sub={`本机 · ${a.vendor}`}
          mono={a.version}
          tag="不联网调用"
          active={value === a.cli}
          disabled={disabled}
          onClick={() => onChange(a.cli)}
        />
      ))}
      <AgentRow
        icon="manual"
        title="导出文件 · 拷给在线 AI"
        sub="ChatGPT / 豆包 / Kimi 都行"
        mono="无 CLI"
        tag="需要你拷过去"
        active={value === 'manual'}
        disabled={disabled}
        onClick={() => onChange('manual')}
      />
      {agents.length === 0 && (
        <p className="aid__none">没在这台电脑上找到 Claude Code、Codex 这类本机 AI，可以先导出文件，交给你常用的在线 AI。</p>
      )}
    </div>
  );
}

function AgentRow({
  icon, title, sub, mono, tag, active, disabled, onClick,
}: {
  icon: string;
  title: string;
  sub: string;
  mono: string;
  tag: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const Ico = iconForCli(icon);
  return (
    <button
      type="button" role="radio" aria-checked={active}
      className={cx('aid__agent', active && 'is-on')}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="aid__radio" aria-hidden="true" />
      <span className="aid__agent-ico" aria-hidden="true"><Ico size={16} /></span>
      <span className="aid__agent-t">
        <span className="aid__agent-n">{title}</span>
        <span className="aid__agent-s">{sub}</span>
      </span>
      <span className="aid__agent-r">
        <span className="aid__agent-v">{mono}</span>
        <span className="aid__agent-tag">{tag}</span>
      </span>
    </button>
  );
}

function agentDisplayLabel(value: AgentChoice, agents: LocalAgent[] | null): string {
  if (value === 'manual') return '生成分析包';
  const a = (agents ?? []).find(x => x.cli === value);
  return a ? `让 ${a.name} 开始分析` : '生成 AI 分析包';
}

// ——————————————————————————————————————————————————————————————

export function ReportReadyBanner({
  pack, friend, onOpenLocation, onCopy, onSendOnline, onDismiss,
}: ReportReadyBannerProps) {
  void usePrivacy();
  const [copied, setCopied] = useState(false);
  const sizeKB = (pack.size / 1024).toFixed(1);
  const privacy = isPrivacyMode();
  const displayPack = privacy ? `${displayName(friend.id, friend.name)}_AI分析包.md` : pack.name;
  return (
    <div className="aid-ready" role="status">
      <span className="ui-led" aria-hidden="true" />
      <span className="aid-ready__k">PACK READY</span>
      <span className="aid-ready__t">
        给 <b>{displayName(friend.id, friend.name)}</b> 的 AI 分析包已生成
      </span>
      <span className="aid-ready__f">{sizeKB} KB · {displayPack}</span>
      <span className="aid-ready__acts">
        <Button size="sm" variant="ghost" icon={<IconFolder size={13} />}
          onClick={() => { void openFolder(pack.path); onOpenLocation(); }}>
          打开文件位置
        </Button>
        <Button size="sm" variant="ghost" icon={<IconCopy size={13} />}
          onClick={() => { onCopy(); setCopied(true); setTimeout(() => setCopied(false), 1800); }}>
          {copied ? '已复制' : '复制全文'}
        </Button>
        <Button size="sm" onClick={onSendOnline}>让 AI 直接分析</Button>
        {onDismiss && (
          <button type="button" className="ui-icon-btn" onClick={onDismiss} title="收起这条提示" aria-label="收起这条提示">
            <IconClose size={13} />
          </button>
        )}
      </span>
    </div>
  );
}
