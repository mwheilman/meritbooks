/**
 * A8 (migration 194 slice): hard close is blocked by an unsettled Merit Projects backlog for that
 * client + period. Feeds the `projects_seam_settled` close task (lib/close/orchestration.ts).
 *
 * Applies ONLY to orgs with entitlements.projects = true (otherwise the task passes — Books stands
 * alone). For each company, counts Projects → Books events dated on/before the period end that are
 *   pending    — not yet processed by Books (any age), or
 *   rejected   — and not since superseded: a later PROCESSED event with the same business key
 *                (billing / deposit / time / internal invoice: payload.source_ref; commitment:
 *                payload.commitment_id; progress: payload.job_id).
 * An event with no location_id in its payload counts against every company (conservative).
 * A read error fails CLOSED (status UNKNOWN blocks), like the other close loaders.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { hasModule } from '@/lib/services/entitlements';
import { CONSUMED_PROJECTS_EVENT_TYPES, PLANNED_PROJECTS_EVENT_TYPES } from '@/lib/events/seam';

type DB = SupabaseClient;

export interface SeamCloseSignal {
  applicable: boolean;
  status: 'OK' | 'BLOCKED' | 'UNKNOWN';
  pending: number;
  rejected: number;
  oldestPendingOn: string | null;
  byType: Record<string, number>;
}

export const SEAM_SIGNAL_NOT_APPLICABLE: SeamCloseSignal = { applicable: false, status: 'OK', pending: 0, rejected: 0, oldestPendingOn: null, byType: {} };
export const SEAM_SIGNAL_UNKNOWN: SeamCloseSignal = { applicable: true, status: 'UNKNOWN', pending: 0, rejected: 0, oldestPendingOn: null, byType: {} };

/** Books-side event types a close waits on (JOB_COST is Books → Projects: Projects' backlog, not Books'). */
export const SEAM_CLOSE_EVENT_TYPES: readonly string[] = [...CONSUMED_PROJECTS_EVENT_TYPES, ...PLANNED_PROJECTS_EVENT_TYPES].filter((t) => t !== 'JOB_COST');

interface EvRow {
  id: string;
  event_type: string;
  status: string;
  occurred_on: string;
  created_at: string;
  payload: Record<string, unknown> | null;
}

/** PURE: the business key a later processed event must share to settle a rejection. */
export function seamResolutionKey(eventType: string, payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const s = (k: string) => (payload[k] == null ? null : String(payload[k]));
  switch (eventType) {
    case 'JOB_COMMITMENT': return s('commitment_id') ? `${eventType}|${s('commitment_id')}` : null;
    case 'JOB_PROGRESS': return s('job_id') ? `${eventType}|${s('job_id')}` : null;
    default: return s('source_ref') ? `${eventType}|${s('source_ref')}` : null;
  }
}

/** PURE: count the unsettled backlog per company. */
export function summarizeSeamBacklog(
  locationIds: readonly string[],
  open: readonly EvRow[],
  processedKeysAfter: ReadonlyMap<string, string>,
): Map<string, SeamCloseSignal> {
  const out = new Map<string, SeamCloseSignal>();
  for (const loc of locationIds) out.set(loc, { applicable: true, status: 'OK', pending: 0, rejected: 0, oldestPendingOn: null, byType: {} });
  for (const e of open) {
    if (e.status === 'rejected') {
      const key = seamResolutionKey(e.event_type, e.payload);
      const settledAt = key ? processedKeysAfter.get(key) : undefined;
      if (settledAt && settledAt > e.created_at) continue;
    }
    const loc = e.payload?.location_id ? String(e.payload.location_id) : null;
    const targets = loc ? (out.has(loc) ? [loc] : []) : [...out.keys()];
    for (const t of targets) {
      const sig = out.get(t)!;
      if (e.status === 'pending') {
        sig.pending++;
        if (!sig.oldestPendingOn || e.occurred_on < sig.oldestPendingOn) sig.oldestPendingOn = e.occurred_on;
      } else {
        sig.rejected++;
      }
      sig.byType[e.event_type] = (sig.byType[e.event_type] ?? 0) + 1;
      sig.status = 'BLOCKED';
    }
  }
  return out;
}

export async function loadSeamCloseSignals(
  db: DB,
  orgId: string,
  periodEndISO: string | null,
  locationIds: string[],
): Promise<Map<string, SeamCloseSignal>> {
  const out = new Map<string, SeamCloseSignal>();
  if (locationIds.length === 0) return out;
  let projects = false;
  try {
    projects = await hasModule(db, orgId, 'projects');
  } catch {
    for (const l of locationIds) out.set(l, SEAM_SIGNAL_UNKNOWN);
    return out;
  }
  if (!projects) {
    for (const l of locationIds) out.set(l, SEAM_SIGNAL_NOT_APPLICABLE);
    return out;
  }
  if (!periodEndISO) {
    for (const l of locationIds) out.set(l, SEAM_SIGNAL_UNKNOWN);
    return out;
  }
  try {
    const { data: open, error } = await fetchAll(
      () => db.schema('core').from('events').select('id, event_type, status, occurred_on, created_at, payload')
        .eq('org_id', orgId).in('source_module', ['PROJECTS', 'projects']).in('status', ['pending', 'rejected'])
        .in('event_type', [...SEAM_CLOSE_EVENT_TYPES]).lte('occurred_on', periodEndISO),
      { label: 'close/seam open events' },
    );
    if (error) throw new Error(error.message);
    const rows = (open ?? []) as EvRow[];
    const rejected = rows.filter((r) => r.status === 'rejected');
    const processedKeys = new Map<string, string>();
    if (rejected.length > 0) {
      const since = rejected.reduce((m, r) => (r.created_at < m ? r.created_at : m), rejected[0].created_at);
      const types = [...new Set(rejected.map((r) => r.event_type))];
      const { data: done, error: dErr } = await fetchAll(
        () => db.schema('core').from('events').select('id, event_type, status, occurred_on, created_at, payload')
          .eq('org_id', orgId).eq('status', 'processed').in('event_type', types).gte('created_at', since),
        { label: 'close/seam processed events' },
      );
      if (dErr) throw new Error(dErr.message);
      for (const d of (done ?? []) as EvRow[]) {
        const k = seamResolutionKey(d.event_type, d.payload);
        if (!k) continue;
        const prev = processedKeys.get(k);
        if (!prev || d.created_at > prev) processedKeys.set(k, d.created_at);
      }
    }
    return summarizeSeamBacklog(locationIds, rows, processedKeys);
  } catch (e) {
    console.warn('[close/seam] backlog read failed:', e instanceof Error ? e.message : e);
    for (const l of locationIds) out.set(l, SEAM_SIGNAL_UNKNOWN);
    return out;
  }
}
