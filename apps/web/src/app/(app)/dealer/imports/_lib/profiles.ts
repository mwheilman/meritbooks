'use client';

/**
 * Saved column mappings ("mapping profiles", FPB §8) — per client + source system +
 * import kind, so next month's export from the same system maps itself.
 *
 * Stored in the browser (localStorage) for now: there is no server-side
 * `dealer_import_mapping_profiles` table yet (DDL reported to the lead). A profile from
 * ANOTHER client on the same source system is offered as a starting point (FPB: profiles
 * are "reusable across clients on the same system").
 */

import type { ImportFileKind } from '@/lib/dealer/types';
import type { ColumnMapping } from '@/lib/dealer/imports/mapping';

const STORAGE_KEY = 'meritbooks.dealer.import-profiles.v1';

export interface MappingProfile {
  locationId: string;
  sourceSystem: string;
  kind: ImportFileKind;
  mapping: ColumnMapping;
  headers: string[];
  savedAt: string;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function readAll(): MappingProfile[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as MappingProfile[]).filter((p) => p && typeof p === 'object' && typeof p.kind === 'string') : [];
  } catch {
    return [];
  }
}

function writeAll(list: MappingProfile[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-200)));
    return true;
  } catch {
    return false;
  }
}

/** This client's profile, else the newest one for the same system + kind from another client. */
export function findProfile(locationId: string, sourceSystem: string, kind: ImportFileKind): { profile: MappingProfile; sameClient: boolean } | null {
  const all = readAll().filter((p) => p.kind === kind && norm(p.sourceSystem) === norm(sourceSystem));
  const own = all.filter((p) => p.locationId === locationId).sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
  if (own) return { profile: own, sameClient: true };
  const other = all.sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
  return other ? { profile: other, sameClient: false } : null;
}

export function saveProfile(p: Omit<MappingProfile, 'savedAt'>): boolean {
  const rest = readAll().filter((x) => !(x.locationId === p.locationId && x.kind === p.kind && norm(x.sourceSystem) === norm(p.sourceSystem)));
  return writeAll([...rest, { ...p, savedAt: new Date().toISOString() }]);
}

export function forgetProfile(locationId: string, sourceSystem: string, kind: ImportFileKind): void {
  writeAll(readAll().filter((x) => !(x.locationId === locationId && x.kind === kind && norm(x.sourceSystem) === norm(sourceSystem))));
}
