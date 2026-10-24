import type { ReactNode } from 'react';
import { cx } from './cx';
import { IconInbox } from './icons';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Defaults to an inbox glyph; pass `null` for none. */
  icon?: ReactNode | null;
  /** Buttons under the text. */
  actions?: ReactNode;
  /** inline = sits in a list/card · page = centered in the viewport. */
  layout?: 'inline' | 'page';
  /** Mono caps label above the title, e.g. "NO DATA" or "SETUP · 00". */
  label?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, actions, layout = 'inline', label, className }: EmptyStateProps) {
  const shownIcon = icon === undefined ? <IconInbox size={26} /> : icon;
  return (
    <div className={cx('ui-empty', `ui-empty--${layout}`, className)}>
      {shownIcon && <div className="ui-medallion">{shownIcon}</div>}
      {label && <div className="ui-label ui-empty__label">{label}</div>}
      <div className="ui-empty__title">{title}</div>
      {description && <div className="ui-empty__desc">{description}</div>}
      {actions && <div className="ui-empty__actions">{actions}</div>}
    </div>
  );
}
