'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { ContextLineItem, Crumb } from '@meritbooks/merit-ui';

/**
 * What a page can tell the merit-ui shell: the 32px context line (date // period //
 * the one fact that matters) and, for record pages, the breadcrumbs. Pages that say
 * nothing get the shell defaults.
 */
interface ShellSlots {
  setLine: (items: ReadonlyArray<ContextLineItem> | null) => void;
  setCrumbs: (crumbs: ReadonlyArray<Crumb> | null) => void;
  /** Open the ⌘J context switcher (e.g. "Choose a client" buttons). */
  openSwitcher: () => void;
}

const noop = () => {};
const ShellSlotsContext = createContext<ShellSlots>({ setLine: noop, setCrumbs: noop, openSwitcher: noop });

export function ShellSlotsProvider({ value, children }: { value: ShellSlots; children: ReactNode }) {
  return <ShellSlotsContext.Provider value={value}>{children}</ShellSlotsContext.Provider>;
}

export function useShellSlots(): ShellSlots {
  return useContext(ShellSlotsContext);
}

/**
 * Replace the shell's context line while this component is mounted. Pass a stable
 * key (e.g. a joined string) so it only re-sets when the content changes.
 */
export function useShellLine(items: ReadonlyArray<ContextLineItem> | null, key: string): void {
  const { setLine } = useShellSlots();
  useEffect(() => {
    setLine(items);
    return () => setLine(null);
    // `key` stands in for the (unstable) items array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setLine]);
}

/** Client island for server pages: <ShellLine items={…} /> sets the context line. */
export function ShellLine({ items }: { items: ReadonlyArray<ContextLineItem> }) {
  const key = JSON.stringify(items.map((i) => (typeof i === 'object' && i !== null && 'label' in i ? [String(i.label), !!i.strong] : String(i))));
  useShellLine(items, key);
  return null;
}
