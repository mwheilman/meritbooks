/**
 * The job's one activity stream (UX seat §3d): every event in pm.activity, sorted into the
 * sources the filter chips name. Pure.
 */
import type { ActivityRow } from '@/lib/pm/types';

export const ACTIVITY_KINDS = ['people', 'field', 'portal', 'ai', 'books', 'system'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABEL: Readonly<Record<ActivityKind, string>> = {
  people: 'People',
  field: 'Field',
  portal: 'Portal',
  ai: 'AI',
  books: 'Books',
  system: 'System',
};

const FIELD = /^(work_order|time|field_log|daily_log|punch|production|rental|unit|photo|checklist|visit|dispatch)\./;
const BOOKS = /^(progress\.snapshot|seam\.|books\.|billing\.(submitted|posted|invoiced|paid|rejected|voided)|cost\.|job_cost\.)/;

export function activityKind(a: Pick<ActivityRow, 'actor_type' | 'verb' | 'meta'>): ActivityKind {
  if (a.actor_type === 'AI') return 'ai';
  const channel = typeof a.meta?.channel === 'string' ? a.meta.channel : null;
  if (channel === 'portal' || a.verb.startsWith('portal.')) return 'portal';
  if (BOOKS.test(a.verb) || channel === 'books') return 'books';
  if (FIELD.test(a.verb) || channel === 'field') return 'field';
  if (a.actor_type === 'SYSTEM') return 'system';
  return 'people';
}

/** Counts per kind, for the chips (kinds with nothing are still listed so the filter is stable). */
export function kindCounts(rows: ReadonlyArray<Pick<ActivityRow, 'actor_type' | 'verb' | 'meta'>>): Record<ActivityKind, number> {
  const out = Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 0])) as Record<ActivityKind, number>;
  for (const r of rows) out[activityKind(r)] += 1;
  return out;
}
