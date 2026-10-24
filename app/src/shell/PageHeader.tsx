/* PageHeader — a page's title + page-specific actions in the app's single
 * top bar.
 *
 * Render it anywhere in the page tree; it portals into the top bar that
 * <AppShell> owns, so pages no longer draw their own chrome bars and the bar
 * looks the same everywhere. While a page has no <PageHeader> mounted (its
 * loading / error states) the shell shows the route's default title instead.
 * Outside the shell (e.g. the dev-only routes) it renders in place.
 */
import { useContext } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui';
import { IconChevronLeft } from '../ui/icons';
import { ShellContext } from './context';

export interface PageHeaderBack {
  label: string;
  onClick: () => void;
}

export interface PageHeaderProps {
  title: ReactNode;
  /** Muted text after the title; truncated first when space runs out. */
  subtitle?: ReactNode;
  /** Back button before the title (sub-pages such as 朋友 / 年代记). */
  back?: PageHeaderBack;
  /** Right-aligned, page-specific controls. Children go here too. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function HeaderBar({ title, subtitle, back, actions, children }: PageHeaderProps) {
  const hasActions = actions != null || children != null;
  return (
    <div className="app-header">
      {back && (
        <>
          <Button variant="ghost" size="sm" className="app-header__back"
            icon={<IconChevronLeft size={16} />} onClick={back.onClick}>
            {back.label}
          </Button>
          <span className="app-header__divider" aria-hidden="true" />
        </>
      )}
      <div className="app-header__titles">
        <h1 className="app-header__title">{title}</h1>
        {subtitle && <span className="app-header__subtitle">{subtitle}</span>}
      </div>
      {hasActions && <div className="app-header__actions">{actions}{children}</div>}
    </div>
  );
}

export function PageHeader(props: PageHeaderProps) {
  const shell = useContext(ShellContext);
  if (!shell) {
    return <div className="app-topbar app-topbar--inline"><HeaderBar {...props} /></div>;
  }
  if (!shell.headerSlot) return null;
  return createPortal(<HeaderBar {...props} />, shell.headerSlot);
}
