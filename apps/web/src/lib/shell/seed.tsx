'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { ShellClientContext } from '@/lib/shell/actions';

/**
 * SERVER-KNOWN SHELL VALUES — read once in the (app) layout and handed to the client
 * so the shell's first paint already names the user and shows the active client's
 * period pip, instead of flashing "Signed in" and a hollow marker until /api/me and
 * the chip's server action answer (slice 1F, item 3).
 *
 * The shell (components/layout/books-shell.tsx) should prefer these values while its
 * own client reads are in flight:
 *   - rail footer name: `useMe().user` → else `useShellSeed().userName`
 *   - chip period:      `useClientContext(id)` → else `seed.clientContext` when
 *                       `seed.clientContext?.id === id`
 * Never authoritative for access decisions — display only.
 */
export interface ShellSeed {
  /** "Mike Heilman" (or the email) from Clerk on the server; null when unknown. */
  userName: string | null;
  /** The active client's chip context (period status, own books), when one is active. */
  clientContext: ShellClientContext | null;
}

const EMPTY: ShellSeed = { userName: null, clientContext: null };
const ShellSeedContext = createContext<ShellSeed>(EMPTY);

export function ShellSeedProvider({ seed, children }: { seed?: ShellSeed | null; children: ReactNode }) {
  return <ShellSeedContext.Provider value={seed ?? EMPTY}>{children}</ShellSeedContext.Provider>;
}

export function useShellSeed(): ShellSeed {
  return useContext(ShellSeedContext);
}
