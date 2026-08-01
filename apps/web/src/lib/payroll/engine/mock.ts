/**
 * MockPayrollEngine — the deterministic, no-network payroll engine.
 *
 * Purpose:
 *  - Makes the entire payroll workflow (draft → preview → submit → approve →
 *    release → post → reconcile) testable end-to-end with zero provider access.
 *  - Is the dev / no-provider fallback so a core capability never depends on a
 *    provider being installed (payroll FPB §4, state "provider-not-connected").
 *
 * The gross-to-net math here is a deterministic ESTIMATE, NOT a tax calculation.
 * It exists only to exercise the pipeline and to give plausible dimensioned
 * amounts to post. In production the licensed provider (Check) returns the real
 * figures; nothing here withholds, remits, or files anything.
 *
 * Estimate model (flat effective rates on gross):
 *   employeeTax = round(gross * 0.18)   // employee withholding estimate
 *   employerTax = round(gross * 0.09)   // employer-side tax estimate
 *   deductions  = 0, benefits = 0       // no deduction/benefit input on the mock
 *   net         = gross - employeeTax - deductions
 * `gross` is the exact integer-cent sum of the employee's earnings.
 */

import type {
  EmployeePayInput,
  EmployeePayResult,
  PayrollEngine,
  PayrollRunPreview,
  PayrollRunTotals,
  SubmitRunInput,
} from './types';

/** Flat estimated effective employee-tax rate on gross (deterministic estimate, not a real calc). */
export const MOCK_EMPLOYEE_TAX_RATE = 0.18;
/** Flat estimated effective employer-tax rate on gross. */
export const MOCK_EMPLOYER_TAX_RATE = 0.09;

function sumEarnings(earnings: EmployeePayInput['earnings']): number {
  return earnings.reduce((acc, e) => acc + e.amountCents, 0);
}

export class MockPayrollEngine implements PayrollEngine {
  readonly name = 'mock';

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
      {
        grossCents: 0,
        netCents: 0,
        employeeTaxCents: 0,
        employerTaxCents: 0,
        deductionsCents: 0,
        benefitsCents: 0,
      },
    );

    return { employees, totals };
  }

  async submitRun(input: SubmitRunInput): Promise<{ providerRunId: string; status: 'PROCESSING' | 'PAID' }> {
    // Deterministic id derived from the run window so re-submitting the same run
    // is stable (idempotent-friendly for the mock/test path). No network.
    const providerRunId =
      input.providerRunId ?? `mock_run_${input.periodStart}_${input.periodEnd}_${input.payDate}`;
    return { providerRunId, status: 'PROCESSING' };
  }

  async getRunStatus(
    providerRunId: string,
  ): Promise<{ status: 'PROCESSING' | 'PAID' | 'FAILED'; paidAt?: string }> {
    // The mock treats any submitted run as settled — deterministic for tests.
    return { status: 'PAID', paidAt: '2026-01-01T00:00:00.000Z' };
  }
}
