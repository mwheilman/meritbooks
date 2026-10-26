/**
 * Optional standard-rate labor accrual (migration 194; owner decision 2026-10-21).
 *
 * Between payrolls a company may estimate job labor from the approved hours at a standard rate
 * (the JOB_TIME cost_rate_cents, else the employee's hourly rate) so mid-period job cost is not
 * understated. The estimate is TRUED UP to actual when the payroll that pays those hours posts
 * (labor-allocation.ts reverses exactly what was accrued for each hours row inside the payroll
 * reclass), so a job always ends at actual payroll cost.
 *
 *   DR JOB_LABOR_COST (per job)  /  CR ACCRUED_EXPENSES        entry date = as-of date
 *
 * Opt-in per company (job_labor_settings.accrue_standard_rate). Idempotent per (company, as-of date):
 * job_labor_accruals UNIQUE + GL source_ref 'labor_accrual:<company>:<date>'; an hours row is
 * accrued once (accrual_id is set only while null). Hours with no standard rate are skipped and
 * reported. JOB_COST CLEARED per accrued hours row (source_ref labor_accrual:<row>), VOIDED at true-up.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { writerFor } from '@/lib/db/scoped-writer';
import { isUniqueViolation } from '@/lib/events/claim';
import { hasModule } from '@/lib/services/entitlements';
import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { emitJobCostEvent } from '@/lib/services/job-cost-events';
import { standardCostCents } from './labor-allocate';
import { departmentGap, laborAccrualCostRef } from './labor-allocation';

type DB = SupabaseClient;

export const LABOR_ACCRUAL_SOURCE_MODULE = 'LABOR_ACCRUAL';

export function laborAccrualSourceRef(locationId: string, asOf: string): string {
  return `labor_accrual:${locationId}:${asOf}`;
}

export type AccrualOutcome =
  | { status: 'NOT_APPLICABLE' | 'NOT_ENABLED'; reason: string }
  | { status: 'NOTHING'; skippedNoRate: number }
  | { status: 'POSTED'; accrualId: string; glEntryId: string; amountCents: number; rows: number; skippedNoRate: number; already: boolean }
  | { status: 'FAILED'; error: string };

const num = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export async function runLaborAccrual(
  db: DB,
  orgId: string,
  args: { locationId: string; asOf: string; actor: string | null },
): Promise<AccrualOutcome> {
  if (!(await hasModule(db, orgId, 'projects').catch(() => false))) return { status: 'NOT_APPLICABLE', reason: 'Projects is not enabled for this organization' };
  const { data: st } = await db.from('job_labor_settings').select('accrue_standard_rate').eq('org_id', orgId).eq('location_id', args.locationId).maybeSingle();
  if (!(st as { accrue_standard_rate: boolean } | null)?.accrue_standard_rate) {
    return { status: 'NOT_ENABLED', reason: 'Standard-rate labor accrual is off for this company' };
  }
  const w = writerFor(db);

  const { data: existing } = await db.from('job_labor_accruals').select('id, gl_entry_id, amount_cents')
    .eq('org_id', orgId).eq('location_id', args.locationId).eq('as_of_date', args.asOf).maybeSingle();
  if (existing && (existing as { gl_entry_id: string | null }).gl_entry_id) {
    const e = existing as { id: string; gl_entry_id: string; amount_cents: number | string };
    return { status: 'POSTED', accrualId: e.id, glEntryId: e.gl_entry_id, amountCents: num(e.amount_cents), rows: 0, skippedNoRate: 0, already: true };
  }

  const { data: hrs, error } = await db.from('job_labor_hours')
    .select('id, job_id, department_id, hours, standard_rate_cents, work_date')
    .eq('org_id', orgId).eq('location_id', args.locationId).eq('status', 'APPROVED')
    .is('allocation_id', null).is('accrual_id', null).lte('work_date', args.asOf);
  if (error) return { status: 'FAILED', error: error.message };
  type H = { id: string; job_id: string; department_id: string | null; hours: number | string; standard_rate_cents: number | string | null; work_date: string };
  const rows = ((hrs ?? []) as H[]).map((h) => ({ ...h, cents: standardCostCents(num(h.hours), h.standard_rate_cents == null ? null : num(h.standard_rate_cents)) }));
  const costed = rows.filter((r) => r.cents > 0);
  const skippedNoRate = rows.length - costed.length;
  if (costed.length === 0) return { status: 'NOTHING', skippedNoRate };

  let laborId: string; let accruedId: string;
  try {
    laborId = (await resolveRole(db, orgId, 'JOB_LABOR_COST', args.locationId)).id;
    accruedId = (await resolveRole(db, orgId, 'ACCRUED_EXPENSES', args.locationId)).id;
  } catch (e) {
    return { status: 'FAILED', error: e instanceof PostingError ? e.message : 'Labor accrual accounts are not set up' };
  }

  const total = costed.reduce((s, r) => s + r.cents, 0);
  const hoursTotal = Math.round(costed.reduce((s, r) => s + num(r.hours) * 100, 0)) / 100;
  let accrualId: string;
  if (existing) {
    accrualId = (existing as { id: string }).id;
  } else {
    const { data: ins, error: iErr } = await w.from('job_labor_accruals').insert({
      org_id: orgId, location_id: args.locationId, as_of_date: args.asOf, amount_cents: total, hours: hoursTotal, status: 'POSTED', created_by: args.actor,
    }).select('id').single();
    if (iErr) {
      if (isUniqueViolation(iErr)) return { status: 'FAILED', error: 'Another accrual for this date is being posted — refresh in a moment' };
      return { status: 'FAILED', error: iErr.message };
    }
    accrualId = (ins as { id: string }).id;
  }

  const byJob = new Map<string, { job: string; dept: string | null; cents: number }>();
  for (const r of costed) {
    const k = `${r.job_id}|${r.department_id ?? ''}`;
    const x = byJob.get(k) ?? { job: r.job_id, dept: r.department_id, cents: 0 };
    x.cents += r.cents;
    byJob.set(k, x);
  }
  const deptGap = await departmentGap(db, orgId, laborId, [...byJob.values()]);
  if (deptGap) {
    await w.from('job_labor_accruals').delete().eq('org_id', orgId).eq('id', accrualId).is('gl_entry_id', null);
    return { status: 'FAILED', error: deptGap };
  }
  const lines: JournalEntryLineInput[] = [...byJob.values()].map((x) => ({
    account_id: laborId, debit_cents: x.cents, credit_cents: 0, location_id: args.locationId, job_id: x.job,
    ...(x.dept ? { department_id: x.dept } : {}), memo: 'Job labor estimate (standard rate, trued up at payroll)',
  }));
  lines.push({ account_id: accruedId, debit_cents: 0, credit_cents: total, location_id: args.locationId, memo: 'Accrued job labor' });

  const je = await postJournalEntry(db, {
    org_id: orgId, location_id: args.locationId, entry_date: args.asOf, entry_type: 'STANDARD',
    memo: `Job labor accrual at standard rate through ${args.asOf}`, source_module: LABOR_ACCRUAL_SOURCE_MODULE,
    source_id: accrualId, source_ref: laborAccrualSourceRef(args.locationId, args.asOf), created_by: null, lines,
  }, { writer: w });
  if (!je.success || !je.entry_id) {
    await w.from('job_labor_accruals').delete().eq('org_id', orgId).eq('id', accrualId).is('gl_entry_id', null);
    return { status: 'FAILED', error: je.error ?? 'The accrual did not post' };
  }
  await w.from('job_labor_accruals').update({ gl_entry_id: je.entry_id, amount_cents: total, hours: hoursTotal, updated_at: new Date().toISOString() })
    .eq('org_id', orgId).eq('id', accrualId);
  for (const r of costed) {
    await w.from('job_labor_hours').update({ accrual_id: accrualId, accrued_cents: r.cents, updated_at: new Date().toISOString() })
      .eq('org_id', orgId).eq('id', r.id).is('accrual_id', null);
    try {
      await emitJobCostEvent(db, {
        orgId, locationId: args.locationId, jobId: r.job_id, departmentId: r.department_id, costType: 'LABOR', amountCents: r.cents,
        occurredOn: r.work_date, lifecycle: 'CLEARED', gate: 'TIMESHEET_PAYROLL', sourceRef: laborAccrualCostRef(r.id), glEntryId: je.entry_id,
        memo: 'Job labor estimate at standard rate (trued up at payroll)',
      }, { writer: db });
    } catch (e) {
      console.error('[labor-accrual] JOB_COST emit failed', e instanceof Error ? e.message : e);
    }
  }
  return { status: 'POSTED', accrualId, glEntryId: je.entry_id, amountCents: total, rows: costed.length, skippedNoRate, already: false };
}
