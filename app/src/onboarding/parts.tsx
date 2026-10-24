// Shared pieces of the WeChat onboarding and the 「读取密钥」 dialog: the step
// rail, the busy screen, the self-check rows and the two error views. Every
// error goes through data/errorCatalog.ts (#38): a full-step failure renders
// as UI-1 ErrorState (原因 / 怎么办 / 复制诊断信息), an inline one as ErrorExplain.
import type { ReactNode } from 'react';
import './onboarding.css';
import { ApiError, errorCode, getDiagBundle } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import { ErrorExplain } from '../components/ErrorExplain';
import { maskText } from '../utils/privacy';
import { Button, Callout, ErrorState, Skeleton, Stepper } from '../ui';
import type { StepItem } from '../ui';
import { IconCheck, IconClose } from '../ui/icons';
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

export function Lead({ children }: { children: ReactNode }) {
  return <p className="ob-lead">{children}</p>;
}

export function Working({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="ob-working" role="status" aria-live="polite">
      <span className="ob-ring" aria-hidden="true" />
      <div className="ob-working__title">{typeof title === 'string' ? maskText(title) : title}</div>
      {sub && <div className="ob-working__sub">{sub}</div>}
    </div>
  );
}

// ———————————————————————— step rail ————————————————————————

export interface StepRailProps {
  steps: StepKey[];
  /** null = nothing started yet (welcome screen: every step upcoming). */
  current: StepKey | null;
  /** Steps already finished — they stay checked (and clickable) after jumping back. */
  done: ReadonlySet<StepKey>;
  error?: boolean;
  /** Redo a finished / current step. Omit while something is running. */
  onStepClick?: (step: StepKey) => void;
  /** Short per-step note under the label (vertical rail only). */
  notes?: Partial<Record<StepKey, string>>;
}

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
    <>
      <nav className="ob-rail ob-rail--v" aria-label="初始化步骤">
        <Stepper steps={items} current={at} orientation="vertical" onStepClick={click} />
        <div className="ob-rail__hint">
          {current ? '点已完成的步骤可以单独重做，不用从头再来。' : '大约需要 2–5 分钟，全部在你的电脑上完成。'}
        </div>
      </nav>
      <nav className="ob-rail ob-rail--h" aria-label="初始化步骤">
        <Stepper steps={items.map(s => ({ ...s, description: undefined }))} current={at} onStepClick={click} />
      </nav>
    </>
  );
}

// ———————————————————————— self-check rows ————————————————————————

const STATUS_TONE: Record<CheckStatus, string | null> = {
  ok: 'success', warn: 'warning', bad: 'danger', info: 'info', off: null,
};
const STATUS_TEXT: Record<CheckStatus, string> = {
  ok: '正常', warn: '需要留意', bad: '需要处理', info: '提示', off: '可选',
};

function StatusMark({ status }: { status: CheckStatus }) {
  return (
    <span className="ob-check__mark" role="img" aria-label={STATUS_TEXT[status]}>
      {status === 'ok' ? <IconCheck size={13} />
        : status === 'bad' ? <IconClose size={12} />
          : status === 'warn' ? '!'
            : status === 'info' ? 'i'
              : '–'}
    </span>
  );
}

export function CheckList({ rows, onAction, busy }: {
  rows: CheckRow[];
  onAction?: (kind: CheckAction) => void;
  /** Action currently running (its button shows a spinner). */
  busy?: CheckAction | null;
}) {
  return (
    <ul className="ob-checks">
      {rows.map(r => {
        const tone = STATUS_TONE[r.status];
        return (
          <li key={r.id} className={`ob-check ob-check--${r.status}${tone ? ` ui-tone--${tone}` : ''}`}>
            <StatusMark status={r.status} />
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
        );
      })}
    </ul>
  );
}

export function CheckListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="ob-checks" aria-busy="true" aria-label="正在检测">
      <div className="ob-checks-skeleton">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="ob-checks-skeleton__row">
            <Skeleton width={22} height={22} circle />
            <Skeleton width={`${34 + ((i * 17) % 30)}%`} height={12} />
          </div>
        ))}
      </div>
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
  const showRaw = !!rawText && !!entry;
  return (
    <div className="ob-error">
      <ErrorState
        tone={!entry || entry.level === 'blocking' ? 'danger' : 'warning'}
        code={code || undefined}
        title={title ?? entry?.title ?? '出了点问题'}
        reason={entry ? entry.reason : rawText ? <span className="ob-prewrap">{maskText(rawText)}</span> : undefined}
        fixes={[entry?.fix ?? fallback?.fix].filter(Boolean)}
        onRetry={onRetry}
        retryLabel={retryLabel}
        diagnostics={() => diagnosticsText(code ?? null, [rawText, logText].filter(Boolean).join('\n\n'))}
        actions={actions}
        details={(showRaw || logText) ? (
          <>
            {showRaw && <><div>原始报错</div><pre>{maskText(rawText)}</pre></>}
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
  const known = !!lookupError(code);
  const text = (raw || '').trim();
  if (known) {
    return (
      <div className={className}>
        <ErrorExplain code={code} style={{ marginBottom: 0 }} />
        {text && <div className="ob-field-msg">原始报错：{maskText(text)}</div>}
      </div>
    );
  }
  if (!text) return null;
  return <Callout tone="danger" compact className={className}>{maskText(text)}</Callout>;
}
