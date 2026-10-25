// Shared pieces of the WeChat onboarding and the 「读取密钥」 dialog, drawn
// in the instrument style (direction B): the segmented step bar, the busy
// readout, labelled sections, numbered operations, annotations, the
// self-check rows and the two error views. Every error goes through
// data/errorCatalog.ts (#38): a full-step failure renders as UI-1 ErrorState
// (原因 / 怎么办 / 复制诊断信息), an inline one as a compact catalog entry.
import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import './onboarding.css';
import { ApiError, errorCode, getDiagBundle } from '../data/api';
import { ERROR_LEVEL_LABEL, lookupError } from '../data/errorCatalog';
import { maskText } from '../utils/privacy';
import { Button, ErrorState, Skeleton, Stepper, cx } from '../ui';
import type { StepItem } from '../ui';
import { STEP_LABEL } from './flow';
import type { CheckAction, CheckRow, CheckStatus, StepKey } from './flow';

/** Code + readable text from anything a request can throw. ApiError keeps the
 * backend's own `error` text in `raw` (its message is the `API /x: 400 {…}` form). */
export function describeError(e: unknown): { code: string | null; raw: string } {
  const code = errorCode(e);
  if (e instanceof ApiError) return { code, raw: e.raw || e.message };
  if (e instanceof Error) return { code, raw: e.message };
  return { code, raw: String(e ?? '') };
}

/** Last `n` lines of a subprocess log — what used to be shown as the reason. */
export function logTail(log: string | null | undefined, n = 12): string {
  return (log || '').split('\n').slice(-n).join('\n').trim();
}

/** 00:00 — seconds as a mono readout (minutes may exceed 59). */
export function clock(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Seconds since this component mounted (display only). */
export function useElapsed(): number {
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(t0);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return Math.floor((now - t0) / 1000);
}

/** A path that wraps after its separators instead of mid-name. */
export function PathText({ path }: { path: string }) {
  const parts = path.split(/([/\\])/);
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}{(p === '/' || p === '\\') && <wbr />}</Fragment>
      ))}
    </>
  );
}

/** Wall clock for a status strip (re-renders only itself). */
export function StripClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="ob-clock">
      <span className="ob-clock__d">{`${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`}</span>
      <span>{`${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`}</span>
    </span>
  );
}

export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('ob-lead', className)}>{children}</p>;
}

/** A labelled block: 「PREP 开始前请先做完这几步 ········ right」 over a rule. */
export function Sec({ label, title, right, children, className }: {
  label: string; title?: ReactNode; right?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <section className={cx('ob-sec', className)}>
      <div className="ob-sec__h">
        <span className="ob-sec__label">{label}</span>
        {title && <b>{title}</b>}
        {right != null && <span className="ob-sec__r">{right}</span>}
      </div>
      {children}
    </section>
  );
}

/** Numbered operations: 「01  在微信里退出登录 …」 rows with a rule between. */
export function Ops({ items, grid, className }: {
  items: Array<ReactNode | { t: ReactNode; d?: ReactNode; state?: 'ok' | 'cur' }>;
  /** Lay short items out side by side (2–3 per row) instead of a list. */
  grid?: boolean;
  className?: string;
}) {
  return (
    // 2 or 4 cells read better as pairs than as a 3-column row with a hole.
    <ol className={cx('ob-ops', grid && 'ob-ops--grid', grid && (items.length === 2 || items.length === 4) && 'ob-ops--pairs', className)}>
      {items.map((it, i) => {
        const obj = it && typeof it === 'object' && 't' in (it as object)
          ? it as { t: ReactNode; d?: ReactNode; state?: 'ok' | 'cur' } : null;
        return (
          <li key={i} className={cx('ob-op', obj?.state && `is-${obj.state}`)}>
            <span className="ob-op__n" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
              {obj?.state === 'ok' && <i>✓</i>}
              {obj?.state === 'cur' && <i className="ob-op__dot" />}
            </span>
            <div className="ob-op__body">
              {obj ? (
                <>
                  <div className="ob-op__t">{obj.t}</div>
                  {obj.d && <div className="ob-op__d">{obj.d}</div>}
                </>
              ) : <div className="ob-op__t ob-op__t--plain">{it as ReactNode}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export type NoteTone = 'info' | 'success' | 'warning' | 'danger' | 'accent';

/** An annotation: a mono label in the tone colour (「RISK 风控提示」) over a
 * short text, with a 2px tone rule on the left. Replaces stacked callouts. */
export function Note({ tone = 'info', label, title, children, actions, className }: {
  tone?: NoteTone; label?: string; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string;
}) {
  return (
    <div className={cx('ob-note', `ui-tone--${tone}`, className)} role={tone === 'danger' ? 'alert' : 'note'}>
      {(label || title) && (
        <div className="ob-note__h">
          {label && <span className="ob-note__label">{label}</span>}
          {title && <span className="ob-note__title">{title}</span>}
        </div>
      )}
      {children && <div className="ob-note__body">{children}</div>}
      {actions && <div className="ob-note__actions">{actions}</div>}
    </div>
  );
}

/** Segmented meter: `n` cells, the first `on` lit (signal), optional peak cell. */
export function Segs({ n, on, className, label }: { n: number; on: number; className?: string; label?: string }) {
  const lit = Math.max(0, Math.min(n, Math.round(on)));
  return (
    <div className={cx('ob-segs', className)} role={label ? 'img' : undefined} aria-label={label}
      aria-hidden={label ? undefined : true}>
      {Array.from({ length: n }, (_, i) => <i key={i} className={i < lit ? 'on' : undefined} />)}
    </div>
  );
}

/** Indeterminate segmented bar for jobs that report no progress. */
export function March({ className }: { className?: string }) {
  return (
    <div className={cx('ob-march', className)} aria-hidden="true">
      {Array.from({ length: 36 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 50}ms` }} />)}
    </div>
  );
}

/** Busy screen: RUN indicator, what is running, elapsed readout, marching bar. */
export function Working({ title, sub, label = 'RUN' }: { title: ReactNode; sub?: ReactNode; label?: string }) {
  const elapsed = useElapsed();
  return (
    <div className="ob-working" role="status" aria-live="polite">
      <div className="ob-working__read">
        <div className="ui-big ob-working__big">{clock(elapsed)}</div>
        <div className="ob-working__meta">
          <div className="ui-label"><i className="ui-led is-pulse" />{label}<b>进行中</b></div>
          <div className="ui-label">ELAPSED<b>已用时</b></div>
        </div>
      </div>
      <March />
      <div className="ob-working__title">{typeof title === 'string' ? maskText(title) : title}</div>
      {sub && <div className="ob-working__sub">{sub}</div>}
    </div>
  );
}

// ———————————————————————— capture readouts ————————————————————————

/** 「已有 n / t 个数据库的密钥」 as a readout: one cell per database. */
export function Coverage({ matched, total, children }: { matched: number; total: number; children?: ReactNode }) {
  return (
    <div className="ob-cov">
      <div className="ob-cov__read">
        <span className="ui-label">DB<b>数据库密钥</b></span>
        <span className="ob-cov__v">{String(matched).padStart(2, '0')}<small> / {String(total).padStart(2, '0')}</small></span>
      </div>
      <Segs n={total} on={matched} className="ob-segs--db" label={`${matched} / ${total}`} />
      {children && <div className="ob-cov__text">{children}</div>}
    </div>
  );
}

/** The live readout of a running capture round (shared with the 免 Frida flow):
 * countdown, 45-segment round meter, matched databases, newly caught ones. */
export function CaptureRun({ head, remaining, seconds, matched, total, newDbs, hits, passphrase, todo, onStop }: {
  head: string;
  /** Seconds left in the round; null = not counting yet (password, copy, attach). */
  remaining: number | null;
  seconds: number;
  matched: number;
  total: number;
  newDbs: string[];
  hits?: number | null;
  passphrase?: string | null;
  todo?: ReactNode;
  onStop: () => void;
}) {
  const span = Math.max(1, seconds || 0);
  const elapsed = remaining == null ? 0 : Math.max(0, span - remaining);
  return (
    <div className="ob-run" role="status" aria-live="polite">
      <div className="ob-run__status">
        <span className="ui-label"><i className="ui-led is-pulse" />STATUS</span>
        <span className="ob-run__head">{head}</span>
      </div>
      {remaining != null ? (
        <>
          <div className="ob-run__read">
            <div className="ui-big ob-run__big">{clock(remaining)}</div>
            <div className="ob-run__meta">
              <div className="ui-label">REMAIN<b>剩余</b></div>
              <div className="ui-label">ELAPSED<b className="ui-num">{clock(elapsed)}</b></div>
            </div>
          </div>
          <Segs n={45} on={(45 * elapsed) / span} className="ob-segs--round" />
          <div className="ob-scale"><span>0 S</span><span>{Math.round(span / 2)} S</span><span>{span} S</span></div>
        </>
      ) : <March className="ui-mt-3" />}

      <div className="ob-run__ro">
        <div>
          <div className="ui-label">MATCHED<b>已匹配</b></div>
          <div className="ob-run__v">{matched}<small> / {total} 个数据库</small></div>
        </div>
        <div>
          <div className="ui-label">NEW<b>这轮新增</b></div>
          <div className="ob-run__v">{newDbs.length}<small> 个</small></div>
        </div>
        {hits != null && (
          <div>
            <div className="ui-label">HITS<b>已截获加解密调用</b></div>
            <div className="ob-run__v">{hits}<small> 次</small></div>
          </div>
        )}
      </div>
      <Segs n={total} on={matched} className="ob-segs--db" label={`已匹配 ${matched} / ${total} 个数据库`} />

      {passphrase && <Note tone="success" label="PASS" className="ui-mt-3">{passphrase}</Note>}
      {newDbs.length > 0 && (
        <ul className="ob-dbs">
          {newDbs.slice(-6).map(n => <li key={n}><span aria-hidden="true">+</span>{n}</li>)}
        </ul>
      )}
      {todo}
      <div className="ob-actions ob-actions--row">
        <Button variant="secondary" size="lg" onClick={onStop}>提前结束这一轮</Button>
      </div>
    </div>
  );
}

// ———————————————————————— step bar ————————————————————————

export interface StepRailProps {
  steps: StepKey[];
  /** null = nothing started yet (welcome screen: every step upcoming). */
  current: StepKey | null;
  /** Steps already finished — they stay checked (and clickable) after jumping back. */
  done: ReadonlySet<StepKey>;
  error?: boolean;
  /** Redo a finished / current step. Omit while something is running. */
  onStepClick?: (step: StepKey) => void;
  /** Short per-step note under the label. */
  notes?: Partial<Record<StepKey, string>>;
}

/** The segmented step bar across the top of the onboarding. */
export function StepRail({ steps, current, done, error, onStepClick, notes }: StepRailProps) {
  const items: StepItem[] = steps.map(k => ({
    key: k,
    label: STEP_LABEL[k],
    description: notes?.[k],
    status: k === current ? (error ? 'error' : 'current') : done.has(k) ? 'done' : 'upcoming',
  }));
  const click = onStepClick ? (key: string) => onStepClick(key as StepKey) : undefined;
  const at = current ? steps.indexOf(current) : -1;
  return (
    <nav className={cx('ob-steps', !onStepClick && current && 'is-locked')} aria-label="初始化步骤">
      <Stepper steps={items} current={at} onStepClick={click} />
    </nav>
  );
}

// ———————————————————————— self-check rows ————————————————————————

const STATUS_TAG: Record<CheckStatus, string> = {
  ok: 'PASS', warn: 'WARN', bad: 'FAIL', info: 'INFO', off: '—',
};
const STATUS_TEXT: Record<CheckStatus, string> = {
  ok: '正常', warn: '需要留意', bad: '需要处理', info: '提示', off: '可选',
};

export function StatusTag({ status }: { status: CheckStatus }) {
  return (
    <span className={`ob-tag ob-tag--${status}`} role="img" aria-label={STATUS_TEXT[status]}>
      {STATUS_TAG[status]}
    </span>
  );
}

/** PASS 5 · WARN 1 · FAIL 0 — the readout in a module header. */
export function checkTally(rows: CheckRow[]): string {
  const n = (s: CheckStatus) => rows.filter(r => r.status === s).length;
  return `PASS ${n('ok')} · WARN ${n('warn')} · FAIL ${n('bad')}`;
}

export function CheckList({ rows, onAction, busy }: {
  rows: CheckRow[];
  onAction?: (kind: CheckAction) => void;
  /** Action currently running (its button shows a spinner). */
  busy?: CheckAction | null;
}) {
  return (
    <ul className="ob-checks">
      {rows.map(r => (
        <li key={r.id} className={`ob-check ob-check--${r.status}`}>
          <StatusTag status={r.status} />
          <div className="ob-check__main">
            <div className="ob-check__top">
              <span className="ob-check__label">{r.label}</span>
              <span className="ob-check__value">{r.value}</span>
            </div>
            {r.hint && <div className="ob-check__hint">{r.hint}</div>}
          </div>
          {r.action && onAction && (
            <div className="ob-check__action">
              <Button size="sm" variant={r.status === 'bad' ? 'primary' : 'secondary'}
                loading={busy === r.action.kind} disabled={!!busy && busy !== r.action.kind}
                onClick={() => onAction(r.action!.kind)}>
                {r.action.label}
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Compact readout of the same rows (side panel): label · value · tag. */
export function CheckReadout({ rows }: { rows: CheckRow[] }) {
  return (
    <ul className="ob-ck">
      {rows.map(r => (
        <li key={r.id} className={`ob-ck__row ob-ck__row--${r.status}`}>
          <span className="ob-ck__k">{r.label}</span>
          <span className="ob-ck__v">{r.value}</span>
          <StatusTag status={r.status} />
        </li>
      ))}
    </ul>
  );
}

export function CheckListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="ob-checks ob-checks--skeleton" aria-busy="true" aria-label="正在检测">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ob-checks-skeleton__row">
          <Skeleton width={38} height={16} />
          <Skeleton width={84} height={12} />
          <Skeleton width={`${24 + ((i * 17) % 30)}%`} height={12} />
        </div>
      ))}
    </div>
  );
}

// ———————————————————————— errors ————————————————————————

async function diagnosticsText(code: string | null, raw: string): Promise<string> {
  try {
    return (await getDiagBundle()).markdown;
  } catch {
    // Backend unreachable: at least hand over what we have (ErrorState redacts it).
    return [`错误码: ${code || '（无）'}`, raw].filter(Boolean).join('\n\n');
  }
}

/** A step that failed: catalog title / 原因 / 怎么办 + retry + 复制诊断信息.
 * Unknown codes fall back to the raw text as the reason. */
export function StepError({ code, raw, log, onRetry, retryLabel = '重试这一步', actions, title }: {
  code: string | null | undefined;
  raw?: string | null;
  log?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  actions?: ReactNode;
  /** Overrides the catalog title (e.g. the 「又回到了引导」 banner). */
  title?: string;
}) {
  const entry = lookupError(code);
  const fallback = lookupError('INTERNAL_ERROR');
  const rawText = (raw || '').trim();
  const logText = (log || '').trim();
  // Generic entries (DECRYPT_FAILED, INTERNAL_ERROR…) say 「见下方原始报错」:
  // show the raw text right there. Specific ones keep it under 技术细节.
  const rawInline = !!rawText && (!entry || entry.reason.includes('原始报错'));
  const rawInDetails = !!rawText && !rawInline;
  return (
    <div className="ob-error">
      <ErrorState
        tone={!entry || entry.level === 'blocking' ? 'danger' : 'warning'}
        code={code || undefined}
        title={title ?? entry?.title ?? '出了点问题'}
        reason={entry ? (
          <>
            {entry.reason}
            {rawInline && <pre className="ob-error-pre">{maskText(rawText)}</pre>}
          </>
        ) : rawText ? <span className="ob-prewrap">{maskText(rawText)}</span> : undefined}
        fixes={[entry?.fix ?? fallback?.fix].filter(Boolean)}
        onRetry={onRetry}
        retryLabel={retryLabel}
        diagnostics={() => diagnosticsText(code ?? null, [rawText, logText].filter(Boolean).join('\n\n'))}
        actions={actions}
        details={(rawInDetails || logText) ? (
          <>
            {rawInDetails && <><div>原始报错</div><pre>{maskText(rawText)}</pre></>}
            {logText && <><div>日志</div><pre>{maskText(logText)}</pre></>}
          </>
        ) : undefined}
      />
    </div>
  );
}

/** A smaller error inside a step (a form, a capture round): catalog
 * explanation when the code is known, otherwise the raw text. */
export function InlineError({ code, raw, className }: { code?: string | null; raw?: string | null; className?: string }) {
  const entry = lookupError(code);
  const text = (raw || '').trim();
  if (entry && code) {
    const tone: NoteTone = entry.level === 'blocking' ? 'danger'
      : entry.level === 'retry' ? 'warning' : entry.level === 'action' ? 'accent' : 'info';
    return (
      <div className={cx('ob-inline-err', `ui-tone--${tone}`, className)} data-error-code={code}>
        <div className="ob-inline-err__h">
          <span className="ob-inline-err__lvl">{ERROR_LEVEL_LABEL[entry.level]}</span>
          <span className="ob-inline-err__title">{entry.title}</span>
          <code className="ob-inline-err__code">{code}</code>
        </div>
        <div className="ob-inline-err__row"><span>CAUSE<b>原因</b></span><p>{entry.reason}</p></div>
        <div className="ob-inline-err__row"><span>FIX<b>怎么办</b></span><p>{entry.fix}</p></div>
        {text && <div className="ob-field-msg">原始报错：{maskText(text)}</div>}
      </div>
    );
  }
  if (!text) return null;
  return <Note tone="danger" label="ERR" className={className}>{maskText(text)}</Note>;
}
