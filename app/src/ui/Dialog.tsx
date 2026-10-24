import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';
import { IconClose } from './icons';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Sticky bottom bar, usually buttons. */
  footer?: ReactNode;
  /** sm 440 · md 560 · lg 720 px wide. */
  size?: 'sm' | 'md' | 'lg';
  /** Esc / scrim click / × close it. Turn off while a step must finish. */
  dismissible?: boolean;
  /** Scrim click closes it (default true). Turn off for long flows where a
   * stray click outside would throw away progress; Esc and × still work. */
  closeOnScrim?: boolean;
  /** Coral bar on the left edge (onboarding look). */
  accent?: boolean;
  closeLabel?: string;
  className?: string;
}

// Open dialogs, innermost last — only the top one reacts to Esc / Tab.
const openStack: number[] = [];
let nextId = 0;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open, onClose, title, eyebrow, description, children, footer,
  size = 'md', dismissible = true, closeOnScrim = true, accent = false, closeLabel = '关闭', className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pressStartedOnScrim = useRef(false);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const id = ++nextId;
    openStack.push(id);
    const restoreFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel;
    first?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        if (!dismissibleRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && panel) {
        const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null);
        if (items.length === 0) { e.preventDefault(); return; }
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === firstEl || active === panel)) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && active === lastEl) { e.preventDefault(); firstEl.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = openStack.indexOf(id);
      if (at >= 0) openStack.splice(at, 1);
      if (openStack.length === 0) document.body.style.overflow = prevOverflow;
      restoreFocus?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="ui-dialog-scrim"
      onMouseDown={(e) => { pressStartedOnScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (dismissible && closeOnScrim && pressStartedOnScrim.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx('ui-dialog', `ui-dialog--${size}`, accent && 'ui-dialog--accent', className)}
      >
        {(title || eyebrow || description || dismissible) && (
          <div className="ui-dialog__header">
            <div className="ui-dialog__heading">
              {eyebrow && <div className="ui-eyebrow ui-eyebrow--accent">{eyebrow}</div>}
              {title && <h2 id={titleId} className="ui-dialog__title">{title}</h2>}
              {description && <p id={descId} className="ui-dialog__desc">{description}</p>}
            </div>
            {dismissible && (
              <button type="button" className="ui-icon-btn ui-dialog__close" onClick={onClose}
                aria-label={closeLabel} title={closeLabel}>
                <IconClose size={16} />
              </button>
            )}
          </div>
        )}
        <div className="ui-dialog__body">{children}</div>
        {footer && <div className="ui-dialog__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
