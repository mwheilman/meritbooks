/**
 * GATE 12.3 — payroll-run GL posting (multi-liability entry).
 *
 * Posts a payroll run from the provider's payroll receipt (the provider is the
 * source of truth for amounts; MeritBooks posts, it does not compute taxes).
 * Shape of the entry (balanced):
 *
 *   DR Wages Expense (gross, by department)               Σ gross
 *   DR Employer Payroll Tax Expense                       Σ employer taxes
 *     CR Net Pay -> Payments in Transit                   Σ net
 *     CR Tax Payable (federal / state / FICA)             employee + employer taxes
 *     CR Garnishments Payable                             child support / garnishments
 *     CR <other employee withholdings> payable            remaining deductions
 *
 * Identity that makes it balance: per employee, gross = net + employee
 * withholdings (taxes + post-tax deductions). Employer taxes balance on their own
 * (expense vs payable). The provider then debits the company bank for the total
 * cash requirement, which clears Payments in Transit -> Cash via the AP
 * settlement path (ap-posting.postApSettlement).
 *
 * SCOPE: wages, employee withholdings, employer payroll taxes, net pay, and
 * employer benefit *contributions* (employer health / 401(k) match / WC) — each
 * posting its expense (6020/6030/6040) and matching payable (2230/2240/2250).
 * Unknown deduction or benefit kinds throw rather than post to a guessed account.
 *
 * Pure build/classify/map functions are DB-free (balance-verifiable). The post
 * wrapper resolves roles and posts through the engine.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type PostResult, type JournalEntryLineInput } from '@/lib/services/gl-posting';
import { resolveRole, type AccountRoleKey } from '@/lib/posting/account-roles';
import { type MoneyMovementEntry, assertBalanced } from './types';
import type { PayrollReceipt } from '@/lib/money/providers/types';

// ---------------------------------------------------------------------------
// Pure classifiers (documented keyword rules; refuse to guess on unknown kinds)
// ---------------------------------------------------------------------------

/** Map a tax agency label to its liability role. */
export function classifyTaxAgency(agency: string): AccountRoleKey {
  const a = agency.toLowerCase();
  if (/(fica|social security|ss|medicare)/.test(a)) return 'FICA_PAYABLE';
  if (/(federal|irs|fed|941|940|944)/.test(a)) return 'FEDERAL_TAX_PAYABLE';
  // Everything else is treated as a state/local withholding liability.
  return 'STATE_TAX_PAYABLE';
}

export class UnmappedDeductionError extends Error {
  constructor(kind: string) {
    super(`Unmapped payroll deduction kind "${kind}" — add a classification before posting (refusing to guess the liability account).`);
    this.name = 'UnmappedDeductionError';
  }
}

/** Map a post-tax deduction kind to its liability role. Throws on unknown kinds. */
export function classifyDeduction(kind: string): AccountRoleKey {
  const k = kind.toLowerCase();
  if (/(child support|garnish|levy|withholding order)/.test(k)) return 'GARNISHMENT_PAYABLE';
  if (/(health|medical|dental|vision|hsa|fsa)/.test(k)) return 'HEALTH_INSURANCE_PAYABLE';
  if (/(401|retire|pension|roth)/.test(k)) return 'RETIREMENT_PAYABLE';
  throw new UnmappedDeductionError(kind);
}

export class UnmappedBenefitError extends Error {
  constructor(kind: string) {
    super(`Unmapped employer benefit kind "${kind}" — add a classification before posting (refusing to guess the expense/liability accounts).`);
    this.name = 'UnmappedBenefitError';
  }
}

/** Map an employer benefit contribution kind to its (expense role, payable role). Throws on unknown kinds. */
export function classifyBenefit(kind: string): { expense: AccountRoleKey; payable: AccountRoleKey } {
  const k = kind.toLowerCase();
  if (/(health|medical|dental|vision|hsa|fsa)/.test(k)) return { expense: 'HEALTH_INSURANCE_EXPENSE', payable: 'HEALTH_INSURANCE_PAYABLE' };
  if (/(401|retire|pension|roth|match)/.test(k)) return { expense: 'RETIREMENT_MATCH_EXPENSE', payable: 'RETIREMENT_PAYABLE' };
  if (/(workers? comp|workman|wc)/.test(k)) return { expense: 'WORKERS_COMP_EXPENSE', payable: 'WORKERS_COMP_PAYABLE' };
  throw new UnmappedBenefitError(kind);
}

// ---------------------------------------------------------------------------
// Pure entry builder
// ---------------------------------------------------------------------------

export interface PayrollWageLine { expenseAccountId: string; departmentId?: string | null; jobId?: string | null; grossCents: number }
export interface PayrollExpenseLine { accountId: string; cents: number; memo?: string }
export interface PayrollLiabilityCredit { accountId: string; cents: number; memo?: string }

export interface PayrollRunPosting {
  locationId: string;
  wageLines: PayrollWageLine[];
  employerExpenseLines: PayrollExpenseLine[]; // employer payroll taxes (+ employer benefit expense if supplied)
  liabilityCredits: PayrollLiabilityCredit[]; // ALL credits except net pay
  netPayCents: number;
  clearingAccountId: string; // PAYMENTS_IN_TRANSIT
}

export function buildPayrollRunEntry(p: PayrollRunPosting, memo = 'Payroll run'): MoneyMovementEntry {
  const lines: JournalEntryLineInput[] = [];

  for (const w of p.wageLines) {
    if (w.grossCents <= 0) continue;
    lines.push({
      account_id: w.expenseAccountId,
      debit_cents: w.grossCents,
      credit_cents: 0,
      location_id: p.locationId,
      department_id: w.departmentId ?? undefined,
      job_id: w.jobId ?? undefined,
      memo: 'Gross wages',
    });
  }
  for (const e of p.employerExpenseLines) {
    if (e.cents <= 0) continue;
    lines.push({ account_id: e.accountId, debit_cents: e.cents, credit_cents: 0, location_id: p.locationId, memo: e.memo ?? 'Employer payroll expense' });
  }
  for (const c of p.liabilityCredits) {
    if (c.cents <= 0) continue;
    lines.push({ account_id: c.accountId, debit_cents: 0, credit_cents: c.cents, location_id: p.locationId, memo: c.memo ?? 'Payroll liability' });
  }
  if (p.netPayCents > 0) {
    lines.push({ account_id: p.clearingAccountId, debit_cents: 0, credit_cents: p.netPayCents, location_id: p.locationId, memo: 'Net pay (in transit)' });
  }

  return assertBalanced({ entryType: 'PAYROLL_RUN', memo, lines });
}

// ---------------------------------------------------------------------------
// Receipt -> posting mapping (aggregates by liability role)
// ---------------------------------------------------------------------------

export interface ResolvedPayrollAccounts {
  wagesExpenseId: string;
  payrollTaxExpenseId: string;
  clearingId: string;
  /** liability role -> account id (FEDERAL_TAX_PAYABLE, STATE_TAX_PAYABLE, FICA_PAYABLE, GARNISHMENT_PAYABLE, HEALTH_INSURANCE_PAYABLE, RETIREMENT_PAYABLE, WORKERS_COMP_PAYABLE). */
  liabilityByRole: Partial<Record<AccountRoleKey, string>>;
  /** employer benefit expense role -> account id (HEALTH_INSURANCE_EXPENSE, RETIREMENT_MATCH_EXPENSE, WORKERS_COMP_EXPENSE). */
  expenseByRole?: Partial<Record<AccountRoleKey, string>>;
}

/** Per-line reconciliation guard: net + employee withholdings must equal gross. */
function assertLineReconciles(line: PayrollReceipt['lines'][number]): void {
  const empTax = line.employeeTaxes.reduce((s, t) => s + t.cents, 0);
  const ded = line.postTaxDeductions.reduce((s, d) => s + d.cents, 0);
  if (line.netCents + empTax + ded !== line.grossCents) {
    throw new Error(`Payroll line for ${line.employeeHandle} does not reconcile: net ${line.netCents} + emp taxes ${empTax} + deductions ${ded} != gross ${line.grossCents}`);
  }
}

export function mapPayrollReceipt(receipt: PayrollReceipt, locationId: string, acc: ResolvedPayrollAccounts): PayrollRunPosting {
  const liabilityTotals = new Map<string, number>(); // accountId -> cents
  const addLiability = (role: AccountRoleKey, cents: number) => {
    const id = acc.liabilityByRole[role];
    if (!id) throw new Error(`No account resolved for payroll liability role ${role}`);
    liabilityTotals.set(id, (liabilityTotals.get(id) ?? 0) + cents);
  };

  const wageByDept = new Map<string | null, number>();
  let employerTaxTotal = 0;
  let netTotal = 0;
  const employerExpenseLines: PayrollExpenseLine[] = [];

  const addExpense = (role: AccountRoleKey, cents: number, memo: string) => {
    const id = acc.expenseByRole?.[role];
    if (!id) throw new Error(`No account resolved for employer benefit expense role ${role}`);
    employerExpenseLines.push({ accountId: id, cents, memo });
  };

  for (const ln of receipt.lines) {
    assertLineReconciles(ln);
    netTotal += ln.netCents;
    wageByDept.set(ln.departmentId, (wageByDept.get(ln.departmentId) ?? 0) + ln.grossCents);
    for (const t of ln.employeeTaxes) addLiability(classifyTaxAgency(t.agency), t.cents);
    for (const d of ln.postTaxDeductions) addLiability(classifyDeduction(d.kind), d.cents);
    for (const t of ln.employerTaxes) { addLiability(classifyTaxAgency(t.agency), t.cents); employerTaxTotal += t.cents; }
    // Employer benefit contributions: DR benefit expense, CR benefit payable.
    for (const b of ln.benefits) {
      const { expense, payable } = classifyBenefit(b.kind);
      addExpense(expense, b.cents, `Employer ${b.kind}`);
      addLiability(payable, b.cents);
    }
  }

  const wageLines: PayrollWageLine[] = [...wageByDept.entries()].map(([departmentId, grossCents]) => ({
    expenseAccountId: acc.wagesExpenseId,
    departmentId,
    grossCents,
  }));

  const liabilityCredits: PayrollLiabilityCredit[] = [...liabilityTotals.entries()].map(([accountId, cents]) => ({ accountId, cents }));

  if (employerTaxTotal > 0) {
    employerExpenseLines.unshift({ accountId: acc.payrollTaxExpenseId, cents: employerTaxTotal, memo: 'Employer payroll taxes' });
  }

  return {
    locationId,
    wageLines,
    employerExpenseLines,
    liabilityCredits,
    netPayCents: netTotal,
    clearingAccountId: acc.clearingId,
  };
}

// ---------------------------------------------------------------------------
// Post wrapper
// ---------------------------------------------------------------------------

export async function postPayrollRun(
  supabase: SupabaseClient,
  args: { orgId: string; locationId: string; entryDate: string; receipt: PayrollReceipt; createdBy: string | null; sourceId?: string },
): Promise<PostResult> {
  const [wages, payrollTaxExpense, clearing, federal, state, fica, garnishment, health, retirement, workersComp, healthExp, retireExp, wcExp] = await Promise.all([
    resolveRole(supabase, args.orgId, 'WAGES_EXPENSE'),
    resolveRole(supabase, args.orgId, 'PAYROLL_TAX_EXPENSE'),
    resolveRole(supabase, args.orgId, 'PAYMENTS_IN_TRANSIT', args.locationId),
    resolveRole(supabase, args.orgId, 'FEDERAL_TAX_PAYABLE'),
    resolveRole(supabase, args.orgId, 'STATE_TAX_PAYABLE'),
    resolveRole(supabase, args.orgId, 'FICA_PAYABLE'),
    resolveRole(supabase, args.orgId, 'GARNISHMENT_PAYABLE'),
    resolveRole(supabase, args.orgId, 'HEALTH_INSURANCE_PAYABLE'),
    resolveRole(supabase, args.orgId, 'RETIREMENT_PAYABLE'),
    resolveRole(supabase, args.orgId, 'WORKERS_COMP_PAYABLE'),
    resolveRole(supabase, args.orgId, 'HEALTH_INSURANCE_EXPENSE'),
    resolveRole(supabase, args.orgId, 'RETIREMENT_MATCH_EXPENSE'),
    resolveRole(supabase, args.orgId, 'WORKERS_COMP_EXPENSE'),
  ]);

  const posting = mapPayrollReceipt(args.receipt, args.locationId, {
    wagesExpenseId: wages.id,
    payrollTaxExpenseId: payrollTaxExpense.id,
    clearingId: clearing.id,
    liabilityByRole: {
      FEDERAL_TAX_PAYABLE: federal.id,
      STATE_TAX_PAYABLE: state.id,
      FICA_PAYABLE: fica.id,
      GARNISHMENT_PAYABLE: garnishment.id,
      HEALTH_INSURANCE_PAYABLE: health.id,
      RETIREMENT_PAYABLE: retirement.id,
      WORKERS_COMP_PAYABLE: workersComp.id,
    },
    expenseByRole: {
      HEALTH_INSURANCE_EXPENSE: healthExp.id,
      RETIREMENT_MATCH_EXPENSE: retireExp.id,
      WORKERS_COMP_EXPENSE: wcExp.id,
    },
  });

  const entry = buildPayrollRunEntry(posting, `Payroll run ${args.receipt.providerRunId}`);

  return postJournalEntry(supabase, {
    org_id: args.orgId,
    location_id: args.locationId,
    entry_date: args.entryDate,
    entry_type: entry.entryType,
    memo: entry.memo,
    source_module: 'PAYROLL',
    source_id: args.sourceId ?? args.receipt.providerRunId,
    created_by: args.createdBy,
    lines: entry.lines,
  });
}
