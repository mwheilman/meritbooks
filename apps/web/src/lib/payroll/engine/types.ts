/**
 * Provider-agnostic payroll engine contract (GATE 12.3 Phase A).
 *
 * MeritBooks is NEVER the regulated party. A licensed provider (Check now,
 * Gusto/others later) calculates gross-to-net, withholds and remits taxes, moves
 * the money, and files the returns. This interface is the single seam every
 * provider plugs in behind. Books owns the GL posting, approvals, audit, data
 * model, and UI — never the tax engine or the bank movement.
 *
 * HARD INVARIANT (canon §2 / payroll FPB §2): PII (SSN, bank/routing numbers,
 * withholding elections) NEVER crosses this boundary and is NEVER persisted in
 * our tables. Only opaque provider references (`providerRef` / `providerRunId`)
 * and amounts in bigint cents flow through here. Adapters must not return, log,
 * or accept PII on these shapes.
 *
 * DO NOT RENAME these types or their members — other agents build against them.
 */

/** A single earning line the tenant is paying (hourly, salary, bonus, reimbursement, …). */
export interface PayrollEarning {
  /** Free-form earning code (e.g. 'salary' | 'hourly' | 'overtime' | 'bonus' | 'reimbursement'). */
  type: string;
  amountCents: number;
}

/** What the tenant tells the engine about one employee for a run. No PII. */
export interface EmployeePayInput {
  /** Opaque employee reference (core.employees.id or the provider employee handle). Not PII. */
  employeeId: string;
  hours?: number;
  earnings: PayrollEarning[];
}

/** The provider-computed gross-to-net for one employee. Amounts only — never PII. */
export interface EmployeePayResult {
  employeeId: string;
  grossCents: number;
  netCents: number;
  employeeTaxCents: number;
  employerTaxCents: number;
  deductionsCents: number;
  benefitsCents: number;
  /** Hours paid (echoed back from the input so the run row can persist it). Amounts only — not PII. */
  hours?: number;
  /** Earning lines (echoed back from the input for persistence). Amounts only — not PII. */
  earnings?: PayrollEarning[];
  /** Opaque provider line reference (e.g. Check payroll-item id). Optional for the mock. */
  providerRef?: string;
}

/** Run-level totals (the sums the GL posting and funding debit tie to). */
export interface PayrollRunTotals {
  grossCents: number;
  netCents: number;
  employeeTaxCents: number;
  employerTaxCents: number;
  deductionsCents: number;
  benefitsCents: number;
}

/** A read-back of the provider's calculation — never a Books calculation. */
export interface PayrollRunPreview {
  employees: EmployeePayResult[];
  totals: PayrollRunTotals;
}

/** Input to commit a previewed run to the provider for processing. */
export interface SubmitRunInput {
  /** Provider's run id if one was already created at preview time. */
  providerRunId?: string;
  preview: PayrollRunPreview;
  periodStart: string;
  periodEnd: string;
  payDate: string;
}

/**
 * The single seam every payroll provider plugs in behind.
 *
 * `name` is the stable adapter identifier ('check' | 'mock'). Callers use it for
 * logging/telemetry and to reason about which engine resolved.
 */
export interface PayrollEngine {
  readonly name: string; // 'check' | 'mock'
  previewRun(input: {
    periodStart: string;
    periodEnd: string;
    payDate: string;
    employees: EmployeePayInput[];
  }): Promise<PayrollRunPreview>;
  submitRun(input: SubmitRunInput): Promise<{ providerRunId: string; status: 'PROCESSING' | 'PAID' }>;
  getRunStatus(providerRunId: string): Promise<{ status: 'PROCESSING' | 'PAID' | 'FAILED'; paidAt?: string }>;
}

/** Thrown when a real provider adapter is invoked without usable credentials/config. */
export class PayrollProviderNotConfiguredError extends Error {
  constructor(message = 'payroll provider not configured') {
    super(message);
    this.name = 'PayrollProviderNotConfiguredError';
  }
}
