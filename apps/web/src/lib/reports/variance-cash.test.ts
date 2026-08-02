import { describe, it, expect } from 'vitest';
import {
  computeCashFlowSnapshot,
  computeCashFlowVariance,
  computeBudgetVariance,
  isBudgetFavorable,
  type CashFlowAcctMeta,
  type CashFlowInputLine,
  type CashFlowRoleSets,
  type BudgetInputRow,
} from './variance-cash';

// Fixed numbers in → correct ranked cash / budget drivers out. This is the
// correctness guarantee for the extended flux narrative: the model only phrases
// what these deterministic computations produce.

// ── Cash-flow fixture ─────────────────────────────────────────────────────────
// Accounts: cash(bank), revenue, opex(incl. depreciation), AR, AP, fixed asset,
// long-term debt, equity.
const acctMeta = new Map<string, CashFlowAcctMeta>([
  ['cash', { type: 'ASSET', subType: 'CURRENT_ASSET', isBank: true, name: 'Operating Bank' }],
  ['rev', { type: 'REVENUE', subType: 'OPERATING_REVENUE', isBank: false, name: 'Service Revenue' }],
  ['opex', { type: 'OPEX', subType: 'OPERATING_EXPENSE', isBank: false, name: 'Rent' }],
  ['dep', { type: 'OPEX', subType: 'OPERATING_EXPENSE', isBank: false, name: 'Depreciation Expense' }],
  ['ar', { type: 'ASSET', subType: 'CURRENT_ASSET', isBank: false, name: 'Accounts Receivable' }],
  ['ap', { type: 'LIABILITY', subType: 'CURRENT_LIABILITY', isBank: false, name: 'Accounts Payable' }],
  ['fa', { type: 'ASSET', subType: 'FIXED_ASSET', isBank: false, name: 'Equipment' }],
  ['debt', { type: 'LIABILITY', subType: 'LONG_TERM_LIABILITY', isBank: false, name: 'Term Loan' }],
  ['eq', { type: 'EQUITY', subType: 'OWNER_EQUITY', isBank: false, name: 'Owner Capital' }],
]);
const roles: CashFlowRoleSets = {
  cashIds: new Set(['cash']),
  arIds: new Set(['ar']),
  apIds: new Set(['ap']),
};

// current period lines
const cur: CashFlowInputLine[] = [
  { account_id: 'rev', debit_cents: 0, credit_cents: 1_000_000 }, // revenue 1,000,000
  { account_id: 'opex', debit_cents: 300_000, credit_cents: 0 }, // opex 300,000
  { account_id: 'dep', debit_cents: 100_000, credit_cents: 0 }, // depreciation 100,000 (add-back)
  { account_id: 'ar', debit_cents: 200_000, credit_cents: 0 }, // AR up 200,000 (use of cash)
  { account_id: 'ap', debit_cents: 0, credit_cents: 150_000 }, // AP up 150,000 (source of cash)
  { account_id: 'fa', debit_cents: 500_000, credit_cents: 0 }, // capex 500,000 (use)
  { account_id: 'debt', debit_cents: 0, credit_cents: 400_000 }, // debt draw 400,000 (source)
  { account_id: 'eq', debit_cents: 50_000, credit_cents: 0 }, // owner draw 50,000 (use)
];

describe('computeCashFlowSnapshot', () => {
  const s = computeCashFlowSnapshot(cur, acctMeta, roles);

  it('adds back depreciation and nets working-capital changes into operating cash', () => {
    // netIncome = 1,000,000 − 400,000(opex incl dep) = 600,000
    // operating = 600,000 + 100,000(D&A) − 200,000(AR) + 150,000(AP) = 650,000
    expect(s.operatingCents).toBe(650_000);
  });

  it('treats capex as an investing use of cash', () => {
    expect(s.investingCents).toBe(-500_000);
  });

  it('sums debt and equity into financing', () => {
    // debt +400,000, equity draw −50,000
    expect(s.financingCents).toBe(350_000);
  });

  it('ties: net change = operating + investing + financing', () => {
    expect(s.netChangeCents).toBe(650_000 - 500_000 + 350_000);
  });

  it('excludes the reconciling cash account from the sections', () => {
    const withCash = computeCashFlowSnapshot(
      [...cur, { account_id: 'cash', debit_cents: 999_999, credit_cents: 0 }],
      acctMeta,
      roles,
    );
    expect(withCash.netChangeCents).toBe(s.netChangeCents);
  });
});

describe('computeCashFlowVariance — period over period', () => {
  const prior = computeCashFlowSnapshot(
    [
      { account_id: 'rev', debit_cents: 0, credit_cents: 1_000_000 },
      { account_id: 'opex', debit_cents: 300_000, credit_cents: 0 },
      { account_id: 'dep', debit_cents: 100_000, credit_cents: 0 },
      { account_id: 'ap', debit_cents: 0, credit_cents: 150_000 },
      { account_id: 'debt', debit_cents: 0, credit_cents: 400_000 },
      { account_id: 'eq', debit_cents: 50_000, credit_cents: 0 },
      // no AR movement, no capex this prior period
    ],
    acctMeta,
    roles,
  );
  const current = computeCashFlowSnapshot(cur, acctMeta, roles);
  const v = computeCashFlowVariance(current, prior);

  it('ranks capex and AR as the biggest movers of cash', () => {
    // capex delta = −500,000 − 0 = −500,000; AR delta = −200,000 − 0 = −200,000
    expect(v.drivers.map((d) => d.key).slice(0, 2)).toEqual(['INVESTING:capex', 'OPERATING:ar']);
  });

  it('flags a decline in cash contribution as unfavorable', () => {
    const capex = v.drivers.find((d) => d.key === 'INVESTING:capex');
    expect(capex?.favorable).toBe(false);
    expect(capex?.direction).toBe('down');
  });

  it('reports the net change in cash for both periods', () => {
    expect(v.netCurrentCents).toBe(current.netChangeCents);
    expect(v.netPriorCents).toBe(prior.netChangeCents);
    expect(v.netDeltaCents).toBe(current.netChangeCents - prior.netChangeCents);
  });
});

// ── Budget vs actual ──────────────────────────────────────────────────────────
describe('isBudgetFavorable', () => {
  it('revenue over budget is favorable', () => {
    expect(isBudgetFavorable('REVENUE', 1_000_000, 1_200_000)).toBe(true);
    expect(isBudgetFavorable('REVENUE', 1_000_000, 900_000)).toBe(false);
  });
  it('expense under budget is favorable', () => {
    expect(isBudgetFavorable('OPEX', 500_000, 400_000)).toBe(true);
    expect(isBudgetFavorable('COGS', 500_000, 600_000)).toBe(false);
  });
});

describe('computeBudgetVariance', () => {
  const rows: BudgetInputRow[] = [
    { key: '4000', label: 'Revenue', section: 'REVENUE', budgetCents: 1_000_000, actualCents: 900_000 }, // 100,000 under, unfavorable
    { key: '5000', label: 'COGS', section: 'COGS', budgetCents: 400_000, actualCents: 450_000 }, // 50,000 over, unfavorable
    { key: '6000', label: 'Rent', section: 'OPEX', budgetCents: 200_000, actualCents: 150_000 }, // 50,000 under, favorable
    { key: '6100', label: 'Marketing', section: 'OPEX', budgetCents: 100_000, actualCents: 100_000 }, // on budget → not a driver
  ];
  const v = computeBudgetVariance(rows);

  it('ranks by absolute variance and drops on-budget lines', () => {
    expect(v.drivers.map((d) => d.key)).toEqual(['4000', '5000', '6000']);
  });

  it('signs favorability per section', () => {
    const byKey = Object.fromEntries(v.drivers.map((d) => [d.key, d]));
    expect(byKey['4000'].favorable).toBe(false); // revenue under budget
    expect(byKey['5000'].favorable).toBe(false); // cost over budget
    expect(byKey['6000'].favorable).toBe(true); // cost under budget
  });

  it('delta is actual − budget and pct is null when budget is zero', () => {
    const rev = v.drivers.find((d) => d.key === '4000');
    expect(rev?.deltaCents).toBe(-100_000);
    expect(rev?.pct).toBe(-10);
    const newLine = computeBudgetVariance([
      { key: '7000', label: 'New Line', section: 'OPEX', budgetCents: 0, actualCents: 25_000 },
    ]);
    expect(newLine.drivers[0].pct).toBeNull();
  });

  it('computes budget vs actual net income', () => {
    // budget net = 1,000,000 − 400,000 − (200,000+100,000) = 300,000
    // actual net = 900,000 − 450,000 − (150,000+100,000) = 200,000
    expect(v.netPriorCents).toBe(300_000);
    expect(v.netCurrentCents).toBe(200_000);
    expect(v.netDeltaCents).toBe(-100_000);
  });
});
