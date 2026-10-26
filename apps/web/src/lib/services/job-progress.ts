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
 *
 * schema_version 2 (A6, migration 194) — the Projects v2 shape adds as_of_date, snapshot_version,
 * pending_co_value_cents (disclosure only, never recognized):
 *   - validate EVERYTHING first (job, as-of period not HARD_CLOSE, version) — a rejection before
 *     the pin leaves the job untouched;
 *   - pin atomically into job_progress_snapshots keyed (job, snapshot_version)
 *     (public.pin_job_progress_snapshot): a re-delivered version is a no-op, an OLDER version is
 *     kept as history (as-of reads) and never overwrites a newer one;
 *   - recognize as of as_of_date with inputs from the books (A4) and THE method resolver (A5);
 *     each snapshot has its own idempotency key, so a second snapshot in a month posts only its
 *     incremental delta (no more "already recognized" rejection after the inputs moved); a negative
 *     delta relieves 1180 then 2410; the anticipated loss is provided when EAC > contract;
 *   - a recognition failure UNPINS the snapshot (job inputs restored) and rejects with an error_code
 *     (G9: a rejected event leaves no partial pin).
 * Unsupported versions are rejected UNSUPPORTED_SCHEMA_VERSION.
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
import { ackClaimedNonInvoiceEvent, rejectClaimedEvent, SeamRejection, schemaVersionOf, versionRejection } from '@/lib/events/seam';

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
  /** v2 */
  schema_version?: number;
  as_of_date?: string | null;
  snapshot_version?: number | null;
  pending_co_value_cents?: number | null;
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

        const vr = versionRejection('JOB_PROGRESS', p);
        if (vr) {
          if (await rejectClaimedEvent(db, ev.id, claim.token, vr)) { out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: vr.message }); }
          else skip(ev, 'Claimed by another drain');
          continue;
        }
        if (schemaVersionOf(p) === 2) {
          const r = await processProgressV2(db, ev, claim.token, runBy);
          if (r.status === 'skipped') skip(ev, r.error ?? 'skipped');
          else {
            if (r.status === 'processed') out.processed++; else out.rejected++;
            out.results.push(r);
          }
          continue;
        }

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


// ─────────────────────────────────────────────────────────────────────────────
// schema_version 2 (A6)
// ─────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type V2Result = { event_id: string; status: 'processed' | 'rejected' | 'skipped'; recognized_delta_cents?: number; error?: string };

async function processProgressV2(db: DB, ev: ClaimedEvent<ProgressPayload>, token: string, runBy: string | null): Promise<V2Result> {
  const orgId = ev.org_id;
  const p = ev.payload;
  const reject = async (r: SeamRejection): Promise<V2Result> => {
    if (!(await rejectClaimedEvent(db, ev.id, token, r))) return { event_id: ev.event_id, status: 'skipped', error: 'Claimed by another drain' };
    return { event_id: ev.event_id, status: 'rejected', error: r.message };
  };

  // ── validate everything BEFORE pinning ─────────────────────────────────────
  const version = Number(p.snapshot_version);
  if (!Number.isInteger(version) || version < 1) return reject(new SeamRejection('INVALID_PAYLOAD', 'snapshot_version must be a positive integer'));
  const asOf = p.as_of_date ?? p.occurred_on;
  if (!asOf || !DATE_RE.test(asOf)) return reject(new SeamRejection('INVALID_PAYLOAD', 'as_of_date must be YYYY-MM-DD'));
  const pct = p.pct_complete == null ? null : Number(p.pct_complete);
  if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 1)) return reject(new SeamRejection('INVALID_PAYLOAD', 'pct_complete must be a fraction between 0 and 1'));
  for (const [k, v] of [['contract_value_cents', p.contract_value_cents], ['cost_estimate_cents', p.cost_estimate_cents]] as const) {
    if (v != null && (!Number.isInteger(Number(v)) || Number(v) < 0)) return reject(new SeamRejection('INVALID_AMOUNT', `${k} must be a non-negative whole number of cents`));
  }
  const { data: job } = await db.schema('core').from('jobs').select('id, location_id').eq('org_id', orgId).eq('id', p.job_id).maybeSingle();
  if (!job) return reject(new SeamRejection('JOB_NOT_FOUND', 'Job not found'));
  const locationId = (job as { location_id: string }).location_id;
  const { data: period } = await db.from('fiscal_periods').select('status').eq('org_id', orgId).eq('location_id', locationId).lte('start_date', asOf).gte('end_date', asOf).maybeSingle();
  if (!period) return reject(new SeamRejection('NO_FISCAL_PERIOD', `No fiscal period for ${asOf}`));
  if ((period as { status: string }).status === 'HARD_CLOSE') return reject(new SeamRejection('PERIOD_CLOSED', `The period for ${asOf} is closed`));

  // ── pin (atomic; idempotent on (job, version)) ─────────────────────────────
  const { data: pinRows, error: pinErr } = await db.rpc('pin_job_progress_snapshot', {
    p_org: orgId, p_job: p.job_id, p_version: version, p_as_of: asOf,
    p_contract: p.contract_value_cents == null ? null : Math.round(Number(p.contract_value_cents)),
    p_estimate: p.cost_estimate_cents == null ? null : Math.round(Number(p.cost_estimate_cents)),
    p_pct: pct, p_pending_co: p.pending_co_value_cents == null ? null : Math.round(Number(p.pending_co_value_cents)),
    p_event: ev.id, p_source_ref: p.source_ref ?? null, p_payload: p,
  });
  if (pinErr) return reject(new SeamRejection('PROGRESS_FAILED', `Could not pin the snapshot: ${pinErr.message}`));
  const pin = (Array.isArray(pinRows) ? pinRows[0] : pinRows) as { snapshot_id: string; applied: boolean; duplicate: boolean } | null;
  if (!pin) return reject(new SeamRejection('PROGRESS_FAILED', 'The snapshot pin returned nothing'));

  if (pin.duplicate || !pin.applied) {
    const ok = await ackClaimedNonInvoiceEvent(db, ev.id, token, {
      snapshot_id: pin.snapshot_id, snapshot_version: version, ...(pin.duplicate ? { duplicate: true } : { historical: true }),
    });
    return ok ? { event_id: ev.event_id, status: 'processed', recognized_delta_cents: 0 } : { event_id: ev.event_id, status: 'skipped', error: 'Finalized by another drain' };
  }

  // ── recognize as of the snapshot date (books inputs, one resolver) ──────────
  let rec: Awaited<ReturnType<typeof recognizeJobById>>;
  try {
    rec = await recognizeJobById(db, orgId, p.job_id, asOf, runBy, {
      sourceRef: `rev_rec:${p.job_id}:${asOf.slice(0, 7)}:v${version}`,
      alreadyPostedIsUnchanged: true,
      lossProvision: true,
    });
  } catch (e) {
    rec = { jobId: p.job_id, method: 'PCT_COSTS_INCURRED', earnedToDateCents: 0, priorRecognizedCents: 0, deltaCents: 0, status: 'skipped', reason: e instanceof Error ? e.message : 'recognition failed' };
  }
  if (rec.status === 'skipped') {
    await db.rpc('unpin_job_progress_snapshot', { p_org: orgId, p_snapshot: pin.snapshot_id });
    return reject(new SeamRejection('REV_REC_UNRESOLVED', rec.reason ?? 'Recognition skipped'));
  }
  await db.rpc('confirm_job_progress_snapshot', { p_org: orgId, p_snapshot: pin.snapshot_id });
  const ok = await ackClaimedNonInvoiceEvent(db, ev.id, token, {
    snapshot_id: pin.snapshot_id, snapshot_version: version, method: rec.method, earned_to_date_cents: rec.earnedToDateCents,
    recognized_delta_cents: rec.deltaCents, loss_provision_cents: rec.lossProvisionCents ?? 0,
  });
  if (!ok) return { event_id: ev.event_id, status: 'skipped', error: 'Finalized by another drain' };
  return { event_id: ev.event_id, status: 'processed', recognized_delta_cents: rec.deltaCents };
}
