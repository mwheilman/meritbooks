'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_VOCAB } from '@/lib/packs';
import type { Crumb } from '@meritbooks/merit-ui';
import type { Vocabulary } from '@/lib/pm/vocab';
import type { MoneyLevel, PersonaGroup, PersonaKey } from '@/lib/access/types';
import { ALL_MONEY, NO_MONEY, moneyVisFromGrants, type MoneyVis } from '@/components/money/visibility';

export interface ShellCompany {
  id: string;
  name: string;
  shortCode: string | null;
  installed: boolean;
}

/** The serialisable slice of Access the browser needs (Sets don't cross the RSC boundary). */
export interface ShellAccess {
  persona: PersonaKey;
  group: PersonaGroup;
  /** Industry title ("Technician") or the persona name. */
  title: string;
  preview: PersonaKey | null;
  moneyLevel: MoneyLevel;
  /** Grants for the company in view (the union in a workspace view). */
  grants: ReadonlyArray<string>;
}

export interface ShellValue {
  vocab: Vocabulary;
  companies: ReadonlyArray<ShellCompany>;
  activeCompanyId: string | null;
  readOnly: boolean;
  /** Always set by AppFrame. */
  access?: ShellAccess | null;
  /** Always set by AppFrame. A provider that omits it (render tests) draws every figure. */
  money?: MoneyVis;
  setCrumbs: (c: ReadonlyArray<Crumb> | null) => void;
}

const Ctx = createContext<ShellValue>({
  vocab: { ...DEFAULT_VOCAB },
  companies: [],
  activeCompanyId: null,
  readOnly: false,
  access: null,
  money: NO_MONEY,
  setCrumbs: () => {},
});

export function ShellProvider({ value, children }: { value: ShellValue; children: ReactNode }) {
  const v = value.money ? value : { ...value, money: ALL_MONEY };
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useShell(): ShellValue {
  return useContext(Ctx);
}

export function useVocab(): Vocabulary {
  return useContext(Ctx).vocab;
}

/** Which money this screen may draw (fails closed outside the shell). */
export function useMoneyVis(): MoneyVis {
  return useContext(Ctx).money ?? NO_MONEY;
}

/** True when the caller holds 'projects.x:action' for the company in view. */
export function useCan(grant: string): boolean {
  const a = useContext(Ctx).access;
  // undefined: a provider without access (render tests) · null: outside the shell → no
  if (a === undefined) return true;
  return !!a && a.grants.includes(grant);
}

/**
 * Narrow money to one company's grants (a job page in a workspace view): children see what the
 * caller holds at THAT company, never the union.
 */
export function MoneyScope({ grants, children }: { grants: ReadonlyArray<string>; children: ReactNode }) {
  const outer = useContext(Ctx);
  const level = outer.access?.moneyLevel ?? 1;
  const key = grants.join(',');
  const value = useMemo(
    () => ({ ...outer, money: moneyVisFromGrants(grants, level), access: outer.access ? { ...outer.access, grants } : outer.access }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outer, key, level],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
