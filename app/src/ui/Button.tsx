import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width. */
  block?: boolean;
  /** Fully rounded ends instead of the size's corner radius. */
  pill?: boolean;
  className?: string;
}

/** Class string for a button look — use it on <a> or other elements that
 * should look like a Button: `<a className={buttonClass({ variant: 'ghost' })}>`. */
export function buttonClass({ variant = 'secondary', size = 'md', block, pill, className }: ButtonStyleOptions = {}): string {
  return cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, block && 'ui-btn--block', pill && 'ui-btn--pill', className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleOptions {
  /** Shows a spinner and blocks clicks. */
  loading?: boolean;
  /** Icon before the label (any 16px node, e.g. from utils/icons). */
  icon?: ReactNode;
  /** Icon after the label. */
  iconAfter?: ReactNode;
}

export function Button({
  variant = 'secondary', size = 'md', block, pill, loading = false,
  icon, iconAfter, className, children, disabled, type = 'button', ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, block, pill, className: cx(loading && 'ui-btn--loading', className) })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : icon}
      {children != null && <span className="ui-btn__label">{children}</span>}
      {!loading && iconAfter}
    </button>
  );
}
