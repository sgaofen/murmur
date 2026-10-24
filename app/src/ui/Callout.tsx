import type { ReactNode } from 'react';
import { cx } from './cx';
import { IconAlertCircle, IconCheckCircle, IconInfoCircle, IconSparkle, IconWarning } from './icons';

/** info / success / warning / danger are status; accent = brand highlight (a recommended path). */
export type Tone = 'info' | 'success' | 'warning' | 'danger' | 'accent';

const DEFAULT_ICON: Record<Tone, ReactNode> = {
  info: <IconInfoCircle size={18} />,
  success: <IconCheckCircle size={18} />,
  warning: <IconWarning size={18} />,
  danger: <IconAlertCircle size={18} />,
  accent: <IconSparkle size={18} />,
};

export interface CalloutProps {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  /** Replace the tone's icon; pass `null` to hide it. */
  icon?: ReactNode | null;
  /** Buttons under the text. */
  actions?: ReactNode;
  /** Tighter padding, smaller text — for inline hints. */
  compact?: boolean;
  className?: string;
}

export function Callout({ tone = 'info', title, children, icon, actions, compact, className }: CalloutProps) {
  const shownIcon = icon === undefined ? DEFAULT_ICON[tone] : icon;
  return (
    <div
      className={cx('ui-callout', `ui-tone--${tone}`, compact && 'ui-callout--compact', className)}
      role={tone === 'danger' ? 'alert' : 'note'}
    >
      {shownIcon && <div className="ui-callout__icon">{shownIcon}</div>}
      <div className="ui-callout__content">
        {title && <div className="ui-callout__title">{title}</div>}
        {children && <div className="ui-callout__body">{children}</div>}
        {actions && <div className="ui-callout__actions">{actions}</div>}
      </div>
    </div>
  );
}
