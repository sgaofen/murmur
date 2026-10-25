import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface ModuleProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Two-digit module number shown first in the header ("01"). */
  id?: string;
  /** Chinese name ("联系人"). */
  title?: ReactNode;
  /** Mono caps subtitle after the title ("CONTACTS", "YEAR × MONTH"). */
  en?: ReactNode;
  /** Right-aligned header slot (readouts, chips, keys). */
  right?: ReactNode;
  /** The body scrolls on its own (tables, long lists). */
  scroll?: boolean;
  /** Corner crop marks: all four corners, or the bottom two only. */
  crop?: boolean | 'bottom';
  bodyClassName?: string;
  /** Rendered element; a <section> by default so headers are landmarks. */
  as?: 'section' | 'div' | 'aside';
  children?: ReactNode;
}

/** A numbered instrument module: "01 联系人 CONTACTS ······ right" header
 * over a flat panel. Put several inside `.ui-rack` (a 1px-gap grid) and the
 * gaps become the panel's rules. */
export function Module({
  id, title, en, right, scroll, crop, bodyClassName, as: Tag = 'section', className, children, ...rest
}: ModuleProps) {
  const hasHead = id != null || title != null || en != null || right != null;
  return (
    <Tag className={cx('ui-mod', scroll && 'ui-mod--scroll', className)} {...rest}>
      {hasHead && (
        <header className="ui-mod__head">
          {id != null && <span className="ui-mod__id">{id}</span>}
          {title != null && <span className="ui-mod__title">{title}</span>}
          {en != null && <span className="ui-mod__en">{en}</span>}
          {right != null && <span className="ui-mod__right">{right}</span>}
        </header>
      )}
      <div className={cx('ui-mod__body', bodyClassName)}>{children}</div>
      {crop && <span className={cx('ui-crop', crop === 'bottom' && 'ui-crop--bottom')} aria-hidden="true" />}
    </Tag>
  );
}
