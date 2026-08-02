/**
 * Direct-method cash-flow engine — classification + tie-out assertions.
 *
 * The engine is pure: it decomposes the counterpart legs of every cash-moving
 * journal entry into direct-method lines and MUST tie back to the independently
 * measured net change in cash. These tests pin the classification rules and the
 * reconciliation guarantee.
 */

import { describe, it, expect } from 'vitest';
import {
  computeDirectCashFlow,
  classifyLeg,
  type CounterpartLeg,
} from './cash-flow-direct';

// Helper: a counterpart leg. `dr`/`cr` are cents.
const leg = (over: Partial<CounterpartLeg> & { accountType: string }): CounterpartLeg => ({
  accountSubType: over.accountSubType ?? '',
  accountName: over.accountName ?? '',
  debitCents: over.debitCents ?? 0,
  creditCents: over.creditCents ?? 0,
  roleTags: over.roleTags,
  ...over,
});

describe('classifyLeg', () => {
  it('routes revenue and the receivable family to customer receipts', () => {
    expect(classifyLeg(leg({ accountType: 'REVENUE', creditCents: 100 }), 100)).toBe('CUSTOMER_RECEIPTS');
    expect(classifyLeg(leg({ accountType: 'ASSET', roleTags: ['AR_CONTROL'], creditCents: 100 }), 100)).toBe('CUSTOMER_RECEIPTS');
    expect(classifyLeg(leg({ accountType: 'LIABILITY', roleTags: ['DEFERRED_REVENUE'], creditCents: 50 }), 50)).toBe('CUSTOMER_RECEIPTS');
  });

  it('routes COGS/OPEX and payables to supplier payments', () => {
    expect(classifyLeg(leg({ accountType: 'COGS', debitCents: 100 }), -100)).toBe('SUPPLIER_PAYMENTS');
    expect(classifyLeg(leg({ accountType: 'OPEX', accountName: 'Office Supplies', debitCents: 40 }), -40)).toBe('SUPPLIER_PAYMENTS');
    expect(classifyLeg(leg({ accountType: 'LIABILITY', roleTags: ['AP_CONTROL'], debitCents: 100 }), -100)).toBe('SUPPLIER_PAYMENTS');
  });

  it('routes wages/payroll to employee payments (by role and by name)', () => {
    expect(classifyLeg(leg({ accountType: 'OPEX', roleTags: ['WAGES_EXPENSE'], debitCents: 100 }), -100)).toBe('EMPLOYEE_PAYMENTS');
    expect(classifyLeg(leg({ accountType: 'OPEX', accountName: 'Salaries & Wages', debitCents: 100 }), -100)).toBe('EMPLOYEE_PAYMENTS');
    expect(classifyLeg(leg({ accountType: 'LIABILITY', roleTags: ['FICA_PAYABLE'], debitCents: 20 }), -20)).toBe('EMPLOYEE_PAYMENTS');
  });

  it('routes interest and income tax by name', () => {
    expect(classifyLeg(leg({ accountType: 'OPEX', accountName: 'Interest Expense', debitCents: 30 }), -30)).toBe('INTEREST_PAID');
    expect(classifyLeg(leg({ accountType: 'OPEX', accountName: 'Income Tax Expense', debitCents: 30 }), -30)).toBe('INCOME_TAX_PAID');
  });

  it('splits fixed-asset movement into capex vs asset sales by cash direction', () => {
    // Buying an asset: DR fixed asset ⇒ cash out ⇒ contribution negative ⇒ capex.
    expect(classifyLeg(leg({ accountType: 'ASSET', accountSubType: 'FIXED_ASSET', debitCents: 500 }), -500)).toBe('CAPEX');
    // Selling: CR fixed asset ⇒ cash in ⇒ contribution positive ⇒ asset sales.
    expect(classifyLeg(leg({ accountType: 'ASSET', accountSubType: 'FIXED_ASSET', creditCents: 500 }), 500)).toBe('ASSET_SALES');
  });

  it('routes long-term debt and equity to financing', () => {
    expect(classifyLeg(leg({ accountType: 'LIABILITY', accountSubType: 'LONG_TERM_LIABILITY', creditCents: 1000 }), 1000)).toBe('DEBT_FINANCING');
    expect(classifyLeg(leg({ accountType: 'EQUITY', accountName: 'Owner Contributions', creditCents: 1000 }), 1000)).toBe('EQUITY_CONTRIBUTIONS');
    expect(classifyLeg(leg({ accountType: 'EQUITY', roleTags: ['OWNERS_DRAW'], debitCents: 200 }), -200)).toBe('DISTRIBUTIONS');
  });
});

describe('computeDirectCashFlow', () => {
  it('ties out: reported net change equals the measured cash change', () => {
    // Customer paid 1,000 on account (DR cash / CR AR) → counterpart AR credit 1000.
    // Paid a vendor bill 400 (DR AP / CR cash) → counterpart AP debit 400.
    // Net cash change = +600.
    const result = computeDirectCashFlow({
      beginningCashCents: 5_000,
      netCashChangeCents: 600,
      legs: [
        leg({ accountType: 'ASSET', roleTags: ['AR_CONTROL'], creditCents: 1_000 }),
        leg({ accountType: 'LIABILITY', roleTags: ['AP_CONTROL'], debitCents: 400 }),
      ],
    });

    expect(result.operating.totalCents).toBe(600);
    expect(result.netChangeCents).toBe(600);
    expect(result.endingCashCents).toBe(5_600);
    expect(result.varianceCents).toBe(0);
    expect(result.reconciled).toBe(true);

    const receipts = result.operating.lines.find((l) => l.key === 'CUSTOMER_RECEIPTS');
    const payments = result.operating.lines.find((l) => l.key === 'SUPPLIER_PAYMENTS');
    expect(receipts?.amountCents).toBe(1_000);
    expect(payments?.amountCents).toBe(-400);
  });

  it('separates operating, investing and financing sections', () => {
    const result = computeDirectCashFlow({
      beginningCashCents: 0,
      netCashChangeCents: 1_000 - 800 - 5_000 + 10_000,
      legs: [
        leg({ accountType: 'REVENUE', creditCents: 1_000 }), // operating in
        leg({ accountType: 'OPEX', accountName: 'Rent', debitCents: 800 }), // operating out
        leg({ accountType: 'ASSET', accountSubType: 'FIXED_ASSET', accountName: 'Equipment', debitCents: 5_000 }), // investing out
        leg({ accountType: 'LIABILITY', accountSubType: 'LONG_TERM_LIABILITY', accountName: 'Term Loan', creditCents: 10_000 }), // financing in
      ],
    });

    expect(result.operating.totalCents).toBe(200);
    expect(result.investing.totalCents).toBe(-5_000);
    expect(result.financing.totalCents).toBe(10_000);
    expect(result.netChangeCents).toBe(5_200);
    expect(result.reconciled).toBe(true);
  });

  it('reports a non-zero variance when the entries do not fully explain the cash move', () => {
    const result = computeDirectCashFlow({
      beginningCashCents: 0,
      netCashChangeCents: 1_000, // measured
      legs: [leg({ accountType: 'REVENUE', creditCents: 600 })], // only explains 600
    });
    expect(result.netChangeCents).toBe(600);
    expect(result.varianceCents).toBe(400);
    expect(result.reconciled).toBe(false);
  });

  it('nets multiple legs of the same line into one row', () => {
    const result = computeDirectCashFlow({
      beginningCashCents: 0,
      netCashChangeCents: 900,
      legs: [
        leg({ accountType: 'REVENUE', creditCents: 1_000 }),
        leg({ accountType: 'REVENUE', accountName: 'Refund', debitCents: 100 }),
      ],
    });
    const receipts = result.operating.lines.filter((l) => l.key === 'CUSTOMER_RECEIPTS');
    expect(receipts.length).toBe(1);
    expect(receipts[0].amountCents).toBe(900);
  });
});
