/* PageHeader — a page's title + page-specific actions in the shell's status
 * strip: `CH 03 / 档案 · subtitle ········ actions`.
 *
 * Render it anywhere in the page tree; it portals into the strip that
 * <AppShell> owns, so pages don't draw their own chrome and the strip looks
 * the same everywhere. While a page has no <PageHeader> mounted (its
 * loading / error states) the shell shows the route's default title instead.
 * Outside the shell (the dev-only routes) it renders in place.
 */
import { useContext } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ShellContext } from './context';

export interface PageHeaderBack {
  label: string;
  onClick: () => void;
}

export interface PageHeaderProps {
  title: ReactNode;
  /** Muted text after the title; truncated first when space runs out. */
  subtitle?: ReactNode;
  /** Back key before the chapter code (sub-pages such as 朋友 / 年代记). */
  back?: PageHeaderBack;
  /** Right-aligned, page-specific controls. Children go here too. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function HeaderBar({ title, subtitle, back, actions, children }: PageHeaderProps) {
  const shell = useContext(ShellContext);
  const hasActions = actions != null || children != null;
  return (
    <div className="app-header">
      {back && (
        <button type="button" className="app-header__back" onClick={back.onClick} title={`返回${back.label}`}>
          <span aria-hidden="true">‹</span>{back.label}
        </button>
      )}
      <div className="app-header__titles">
        {shell?.chapter && <span className="app-header__ch" aria-hidden="true">{shell.chapter}<i>/</i></span>}
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
    return <div className="app-strip app-strip--inline"><HeaderBar {...props} /></div>;
  }
  if (!shell.headerSlot) return null;
  return createPortal(<HeaderBar {...props} />, shell.headerSlot);
}
