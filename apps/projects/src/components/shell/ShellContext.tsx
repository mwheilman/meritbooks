'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_VOCAB } from '@/lib/packs';
import type { Crumb } from '@meritbooks/merit-ui';
import type { Vocabulary } from '@/lib/pm/vocab';

export interface ShellCompany {
  id: string;
  name: string;
  shortCode: string | null;
  installed: boolean;
}

export interface ShellValue {
  vocab: Vocabulary;
  companies: ReadonlyArray<ShellCompany>;
  activeCompanyId: string | null;
  readOnly: boolean;
  setCrumbs: (c: ReadonlyArray<Crumb> | null) => void;
}

const Ctx = createContext<ShellValue>({
  vocab: { ...DEFAULT_VOCAB },
  companies: [],
  activeCompanyId: null,
  readOnly: false,
  setCrumbs: () => {},
});

export function ShellProvider({ value, children }: { value: ShellValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShell(): ShellValue {
  return useContext(Ctx);
}

export function useVocab(): Vocabulary {
  return useContext(Ctx).vocab;
}

/** A page names its own breadcrumbs (a job's number and name). Cleared on unmount. */
export function PageCrumbs({ items }: { items: ReadonlyArray<Crumb> }) {
  const { setCrumbs } = useShell();
  const key = JSON.stringify(items.map((i) => [String(i.label), i.href ?? '']));
  useEffect(() => {
    setCrumbs(items);
    return () => setCrumbs(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setCrumbs]);
  return null;
}

/** "Loaded 9:41 AM", set on the client so server and browser clocks never disagree. */
export function useLoadedAt(dep: unknown): string | null {
  const [t, setT] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date();
    const h = d.getHours();
    setT(`${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`);
  }, [dep]);
  return t;
}
