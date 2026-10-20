/**
 * MockPayrollEngine — the deterministic, no-network payroll provider.
 *
 * Purpose:
 *  - Makes the entire payroll workflow (draft → preview → submit → approve →
 *    release → post → reconcile) testable end-to-end with zero provider access.
 *  - Is the dev / no-provider fallback so a core capability never depends on a
 *    provider being installed (payroll FPB §4, state "provider-not-connected").
 *
 * The gross-to-net math here is a deterministic ESTIMATE, NOT a tax calculation.
 * It exists only to exercise the pipeline and to give plausible dimensioned
 * amounts to post. In production the licensed provider (Gusto / Check) returns the
 * real figures; nothing here withholds, remits, or files anything.
 *
 * Estimate model (flat effective rates on gross):
 *   employeeTax = round(gross * 0.18)   // employee withholding estimate
 *   employerTax = round(gross * 0.09)   // employer-side tax estimate
 *   deductions  = 0, benefits = 0       // no deduction/benefit input on the mock
 *   net         = gross - employeeTax - deductions
 * `gross` is the exact integer-cent sum of the employee's earnings.
 *
 * Implements the full `PayrollProvider` contract so every provider-facing surface
 * (roster, schedules, journal export, earnings import) has a no-network double.
 * State (submitted runs, imported earnings) is per-instance and in-memory only.
 */

import type {
  EmployeePayInput,
  EmployeePayResult,
  PayrollRunPreview,
  PayrollRunTotals,
  SubmitRunInput,
} from '../engine/types';
import {
  summarizeJournal,
  type EarningsLine,
  type ImportEarningsInput,
  type ImportEarningsResult,
  type PayrollJournalExport,
  type PayrollProvider,
  type PayrollProviderCapabilities,
  type ProviderConnectionStatus,
  type ProviderDocumentLink,
  type ProviderEmployee,
  type ProviderPaySchedule,
  type PtoBalance,
} from './types';
import { validateEarningsLines } from './earnings';

/** Flat estimated effective employee-tax rate on gross (deterministic estimate, not a real calc). */
export const MOCK_EMPLOYEE_TAX_RATE = 0.18;
/** Flat estimated effective employer-tax rate on gross. */
export const MOCK_EMPLOYER_TAX_RATE = 0.09;

export const MOCK_CAPABILITIES: PayrollProviderCapabilities = Object.freeze({
  runPayroll: true,
  employeeSync: true,
  paySchedules: true,
  documents: false,
  journalExport: true,
  earningsImport: true,
  ptoBalances: true,
  registerImport: false,
});

function sumEarnings(earnings: EmployeePayInput['earnings']): number {
  return earnings.reduce((acc, e) => acc + e.amountCents, 0);
}

const ZERO_TOTALS: PayrollRunTotals = {
  grossCents: 0,
  netCents: 0,
  employeeTaxCents: 0,
  employerTaxCents: 0,
  deductionsCents: 0,
  benefitsCents: 0,
};

/** Thrown when a real payroll would be released through the sandbox engine in production. */
export class MockPayrollInProductionError extends Error {
  constructor() {
    super(
      'No payroll provider is connected. Connect Gusto (or another provider) in Settings → Payroll before releasing a run — the sandbox engine only estimates and never pays anyone.',
    );
    this.name = 'MockPayrollInProductionError';
  }
}

/** Production = Vercel production deploy. Override: PAYROLL_MOCK_ALLOWED=true. */
export function assertMockReleaseAllowed(env: Record<string, string | undefined> = process.env): void {
  if (env.VERCEL_ENV === 'production' && env.PAYROLL_MOCK_ALLOWED !== 'true') {
    throw new MockPayrollInProductionError();
  }
}

export class MockPayrollEngine implements PayrollProvider {
  readonly name = 'mock';
  readonly id = 'mock' as const;
  readonly displayName = 'Sandbox (no provider connected)';
  readonly capabilities = MOCK_CAPABILITIES;

  /** Submitted runs by providerRunId — feeds exportJournal. */
  private readonly submitted = new Map<string, { payDate: string; totals: PayrollRunTotals }>();
  /** Earnings accepted by importEarnings, by sourceRef (idempotent). */
  private readonly earnings = new Map<string, EarningsLine>();

  isConfigured(): boolean {
    return true;
  }

  async status(): Promise<ProviderConnectionStatus> {
    return {
      provider: 'mock',
      state: 'CONNECTED',
      detail: 'Sandbox engine — estimates only; no money moves and nothing is filed.',
      environment: 'test',
    };
  }

  async previewRun(input: {
    periodStart: string;
    periodEnd: string;
    payDate: string;
    employees: EmployeePayInput[];
  }): Promise<PayrollRunPreview> {
    const employees: EmployeePayResult[] = input.employees.map((emp) => {
      const grossCents = sumEarnings(emp.earnings);
      const employeeTaxCents = Math.round(grossCents * MOCK_EMPLOYEE_TAX_RATE);
      const employerTaxCents = Math.round(grossCents * MOCK_EMPLOYER_TAX_RATE);
      const deductionsCents = 0;
      const benefitsCents = 0;
      const netCents = grossCents - employeeTaxCents - deductionsCents;
      return {
        employeeId: emp.employeeId,
        grossCents,
        netCents,
        employeeTaxCents,
        employerTaxCents,
        deductionsCents,
        benefitsCents,
        providerRef: `mock_emp_${emp.employeeId}`,
      };
    });

    const totals = employees.reduce<PayrollRunTotals>(
      (acc, e) => ({
        grossCents: acc.grossCents + e.grossCents,
        netCents: acc.netCents + e.netCents,
        employeeTaxCents: acc.employeeTaxCents + e.employeeTaxCents,
        employerTaxCents: acc.employerTaxCents + e.employerTaxCents,
        deductionsCents: acc.deductionsCents + e.deductionsCents,
        benefitsCents: acc.benefitsCents + e.benefitsCents,
      }),
      { ...ZERO_TOTALS },
    );

    return { employees, totals };
  }

  async submitRun(input: SubmitRunInput): Promise<{ providerRunId: string; status: 'PROCESSING' | 'PAID' }> {
    // Fail closed in production: the sandbox engine uses flat estimated tax rates
    // and moves no money, so "releasing" a real run through it would record a
    // payroll that never happened. releaseRun catches this and leaves the run
    // APPROVED. Opt-in override exists only for demo tenants on prod infra.
    assertMockReleaseAllowed();
    // Deterministic id derived from the run window so re-submitting the same run
    // is stable (idempotent-friendly for the mock/test path). No network.
    const providerRunId =
      input.providerRunId ?? `mock_run_${input.periodStart}_${input.periodEnd}_${input.payDate}`;
    this.submitted.set(providerRunId, { payDate: input.payDate, totals: input.preview.totals });
    return { providerRunId, status: 'PROCESSING' };
  }

  async getRunStatus(
    _providerRunId: string,
  ): Promise<{ status: 'PROCESSING' | 'PAID' | 'FAILED'; paidAt?: string }> {
    // The mock treats any submitted run as settled — deterministic for tests.
    return { status: 'PAID', paidAt: '2026-01-01T00:00:00.000Z' };
  }

  async listEmployees(): Promise<ProviderEmployee[]> {
    return [];
  }

  async listPaySchedules(): Promise<ProviderPaySchedule[]> {
    return [];
  }

  async getDocumentLinks(input: {
    providerEmployeeId: string;
    providerRunId?: string;
    year?: number;
  }): Promise<ProviderDocumentLink[]> {
    void input;
    return [];
  }

  /**
   * Balanced summary journal for a run this instance submitted:
   *   DR wages (gross) + DR employer tax  =  CR net + CR employee tax/deductions + CR employer tax payable.
   */
  async exportJournal(providerRunId: string): Promise<PayrollJournalExport> {
    const run = this.submitted.get(providerRunId);
    const t = run?.totals ?? ZERO_TOTALS;
    const withheld = t.employeeTaxCents + t.deductionsCents;
    const lines = [
      { accountType: 'RegularWages', description: 'Gross wages', debitCents: t.grossCents, creditCents: 0, job: null },
      { accountType: 'EmployerTax', description: 'Employer payroll taxes', debitCents: t.employerTaxCents, creditCents: 0, job: null },
      { accountType: 'DebitNetPay', description: 'Net pay', debitCents: 0, creditCents: t.netCents, job: null },
      { accountType: 'EmployeeWithholding', description: 'Employee taxes + deductions withheld', debitCents: 0, creditCents: withheld, job: null },
      { accountType: 'EmployerTaxPayable', description: 'Employer taxes payable', debitCents: 0, creditCents: t.employerTaxCents, job: null },
    ].filter((l) => l.debitCents !== 0 || l.creditCents !== 0);
    return summarizeJournal(providerRunId, run?.payDate ?? null, lines);
  }

  async importEarnings(input: ImportEarningsInput): Promise<ImportEarningsResult> {
    const { valid, rejected } = validateEarningsLines(input.lines);
    for (const l of valid) this.earnings.set(l.sourceRef, l);
    return {
      mode: 'API',
      acceptedCount: valid.length,
      acceptedCents: valid.reduce((s, l) => s + l.amountCents, 0),
      rejected,
      providerRunId: input.providerRunId ?? null,
      file: null,
    };
  }

  async getPtoBalances(): Promise<PtoBalance[]> {
    return [];
  }
}
