'use client';
/**
 * Background import activity (PLT-67 "runs in the background with a progress pill"). Imports keep
 * running while the person moves on through setup; any screen can show the pill. A tiny external
 * store (useSyncExternalStore) so the shell can mount <ImportProgressPill/> too.
 */
import { useSyncExternalStore } from 'react';

export type ActivityPhase = 'reading' | 'staged' | 'committing' | 'done' | 'error';

export interface ImportActivity {
  id: string;
  label: string;
  phase: ActivityPhase;
  detail: string | null;
  startedAt: number;
}

let items: ImportActivity[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function trackImport(a: Omit<ImportActivity, 'startedAt'>): void {
  const existing = items.find((x) => x.id === a.id);
  items = existing ? items.map((x) => (x.id === a.id ? { ...x, ...a } : x)) : [...items, { ...a, startedAt: Date.now() }];
  emit();
}

export function clearFinished(): void {
  items = items.filter((x) => x.phase !== 'done' && x.phase !== 'error');
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const EMPTY: ImportActivity[] = [];
export function useImportActivity(): ImportActivity[] {
  return useSyncExternalStore(subscribe, () => items, () => EMPTY);
}
