import { describe, it, expect } from 'vitest';
import {
  buildReimbursementLines,
  computeReportTotals,
  type ExpenseReportLineRow,
} from './expense-reports';

const AP = 'ap-account-0000';
const LOC = 'loc-header-0000';

const rl = (over: Partial<ExpenseReportLineRow> = {}): ExpenseReportLineRow => ({
  id: 'x',
  report_id: 'r1',
  line_number: 1,
  expense_date: '2026-08-03',
  merchant: 'Acme',
  description: null,
  account_id: 'acct-meals',
  department_id: null,
  class_id: null,
  location_id: null,
  amount_cents: 5000,
  payment_source: 'OUT_OF_POCKET',
  receipt_id: null,
  bank_transaction_id: null,
  has_receipt: true,
  policy_flag: false,
  policy_reasons: [],
  billable: false,
  job_id: null,
  ...over,
});

describe('computeReportTotals', () => {
  it('splits reimbursable (out-of-pocket) from card totals', () => {
    const t = computeReportTotals([
      { amount_cents: 5000, payment_source: 'OUT_OF_POCKET' },
      { amount_cents: 3000, payment_source: 'CORPORATE_CARD' },
      { amount_cents: 2000, payment_source: 'OUT_OF_POCKET' },
    ]);
    expect(t).toEqual({ totalCents: 10000, reimbursableCents: 7000, cardCents: 3000 });
  });
});

describe('buildReimbursementLines', () => {
  it('DR each out-of-pocket expense / CR AP for the out-of-pocket total, balanced', () => {
    const lines = buildReimbursementLines(
      [
        rl({ id: 'a', line_number: 1, account_id: 'acct-meals', amount_cents: 5000 }),
        rl({ id: 'b', line_number: 2, account_id: 'acct-travel', amount_cents: 2500 }),
      ],
      AP,
      LOC,
      'Aug trip'
    );

    // 2 expense debits + 1 AP credit
    expect(lines).toHaveLength(3);
    const debits = lines.reduce((s, l) => s + l.debit_cents, 0);
    const credits = lines.reduce((s, l) => s + l.credit_cents, 0);
    expect(debits).toBe(7500);
    expect(credits).toBe(7500); // balanced
    const ap = lines.find((l) => l.account_id === AP)!;
    expect(ap.credit_cents).toBe(7500);
    expect(ap.debit_cents).toBe(0);
  });

  it('EXCLUDES corporate-card lines from the reimbursement JE (never double-paid)', () => {
    const lines = buildReimbursementLines(
      [
        rl({ id: 'a', account_id: 'acct-meals', amount_cents: 5000, payment_source: 'OUT_OF_POCKET' }),
        rl({ id: 'b', account_id: 'acct-travel', amount_cents: 9999, payment_source: 'CORPORATE_CARD' }),
      ],
      AP,
      LOC,
      'ref'
    );
    // only the out-of-pocket $50 debit + AP credit
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.account_id === AP)!.credit_cents).toBe(5000);
  });

  it('returns [] when nothing is out-of-pocket (all card)', () => {
    const lines = buildReimbursementLines(
      [rl({ payment_source: 'CORPORATE_CARD', amount_cents: 5000 })],
      AP,
      LOC,
      'ref'
    );
    expect(lines).toEqual([]);
  });

  it('carries line dimensions and falls back to the header location', () => {
    const lines = buildReimbursementLines(
      [rl({ account_id: 'acct-meals', amount_cents: 1000, department_id: 'dept-1', location_id: 'loc-line', job_id: 'job-9' })],
      AP,
      LOC,
      'ref'
    );
    const debit = lines[0];
    expect(debit.department_id).toBe('dept-1');
    expect(debit.location_id).toBe('loc-line');
    expect(debit.job_id).toBe('job-9');
    // AP credit uses the header location
    expect(lines[1].location_id).toBe(LOC);
  });

  it('throws when an out-of-pocket line has no GL category', () => {
    expect(() =>
      buildReimbursementLines([rl({ account_id: null, amount_cents: 1000 })], AP, LOC, 'ref')
    ).toThrow(/no GL category/);
  });
});
