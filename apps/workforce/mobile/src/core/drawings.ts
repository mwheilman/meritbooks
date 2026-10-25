/**
 * The current drawing set on the phone, offline. The server lists the CURRENT revision of each
 * sheet on my jobs; the phone keeps one file per revision ("<revision id>.pdf" in its private
 * storage), downloads the new ones, and deletes superseded or no-longer-assigned revisions — so
 * what opens with no signal is never an old sheet. Pure planning (unit-tested); lib/files.ts
 * does the disk work.
 */
import type { PhoneSheet } from './contract';

export interface CachedSheet {
  revisionId: string;
  sheetId: string;
  jobId: string;
  number: string;
  title: string | null;
  discipline: string | null;
  revisionLabel: string | null;
  setName: string;
  issuedOn: string | null;
  bytes: number | null;
  savedAt: number;
}

/** Keep the cache under this (a phone is not a plan room). */
export const DRAWING_BUDGET_BYTES = 250 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The file name for a revision, or null for anything that is not a revision id (no path tricks). */
export function sheetFileName(revisionId: string): string | null {
  return UUID.test(revisionId) ? `${revisionId.toLowerCase()}.pdf` : null;
}

export interface CachePlan {
  download: PhoneSheet[];
  keep: CachedSheet[];
  remove: CachedSheet[];
  /** Sheets left out to stay under the budget. */
  skipped: PhoneSheet[];
}

/**
 * Diff the server's current list against what the phone holds. `priorityJobs` (today's jobs
 * first) decides what fits when the budget runs out.
 */
export function planCache(current: ReadonlyArray<PhoneSheet>, cached: ReadonlyArray<CachedSheet>, onDisk: (revisionId: string) => boolean, priorityJobs: ReadonlyArray<string> = [], budget = DRAWING_BUDGET_BYTES): CachePlan {
  const want = new Map(current.filter((s) => sheetFileName(s.revisionId)).map((s) => [s.revisionId, s]));
  const keep = cached.filter((c) => want.has(c.revisionId) && onDisk(c.revisionId));
  const kept = new Set(keep.map((k) => k.revisionId));
  const remove = cached.filter((c) => !kept.has(c.revisionId));
  let used = keep.reduce((n, k) => n + (k.bytes ?? 0), 0);
  const rank = (jobId: string) => {
    const i = priorityJobs.indexOf(jobId);
    return i < 0 ? priorityJobs.length : i;
  };
  const todo = [...want.values()].filter((s) => !kept.has(s.revisionId) && !!s.url).sort((a, b) => rank(a.jobId) - rank(b.jobId) || a.number.localeCompare(b.number));
  const download: PhoneSheet[] = [];
  const skipped: PhoneSheet[] = [];
  for (const s of todo) {
    const size = s.bytes ?? 2 * 1024 * 1024;
    if (used + size > budget) {
      skipped.push(s);
      continue;
    }
    used += size;
    download.push(s);
  }
  return { download, keep, remove, skipped };
}

export function toCached(s: PhoneSheet, now: number): CachedSheet {
  return {
    revisionId: s.revisionId, sheetId: s.sheetId, jobId: s.jobId, number: s.number, title: s.title, discipline: s.discipline,
    revisionLabel: s.revisionLabel, setName: s.setName, issuedOn: s.issuedOn, bytes: s.bytes, savedAt: now,
  };
}

/** Sheets of one job by discipline (A, S, M, E, P …), in sheet-number order. */
export function byDiscipline<T extends { discipline: string | null; number: string }>(sheets: ReadonlyArray<T>): Array<[string, T[]]> {
  const m = new Map<string, T[]>();
  for (const s of [...sheets].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }))) {
    const k = s.discipline || '—';
    m.set(k, [...(m.get(k) ?? []), s]);
  }
  return [...m.entries()];
}

export function isCachedSheets(v: unknown): v is CachedSheet[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'object' && x !== null && typeof (x as CachedSheet).revisionId === 'string' && typeof (x as CachedSheet).jobId === 'string');
}
