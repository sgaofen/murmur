import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from './cx';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Tooltip + accessible name (needed when the label is hidden). */
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the whole group. */
  label: string;
  size?: 'sm' | 'md';
  /** Show icons only (labels stay as accessible names). */
  iconOnly?: boolean;
  className?: string;
}

/** One-of-N picker (radio group). Arrow keys move the selection. */
export function SegmentedControl<T extends string>({
  options, value, onChange, label, size = 'md', iconOnly, className,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = options.findIndex(o => o.value === value);
    const next = (at + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown}
      className={cx('ui-segmented', `ui-segmented--${size}`, iconOnly && 'ui-segmented--icon-only', className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={el => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.title ?? (typeof o.label === 'string' ? o.label : undefined)}
            aria-label={iconOnly ? (o.title ?? (typeof o.label === 'string' ? o.label : undefined)) : undefined}
            className={cx('ui-segmented__item', on && 'is-on')}
            onClick={() => onChange(o.value)}
          >
            {o.icon}
            {!iconOnly && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
