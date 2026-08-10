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
  await db.from('payroll_run_employees').delete().eq('org_id', orgId).eq('payroll_run_id', runId);
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
  await db.from('payroll_run_employees').delete().eq('org_id', orgId).eq('payroll_run_id', runId);
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

  // Prepare -> submit -> approve. The approval's preparedBy is the RUN preparer so
  // the SoD CHECK compares the approver against the true preparer, not the caller.
  const approval = await createApproval(db, orgId, {
    kind: 'PAYROLL_RUN',
    subjectTable: 'payroll_runs',
    subjectId: runId,
    amountCents: run.gross_cents,
    preparedBy,
  });
  await submitForApproval(db, orgId, approval.id, preparedBy);
  await approve(db, orgId, approval.id, approverClerkId); // throws on SoD / not-authorized

  const { data: updated, error } = await db
    .from('payroll_runs')
    .update({ status: 'APPROVED', approved_by: approverClerkId, approval_id: approval.id, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', runId)
    .select('*')
    .single();
  if (error || !updated) throw new RunStateError(`Failed to mark run approved: ${error?.message ?? 'unknown'}`);
  return updated as PayrollRunRow;
}

// ── releaseRun (THE ONLY MONEY-MOVEMENT STEP) ───────────────────────────────

/**
 * Release funding. **This is the single step that instructs the provider to move
 * money** (engine.submitRun debits the tenant's bank and pays employees/agencies).
 * Requires an APPROVED run and an explicit human actor (the route additionally
 * gates payroll:approve). Records the provider run id + releaser and advances the
 * approval to RELEASED.
 *
 * Post-condition is exactly RELEASED (the asserted transition). Async provider
 * progress (RELEASED -> PROCESSING/PAID/FAILED) is driven later by a status-sync
 * / webhook step (engine.getRunStatus, Phase B), never guessed synchronously
 * here. Fail closed: if submitRun throws, the run stays APPROVED and no money
 * state is recorded.
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

  // Separation of duties: the human releasing the money cannot be the one who
  // approved it (mirrors the AP releaser != preparer check on /ap/disbursements).
  // Fail closed BEFORE any provider call — no money moves on an SoD violation.
  if (run.approved_by && run.approved_by === releaserClerkId) {
    throw new RunReleaserCannotApproveError();
  }

  const eng = await loadEngine(db, orgId, engine);

  // Rebuild the previewed run (persisted at preview time) into the engine's
  // PayrollRunPreview shape — submitRun commits exactly what was reviewed/approved.
  const { data: empRows } = await db
    .from('payroll_run_employees')
    .select('employee_id, gross_cents, net_cents, employee_tax_cents, employer_tax_cents, deductions_cents, benefits_cents, provider_ref')
    .eq('org_id', orgId)
    .eq('payroll_run_id', runId);
  const preview: PayrollRunPreview = {
    employees: ((empRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      employeeId: String(r.employee_id ?? ''),
      grossCents: Number(r.gross_cents ?? 0),
      netCents: Number(r.net_cents ?? 0),
      employeeTaxCents: Number(r.employee_tax_cents ?? 0),
      employerTaxCents: Number(r.employer_tax_cents ?? 0),
      deductionsCents: Number(r.deductions_cents ?? 0),
      benefitsCents: Number(r.benefits_cents ?? 0),
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
  const submitted = await eng.submitRun({
    providerRunId: run.provider_run_id ?? undefined,
    preview,
    periodStart: run.period_start,
    periodEnd: run.period_end,
    payDate: run.pay_date,
  });

  const providerRunId = submitted.providerRunId;

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
    .select('*')
    .single();
  if (error || !updated) throw new RunStateError(`Failed to mark run released: ${error?.message ?? 'unknown'}`);

  // Advance the approval to RELEASED (records releaser + provider correlation id).
  if (run.approval_id) {
    const { markReleased } = await import('@/lib/money/approvals');
    await markReleased(db, orgId, run.approval_id, releaserClerkId, providerRunId).catch(() => {
      /* approval already RELEASED/terminal — the run state is authoritative here */
    });
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
