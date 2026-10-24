import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** paper = default card, sunken = tinted well, outline = border only. */
  variant?: 'paper' | 'sunken' | 'outline';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Hover lift + pointer cursor (pair with onClick). */
  interactive?: boolean;
}

export function Card({ variant = 'paper', padding = 'md', interactive, className, ...rest }: CardProps) {
  return (
    <div
      className={cx('ui-card', `ui-card--${variant}`, `ui-card--pad-${padding}`, interactive && 'ui-card--interactive', className)}
      {...rest}
    />
  );
}

export interface CardHeaderProps {
  eyebrow?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned slot (buttons, chips). */
  actions?: ReactNode;
  className?: string;
}

export function CardHeader({ eyebrow, title, description, actions, className }: CardHeaderProps) {
  return (
    <div className={cx('ui-card__header', className)}>
      <div className="ui-card__heading">
        {eyebrow && <div className="ui-eyebrow">{eyebrow}</div>}
        {title && <div className="ui-card__title">{title}</div>}
        {description && <div className="ui-card__desc">{description}</div>}
      </div>
      {actions && <div className="ui-card__actions">{actions}</div>}
    </div>
  );
}
