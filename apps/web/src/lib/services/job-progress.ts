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

type DB = SupabaseClient;

interface ProgressPayload {
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
  results: { event_id: string; status: 'processed' | 'rejected'; recognized_delta_cents?: number; error?: string }[];
}

async function rejectEvent(db: DB, rowId: string, error: string) {
  await db.schema('core').from('events').update({ status: 'rejected', error, processed_at: new Date().toISOString() }).eq('id', rowId);
}

/** Drain pending JOB_PROGRESS events for an org. */
export async function processProgressEvents(db: DB, orgId: string, runBy: string | null): Promise<ProgressDrainResult> {
  const { data: events } = await db
    .schema('core').from('events')
    .select('id, event_id, payload, occurred_on')
    .eq('org_id', orgId)
    .eq('event_type', 'JOB_PROGRESS')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  const out: ProgressDrainResult = { processed: 0, rejected: 0, results: [] };

  for (const ev of (events ?? []) as { id: string; event_id: string; payload: ProgressPayload; occurred_on: string }[]) {
    const p = ev.payload;
    try {
      // Job must exist and belong to the named company.
      const { data: job } = await db.schema('core').from('jobs').select('id, location_id').eq('org_id', orgId).eq('id', p.job_id).maybeSingle();
      if (!job) { await rejectEvent(db, ev.id, 'Job not found'); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: 'Job not found' }); continue; }
      const locationId = (job as { location_id: string }).location_id;

      // Period gate (Rule F).
      const { data: period } = await db.from('fiscal_periods').select('status').eq('org_id', orgId).eq('location_id', locationId).lte('start_date', p.occurred_on).gte('end_date', p.occurred_on).maybeSingle();
      if (!period) { await rejectEvent(db, ev.id, `No fiscal period for ${p.occurred_on}`); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: `No fiscal period for ${p.occurred_on}` }); continue; }
      if ((period as { status: string }).status === 'HARD_CLOSE') { await rejectEvent(db, ev.id, 'Period is closed/locked'); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: 'Period is closed/locked' }); continue; }

      // Pin the snapshot onto the job's rev-rec input columns (only fields that were sent).
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (p.contract_value_cents != null) patch.contract_amount_cents = Math.round(Number(p.contract_value_cents));
      if (p.cost_estimate_cents != null) patch.estimated_cost_cents = Math.round(Number(p.cost_estimate_cents));
      if (p.pct_complete != null) patch.pct_complete = Math.round(Number(p.pct_complete) * 10000) / 100; // 0..1 → 0..100
      await db.schema('core').from('jobs').update(patch).eq('org_id', orgId).eq('id', p.job_id);

      // Recognize per the resolved method.
      const rec = await recognizeJobById(db, orgId, p.job_id, p.occurred_on, runBy);
      if (rec.status === 'skipped') {
        await rejectEvent(db, ev.id, rec.reason ?? 'Recognition skipped');
        out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: rec.reason ?? 'Recognition skipped' });
        continue;
      }

      await db.schema('core').from('events').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('id', ev.id);
      out.processed++;
      out.results.push({ event_id: ev.event_id, status: 'processed', recognized_delta_cents: rec.deltaCents });
    } catch (e) {
      await rejectEvent(db, ev.id, e instanceof Error ? e.message : 'consumer error');
      out.rejected++;
      out.results.push({ event_id: ev.event_id, status: 'rejected', error: e instanceof Error ? e.message : 'consumer error' });
    }
  }

  return out;
}
