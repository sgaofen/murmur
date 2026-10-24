import type { ReactNode } from 'react';
import { cx } from './cx';
import { IconClose } from './icons';

export type ChipTone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

export interface ChipProps {
  children: ReactNode;
  tone?: ChipTone;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  /** Filter-chip "on" state (ink fill). Only meaningful with onClick. */
  selected?: boolean;
  /** Makes the whole chip a toggle button. Don't combine with onRemove. */
  onClick?: () => void;
  /** Adds a small × button (static chips only). */
  onRemove?: () => void;
  removeLabel?: string;
  title?: string;
  className?: string;
}

export function Chip({
  children, tone = 'neutral', size = 'md', icon, selected, onClick, onRemove, removeLabel = '移除', title, className,
}: ChipProps) {
  const cls = cx('ui-chip', `ui-chip--${tone}`, `ui-chip--${size}`, selected && 'is-selected', onClick && 'ui-chip--button', className);
  const inner = (
    <>
      {icon && <span className="ui-chip__icon">{icon}</span>}
      <span className="ui-chip__label">{children}</span>
    </>
  );
  if (onClick) {
    return <button type="button" className={cls} aria-pressed={selected} onClick={onClick} title={title}>{inner}</button>;
  }
  return (
    <span className={cls} title={title}>
      {inner}
      {onRemove && (
        <button type="button" className="ui-chip__remove" onClick={onRemove} aria-label={removeLabel} title={removeLabel}>
          <IconClose size={12} />
        </button>
      )}
    </span>
  );
}
