import { describe, it, expect } from 'vitest';
import {
  computeCashIncomeStatement,
  type CashAccountMeta,
  type CashISInput,
} from './income-statement-cash';

/**
 * Cash-basis P&L — pure computation tests. No DB: we hand the compute function
 * the three normalized legs (customer receipts, bill payments, direct cash P&L)
 * and assert the recognized figures, the tax-exclusion, and the accrual-identical
 * section/summary shape.
 */

const accounts = new Map<string, CashAccountMeta>([
  ['a-4000', { accountId: 'a-4000', accountNumber: '4000', accountName: 'Product Revenue', accountType: 'REVENUE', groupName: 'Sales', groupOrder: 1, normalBalance: 'CREDIT' }],
  ['a-4100', { accountId: 'a-4100', accountNumber: '4100', accountName: 'Service Revenue', accountType: 'REVENUE', groupName: 'Sales', groupOrder: 1, normalBalance: 'CREDIT' }],
  ['a-5000', { accountId: 'a-5000', accountNumber: '5000', accountName: 'Materials', accountType: 'COGS', groupName: 'Direct Costs', groupOrder: 2, normalBalance: 'DEBIT' }],
  ['a-6000', { accountId: 'a-6000', accountNumber: '6000', accountName: 'Rent', accountType: 'OPEX', groupName: 'Overhead', groupOrder: 3, normalBalance: 'DEBIT' }],
  ['a-7000', { accountId: 'a-7000', accountNumber: '7000', accountName: 'Interest Income', accountType: 'OTHER', groupName: 'Other', groupOrder: 4, normalBalance: 'CREDIT' }],
  // A non-P&L account (sales-tax liability) that may appear on a leg's line set — must be dropped.
  ['a-2200', { accountId: 'a-2200', accountNumber: '2200', accountName: 'Sales Tax Payable', accountType: 'LIABILITY', groupName: 'Current Liabilities', groupOrder: 9, normalBalance: 'CREDIT' }],
]);

const filters = { startDate: '2026-01-01', endDate: '2026-01-31' };

function sectionTotal(model: ReturnType<typeof computeCashIncomeStatement>, type: string): number {
  return model.sections.find((s) => s.type === type)?.totalCents ?? 0;
}

describe('computeCashIncomeStatement', () => {
  it('recognizes revenue only when cash is received, excluding the sales-tax portion', () => {
    // Invoice: $1,000 revenue (600 product + 400 service) + $100 tax = $1,100 total.
    // Only $550 of cash applied → recognize half the revenue ($500), zero tax.
    const input: CashISInput = {
      accounts,
      receipts: [
        {
          cashCents: 550,
          documentTotalCents: 1100,
          lines: [
            { accountId: 'a-4000', amountCents: 600 },
            { accountId: 'a-4100', amountCents: 400 },
          ],
        },
      ],
      disbursements: [],
      directLines: [],
      filters,
    };
    const model = computeCashIncomeStatement(input);
    expect(sectionTotal(model, 'REVENUE')).toBe(500);
    // 550 * 600/1100 = 300 ; 550 * 400/1100 = 200
    const sales = model.sections.find((s) => s.type === 'REVENUE')!.groups.find((g) => g.name === 'Sales')!;
    expect(sales.accounts.map((a) => [a.accountNumber, a.amountCents])).toEqual([
      ['4000', 300],
      ['4100', 200],
    ]);
    expect(model.summary.netIncomeCents).toBe(500);
  });

  it('recognizes expense only when a bill is paid, excluding the tax portion', () => {
    // Bill: $2,000 expense (1200 COGS + 800 OPEX) + $200 tax = $2,200. Paid $1,100 (half).
    const input: CashISInput = {
      accounts,
      receipts: [],
      disbursements: [
        {
          cashCents: 1100,
          documentTotalCents: 2200,
          lines: [
            { accountId: 'a-5000', amountCents: 1200 },
            { accountId: 'a-6000', amountCents: 800 },
          ],
        },
      ],
      directLines: [],
      filters,
    };
    const model = computeCashIncomeStatement(input);
    expect(sectionTotal(model, 'COGS')).toBe(600); // 1100 * 1200/2200
    expect(sectionTotal(model, 'OPEX')).toBe(400); // 1100 * 800/2200
    expect(model.summary.grossProfitCents).toBe(-600);
    expect(model.summary.netIncomeCents).toBe(-1000);
  });

  it('captures direct cash sales and direct cash disbursements (leg C)', () => {
    const input: CashISInput = {
      accounts,
      receipts: [],
      disbursements: [],
      directLines: [
        { accountId: 'a-4000', debitCents: 0, creditCents: 300 }, // direct cash sale
        { accountId: 'a-6000', debitCents: 150, creditCents: 0 }, // direct expense payment
        { accountId: 'a-7000', debitCents: 0, creditCents: 50 }, // other income
      ],
      filters,
    };
    const model = computeCashIncomeStatement(input);
    expect(sectionTotal(model, 'REVENUE')).toBe(300);
    expect(sectionTotal(model, 'OPEX')).toBe(150);
    expect(sectionTotal(model, 'OTHER')).toBe(50);
    // net = (300 rev) - 0 cogs - 150 opex - 50 other = 100 (OTHER convention matches accrual engine)
    expect(model.summary.netIncomeCents).toBe(100);
  });

  it('combines all three legs and computes the full summary chain', () => {
    const input: CashISInput = {
      accounts,
      receipts: [
        { cashCents: 550, documentTotalCents: 1100, lines: [{ accountId: 'a-4000', amountCents: 600 }, { accountId: 'a-4100', amountCents: 400 }] },
      ],
      disbursements: [
        { cashCents: 1100, documentTotalCents: 2200, lines: [{ accountId: 'a-5000', amountCents: 1200 }, { accountId: 'a-6000', amountCents: 800 }] },
      ],
      directLines: [
        { accountId: 'a-4000', debitCents: 0, creditCents: 300 },
        { accountId: 'a-6000', debitCents: 150, creditCents: 0 },
        { accountId: 'a-7000', debitCents: 0, creditCents: 50 },
      ],
      filters,
    };
    const model = computeCashIncomeStatement(input);
    // Revenue: 4000 = 300 (A) + 300 (C) = 600 ; 4100 = 200 (A) → 800
    expect(sectionTotal(model, 'REVENUE')).toBe(800);
    expect(sectionTotal(model, 'COGS')).toBe(600);
    expect(sectionTotal(model, 'OPEX')).toBe(550); // 400 (B) + 150 (C)
    expect(sectionTotal(model, 'OTHER')).toBe(50);
    expect(model.summary.grossProfitCents).toBe(200); // 800 - 600
    expect(model.summary.ebitdaCents).toBe(-350); // 200 - 550
    expect(model.summary.netIncomeCents).toBe(-400); // -350 - 50
    expect(model.summary.grossMarginPct).toBe(25); // 200/800
    // 4000 aggregates two legs into one account row
    const s4000 = model.sections.find((s) => s.type === 'REVENUE')!.groups[0].accounts.find((a) => a.accountNumber === '4000')!;
    expect(s4000.amountCents).toBe(600);
    expect(model.filters?.basis).toBe('cash');
  });

  it('drops non-P&L accounts and stamps the accrual-identical shape', () => {
    // Line set includes a sales-tax LIABILITY line — it must not appear in the P&L.
    const input: CashISInput = {
      accounts,
      receipts: [
        { cashCents: 1100, documentTotalCents: 1100, lines: [{ accountId: 'a-4000', amountCents: 1000 }, { accountId: 'a-2200', amountCents: 100 }] },
      ],
      disbursements: [],
      directLines: [],
      filters,
    };
    const model = computeCashIncomeStatement(input);
    // 1100 * 1000/1100 = 1000 revenue ; the tax line maps to a LIABILITY → dropped.
    expect(sectionTotal(model, 'REVENUE')).toBe(1000);
    expect(model.sections.map((s) => s.type)).toEqual(['REVENUE', 'COGS', 'OPEX', 'OTHER']);
    // No liability leaked into any section.
    const anyLiability = model.sections.some((s) => s.groups.some((g) => g.accounts.some((a) => a.accountNumber === '2200')));
    expect(anyLiability).toBe(false);
    expect(model.summary).toHaveProperty('revenueCents', 1000);
  });

  it('is empty (all zeros) when no cash moved', () => {
    const model = computeCashIncomeStatement({ accounts, receipts: [], disbursements: [], directLines: [], filters });
    expect(model.summary.revenueCents).toBe(0);
    expect(model.summary.netIncomeCents).toBe(0);
    expect(model.sections.every((s) => s.groups.length === 0)).toBe(true);
  });
});
