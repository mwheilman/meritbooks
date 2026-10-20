/**
 * Gusto Embedded Payroll — PURE response shapes + mappers (no I/O). Split out of
 * the adapter (gusto.ts) so the HTTP/OAuth class stays small and these can be
 * unit-tested directly. Every shape is ALLOW-LISTED: Gusto payloads carry PII
 * (SSN, addresses, bank data) and only the fields declared here are ever read.
 * Gusto sends money as decimal-dollar strings; everything here converts to
 * integer cents with integer arithmetic (decimalToCents).
 */

import type {
  EmployeePayInput,
  EmployeePayResult,
  PayrollRunPreview,
  PayrollRunTotals,
} from '../engine/types';
import {
  decimalToCents,
  summarizeJournal,
  type ExternalEarningType,
  type PayrollJournalExport,
  type PayrollJournalLine,
  type ProviderPaySchedule,
} from './types';

/** Per-company OAuth token pair, stored as JSON in Vault. */
export interface GustoTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
}

/** Parse the Vault secret JSON into tokens; null when absent/malformed (→ not configured). */
export function parseGustoTokens(secret: string | null): GustoTokens | null {
  if (!secret) return null;
  try {
    const o = JSON.parse(secret) as Partial<GustoTokens>;
    if (typeof o.accessToken === 'string' && typeof o.refreshToken === 'string' && typeof o.expiresAt === 'number') {
      return { accessToken: o.accessToken, refreshToken: o.refreshToken, expiresAt: o.expiresAt };
    }
  } catch {
    /* malformed secret → treated as not configured */
  }
  return null;
}

/** Map a Books earning code to a Gusto fixed-compensation name. Null = not a fixed comp. */
export function gustoFixedCompName(type: string): string | null {
  switch (type.trim().toLowerCase()) {
    case 'bonus':
    case 'spiff':
      return 'Bonus';
    case 'commission':
      return 'Commission';
    case 'correction':
      return 'Correction Payment';
    case 'tips':
    case 'paycheck_tips':
      return 'Paycheck Tips';
    case 'cash_tips':
      return 'Cash Tips';
    case 'reimbursement':
      return 'Reimbursement';
    // salary / hourly / overtime are driven by the job compensation + hours in Gusto.
    case 'salary':
    case 'hourly':
    case 'regular':
    case 'overtime':
    case 'double_overtime':
      return null;
    default:
      // A tenant-defined custom earning type (created via POST earning_types).
      return type.trim() || null;
  }
}

export const EXTERNAL_TO_GUSTO: Record<ExternalEarningType, string> = {
  COMMISSION: 'Commission',
  BONUS: 'Bonus',
  SPIFF: 'Bonus',
  REIMBURSEMENT: 'Reimbursement',
  OTHER: 'Bonus',
};

// ── Minimal Gusto response shapes (allow-listed fields only) ─────────────────────

export interface GustoPayrollSummary {
  payroll_uuid?: string;
  uuid?: string;
  processed?: boolean;
  check_date?: string;
  calculated_at?: string | null;
  pay_period?: { start_date?: string; end_date?: string; pay_schedule_uuid?: string };
}

export interface GustoFixedComp {
  name?: string;
  amount?: string;
  job_uuid?: string;
}
export interface GustoHourlyComp {
  name?: string;
  hours?: string;
  job_uuid?: string;
}
export interface GustoEmployeeCompensation {
  employee_uuid?: string;
  version?: string;
  excluded?: boolean;
  payment_method?: string;
  fixed_compensations?: GustoFixedComp[];
  hourly_compensations?: GustoHourlyComp[];
  // Post-calculate amounts. TODO(gusto-sandbox): confirm field names.
  gross_pay?: string;
  net_pay?: string;
  taxes?: Array<{ name?: string; employer?: boolean; amount?: string }>;
  benefits?: Array<{ name?: string; employee_deduction?: string; company_contribution?: string }>;
  deductions?: Array<{ name?: string; amount?: string }>;
}

export interface GustoPayrollDetail extends GustoPayrollSummary {
  employee_compensations?: GustoEmployeeCompensation[];
  // TODO(gusto-sandbox): confirm `totals` field names.
  totals?: {
    gross_pay?: string;
    net_pay?: string;
    employer_taxes?: string;
    employee_taxes?: string;
    benefits?: string;
    employee_benefits_deductions?: string;
    other_deductions?: string;
  };
}

// ── Pure mappers (exported for tests) ───────────────────────────────────────────

export function normalizeGustoFrequency(f?: string): ProviderPaySchedule['frequency'] {
  switch ((f ?? '').toLowerCase()) {
    case 'every week':
      return 'WEEKLY';
    case 'every other week':
      return 'BIWEEKLY';
    case 'twice per month':
      return 'SEMIMONTHLY';
    case 'monthly':
      return 'MONTHLY';
    default:
      return 'OTHER';
  }
}

/** Gusto calculated payroll → provider-agnostic preview (integer cents). */
export function mapGustoPayrollToPreview(
  p: GustoPayrollDetail,
  payrollUuid: string,
  inputs: Map<string, EmployeePayInput>,
): PayrollRunPreview {
  const employees: EmployeePayResult[] = (p.employee_compensations ?? [])
    .filter((c) => c.employee_uuid && !c.excluded)
    .map((c) => {
      const grossCents = decimalToCents(c.gross_pay);
      const netCents = decimalToCents(c.net_pay);
      const employeeTaxCents = (c.taxes ?? []).filter((t) => !t.employer).reduce((s, t) => s + decimalToCents(t.amount), 0);
      const employerTaxCents = (c.taxes ?? []).filter((t) => t.employer).reduce((s, t) => s + decimalToCents(t.amount), 0);
      const benefitDeductions = (c.benefits ?? []).reduce((s, b) => s + decimalToCents(b.employee_deduction), 0);
      const benefitsCents = (c.benefits ?? []).reduce((s, b) => s + decimalToCents(b.company_contribution), 0);
      const otherDeductions = (c.deductions ?? []).reduce((s, d) => s + decimalToCents(d.amount), 0);
      const input = inputs.get(c.employee_uuid!);
      return {
        employeeId: c.employee_uuid!,
        grossCents,
        netCents,
        employeeTaxCents,
        employerTaxCents,
        deductionsCents: benefitDeductions + otherDeductions,
        benefitsCents,
        hours: input?.hours,
        earnings: input?.earnings,
        providerRef: `gusto_payroll:${payrollUuid}`,
      };
    });

  const sum = (k: keyof PayrollRunTotals) =>
    employees.reduce((s, e) => s + (e[k as keyof EmployeePayResult] as number), 0);
  const totals: PayrollRunTotals = p.totals
    ? {
        grossCents: decimalToCents(p.totals.gross_pay),
        netCents: decimalToCents(p.totals.net_pay),
        employeeTaxCents: decimalToCents(p.totals.employee_taxes),
        employerTaxCents: decimalToCents(p.totals.employer_taxes),
        deductionsCents:
          decimalToCents(p.totals.employee_benefits_deductions) + decimalToCents(p.totals.other_deductions),
        benefitsCents: decimalToCents(p.totals.benefits),
      }
    : {
        grossCents: sum('grossCents'),
        netCents: sum('netCents'),
        employeeTaxCents: sum('employeeTaxCents'),
        employerTaxCents: sum('employerTaxCents'),
        deductionsCents: sum('deductionsCents'),
        benefitsCents: sum('benefitsCents'),
      };
  return { employees, totals };
}

export interface GustoGlReport {
  check_date?: string;
  data?: Array<{
    headers?: string[];
    rows?: Array<Array<string | null>>;
    data_type?: string;
  }>;
}

/** Parse Gusto's GL report JSON ("Basic" section) into journal lines (cents). */
export function parseGustoGeneralLedger(providerRunId: string, report: GustoGlReport): PayrollJournalExport {
  const section = (report.data ?? []).find((d) => d.data_type === 'Basic') ?? (report.data ?? [])[0];
  const headers = (section?.headers ?? []).map((h) => h.toLowerCase());
  const col = (name: string) => headers.indexOf(name);
  const iType = col('account type');
  const iDesc = col('account description');
  const iJob = col('job');
  const iDr = col('debit');
  const iCr = col('credit');
  const lines: PayrollJournalLine[] = (section?.rows ?? []).map((r) => ({
    accountType: (iType >= 0 ? r[iType] : null) ?? '',
    description: ((iDesc >= 0 ? r[iDesc] : null) ?? '').trim(),
    job: iJob >= 0 ? r[iJob] || null : null,
    debitCents: iDr >= 0 ? decimalToCents(r[iDr]) : 0,
    creditCents: iCr >= 0 ? decimalToCents(r[iCr]) : 0,
  }));
  return summarizeJournal(providerRunId, report.check_date ?? null, lines);
}
