import { createContext } from 'react';

export interface ShellContextValue {
  /** The status strip's header slot; null until the shell has mounted. */
  headerSlot: HTMLElement | null;
  /** Chapter code of the current page ("CH 01", "SYS"), shown before the title. */
  chapter: string | null;
}

/** Provided by <AppShell>. Pages reach the shell's status strip through
 * <PageHeader>, which portals into `headerSlot`. */
export const ShellContext = createContext<ShellContextValue | null>(null);
