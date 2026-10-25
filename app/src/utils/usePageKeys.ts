// Single-letter shortcuts for one page (the keycaps drawn on its buttons,
// e.g. 「R 打开报告」). Same guards as the shell's 1–8 keys: nothing fires
// while typing in a field, with a modifier held, or while a modal (dialog,
// palette, reader, lock screen) owns the keyboard.
import { useEffect, useRef } from 'react';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color'].includes(type);
  }
  return false;
}

/** `keys` maps a lower-case key ('r', '/') to its action; a missing or
 * undefined entry is ignored, so callers can switch keys off per state. */
export function usePageKeys(keys: Record<string, (() => void) | undefined | false>, enabled = true): void {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const fn = ref.current[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
