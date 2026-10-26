/**
 * Payroll → job labor allocation (migration 194; owner decision 2026-10-21).
 *
 * When a payroll run is POSTED (payroll_runs.gl_entry_id set), the actual cost of every employee
 * on it — gross + employer taxes + employer benefits — is allocated to the jobs they worked in the
 * pay period by approved Projects hours (job_labor_hours, JOB_TIME), with the pure math in
 * labor-allocate.ts. One balanced reclass entry per run (entry date = pay date):
 *
 *   DR JOB_LABOR_COST (5000 Direct Labor, COGS) per job          Σ allocated
 *   CR WAGES_EXPENSE              Σ wages share
 *   CR PAYROLL_TAX_EXPENSE        Σ employer-tax share
 *   CR HEALTH_INSURANCE_EXPENSE   Σ employer-benefit share (only when benefits are carried)
 *   standard-rate accrual true-up (only for rows that were accrued):
 *   DR ACCRUED_EXPENSES / CR JOB_LABOR_COST per job              Σ accrued
 *
 * so each job ends at ACTUAL cost and the payroll expense keeps only the paid time not on a job.
 * JOB_COST (CLEARED, LABOR, gate TIMESHEET_PAYROLL) goes back to Projects per job × cost code,
 * and the accrual's JOB_COST rows are VOIDED as they are trued up.
 *
 * Idempotent per payroll run: job_labor_allocations UNIQUE (org, payroll_run_id) is the claim, the
 * GL source_ref 'payroll_labor:<run>' is unique (064), and an hours row is stamped only while its
 * allocation_id is still null. A run with nothing to allocate is recorded NOTHING (and not retried).
 * Only for orgs with entitlements.projects = true — otherwise a no-op.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { writerFor } from '@/lib/db/scoped-writer';
import { isUniqueViolation } from '@/lib/events/claim';
import { hasModule } from '@/lib/services/entitlements';
import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { emitJobCostEvent } from '@/lib/services/job-cost-events';
import { allocateLabor, type JobHourRow, type PayrollEmployeeCost } from './labor-allocate';

type DB = SupabaseClient;

export const PAYROLL_LABOR_SOURCE_MODULE = 'PAYROLL_LABOR';

export function payrollLaborSourceRef(runId: string): string {
  return `payroll_labor:${runId}`;
}

export function laborAccrualCostRef(hoursRowId: string): string {
  return `labor_accrual:${hoursRowId}`;
}

export type AllocationOutcome =
  | { status: 'NOT_APPLICABLE'; reason: string }
  | { status: 'NOT_POSTED'; reason: string }
  | { status: 'IN_PROGRESS'; allocationId: string }
  | { status: 'NOTHING'; allocationId: string; unallocatedHours: number; unallocatedCostCents: number }
  | { status: 'POSTED'; allocationId: string; glEntryId: string; allocatedCents: number; unallocatedCostCents: number; unallocatedHours: number; accrualReversedCents: number; already: boolean }
  | { status: 'FAILED'; allocationId: string | null; error: string };

interface RunRow {
  id: string;
  location_id: string | null;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: string;
  gl_entry_id: string | null;
}

interface AllocRow {
  id: string;
  status: 'PENDING' | 'POSTED' | 'NOTHING' | 'FAILED';
  gl_entry_id: string | null;
  allocated_cents: number | string;
  unallocated_cost_cents: number | string;
  unallocated_hours: number | string;
  accrual_reversed_cents: number | string;
  created_at: string;
  updated_at: string;
}

const num = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

const STALE_PENDING_MS = 10 * 60_000;

function postedOutcome(a: AllocRow, already: boolean): AllocationOutcome {
  return {
    status: 'POSTED', allocationId: a.id, glEntryId: a.gl_entry_id as string, allocatedCents: num(a.allocated_cents),
    unallocatedCostCents: num(a.unallocated_cost_cents), unallocatedHours: num(a.unallocated_hours),
    accrualReversedCents: num(a.accrual_reversed_cents), already,
  };
}

/**
 * Allocate one posted payroll run's labor to jobs. `db` must be the SERVICE-ROLE client (the
 * payroll post and the scheduler both hold it); every read and write is pinned to `orgId`.
 */
export async function allocateLaborForRun(db: DB, orgId: string, runId: string): Promise<AllocationOutcome> {
  if (!(await hasModule(db, orgId, 'projects').catch(() => false))) {
    return { status: 'NOT_APPLICABLE', reason: 'Projects is not enabled for this organization' };
  }
  const w = writerFor(db);
  const { data: runData, error: runErr } = await db.from('payroll_runs')
    .select('id, location_id, period_start, period_end, pay_date, status, gl_entry_id').eq('org_id', orgId).eq('id', runId).maybeSingle();
  if (runErr) return { status: 'FAILED', allocationId: null, error: runErr.message };
  const run = runData as RunRow | null;
  if (!run) return { status: 'FAILED', allocationId: null, error: 'Payroll run not found' };
  if (!run.gl_entry_id) return { status: 'NOT_POSTED', reason: 'The payroll run is not posted yet — labor is allocated when payroll posts' };
  if (!run.location_id) return { status: 'FAILED', allocationId: null, error: 'The payroll run has no company' };
  const locationId = run.location_id;

  // ── claim (one allocation per run) ──────────────────────────────────────────
  const readAlloc = async (): Promise<AllocRow | null> => {
    const { data } = await db.from('job_labor_allocations')
      .select('id, status, gl_entry_id, allocated_cents, unallocated_cost_cents, unallocated_hours, accrual_reversed_cents, created_at, updated_at')
      .eq('org_id', orgId).eq('payroll_run_id', runId).maybeSingle();
    return (data as AllocRow | null) ?? null;
  };
  let alloc = await readAlloc();
  if (alloc?.status === 'POSTED') return postedOutcome(alloc, true);
  if (alloc?.status === 'NOTHING') {
    return { status: 'NOTHING', allocationId: alloc.id, unallocatedHours: num(alloc.unallocated_hours), unallocatedCostCents: num(alloc.unallocated_cost_cents) };
  }
  if (alloc?.status === 'PENDING' && Date.now() - new Date(alloc.updated_at).getTime() < STALE_PENDING_MS) {
    // Another worker may be mid-post: finish from the GL if the entry already exists.
    const done = await finishFromGl(db, orgId, alloc.id, runId);
    if (done) return done;
    return { status: 'IN_PROGRESS', allocationId: alloc.id };
  }
  if (!alloc) {
    const { data, error } = await w.from('job_labor_allocations').insert({
      org_id: orgId, location_id: locationId, payroll_run_id: runId, period_start: run.period_start, period_end: run.period_end,
      pay_date: run.pay_date, status: 'PENDING',
    }).select('id, status, gl_entry_id, allocated_cents, unallocated_cost_cents, unallocated_hours, accrual_reversed_cents, created_at, updated_at').single();
    if (error) {
      if (!isUniqueViolation(error)) return { status: 'FAILED', allocationId: null, error: error.message };
      alloc = await readAlloc();
      if (alloc?.status === 'POSTED') return postedOutcome(alloc, true);
      return { status: 'IN_PROGRESS', allocationId: alloc?.id ?? '' };
    }
    alloc = data as AllocRow;
  } else {
    // FAILED or stale PENDING → retry under a fresh claim timestamp.
    const done = await finishFromGl(db, orgId, alloc.id, runId);
    if (done) return done;
    const { data } = await w.from('job_labor_allocations').update({ status: 'PENDING', error: null, updated_at: new Date().toISOString() })
      .eq('org_id', orgId).eq('id', alloc.id).eq('updated_at', alloc.updated_at).select('id');
    if (!Array.isArray(data) || data.length === 0) return { status: 'IN_PROGRESS', allocationId: alloc.id };
  }
  const allocationId = alloc.id;
  const fail = async (msg: string): Promise<AllocationOutcome> => {
    await w.from('job_labor_allocations').update({ status: 'FAILED', error: msg.slice(0, 1000), updated_at: new Date().toISOString() })
      .eq('org_id', orgId).eq('id', allocationId);
    return { status: 'FAILED', allocationId, error: msg };
  };

  try {
    // ── inputs ──────────────────────────────────────────────────────────────────
    const { data: emps, error: eErr } = await db.from('payroll_run_employees')
      .select('employee_id, gross_cents, employer_tax_cents, employer_benefits_cents, hours').eq('org_id', orgId).eq('payroll_run_id', runId);
    if (eErr) return fail(`payroll lines: ${eErr.message}`);
    const byEmployee = new Map<string, PayrollEmployeeCost>();
    for (const e of (emps ?? []) as { employee_id: string | null; gross_cents: number | string; employer_tax_cents: number | string; employer_benefits_cents: number | string | null; hours: number | string | null }[]) {
      if (!e.employee_id) continue;
      const prev = byEmployee.get(e.employee_id);
      byEmployee.set(e.employee_id, {
        employeeId: e.employee_id,
        grossCents: (prev?.grossCents ?? 0) + num(e.gross_cents),
        employerTaxCents: (prev?.employerTaxCents ?? 0) + num(e.employer_tax_cents),
        benefitsCents: (prev?.benefitsCents ?? 0) + num(e.employer_benefits_cents),
        paidHours: e.hours == null && prev?.paidHours == null ? null : (prev?.paidHours ?? 0) + num(e.hours),
      });
    }

    const { data: hrs, error: hErr } = await db.from('job_labor_hours')
      .select('id, employee_id, job_id, cost_code_id, cost_code, department_id, hours, accrued_cents, status, work_date')
      .eq('org_id', orgId).eq('location_id', locationId).is('allocation_id', null)
      .gte('work_date', run.period_start).lte('work_date', run.period_end);
    if (hErr) return fail(`labor hours: ${hErr.message}`);
    type H = { id: string; employee_id: string | null; job_id: string; cost_code_id: string | null; cost_code: string | null; department_id: string | null; hours: number | string; accrued_cents: number | string; status: string };
    const all = (hrs ?? []) as H[];
    const approved = all.filter((h) => h.status === 'APPROVED');
    // Withdrawn hours that had been accrued: reverse their accrual (no actual cost).
    const withdrawnAccrued = all.filter((h) => h.status === 'WITHDRAWN' && num(h.accrued_cents) > 0);
    const hourRows: JobHourRow[] = approved.map((h) => ({
      id: h.id, employeeId: h.employee_id, jobId: h.job_id, costCodeId: h.cost_code_id, costCode: h.cost_code,
      departmentId: h.department_id, hours: num(h.hours), accruedCents: num(h.accrued_cents),
    }));
    // Only the employees who appear on this run are costed here; their unworked-on-job time stays in payroll expense.
    const a = allocateLabor([...byEmployee.values()], hourRows);
    // Hours for employees not on THIS run may be paid by another run (another pay schedule): report, don't stamp.
    const withdrawnReversal = withdrawnAccrued.reduce((s, h) => s + num(h.accrued_cents), 0);

    if (a.rows.length === 0 && withdrawnReversal === 0) {
      await w.from('job_labor_allocations').update({
        status: 'NOTHING', payroll_cost_cents: a.totals.payrollCostCents, allocated_cents: 0, unallocated_cost_cents: a.totals.unallocatedCostCents,
        allocated_hours: 0, unallocated_hours: a.totals.unallocatedHours, updated_at: new Date().toISOString(),
      }).eq('org_id', orgId).eq('id', allocationId);
      return { status: 'NOTHING', allocationId, unallocatedHours: a.totals.unallocatedHours, unallocatedCostCents: a.totals.unallocatedCostCents };
    }

    // ── accounts by role ──────────────────────────────────────────────────────
    let laborId: string; let wagesId: string; let taxId: string; let benefitsId: string | null = null; let accruedId: string | null = null;
    try {
      laborId = (await resolveRole(db, orgId, 'JOB_LABOR_COST', locationId)).id;
      wagesId = (await resolveRole(db, orgId, 'WAGES_EXPENSE', locationId)).id;
      taxId = (await resolveRole(db, orgId, 'PAYROLL_TAX_EXPENSE', locationId)).id;
      if (a.rows.some((r) => r.benefitsCents > 0)) benefitsId = (await resolveRole(db, orgId, 'HEALTH_INSURANCE_EXPENSE', locationId)).id;
      if (a.totals.accrualReversedCents + withdrawnReversal > 0) accruedId = (await resolveRole(db, orgId, 'ACCRUED_EXPENSES', locationId)).id;
    } catch (e) {
      return fail(e instanceof PostingError ? e.message : 'Labor accounts are not set up');
    }

    // ── the reclass entry ─────────────────────────────────────────────────────
    const key = (job: string, dept: string | null) => `${job}|${dept ?? ''}`;
    const drByJob = new Map<string, { job: string; dept: string | null; cents: number }>();
    const accByJob = new Map<string, { job: string; dept: string | null; cents: number }>();
    for (const r of a.rows) {
      const k = key(r.jobId, r.departmentId);
      const d = drByJob.get(k) ?? { job: r.jobId, dept: r.departmentId, cents: 0 };
      d.cents += r.amountCents;
      drByJob.set(k, d);
      if (r.accrualReversedCents > 0) {
        const c = accByJob.get(k) ?? { job: r.jobId, dept: r.departmentId, cents: 0 };
        c.cents += r.accrualReversedCents;
        accByJob.set(k, c);
      }
    }
    for (const h of withdrawnAccrued) {
      const k = key(h.job_id, h.department_id);
      const c = accByJob.get(k) ?? { job: h.job_id, dept: h.department_id, cents: 0 };
      c.cents += num(h.accrued_cents);
      accByJob.set(k, c);
    }
    const deptGap = await departmentGap(db, orgId, laborId, [...drByJob.values(), ...accByJob.values()]);
    if (deptGap) return fail(deptGap);
    const lines: JournalEntryLineInput[] = [];
    for (const d of drByJob.values()) {
      if (d.cents > 0) lines.push({ account_id: laborId, debit_cents: d.cents, credit_cents: 0, location_id: locationId, job_id: d.job, ...(d.dept ? { department_id: d.dept } : {}), memo: 'Job labor (actual payroll by hours)' });
    }
    const sumW = a.rows.reduce((s, r) => s + r.wagesCents, 0);
    const sumT = a.rows.reduce((s, r) => s + r.employerTaxCents, 0);
    const sumB = a.rows.reduce((s, r) => s + r.benefitsCents, 0);
    if (sumW > 0) lines.push({ account_id: wagesId, debit_cents: 0, credit_cents: sumW, location_id: locationId, memo: 'Wages reclassed to job labor' });
    if (sumT > 0) lines.push({ account_id: taxId, debit_cents: 0, credit_cents: sumT, location_id: locationId, memo: 'Employer payroll tax reclassed to job labor' });
    if (sumB > 0 && benefitsId) lines.push({ account_id: benefitsId, debit_cents: 0, credit_cents: sumB, location_id: locationId, memo: 'Employer benefits reclassed to job labor' });
    const accrualTotal = [...accByJob.values()].reduce((s, c) => s + c.cents, 0);
    if (accrualTotal > 0 && accruedId) {
      lines.push({ account_id: accruedId, debit_cents: accrualTotal, credit_cents: 0, location_id: locationId, memo: 'Reverse standard-rate labor accrual (trued up to payroll)' });
      for (const c of accByJob.values()) {
        if (c.cents > 0) lines.push({ account_id: laborId, debit_cents: 0, credit_cents: c.cents, location_id: locationId, job_id: c.job, ...(c.dept ? { department_id: c.dept } : {}), memo: 'Standard-rate accrual trued up' });
      }
    }

    let glEntryId: string | null = null;
    if (lines.length > 0) {
      const je = await postJournalEntry(db, {
        org_id: orgId, location_id: locationId, entry_date: run.pay_date, entry_type: 'STANDARD',
        memo: `Job labor from payroll ${run.period_start} – ${run.period_end}`,
        source_module: PAYROLL_LABOR_SOURCE_MODULE, source_id: runId, source_ref: payrollLaborSourceRef(runId), created_by: null, lines,
      }, { writer: w });
      if (!je.success || !je.entry_id) {
        const done = /duplicate key|uq_gl_entries_org_source/i.test(je.error ?? '') ? await finishFromGl(db, orgId, allocationId, runId) : null;
        if (done) return done;
        return fail(je.error ?? 'The labor entry did not post');
      }
      glEntryId = je.entry_id;
    }

    // ── record ────────────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    if (a.rows.length > 0) {
      const { error: lErr } = await w.from('job_labor_allocation_lines').insert(a.rows.map((r) => ({
        org_id: orgId, location_id: locationId, allocation_id: allocationId, job_id: r.jobId, employee_id: r.employeeId,
        labor_hours_id: r.hoursRowId, cost_code_id: r.costCodeId, cost_code: r.costCode, department_id: r.departmentId, hours: r.hours,
        wages_cents: r.wagesCents, employer_tax_cents: r.employerTaxCents, benefits_cents: r.benefitsCents, amount_cents: r.amountCents,
        accrual_reversed_cents: r.accrualReversedCents,
      })));
      if (lErr) console.error('[labor-allocation] lines', lErr.message);
    }
    for (const r of a.rows) {
      await w.from('job_labor_hours').update({ allocation_id: allocationId, allocated_cents: r.amountCents, updated_at: now })
        .eq('org_id', orgId).eq('id', r.hoursRowId).is('allocation_id', null);
    }
    for (const h of withdrawnAccrued) {
      await w.from('job_labor_hours').update({ allocation_id: allocationId, allocated_cents: 0, updated_at: now })
        .eq('org_id', orgId).eq('id', h.id).is('allocation_id', null);
    }
    await markAccrualsTrued(db, orgId, [...a.rows.filter((r) => r.accrualReversedCents > 0).map((r) => r.hoursRowId), ...withdrawnAccrued.map((h) => h.id)]);

    await w.from('job_labor_allocations').update({
      status: 'POSTED', gl_entry_id: glEntryId, payroll_cost_cents: a.totals.payrollCostCents, allocated_cents: a.totals.allocatedCents,
      unallocated_cost_cents: a.totals.unallocatedCostCents, allocated_hours: a.totals.allocatedHours, unallocated_hours: a.totals.unallocatedHours,
      accrual_reversed_cents: accrualTotal, error: null, updated_at: now,
    }).eq('org_id', orgId).eq('id', allocationId);

    // ── JOB_COST back to Projects (best effort: the GL is the truth; a failed emit is retried by the cron sweep) ─
    await emitLaborJobCosts(db, orgId, locationId, run, a.rows, withdrawnAccrued.map((h) => ({ id: h.id, jobId: h.job_id, cents: num(h.accrued_cents) })), glEntryId);

    const fresh = await readAlloc();
    return fresh ? postedOutcome(fresh, false) : { status: 'FAILED', allocationId, error: 'allocation vanished' };
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'labor allocation failed');
  }
}

/**
 * The labor account may require a department (5000 Direct Labor does in the standard chart). Name
 * the jobs that have none — on the job or the worker — instead of failing inside the GL trigger.
 */
export async function departmentGap(
  db: DB,
  orgId: string,
  laborAccountId: string,
  lines: ReadonlyArray<{ job: string; dept: string | null; cents: number }>,
): Promise<string | null> {
  const missing = [...new Set(lines.filter((l) => l.cents > 0 && !l.dept).map((l) => l.job))];
  if (missing.length === 0) return null;
  const { data: acct } = await db.from('accounts').select('account_number, name, require_department').eq('org_id', orgId).eq('id', laborAccountId).maybeSingle();
  const a = acct as { account_number: string; name: string; require_department: boolean | null } | null;
  if (!a?.require_department) return null;
  const { data: jobs } = await db.schema('core').from('jobs').select('id, job_number').eq('org_id', orgId).in('id', missing);
  const names = ((jobs ?? []) as { id: string; job_number: string | null }[]).map((j) => j.job_number ?? j.id.slice(0, 8));
  return `${a.account_number} ${a.name} needs a department on every line — set a department on job ${names.join(', ')} (or on the worker in Books) and retry.`;
}

/** The entry exists (a crash after posting): finish the header from the GL. */
async function finishFromGl(db: DB, orgId: string, allocationId: string, runId: string): Promise<AllocationOutcome | null> {
  const { data } = await db.from('gl_entries').select('id').eq('org_id', orgId).eq('source_ref', payrollLaborSourceRef(runId)).eq('status', 'POSTED').limit(1).maybeSingle();
  const entry = data as { id: string } | null;
  if (!entry) return null;
  const w = writerFor(db);
  await w.from('job_labor_allocations').update({ status: 'POSTED', gl_entry_id: entry.id, updated_at: new Date().toISOString() })
    .eq('org_id', orgId).eq('id', allocationId).neq('status', 'POSTED');
  const { data: a } = await db.from('job_labor_allocations')
    .select('id, status, gl_entry_id, allocated_cents, unallocated_cost_cents, unallocated_hours, accrual_reversed_cents, created_at, updated_at')
    .eq('org_id', orgId).eq('id', allocationId).maybeSingle();
  return a ? postedOutcome(a as AllocRow, true) : null;
}

async function markAccrualsTrued(db: DB, orgId: string, hoursRowIds: string[]): Promise<void> {
  if (hoursRowIds.length === 0) return;
  const w = writerFor(db);
  const { data } = await db.from('job_labor_hours').select('accrual_id, accrued_cents').eq('org_id', orgId).in('id', hoursRowIds);
  const byAccrual = new Map<string, number>();
  for (const r of (data ?? []) as { accrual_id: string | null; accrued_cents: number | string }[]) {
    if (!r.accrual_id) continue;
    byAccrual.set(r.accrual_id, (byAccrual.get(r.accrual_id) ?? 0) + num(r.accrued_cents));
  }
  for (const [id, add] of byAccrual) {
    const { data: acc } = await db.from('job_labor_accruals').select('amount_cents, trued_up_cents').eq('org_id', orgId).eq('id', id).maybeSingle();
    if (!acc) continue;
    const a = acc as { amount_cents: number | string; trued_up_cents: number | string };
    const trued = Math.min(num(a.amount_cents), num(a.trued_up_cents) + add);
    await w.from('job_labor_accruals').update({ trued_up_cents: trued, status: trued >= num(a.amount_cents) ? 'TRUED_UP' : 'PARTIAL', updated_at: new Date().toISOString() })
      .eq('org_id', orgId).eq('id', id);
  }
}

async function emitLaborJobCosts(
  db: DB,
  orgId: string,
  locationId: string,
  run: RunRow,
  rows: ReturnType<typeof allocateLabor>['rows'],
  withdrawn: Array<{ id: string; jobId: string; cents: number }>,
  glEntryId: string | null,
): Promise<void> {
  const agg = new Map<string, { jobId: string; costCodeId: string | null; costCode: string | null; dept: string | null; cents: number; hours: number }>();
  for (const r of rows) {
    const k = `${r.jobId}|${r.costCodeId ?? r.costCode ?? 'none'}`;
    const x = agg.get(k) ?? { jobId: r.jobId, costCodeId: r.costCodeId, costCode: r.costCode, dept: r.departmentId, cents: 0, hours: 0 };
    x.cents += r.amountCents;
    x.hours += r.hours;
    agg.set(k, x);
  }
  for (const x of agg.values()) {
    if (x.cents <= 0) continue;
    try {
      await emitJobCostEvent(db, {
        orgId, locationId, jobId: x.jobId, departmentId: x.dept, costType: 'LABOR', amountCents: x.cents, occurredOn: run.pay_date,
        lifecycle: 'CLEARED', gate: 'TIMESHEET_PAYROLL', sourceRef: `${payrollLaborSourceRef(run.id)}:${x.jobId}:${x.costCodeId ?? x.costCode ?? 'none'}`,
        glEntryId, memo: `Payroll labor ${run.period_start} – ${run.period_end} (${Math.round(x.hours * 100) / 100} h)`,
        ...(x.costCodeId ? { costCodeId: x.costCodeId } : x.costCode ? { costCode: x.costCode } : {}),
        description: 'Actual payroll cost allocated by hours',
      }, { writer: db });
    } catch (e) {
      console.error('[labor-allocation] JOB_COST emit failed', e instanceof Error ? e.message : e);
    }
  }
  // Accrual true-up: the estimate rows Projects received are voided now that actual cost has landed.
  const { data: accrued } = await db.from('job_labor_hours').select('id, job_id, accrued_cents, department_id, work_date')
    .eq('org_id', orgId).in('id', [...rows.filter((r) => r.accrualReversedCents > 0).map((r) => r.hoursRowId), ...withdrawn.map((w) => w.id)]);
  for (const h of (accrued ?? []) as { id: string; job_id: string; accrued_cents: number | string; department_id: string | null; work_date: string }[]) {
    if (num(h.accrued_cents) <= 0) continue;
    try {
      await emitJobCostEvent(db, {
        orgId, locationId, jobId: h.job_id, departmentId: h.department_id, costType: 'LABOR', amountCents: num(h.accrued_cents),
        occurredOn: h.work_date, lifecycle: 'VOIDED', gate: 'TIMESHEET_PAYROLL', sourceRef: laborAccrualCostRef(h.id), glEntryId,
        memo: 'Standard-rate labor estimate trued up to payroll',
      }, { writer: db });
    } catch (e) {
      console.error('[labor-allocation] accrual void emit failed', e instanceof Error ? e.message : e);
    }
  }
}

/** Posted payroll runs (Projects orgs) that have no allocation yet, or a FAILED one — the cron sweep. */
export async function payrollRunsAwaitingAllocation(db: DB, orgId: string, limit = 25): Promise<string[]> {
  const { data: runs } = await db.from('payroll_runs').select('id, gl_entry_id, pay_date').eq('org_id', orgId)
    .in('status', ['RELEASED', 'PROCESSING', 'PAID']).order('pay_date', { ascending: false }).limit(200);
  const posted = ((runs ?? []) as { id: string; gl_entry_id: string | null }[]).filter((r) => r.gl_entry_id).map((r) => r.id);
  if (posted.length === 0) return [];
  const { data: allocs } = await db.from('job_labor_allocations').select('payroll_run_id, status').eq('org_id', orgId).in('payroll_run_id', posted);
  const done = new Map(((allocs ?? []) as { payroll_run_id: string; status: string }[]).map((a) => [a.payroll_run_id, a.status]));
  return posted.filter((id) => !done.has(id) || done.get(id) === 'FAILED').slice(0, limit);
}
