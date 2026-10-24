import { createContext } from 'react';

export interface ShellContextValue {
  /** The top bar's slot element; null until the shell has mounted. */
  headerSlot: HTMLElement | null;
}

/** Provided by <AppShell>. Pages reach the shell's top bar through
 * <PageHeader>, which portals into `headerSlot`. */
export const ShellContext = createContext<ShellContextValue | null>(null);
