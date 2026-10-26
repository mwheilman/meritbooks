/**
 * Payroll run state machine (GATE 12.3 Phase A — provider-agnostic).
 *
 * Owns the lifecycle of a payroll run inside the book of record:
 *
 *   DRAFT --preview--> PREVIEWED --approve--> APPROVED --release--> RELEASED
 *                                                                     |
 *                                                          (provider) v
 *                                                    PROCESSING --> PAID / FAILED
 *
 * Hard money-safety invariants (CANON §3, FPB-payroll §5/§12):
 *   1. The provider computes gross-to-net; Books never computes a tax.
 *   2. **Only releaseRun tells the provider to move money** (engine.submitRun).
 *      Every other step is read-only against the tenant's bank.
 *   3. Preparer ≠ approver — enforced here (early, explicit), in the approvals
 *      service (`approve()`), AND by a DB CHECK (migration 042). Fail closed.
 *   4. Release requires an APPROVED run and is an explicit, logged human action.
 *   5. The GL post is balanced (`recordPayrollRun` → `check_journal_balance()`)
 *      and idempotent (guarded on `gl_entry_id`).
 *
 * The PayrollEngine contract (previewRun / submitRun / getRunStatus) is owned by
 * the sibling module `@/lib/payroll/engine`; this file builds AGAINST it and does
 * not redefine it. The concrete engine is resolved lazily so this module — and
 * its unit tests — do not hard-depend on the engine implementation being present
 * (tests inject a fake). Type-only imports are erased at runtime.
 *
 * WRITES (migration 170): public.payroll_runs and public.payroll_run_employees are
 * SELECT-only for members, and the per-person amount columns are not member-readable
 * at all. Every function here that writes (createRun / previewRun / approveRun /
 * releaseRun / postRun) MUST be handed the SERVICE-ROLE client (`createAdminSupabase()`
 * from `@/lib/supabase/admin`) by a route that has already authorized the caller; every
 * query is pinned to the explicit `orgId`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  PayrollEngine,
  EmployeePayInput,
  EmployeePayResult,
  PayrollRunTotals,
  PayrollRunPreview,
} from '@/lib/payroll/engine/types';
import { recordPayrollRun, recordPayrollRemittance, type PayrollComponent } from '@/lib/posting/payroll';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';

type DB = SupabaseClient;

// ── Status model ────────────────────────────────────────────────────────────
// Mirrors the public.payroll_runs.status CHECK (migration 069).

export type RunStatus =
  | 'DRAFT'
  | 'PREVIEWED'
  | 'APPROVED'
  | 'RELEASED'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'CANCELED';

/**
 * Legal transitions. Note the money boundary: once RELEASED the run can only
 * move forward under provider control (PROCESSING/PAID/FAILED) — it can NEVER be
 * canceled or edited, because the money is already in flight. Cancellation is
 * only possible while nothing has been released.
 */
export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  DRAFT: ['PREVIEWED', 'CANCELED'],
  PREVIEWED: ['PREVIEWED', 'APPROVED', 'DRAFT', 'CANCELED'],
  APPROVED: ['RELEASED', 'CANCELED'],
  RELEASED: ['PROCESSING', 'PAID', 'FAILED'],
  PROCESSING: ['PAID', 'FAILED'],
  PAID: [],
  FAILED: [],
  CANCELED: [],
};

/** Statuses at/after which the money has been committed to the provider. The GL
 * expense is recognized here — postRun is allowed only once release has happened. */
export const POSTABLE_STATUSES: readonly RunStatus[] = ['RELEASED', 'PROCESSING', 'PAID'];

export class InvalidRunTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`Invalid payroll run transition ${from} -> ${to}`);
    this.name = 'InvalidRunTransitionError';
  }
}

export class RunPreparerCannotApproveError extends Error {
  constructor() {
    super('The payroll run approver/releaser cannot be its preparer (separation of duties).');
    this.name = 'RunPreparerCannotApproveError';
  }
}

export class RunReleaserCannotApproveError extends Error {
  constructor() {
    super('The payroll run releaser cannot be its approver (separation of duties).');
    this.name = 'RunReleaserCannotApproveError';
  }
}

export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStateError';
  }
}

/** Another release of the same run holds the approval claim (or already released it). */
export class RunReleaseConflictError extends Error {
  constructor() {
    super('This payroll run is already being released (or was released) by someone else.');
    this.name = 'RunReleaseConflictError';
  }
}

/** What was approved no longer matches what would be released (lines / amounts changed). */
export class RunTamperedError extends Error {
  constructor(detail: string) {
    super(`This payroll run changed after it was approved (${detail}). Preview and approve it again before releasing.`);
    this.name = 'RunTamperedError';
  }
}

/**
 * The provider accepted the release (money is moving) but Books could not record it.
 * Never retried automatically and never rolled back — an operator must reconcile it.
 */
export class RunReleaseRecordingError extends Error {
  readonly providerRunId: string;
  constructor(providerRunId: string, cause: string) {
    super(`Payroll was released to the provider (run ${providerRunId}) but recording the release failed: ${cause}. Do not release again — contact support to reconcile.`);
    this.name = 'RunReleaseRecordingError';
    this.providerRunId = providerRunId;
  }
}

// ── Approved-lines fingerprint ──────────────────────────────────────────────

/** The per-employee amounts a release commits to (payroll_run_employees money columns). */
export interface PayrollLineAmounts {
  employee_id: string | null;
  gross_cents: number | string | null;
  net_cents: number | string | null;
  employee_tax_cents: number | string | null;
  employer_tax_cents: number | string | null;
  deductions_cents: number | string | null;
  benefits_cents: number | string | null;
}

const n0 = (v: number | string | null | undefined): number => Number(v ?? 0);

/**
 * SHA-256 over the canonical, order-independent form of the run's per-employee
 * amounts. Stored on the approval at approve time and re-checked at release, so the
 * lines that move money are exactly the lines that were approved.
 */
export async function payrollLinesDigest(rows: readonly PayrollLineAmounts[]): Promise<string> {
  const canon = rows
    .map((r) => [r.employee_id ?? '', n0(r.gross_cents), n0(r.net_cents), n0(r.employee_tax_cents),
      n0(r.employer_tax_cents), n0(r.deductions_cents), n0(r.benefits_cents)].join('|'))
    .sort()
    .join('\n');
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const LINE_AMOUNT_COLUMNS =
  'employee_id, gross_cents, net_cents, employee_tax_cents, employer_tax_cents, deductions_cents, benefits_cents';

async function loadLineAmounts(db: DB, orgId: string, runId: string): Promise<PayrollLineAmounts[]> {
  const { data, error } = await db
    .from('payroll_run_employees')
    .select(LINE_AMOUNT_COLUMNS)
    .eq('org_id', orgId)
    .eq('payroll_run_id', runId);
  if (error) throw new RunStateError(`Failed to read run lines: ${error.message}`);
  return (data ?? []) as PayrollLineAmounts[];
}

/** Pure guard — throws `InvalidRunTransitionError` on an illegal transition. */
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!RUN_TRANSITIONS[from]?.includes(to)) {
    throw new InvalidRunTransitionError(from, to);
  }
}

// ── Row shapes ──────────────────────────────────────────────────────────────

export interface PayrollRunRow {
  id: string;
  org_id: string;
  location_id: string | null;
  pay_schedule_id: string | null;
  provider: string | null;
  provider_run_id: string | null;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: RunStatus;
  gross_cents: number;
  net_cents: number;
  employer_tax_cents: number;
  employee_tax_cents: number;
  benefits_cents: number;
  deductions_cents: number;
  approval_id: string | null;
  gl_entry_id: string | null;
  prepared_by: string | null;
  approved_by: string | null;
  released_by: string | null;
  memo: string | null;
}

/**
 * Client scope for service-role writes (mig 170). The service role bypasses 163's
 * RESTRICTIVE client-scope policy, so before a route writes a run with the admin client
 * it confirms — on the CALLER's RLS client — that the caller can see the run (or, for a
 * new run, its company). false → the route answers 404.
 */
export async function runVisibleToCaller(callerDb: DB, orgId: string, runId: string): Promise<boolean> {
  const { data, error } = await callerDb.from('payroll_runs').select('id').eq('org_id', orgId).eq('id', runId).maybeSingle();
  return !error && !!data;
}

export async function companyVisibleToCaller(callerDb: DB, orgId: string, locationId: string): Promise<boolean> {
  const { data, error } = await callerDb.schema('core').from('locations').select('id').eq('org_id', orgId).eq('id', locationId).maybeSingle();
  return !error && !!data;
}

async function getRun(db: DB, orgId: string, runId: string): Promise<PayrollRunRow> {
  const { data, error } = await db
    .from('payroll_runs')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', runId)
    .single();
  if (error || !data) throw new RunStateError(`Payroll run ${runId} not found`);
  return data as PayrollRunRow;
}

// ── createRun ───────────────────────────────────────────────────────────────

export interface CreateRunInput {
  locationId: string;
  payScheduleId?: string | null;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  memo?: string | null;
  /** The Clerk user id of the runner — recorded as `prepared_by` so SoD can later
   * refuse to let this same human approve/release the run. */
  preparedBy: string;
  employeeInputs: EmployeePayInput[];
}

/** Insert a DRAFT run + its per-employee input rows. No money math, no provider. */
export async function createRun(db: DB, orgId: string, input: CreateRunInput): Promise<PayrollRunRow> {
  if (!input.employeeInputs.length) throw new RunStateError('A run needs at least one employee');

  // Service-role write (mig 170): every employee must be a person of THIS tenant.
  const employeeIds = [...new Set(input.employeeInputs.map((e) => e.employeeId))];
  const { data: emps, error: empErr } = await db
    .schema('core').from('employees').select('id').eq('org_id', orgId).in('id', employeeIds);
  if (empErr) throw new RunStateError(`Failed to verify employees: ${empErr.message}`);
  if (((emps ?? []) as Array<{ id: string }>).length !== employeeIds.length) {
    throw new RunStateError('One or more employees are not in this organization');
  }

  const { data: run, error } = await db
    .from('payroll_runs')
    .insert({
      org_id: orgId,
      location_id: input.locationId,
      pay_schedule_id: input.payScheduleId ?? null,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      pay_date: input.payDate,
      status: 'DRAFT',
      prepared_by: input.preparedBy,
      memo: input.memo ?? null,
    })
    .select('*')
    .single();
  if (error || !run) throw new RunStateError(`Failed to create payroll run: ${error?.message ?? 'unknown'}`);

  const runRow = run as PayrollRunRow;
  await insertRunEmployees(db, orgId, runRow.id, input.employeeInputs);
  return runRow;
}

/** Persist the per-employee input rows (draft state — amounts default to 0 until
 * the provider preview fills them in). Replaces any existing rows for the run. */
async function insertRunEmployees(
  db: DB,
  orgId: string,
  runId: string,
  inputs: EmployeePayInput[],
): Promise<void> {
  const { error: delErr } = await db.from('payroll_run_employees').delete().eq('org_id', orgId).eq('payroll_run_id', runId);
  if (delErr) throw new RunStateError(`Failed to reset run employees: ${delErr.message}`);
  const rows = inputs.map((e) => ({
    org_id: orgId,
    payroll_run_id: runId,
    employee_id: e.employeeId,
    hours: e.hours ?? null,
    earnings: e.earnings ?? [],
  }));
  const { error } = await db.from('payroll_run_employees').insert(rows);
  if (error) throw new RunStateError(`Failed to persist run employees: ${error.message}`);
}

// ── previewRun ──────────────────────────────────────────────────────────────

/** Map an engine total object onto the payroll_runs money columns. Centralized so
 * the (sibling-owned) contract has a single persistence seam. */
function totalsToRunColumns(t: PayrollRunTotals) {
  return {
    gross_cents: t.grossCents,
    net_cents: t.netCents,
    employer_tax_cents: t.employerTaxCents,
    employee_tax_cents: t.employeeTaxCents,
    benefits_cents: t.benefitsCents,
    deductions_cents: t.deductionsCents,
  };
}

function resultToEmployeeRow(orgId: string, runId: string, r: EmployeePayResult) {
  return {
    org_id: orgId,
    payroll_run_id: runId,
    employee_id: r.employeeId,
    gross_cents: r.grossCents,
    net_cents: r.netCents,
    employee_tax_cents: r.employeeTaxCents,
    employer_tax_cents: r.employerTaxCents,
    deductions_cents: r.deductionsCents,
    benefits_cents: r.benefitsCents,
    hours: r.hours ?? null,
    earnings: r.earnings ?? [],
    provider_ref: r.providerRef ?? null,
  };
}

async function loadEngine(db: DB, orgId: string, injected?: PayrollEngine): Promise<PayrollEngine> {
  if (injected) return injected;
  // Lazy so this module (and its unit tests) don't hard-depend on the engine
  // implementation existing at import time — the sibling owns it.
  const { resolvePayrollEngine } = await import('@/lib/payroll/engine');
  return resolvePayrollEngine(db, orgId);
}

/**
 * Ask the provider engine for the gross-to-net preview, persist the per-employee
 * results + the run totals, and move DRAFT/PREVIEWED -> PREVIEWED. **No money
 * moves.** `engine` is injectable for tests.
 */
export async function previewRun(
  db: DB,
  orgId: string,
  runId: string,
  _actor: string,
  engine?: PayrollEngine,
): Promise<PayrollRunRow> {
  const run = await getRun(db, orgId, runId);
  assertRunTransition(run.status, 'PREVIEWED');

  const eng = await loadEngine(db, orgId, engine);
  const { data: empInputs } = await db
    .from('payroll_run_employees')
    .select('employee_id, hours, earnings')
    .eq('org_id', orgId)
    .eq('payroll_run_id', runId);

  const inputs: EmployeePayInput[] = ((empInputs ?? []) as Array<{
    employee_id: string;
    hours: number | null;
    earnings: unknown;
  }>).map((e) => ({
    employeeId: e.employee_id,
    hours: e.hours ?? undefined,
    earnings: (e.earnings as EmployeePayInput['earnings']) ?? [],
  }));

  const preview = await eng.previewRun({
    periodStart: run.period_start,
    periodEnd: run.period_end,
    payDate: run.pay_date,
    employees: inputs,
  });

  // Persist per-employee results (replace) + run totals.
  const { error: delErr } = await db.from('payroll_run_employees').delete().eq('org_id', orgId).eq('payroll_run_id', runId);
  if (delErr) throw new RunStateError(`Failed to reset preview results: ${delErr.message}`);
  if (preview.employees.length) {
    const { error: insErr } = await db
      .from('payroll_run_employees')
      .insert(preview.employees.map((r) => resultToEmployeeRow(orgId, runId, r)));
    if (insErr) throw new RunStateError(`Failed to persist preview results: ${insErr.message}`);
  }

  const { data: updated, error } = await db
    .from('payroll_runs')
    .update({ status: 'PREVIEWED', ...totalsToRunColumns(preview.totals), updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', runId)
    .in('status', ['DRAFT', 'PREVIEWED']) // never re-price an approved / released run
    .select('*')
    .single();
  if (error || !updated) throw new RunStateError(`Failed to persist preview totals: ${error?.message ?? 'unknown'}`);
  return updated as PayrollRunRow;
}

// ── approveRun ──────────────────────────────────────────────────────────────

/**
 * Route the run through the money-movement approvals engine (kind PAYROLL_RUN)
 * and mark it APPROVED. Enforces preparer ≠ approver up front (RunPreparer...),
 * then defers to `approve()` which re-checks SoD, checks approval authority
 * (canApprove, reconciled to core identity), and is backstopped by a DB CHECK.
 *
 * **No money moves here** — approval authorizes the amount; release moves it.
 */
export async function approveRun(
  db: DB,
  orgId: string,
  runId: string,
  approverClerkId: string,
): Promise<PayrollRunRow> {
  const run = await getRun(db, orgId, runId);
  assertRunTransition(run.status, 'APPROVED');

  const preparedBy = run.prepared_by;
  if (!preparedBy) throw new RunStateError('Run has no preparer recorded; cannot enforce separation of duties');
  // Early, explicit SoD guard (defense in depth on top of approve() + DB CHECK).
  if (approverClerkId === preparedBy) throw new RunPreparerCannotApproveError();

  const { createApproval, submitForApproval, approve } = await import('@/lib/money/approvals');

  // Fingerprint EXACTLY what is being approved; releaseRun re-checks it.
  const lines = await loadLineAmounts(db, orgId, runId);
  if (lines.length === 0) throw new RunStateError('The run has no previewed lines to approve');
  const digest = await payrollLinesDigest(lines);

  // Prepare -> submit -> approve. The approval's preparedBy is the RUN preparer so
  // the SoD CHECK compares the approver against the true preparer, not the caller.
  const approval = await createApproval(db, orgId, {
    kind: 'PAYROLL_RUN',
    subjectTable: 'payroll_runs',
    subjectId: runId,
    amountCents: run.gross_cents,
    preparedBy,
    metadata: { lines_digest: digest, line_count: lines.length, net_cents: run.net_cents, gross_cents: run.gross_cents },
  });
  await submitForApproval(db, orgId, approval.id, preparedBy);
  await approve(db, orgId, approval.id, approverClerkId); // throws on SoD / not-authorized

  const { data: updated, error } = await db
    .from('payroll_runs')
    .update({ status: 'APPROVED', approved_by: approverClerkId, approval_id: approval.id, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', runId)
    .eq('status', 'PREVIEWED') // compare-and-set: a concurrent change loses
    .select('*')
    .maybeSingle();
  if (error || !updated) throw new RunStateError(`Failed to mark run approved: ${error?.message ?? 'the run changed meanwhile'}`);
  return updated as PayrollRunRow;
}

// ── releaseRun (THE ONLY MONEY-MOVEMENT STEP) ───────────────────────────────

/**
 * Release funding. **This is the single step that instructs the provider to move
 * money** (engine.submitRun debits the tenant's bank and pays employees/agencies).
 *
 * The AUTHORITY is the money-approval record (public.approvals, kind PAYROLL_RUN),
 * not the run's own columns:
 *   1. the run must be APPROVED and linked to an APPROVED PAYROLL_RUN approval for
 *      THIS run whose preparer / approver / amount match the run;
 *   2. separation of duties: the releaser is neither the preparer nor the approver
 *      (strict for payroll — sole-approver mode does not relax it), re-checked by
 *      assertReleaseSod inside the claim and by the DB release guard (mig 165);
 *   3. the per-employee lines still hash to the digest stored at approval and sum
 *      to the run totals — what moves is exactly what was approved;
 *   4. the approval is CLAIMED (APPROVED → RELEASED compare-and-set) BEFORE the
 *      provider is called, so two concurrent releases can never both pay;
 *   5. if the provider call fails the claim is reverted (back to APPROVED, retryable);
 *      once the provider accepted, the claim is finalized FIRST (provider reference
 *      stamped — irreversible) and only then is the run marked RELEASED. Nothing is
 *      swallowed: a recording failure after money moved raises RunReleaseRecordingError.
 *
 * Async provider progress (RELEASED -> PROCESSING/PAID/FAILED) is driven later by a
 * status-sync / webhook step (engine.getRunStatus, Phase B).
 */
export async function releaseRun(
  db: DB,
  orgId: string,
  runId: string,
  releaserClerkId: string,
  engine?: PayrollEngine,
): Promise<PayrollRunRow> {
  const run = await getRun(db, orgId, runId);
  assertRunTransition(run.status, 'RELEASED');

  // Separation of duties on the run's recorded parties — fail closed BEFORE any
  // further read, claim or provider call.
  if (run.prepared_by && run.prepared_by === releaserClerkId) throw new RunPreparerCannotApproveError();
  if (run.approved_by && run.approved_by === releaserClerkId) throw new RunReleaserCannotApproveError();
  if (!run.approval_id) throw new RunStateError('This run has no approval on record; approve it before releasing');

  const approvals = await import('@/lib/money/approvals');
  const approval = await approvals.loadApproval(orgId, run.approval_id);
  if (!approval) throw new RunStateError('The approval for this run was not found');
  if (approval.kind !== 'PAYROLL_RUN' || approval.subjectTable !== 'payroll_runs' || approval.subjectId !== runId) {
    throw new RunTamperedError('the approval on record belongs to something else');
  }
  if (approval.status !== 'APPROVED') {
    if (approval.status === 'RELEASED') throw new RunReleaseConflictError();
    throw new RunStateError(`The approval for this run is ${approval.status}, not APPROVED`);
  }
  if (!approval.approvedBy) throw new RunStateError('The approval for this run has no approver');
  if (approval.preparedBy !== run.prepared_by || approval.approvedBy !== run.approved_by) {
    throw new RunTamperedError('preparer or approver differs from the approval record');
  }
  if (approval.amountCents !== null && Number(approval.amountCents) !== Number(run.gross_cents)) {
    throw new RunTamperedError('gross pay differs from the approved amount');
  }
  // Strict H6 on the AUTHORITATIVE parties (the run row is only a mirror).
  if (approval.preparedBy === releaserClerkId) throw new RunPreparerCannotApproveError();
  if (approval.approvedBy === releaserClerkId) throw new RunReleaserCannotApproveError();

  // Rebuild the previewed run (persisted at preview time) into the engine's
  // PayrollRunPreview shape — submitRun commits exactly what was reviewed/approved.
  const { data: empData, error: empErr } = await db
    .from('payroll_run_employees')
    .select('employee_id, gross_cents, net_cents, employee_tax_cents, employer_tax_cents, deductions_cents, benefits_cents, provider_ref')
    .eq('org_id', orgId)
    .eq('payroll_run_id', runId);
  if (empErr) throw new RunStateError(`Failed to read run lines: ${empErr.message}`);
  const empRows = (empData ?? []) as Array<PayrollLineAmounts & { provider_ref: string | null }>;
  if (empRows.length === 0) throw new RunStateError('The run has no lines to release');

  const sumGross = empRows.reduce((s, r) => s + n0(r.gross_cents), 0);
  const sumNet = empRows.reduce((s, r) => s + n0(r.net_cents), 0);
  if (sumGross !== Number(run.gross_cents) || sumNet !== Number(run.net_cents)) {
    throw new RunTamperedError('per-employee lines no longer add up to the run totals');
  }
  const approvedDigest = typeof approval.metadata.lines_digest === 'string' ? approval.metadata.lines_digest : null;
  if (approvedDigest && approvedDigest !== (await payrollLinesDigest(empRows))) {
    throw new RunTamperedError('per-employee lines differ from the approved lines');
  }

  // Resolve the provider BEFORE claiming, so a setup error never churns the claim.
  const eng = await loadEngine(db, orgId, engine);

  // >>> claim the money approval (the DB is the concurrency guarantor) <<<
  const claim = await approvals.claimApprovalForRelease(db, orgId, run.approval_id, releaserClerkId, {
    preparedBy: approval.preparedBy,
    approvedBy: approval.approvedBy,
  });
  if (claim !== 'CLAIMED') throw new RunReleaseConflictError();

  const preview: PayrollRunPreview = {
    employees: empRows.map((r) => ({
      employeeId: String(r.employee_id ?? ''),
      grossCents: n0(r.gross_cents),
      netCents: n0(r.net_cents),
      employeeTaxCents: n0(r.employee_tax_cents),
      employerTaxCents: n0(r.employer_tax_cents),
      deductionsCents: n0(r.deductions_cents),
      benefitsCents: n0(r.benefits_cents),
      providerRef: r.provider_ref ? String(r.provider_ref) : undefined,
    })),
    totals: {
      grossCents: run.gross_cents,
      netCents: run.net_cents,
      employeeTaxCents: run.employee_tax_cents,
      employerTaxCents: run.employer_tax_cents,
      deductionsCents: run.deductions_cents,
      benefitsCents: run.benefits_cents,
    },
  };

  // >>> the money moves here <<<
  let providerRunId: string;
  try {
    const submitted = await eng.submitRun({
      providerRunId: run.provider_run_id ?? undefined,
      preview,
      periodStart: run.period_start,
      periodEnd: run.period_end,
      payDate: run.pay_date,
    });
    providerRunId = submitted.providerRunId;
    if (!providerRunId) throw new RunStateError('The payroll provider returned no run reference');
  } catch (e) {
    // Nothing was released: hand the claim back so the run can be retried.
    await approvals.revertReleaseClaim(db, orgId, run.approval_id);
    throw e;
  }

  // Money is in flight. Make the claim irreversible FIRST (provider reference stamped +
  // immutable RELEASED audit step), then mirror it on the run. Never swallowed.
  try {
    await approvals.finalizeReleaseClaim(db, orgId, run.approval_id, releaserClerkId, providerRunId);
  } catch (e) {
    throw new RunReleaseRecordingError(providerRunId, e instanceof Error ? e.message : String(e));
  }

  const { data: updated, error } = await db
    .from('payroll_runs')
    .update({
      status: 'RELEASED',
      released_by: releaserClerkId,
      provider_run_id: providerRunId,
      provider: eng.name ?? run.provider ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', orgId)
    .eq('id', runId)
    .eq('status', 'APPROVED')
    .select('*')
    .maybeSingle();
  if (error || !updated) {
    throw new RunReleaseRecordingError(providerRunId, error?.message ?? 'the run was no longer APPROVED');
  }
  return updated as PayrollRunRow;
}

// ── postRun (balanced GL, idempotent) ───────────────────────────────────────

export interface PayrollPostingAccountIds {
  wagesExpenseId: string;
  payrollTaxExpenseId: string;
  paymentsInTransitId: string;
  federalTaxPayableId: string;
  benefitsPayableId: string;
  garnishmentPayableId: string;
  employerTaxPayableId: string;
}

export interface PayrollPostingLines {
  grossWagesCents: number;
  withholdings: PayrollComponent[];
  employerTaxExpenses: PayrollComponent[];
  employerTaxLiabilities: PayrollComponent[];
  /** net = gross − Σ withholdings; recomputed here for assertion/tests. */
  netPayCents: number;
}

/**
 * PURE: build the balanced posting components from the run's aggregate totals.
 *
 * DR gross wages + DR employer tax  ==  CR net pay + CR employee withholding
 *   + CR benefits + CR deductions + CR employer-tax liability.
 *
 * Phase A posts from the run-level aggregate; per-employee dimensioned lines
 * (job/dept/class) are a documented follow-up — the granular data is retained on
 * payroll_run_employees. Zero-value components are omitted so the entry stays
 * minimal (and always ≥ 2 lines via gross + net).
 */
export function buildPayrollPostingLines(
  totals: Pick<PayrollRunTotals, 'grossCents' | 'employeeTaxCents' | 'employerTaxCents' | 'benefitsCents' | 'deductionsCents'>,
  accounts: PayrollPostingAccountIds,
): PayrollPostingLines {
  const withholdings: PayrollComponent[] = [];
  if (totals.employeeTaxCents > 0)
    withholdings.push({ account_id: accounts.federalTaxPayableId, amount_cents: totals.employeeTaxCents, memo: 'Employee tax withholding' });
  if (totals.benefitsCents > 0)
    withholdings.push({ account_id: accounts.benefitsPayableId, amount_cents: totals.benefitsCents, memo: 'Employee benefit deduction' });
  if (totals.deductionsCents > 0)
    withholdings.push({ account_id: accounts.garnishmentPayableId, amount_cents: totals.deductionsCents, memo: 'Employee deductions / garnishments' });

  const employerTaxExpenses: PayrollComponent[] = [];
  const employerTaxLiabilities: PayrollComponent[] = [];
  if (totals.employerTaxCents > 0) {
    employerTaxExpenses.push({ account_id: accounts.payrollTaxExpenseId, amount_cents: totals.employerTaxCents, memo: 'Employer payroll tax' });
    employerTaxLiabilities.push({ account_id: accounts.employerTaxPayableId, amount_cents: totals.employerTaxCents, memo: 'Employer payroll tax payable' });
  }

  const netPayCents = totals.grossCents - withholdings.reduce((s, w) => s + w.amount_cents, 0);
  return { grossWagesCents: totals.grossCents, withholdings, employerTaxExpenses, employerTaxLiabilities, netPayCents };
}

const POSTING_ROLES: Record<keyof PayrollPostingAccountIds, AccountRoleKey> = {
  wagesExpenseId: 'WAGES_EXPENSE',
  payrollTaxExpenseId: 'PAYROLL_TAX_EXPENSE',
  paymentsInTransitId: 'PAYMENTS_IN_TRANSIT',
  federalTaxPayableId: 'FEDERAL_TAX_PAYABLE',
  benefitsPayableId: 'HEALTH_INSURANCE_PAYABLE',
  garnishmentPayableId: 'GARNISHMENT_PAYABLE',
  employerTaxPayableId: 'FICA_PAYABLE',
};

async function resolvePostingAccounts(db: DB, orgId: string, locationId: string): Promise<PayrollPostingAccountIds> {
  const entries = await Promise.all(
    (Object.keys(POSTING_ROLES) as Array<keyof PayrollPostingAccountIds>).map(async (k) => {
      const ref = await resolveRole(db, orgId, POSTING_ROLES[k], locationId);
      return [k, ref.id] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as PayrollPostingAccountIds;
}

export interface PostRunResult {
  glEntryId: string;
  alreadyPosted: boolean;
}

/**
 * Post the run to the GL from its aggregate totals — balanced, PAYROLL_RUN
 * entry_type, and **idempotent**: if `gl_entry_id` is already set it returns that
 * without posting again (the DB is the single source of the double-post guard).
 * Allowed only once the run has been released (money committed).
 */
export async function postRun(db: DB, orgId: string, runId: string): Promise<PostRunResult> {
  const run = await getRun(db, orgId, runId);

  // Idempotency: never double-post.
  if (run.gl_entry_id) return { glEntryId: run.gl_entry_id, alreadyPosted: true };

  if (!POSTABLE_STATUSES.includes(run.status)) {
    throw new RunStateError(`Cannot post a payroll run in status ${run.status}; it must be released first`);
  }
  if (!run.location_id) {
    throw new PostingError('Payroll run has no location; a location is required to resolve the fiscal period and cost dimensions');
  }

  const accounts = await resolvePostingAccounts(db, orgId, run.location_id);
  const lines = buildPayrollPostingLines(
    {
      grossCents: run.gross_cents,
      employeeTaxCents: run.employee_tax_cents,
      employerTaxCents: run.employer_tax_cents,
      benefitsCents: run.benefits_cents,
      deductionsCents: run.deductions_cents,
    },
    accounts,
  );

  const result = await recordPayrollRun(db, {
    orgId,
    locationId: run.location_id,
    payDate: run.pay_date,
    grossWagesAccountId: accounts.wagesExpenseId,
    grossWagesCents: lines.grossWagesCents,
    withholdings: lines.withholdings,
    employerTaxExpenses: lines.employerTaxExpenses,
    employerTaxLiabilities: lines.employerTaxLiabilities,
    netPayAccountId: accounts.paymentsInTransitId,
  });
  if (!result.gl_entry_id) throw new PostingError('Payroll GL post returned no entry id');

  // Persist the GL link. Re-guard on gl_entry_id IS NULL so a concurrent post
  // cannot overwrite (belt-and-suspenders with the app-level idempotency check).
  const { error } = await db
    .from('payroll_runs')
    .update({ gl_entry_id: result.gl_entry_id, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', runId)
    .is('gl_entry_id', null);
  if (error) throw new RunStateError(`Failed to link GL entry to run: ${error.message}`);

  // Projects seam (migration 194): for a client that uses Merit Projects, allocate this run's
  // actual labor cost to jobs by approved hours. Best effort — the payroll post stands on its
  // own; a failure is recorded on job_labor_allocations and retried by the seam cron.
  try {
    const { allocateLaborForRun } = await import('@/lib/projects-seam/labor-allocation');
    await allocateLaborForRun(db, orgId, runId);
  } catch (e) {
    console.error('[payroll] job labor allocation deferred:', e instanceof Error ? e.message : e);
  }

  return { glEntryId: result.gl_entry_id, alreadyPosted: false };
}

// ── remitRun (clear the run's payroll payables against cash) ─────────────────

/**
 * The payroll-payable roles a remittance clears, paired with the run's aggregate
 * column that funded each. This mirrors buildPayrollPostingLines' liability side
 * exactly, so a remittance DRs back precisely what postRun CR'd — after remitting,
 * these five payables net to zero for the run:
 *
 *   FEDERAL_TAX_PAYABLE       ← employee_tax_cents  (employee income-tax withholding)
 *   FICA_PAYABLE              ← employer_tax_cents  (employer payroll tax)
 *   HEALTH_INSURANCE_PAYABLE  ← benefits_cents      (employee benefit deductions)
 *   GARNISHMENT_PAYABLE       ← deductions_cents    (garnishments / other deductions)
 */
const REMIT_LIABILITY_ROLES: ReadonlyArray<{ role: AccountRoleKey; column: keyof Pick<PayrollRunRow, 'employee_tax_cents' | 'employer_tax_cents' | 'benefits_cents' | 'deductions_cents'>; memo: string }> = [
  { role: 'FEDERAL_TAX_PAYABLE', column: 'employee_tax_cents', memo: 'Remit employee tax withholding' },
  { role: 'FICA_PAYABLE', column: 'employer_tax_cents', memo: 'Remit employer payroll tax' },
  { role: 'HEALTH_INSURANCE_PAYABLE', column: 'benefits_cents', memo: 'Remit employee benefit deductions' },
  { role: 'GARNISHMENT_PAYABLE', column: 'deductions_cents', memo: 'Remit garnishments / deductions' },
];

/** Stable per-run idempotency key for a payroll remittance entry. */
export function remittanceSourceRef(runId: string): string {
  return `payroll_remit:${runId}`;
}

export interface RemitRunResult {
  glEntryId: string | null;
  totalCents: number;
  alreadyRemitted: boolean;
}

/**
 * Record a remittance of a posted run's payroll payables: DR each payable (resolved
 * by ROLE) / CR cash for the total. Balanced, and **idempotent per run** via the
 * stable source_ref `payroll_remit:<runId>` — migration 064's UNIQUE(org_id,
 * source_ref, entry_type) is the DB double-post guarantor, so a concurrent or
 * repeated remittance cannot double-credit cash.
 *
 * Only allowed once the run has been posted to the GL (its payables must exist to be
 * cleared). No provider/money-movement API is called here — this books the accounting
 * of a tax/benefit payment (the cash actually leaves via the tenant's bank/EFTPS).
 */
export async function remitRun(db: DB, orgId: string, runId: string): Promise<RemitRunResult> {
  const run = await getRun(db, orgId, runId);

  if (!run.gl_entry_id) {
    throw new RunStateError('Post the payroll run to the GL before remitting its payables');
  }
  if (!run.location_id) {
    throw new PostingError('Payroll run has no location; a location is required to resolve accounts and the fiscal period');
  }

  const sourceRef = remittanceSourceRef(runId);

  // Idempotency pre-check (the 064 unique index is the hard race guarantor).
  const { data: existing } = await db
    .from('gl_entries')
    .select('id')
    .eq('org_id', orgId)
    .eq('source_ref', sourceRef)
    .eq('status', 'POSTED')
    .limit(1)
    .maybeSingle();
  if (existing) {
    return { glEntryId: (existing as { id: string }).id, totalCents: 0, alreadyRemitted: true };
  }

  // Resolve the payable accounts by role and build the liability components from the
  // run's aggregate columns (skipping zero-value payables).
  const liabilities: PayrollComponent[] = [];
  for (const spec of REMIT_LIABILITY_ROLES) {
    const amount = Number(run[spec.column] ?? 0);
    if (amount <= 0) continue;
    const ref = await resolveRole(db, orgId, spec.role, run.location_id);
    liabilities.push({ account_id: ref.id, amount_cents: amount, memo: spec.memo });
  }

  if (liabilities.length === 0) {
    throw new RunStateError('This run has no payroll payables to remit');
  }

  const result = await recordPayrollRemittance(db, {
    orgId,
    locationId: run.location_id,
    payDate: run.pay_date,
    liabilities,
    // Default rail (ach) resolves to OPERATING_BANK for the cash credit.
    memo: `Payroll remittance — run ${runId}`,
    sourceRef,
  });

  return { glEntryId: result.gl_entry_id, totalCents: result.total_cents, alreadyRemitted: false };
}
