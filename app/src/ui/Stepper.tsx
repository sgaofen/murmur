import type { ReactNode } from 'react';
import { cx } from './cx';

export type StepStatus = 'done' | 'current' | 'upcoming' | 'error';

export interface StepItem {
  key: string;
  label: ReactNode;
  description?: ReactNode;
  /** Override the status derived from `current` (e.g. a skipped step = 'upcoming'). */
  status?: StepStatus;
}

export interface StepperProps {
  steps: StepItem[];
  /** Current step, by index or key. Earlier steps count as done. */
  current: number | string;
  /** The current step failed. */
  error?: boolean;
  orientation?: 'horizontal' | 'vertical';
  /** Makes done / current / failed steps clickable (redo a step). */
  onStepClick?: (key: string, index: number) => void;
  className?: string;
}

export function stepStatus(index: number, currentIndex: number, error = false): StepStatus {
  if (index < currentIndex) return 'done';
  if (index === currentIndex) return error ? 'error' : 'current';
  return 'upcoming';
}

const STATE_LABEL: Record<StepStatus, string> = {
  done: 'DONE',
  current: 'RUN',
  error: 'FAIL',
  upcoming: '—',
};

export function Stepper({ steps, current, error, orientation = 'horizontal', onStepClick, className }: StepperProps) {
  const currentIndex = typeof current === 'number' ? current : Math.max(0, steps.findIndex(s => s.key === current));
  return (
    <ol className={cx('ui-stepper', `ui-stepper--${orientation}`, className)}>
      {steps.map((step, i) => {
        const status = step.status ?? stepStatus(i, currentIndex, error);
        const clickable = !!onStepClick && status !== 'upcoming';
        // Instrument cell: "01 ········ RUN" over the label, a 3px rail below.
        const marker = (
          <span className="ui-step__top" aria-hidden="true">
            <span className="ui-step__marker">{String(i + 1).padStart(2, '0')}</span>
            <span className="ui-step__state">
              {status === 'current' && <i className="ui-led" />}
              {STATE_LABEL[status]}
            </span>
          </span>
        );
        const text = (
          <span className="ui-step__text">
            <span className="ui-step__label">{step.label}</span>
            {step.description && <span className="ui-step__desc">{step.description}</span>}
          </span>
        );
        return (
          <li key={step.key} className={cx('ui-step', `is-${status}`)}
            aria-current={status === 'current' || status === 'error' ? 'step' : undefined}>
            {clickable ? (
              <button type="button" className="ui-step__hit" onClick={() => onStepClick?.(step.key, i)}>
                {marker}{text}
              </button>
            ) : (
              <span className="ui-step__hit">{marker}{text}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
