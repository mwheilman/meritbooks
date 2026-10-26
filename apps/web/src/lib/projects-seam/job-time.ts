/**
 * JOB_TIME consumer (Projects → Books, schema_version 1, migration 194).
 *
 * Projects owns the HOURS; Books owns the COST (owner decision 2026-10-21: job labor = actual
 * payroll cost allocated by hours worked). This consumer only RECORDS approved hours — it never
 * posts. Cost reaches the job when payroll posts (labor-allocation.ts), optionally estimated in
 * between by the standard-rate accrual (labor-accrual.ts).
 *
 * Payload (pm.approve_time_entries / pm.unapprove_time_entry, 1108 §4):
 *   { action APPROVED | UNAPPROVED, revision, source_ref 'pm:time:{time_entry_id}', time_entry_id,
 *     employee_id, job_id, location_id, department_id, occurred_on (work date), hours, pay_type,
 *     cost_code_id, cost_code, cost_rate_cents (information only), reverses_event_id }
 *
 *   APPROVED     → one job_labor_hours row keyed (org, source_ref, revision) — a re-delivered event
 *                  is a no-op (unique key), a re-approval after an unapproval is a new revision.
 *   UNAPPROVED   → that revision is WITHDRAWN. If payroll already costed it, the posted allocation
 *                  stands (posted GL is immutable) and the row is surfaced as "withdrawn after payroll"
 *                  for a person to correct with a reclass.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { claimPendingEvents, releaseEventClaims, renewEventClaim, isUniqueViolation, type ClaimedEvent } from '@/lib/events/claim';
import { ackClaimedNonInvoiceEvent, projectsEntitlementCache, rejectClaimedEvent, SeamRejection, versionRejection } from '@/lib/events/seam';
import { writerFor } from '@/lib/db/scoped-writer';

type DB = SupabaseClient;

export interface JobTimePayload {
  event_id: string;
  action: 'APPROVED' | 'UNAPPROVED';
  revision?: number | null;
  source_ref: string;
  time_entry_id?: string | null;
  employee_id?: string | null;
  job_id: string;
  location_id: string;
  department_id?: string | null;
  occurred_on: string;
  hours: number | string;
  pay_type?: string | null;
  cost_code_id?: string | null;
  cost_code?: string | null;
  cost_rate_cents?: number | null;
  reverses_event_id?: string | null;
  schema_version?: number;
}

export interface JobTimeDrainResult {
  processed: number;
  rejected: number;
  skipped: number;
  results: { event_id: string; status: 'processed' | 'rejected' | 'skipped'; labor_hours_id?: string; error?: string; error_code?: string }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PURE: validate a JOB_TIME payload. Throws SeamRejection. */
export function validateJobTime(p: JobTimePayload | null | undefined): { hours: number; revision: number } {
  if (!p) throw new SeamRejection('INVALID_PAYLOAD', 'Empty JOB_TIME payload');
  if (!p.source_ref) throw new SeamRejection('MISSING_SOURCE_REF', 'The time event has no source_ref');
  if (p.action !== 'APPROVED' && p.action !== 'UNAPPROVED') throw new SeamRejection('INVALID_PAYLOAD', `Unknown action ${String(p.action)}`);
  if (!p.job_id || !UUID_RE.test(p.job_id)) throw new SeamRejection('INVALID_PAYLOAD', 'job_id must be a uuid');
  if (!p.occurred_on || !DATE_RE.test(p.occurred_on)) throw new SeamRejection('INVALID_PAYLOAD', 'occurred_on (work date) must be YYYY-MM-DD');
  if (p.employee_id != null && !UUID_RE.test(p.employee_id)) throw new SeamRejection('INVALID_PAYLOAD', 'employee_id must be a uuid');
  const hours = Math.round(Number(p.hours) * 100) / 100;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new SeamRejection('INVALID_HOURS', 'hours must be greater than 0 and at most 24');
  const revision = p.revision == null ? 1 : Number(p.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new SeamRejection('INVALID_PAYLOAD', 'revision must be a positive integer');
  return { hours, revision };
}

export async function processJobTimeEvents(
  db: DB,
  orgFilter?: string | null,
  opts: { claimed?: { token: string; rows: ClaimedEvent<JobTimePayload>[] } } = {},
): Promise<JobTimeDrainResult> {
  const claim = opts.claimed ?? (await claimPendingEvents<JobTimePayload>(db, { eventType: 'JOB_TIME', orgId: orgFilter ?? null }));
  const projectsOn = projectsEntitlementCache(db);
  const w = writerFor(db);
  const out: JobTimeDrainResult = { processed: 0, rejected: 0, skipped: 0, results: [] };

  const skip = (ev: ClaimedEvent<JobTimePayload>, why: string) => {
    out.skipped++;
    out.results.push({ event_id: ev.event_id, status: 'skipped', error: why });
  };
  const reject = async (ev: ClaimedEvent<JobTimePayload>, r: SeamRejection) => {
    if (!(await rejectClaimedEvent(db, ev.id, claim.token, r))) { skip(ev, 'Claimed by another drain'); return; }
    out.rejected++;
    out.results.push({ event_id: ev.event_id, status: 'rejected', error: r.message, error_code: r.code });
  };
  const ack = async (ev: ClaimedEvent<JobTimePayload>, meta: Record<string, unknown>, id?: string) => {
    if (!(await ackClaimedNonInvoiceEvent(db, ev.id, claim.token, meta))) { skip(ev, 'Recorded; finalized by the drain that now holds the event'); return; }
    out.processed++;
    out.results.push({ event_id: ev.event_id, status: 'processed', labor_hours_id: id });
  };

  try {
    for (const ev of claim.rows) {
      const orgId = ev.org_id;
      const p = ev.payload;
      try {
        if (!(await renewEventClaim(db, ev.id, claim.token))) { skip(ev, 'Claimed by another drain'); continue; }
        const vr = versionRejection('JOB_TIME', p);
        if (vr) { await reject(ev, vr); continue; }
        if (!(await projectsOn(orgId))) {
          await releaseEventClaims(db, claim.token, [ev.id]).catch(() => 0);
          skip(ev, 'Projects is not enabled for this organization');
          continue;
        }
        const { hours, revision } = validateJobTime(p);

        const { data: job } = await db.schema('core').from('jobs').select('id, location_id, department_id').eq('org_id', orgId).eq('id', p.job_id).maybeSingle();
        const j = job as { id: string; location_id: string; department_id: string | null } | null;
        if (!j) { await reject(ev, new SeamRejection('JOB_NOT_FOUND', 'Job not found in this organization')); continue; }

        if (p.action === 'UNAPPROVED') {
          const { data: rows } = await db.from('job_labor_hours').select('id, status, allocation_id')
            .eq('org_id', orgId).eq('source_ref', p.source_ref).eq('revision', revision);
          const row = ((rows ?? []) as { id: string; status: string; allocation_id: string | null }[])[0];
          if (!row) {
            // Withdrawn before Books ever saw the approval (or the approval was rejected): nothing to undo.
            await ack(ev, { withdrawn: false, reason: 'no matching approved hours' });
            continue;
          }
          if (row.status !== 'WITHDRAWN') {
            const { error } = await w.from('job_labor_hours')
              .update({ status: 'WITHDRAWN', withdrawn_event_id: ev.id, withdrawn_at: new Date().toISOString(), updated_at: new Date().toISOString() })
              .eq('org_id', orgId).eq('id', row.id);
            if (error) throw new Error(`withdraw hours: ${error.message}`);
          }
          await ack(ev, { labor_hours_id: row.id, withdrawn: true, ...(row.allocation_id ? { withdrawn_after_payroll: true } : {}) }, row.id);
          continue;
        }

        let employeeId: string | null = p.employee_id ?? null;
        let employeeDept: string | null = null;
        let standardRate: number | null = p.cost_rate_cents == null ? null : Math.round(Number(p.cost_rate_cents));
        if (employeeId) {
          const { data: emp } = await db.schema('core').from('employees').select('id, hourly_rate_cents, department_id').eq('org_id', orgId).eq('id', employeeId).maybeSingle();
          if (!emp) employeeId = null; // unknown employee → hours recorded but cannot be costed (surfaced as unallocated)
          else {
            employeeDept = (emp as { department_id: string | null }).department_id ?? null;
            if (standardRate == null) {
              const hr = (emp as { hourly_rate_cents: number | null }).hourly_rate_cents;
              standardRate = hr == null ? null : Math.round(Number(hr));
            }
          }
        }

        const row = {
          org_id: orgId,
          location_id: j.location_id,
          job_id: j.id,
          // The job's department, else the worker's: Direct Labor (5000) requires a department on its lines.
          department_id: p.department_id ?? j.department_id ?? employeeDept ?? null,
          employee_id: employeeId,
          time_entry_id: p.time_entry_id && UUID_RE.test(p.time_entry_id) ? p.time_entry_id : null,
          work_date: p.occurred_on,
          hours,
          pay_type: p.pay_type ?? null,
          cost_code_id: p.cost_code_id && UUID_RE.test(p.cost_code_id) ? p.cost_code_id : null,
          cost_code: p.cost_code ?? null,
          standard_rate_cents: standardRate != null && Number.isFinite(standardRate) ? standardRate : null,
          source_ref: p.source_ref,
          revision,
          status: 'APPROVED',
          source_event_id: ev.id,
        };
        const { data: ins, error } = await w.from('job_labor_hours').insert(row).select('id').single();
        if (error) {
          if (!isUniqueViolation(error)) throw new Error(`record hours: ${error.message}`);
          const { data: dup } = await db.from('job_labor_hours').select('id').eq('org_id', orgId).eq('source_ref', p.source_ref).eq('revision', revision).maybeSingle();
          await ack(ev, { labor_hours_id: (dup as { id: string } | null)?.id ?? null, duplicate: true }, (dup as { id: string } | null)?.id);
          continue;
        }
        const id = (ins as { id: string }).id;
        await ack(ev, { labor_hours_id: id, hours, ...(employeeId ? {} : { costable: false, reason: 'no Books employee' }) }, id);
      } catch (e) {
        await reject(ev, e instanceof SeamRejection ? e : new SeamRejection('LABOR_FAILED', e instanceof Error ? e.message : 'time consumer error'));
      }
    }
  } finally {
    await releaseEventClaims(db, claim.token).catch(() => 0);
  }
  return out;
}
