/**
 * JOB_PROGRESS consumer (Projects → Books) — Event & Cost/Billing Contract (FROZEN v3) §5.
 *
 * Drains pending JOB_PROGRESS events. Each is a full snapshot keyed by job_id, so
 * a missed event self-heals on the next one. For each event Books:
 *   1. pins (Rule B) contract_value_cents, cost_estimate_cents, pct_complete onto
 *      the job's rev-rec input columns on core.jobs (Books does not author these);
 *   2. rejects if the occurred_on period is HARD_CLOSE (Rule F);
 *   3. runs recognition for that job per its resolved method.
 * Idempotent on event_id (only status='pending' rows are taken; the unique
 * (org_id, event_id) constraint blocks duplicate inserts upstream).
 *
 * pct_complete arrives as a 0..1 fraction; core.jobs.pct_complete is stored 0..100.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { recognizeJobById } from './rev-rec';
import {
  claimPendingEvents,
  finalizeClaimedEvent,
  releaseEventClaims,
  renewEventClaim,
  type ClaimedEvent,
} from '@/lib/events/claim';

type DB = SupabaseClient;

export interface ProgressPayload {
  event_id: string;
  job_id: string;
  location_id: string;
  trigger?: string;
  contract_value_cents?: number | null;
  cost_estimate_cents?: number | null;
  pct_complete?: number | null;   // 0..1 fraction, or null
  occurred_on: string;
  source_ref?: string;
  memo?: string | null;
}

export interface ProgressDrainResult {
  processed: number;
  rejected: number;
  /** Events another drain took over mid-run (lease lapsed) — left to their new owner. */
  skipped?: number;
  results: { event_id: string; status: 'processed' | 'rejected' | 'skipped'; recognized_delta_cents?: number; error?: string }[];
}

/** Reject — only while this drain still holds the claim (wave 2G). */
async function rejectEvent(db: DB, rowId: string, token: string, error: string): Promise<boolean> {
  return finalizeClaimedEvent(db, rowId, token, { status: 'rejected', error, processed_at: new Date().toISOString() });
}

/**
 * Drain pending JOB_PROGRESS events. Each core.events row carries its own org_id
 * (FROZEN v3), and every pin/recognition below is scoped to THAT event's org.
 *
 * `orgFilter` is optional: pass an org id to restrict the drain to one tenant;
 * omit it to drain all tenants. Per-event org is authoritative for the work.
 */
export async function processProgressEvents(
  db: DB,
  orgFilter: string | null | undefined,
  runBy: string | null,
  opts: { claimed?: { token: string; rows: ClaimedEvent<ProgressPayload>[] } } = {},
): Promise<ProgressDrainResult> {
  // M5: process ONLY rows this drain atomically claimed (see lib/events/claim.ts).
  const claim = opts.claimed ?? (await claimPendingEvents<ProgressPayload>(db, { eventType: 'JOB_PROGRESS', orgId: orgFilter ?? null }));

  const out: ProgressDrainResult = { processed: 0, rejected: 0, skipped: 0, results: [] };
  const skip = (ev: ClaimedEvent<ProgressPayload>, why: string) => {
    out.skipped = (out.skipped ?? 0) + 1;
    out.results.push({ event_id: ev.event_id, status: 'skipped', error: why });
  };

  try {
    for (const ev of claim.rows) {
      // Per-event org — authoritative for the job pin + recognition below.
      const orgId = ev.org_id;
      const p = ev.payload;
      try {
        // Wave 2G: work an event only while this drain still holds it (fresh lease).
        // Recognition itself is idempotent per job+period (rev-rec source_ref, mig 064).
        if (!(await renewEventClaim(db, ev.id, claim.token))) { skip(ev, 'Claimed by another drain'); continue; }

        // Job must exist and belong to the named company.
        const { data: job } = await db.schema('core').from('jobs').select('id, location_id').eq('org_id', orgId).eq('id', p.job_id).maybeSingle();
        if (!job) { await rejectEvent(db, ev.id, claim.token, 'Job not found'); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: 'Job not found' }); continue; }
        const locationId = (job as { location_id: string }).location_id;

        // Period gate (Rule F).
        const { data: period } = await db.from('fiscal_periods').select('status').eq('org_id', orgId).eq('location_id', locationId).lte('start_date', p.occurred_on).gte('end_date', p.occurred_on).maybeSingle();
        if (!period) { await rejectEvent(db, ev.id, claim.token, `No fiscal period for ${p.occurred_on}`); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: `No fiscal period for ${p.occurred_on}` }); continue; }
        if ((period as { status: string }).status === 'HARD_CLOSE') { await rejectEvent(db, ev.id, claim.token, 'Period is closed/locked'); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: 'Period is closed/locked' }); continue; }

        // Pin the snapshot onto the job's rev-rec input columns (only fields that were sent).
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (p.contract_value_cents != null) patch.contract_amount_cents = Math.round(Number(p.contract_value_cents));
        if (p.cost_estimate_cents != null) patch.estimated_cost_cents = Math.round(Number(p.cost_estimate_cents));
        if (p.pct_complete != null) patch.pct_complete = Math.round(Number(p.pct_complete) * 10000) / 100; // 0..1 → 0..100
        await db.schema('core').from('jobs').update(patch).eq('org_id', orgId).eq('id', p.job_id);

        // Recognize per the resolved method.
        const rec = await recognizeJobById(db, orgId, p.job_id, p.occurred_on, runBy);
        if (rec.status === 'skipped') {
          await rejectEvent(db, ev.id, claim.token, rec.reason ?? 'Recognition skipped');
          out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: rec.reason ?? 'Recognition skipped' });
          continue;
        }

        if (!(await finalizeClaimedEvent(db, ev.id, claim.token, { status: 'processed', processed_at: new Date().toISOString() }))) {
          skip(ev, 'Finalized by the drain that now holds the event');
          continue;
        }
        out.processed++;
        out.results.push({ event_id: ev.event_id, status: 'processed', recognized_delta_cents: rec.deltaCents });
      } catch (e) {
        await rejectEvent(db, ev.id, claim.token, e instanceof Error ? e.message : 'consumer error');
        out.rejected++;
        out.results.push({ event_id: ev.event_id, status: 'rejected', error: e instanceof Error ? e.message : 'consumer error' });
      }
    }
  } finally {
    // Anything still pending under this claim (an abort mid-run) is handed back.
    await releaseEventClaims(db, claim.token).catch(() => 0);
  }

  return out;
}
