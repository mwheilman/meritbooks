/**
 * Payroll posting.
 *
 * A payroll run is inherently multi-line, so it takes structured input rather
 * than going through the single-fact template registry:
 *   DR gross wages expense
 *   DR each employer-tax expense
 *   CR net pay (cash, or accrued wages)
 *   CR each employee withholding liability
 *   CR each employer-tax liability
 *
 * Net pay = gross − Σ withholdings. The entry balances iff Σ employer-tax
 * expense == Σ employer-tax liability (the employer's cost is matched by what it
 * owes), which is validated before posting. Remittance later clears those
 * liabilities against cash.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type JournalEntryLineInput } from '../services/gl-posting';
import { PostingError, resolveCashSide, getAccountRef } from './account-roles';
import { debitCreditFor } from './account-direction';
import type { PaymentRail } from './transaction-types';

type DB = SupabaseClient;

export interface PayrollComponent {
  account_id: string;
  amount_cents: number;
  memo?: string;
}

export interface PayrollRunInput {
  orgId: string;
  locationId: string;
  payDate: string;
  departmentId?: string;
  grossWagesAccountId: string;
  grossWagesCents: number;
  withholdings: PayrollComponent[];        // CR employee withholding liabilities
  employerTaxExpenses: PayrollComponent[]; // DR employer-tax expense
  employerTaxLiabilities: PayrollComponent[]; // CR employer-tax liabilities
  netPayAccountId: string;                 // cash/bank, or accrued-wages liability
}

export interface PayrollRunResult {
  gl_entry_id: string | null;
  gross_cents: number;
  net_pay_cents: number;
}

function sum(items: PayrollComponent[]): number {
  return items.reduce((s, i) => s + i.amount_cents, 0);
}

export async function recordPayrollRun(db: DB, input: PayrollRunInput): Promise<PayrollRunResult> {
  const totalWithheld = sum(input.withholdings);
  const netPay = input.grossWagesCents - totalWithheld;
  if (netPay < 0) throw new PostingError('Withholdings exceed gross wages');
  if (sum(input.employerTaxExpenses) !== sum(input.employerTaxLiabilities)) {
    throw new PostingError('Employer-tax expense total must equal employer-tax liability total');
  }

  const dims = { location_id: input.locationId, department_id: input.departmentId ?? undefined };
  const lines: JournalEntryLineInput[] = [
    { account_id: input.grossWagesAccountId, debit_cents: input.grossWagesCents, credit_cents: 0, ...dims, memo: 'Gross wages' },
  ];
  for (const e of input.employerTaxExpenses) {
    lines.push({ account_id: e.account_id, debit_cents: e.amount_cents, credit_cents: 0, ...dims, memo: e.memo ?? 'Employer tax' });
  }
  lines.push({ account_id: input.netPayAccountId, debit_cents: 0, credit_cents: netPay, ...dims, memo: 'Net pay' });
  for (const w of input.withholdings) {
    lines.push({ account_id: w.account_id, debit_cents: 0, credit_cents: w.amount_cents, ...dims, memo: w.memo ?? 'Withholding' });
  }
  for (const l of input.employerTaxLiabilities) {
    lines.push({ account_id: l.account_id, debit_cents: 0, credit_cents: l.amount_cents, ...dims, memo: l.memo ?? 'Employer tax payable' });
  }

  const je = await postJournalEntry(db, {
    org_id: input.orgId,
    location_id: input.locationId,
    entry_date: input.payDate,
    // A payroll run posts under its dedicated entry_type (enum value added in
    // migration 055) so the schema-drift guard and reporting can distinguish
    // payroll entries from generic manual entries. FPB-payroll §11 wiring gap.
    entry_type: 'PAYROLL_RUN',
    memo: 'Payroll run',
    source_module: 'PAYROLL',
    created_by: null,
    lines,
  });
  if (!je.success) throw new PostingError(je.error ?? 'Failed to post payroll');
  return { gl_entry_id: je.entry_id ?? null, gross_cents: input.grossWagesCents, net_pay_cents: netPay };
}

export interface PayrollRemittanceInput {
  orgId: string;
  locationId: string;
  payDate: string;
  liabilities: PayrollComponent[]; // accrued payroll-liability accounts to clear
  rail?: PaymentRail;
  cashAccountId?: string;
  /** Optional idempotency key. When set, migration 064's UNIQUE(org_id, source_ref,
   *  entry_type) is the DB double-post guarantor: a second remittance with the same
   *  key fails on insert instead of double-crediting cash. */
  sourceRef?: string;
  /** Optional entry memo (defaults to "Payroll remittance"). */
  memo?: string;
}

/** Remit accrued payroll liabilities: DR each liability / CR cash for the total. */
export async function recordPayrollRemittance(db: DB, input: PayrollRemittanceInput): Promise<{ gl_entry_id: string | null; total_cents: number }> {
  const total = sum(input.liabilities);
  if (total <= 0) throw new PostingError('Nothing to remit');

  const cash = input.cashAccountId
    ? await getAccountRef(db, input.orgId, input.cashAccountId)
    : await resolveCashSide(db, input.orgId, input.rail ?? 'ach', input.locationId);

  const lines: JournalEntryLineInput[] = input.liabilities.map((l) => ({
    account_id: l.account_id,
    debit_cents: l.amount_cents,
    credit_cents: 0,
    location_id: input.locationId,
    memo: l.memo ?? 'Remit payroll liability',
  }));
  // cash side: bank (asset) decreases.
  const cashDc = debitCreditFor(cash.account_type, 'decrease', total, cash.account_sub_type);
  lines.push({ account_id: cash.id, debit_cents: cashDc.debit_cents, credit_cents: cashDc.credit_cents, location_id: input.locationId, memo: 'Payroll remittance' });

  const je = await postJournalEntry(db, {
    org_id: input.orgId,
    location_id: input.locationId,
    entry_date: input.payDate,
    entry_type: 'STANDARD',
    memo: input.memo ?? 'Payroll remittance',
    source_module: 'PAYROLL',
    source_ref: input.sourceRef,
    created_by: null,
    lines,
  });
  if (!je.success) throw new PostingError(je.error ?? 'Failed to post remittance');
  return { gl_entry_id: je.entry_id ?? null, total_cents: total };
}
