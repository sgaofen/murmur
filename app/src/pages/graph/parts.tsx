/* 关系网右栏 / 左栏共用的小部件：节点小样、读数格、小节抬头、AI 运行过程。样式在 ../Graph.css。 */
import type { ReactNode } from 'react';
import type { Tier } from '../../components/graph3d/engine';
import type { LocalAgent } from '../../data/api';
import { AGENT_CLI_LIST, agentDisplayName } from '../../utils/agents';
import { maskText } from '../../utils/privacy';
import { Button, cx } from '../../ui';

export type GlyphKind = 'a' | 'b' | 'c' | 'x' | 'd' | 'e';

export function glyphKind(tier: Tier): GlyphKind {
  return tier === 'A' ? 'a' : tier === 'B' ? 'b' : tier === 'C' ? 'c' : tier === 'D' ? 'd' : 'e';
}

/** The same box the canvas draws for a person, as an inline sample. */
export function Glyph({ code, kind, core, sel, size, title }: {
  code: string; kind: GlyphKind; core?: boolean; sel?: boolean; size?: 'sm' | 'md'; title?: string;
}) {
  return (
    <span className={cx('gx-ng', `is-${kind}`, core && 'is-core', sel && 'is-sel', size === 'md' && 'is-md')} title={title} aria-hidden={title ? undefined : true}>
      {code}
    </span>
  );
}

/** Numbered sub-module head inside a column: 「12 AI 摘要 ······ LOCAL MODEL」. */
export function SubHead({ id, title, right, first }: { id: string; title: ReactNode; right?: ReactNode; first?: boolean }) {
  return (
    <div className={cx('ui-mod__head gx-subhead', first && 'is-first')}>
      <span className="ui-mod__id">{id}</span>
      <span className="ui-mod__title">{title}</span>
      {right != null && <span className="ui-mod__right">{right}</span>}
    </div>
  );
}

export function Readout({ en, zh, children, sub }: { en: string; zh: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="gx-ro__cell">
      <div className="ui-label">{en}<b>{zh}</b></div>
      <div className="gx-ro__v">{children}</div>
      {sub != null && <div className="gx-ro__s">{sub}</div>}
    </div>
  );
}

export interface StreamState { output: string; stage: string; elapsed: number }

/** A local agent at work: stage, elapsed seconds and the tail of what it has written so far. */
export function StreamBox({ stream }: { stream: StreamState | null }) {
  const tail = stream?.output?.trim().slice(-1600);
  return (
    <div className="gx-stream" aria-live="polite">
      <div className="gx-stream__head">
        <span className="ui-led is-pulse" />
        <span>{stream?.stage || '排队中'}</span>
        <span className="gx-stream__t">{stream?.elapsed || 0}s</span>
      </div>
      {tail && <pre className="gx-stream__out">{maskText(tail)}<i className="gx-stream__cur" /></pre>}
    </div>
  );
}

/** One button per detected local agent CLI, or the install hint when there is none. */
export function AgentButtons({ agents, onRun, verb }: { agents: LocalAgent[] | null; onRun: (cli: string) => void; verb: string }) {
  if (agents == null) return null;
  if (!agents.length) {
    return <p className="gx-note gx-note--faint">没检测到本机 AI CLI（{AGENT_CLI_LIST}），装上其中一个就能在这里直接分析。</p>;
  }
  return (
    <div className="gx-agents">
      {agents.map(a => (
        <Button key={a.cli} size="sm" variant={agents[0] === a ? 'primary' : 'secondary'} onClick={() => onRun(a.cli)}>
          让 {a.name || agentDisplayName(a.cli)} {verb}
        </Button>
      ))}
    </div>
  );
}

export function Meter({ parts }: { parts: { pct: number; tone: 'ink' | 'dim' | 'sig' }[] }) {
  return (
    <div className="gx-meter" aria-hidden="true">
      {parts.map((p, i) => <i key={i} className={`is-${p.tone}`} style={{ flexBasis: `${Math.max(0, p.pct)}%` }} />)}
    </div>
  );
}
