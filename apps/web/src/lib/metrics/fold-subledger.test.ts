import { describe, expect, it } from 'vitest';
import { classifyAccounts, type AccountMeta } from './classes';
import { budgetMonth, foldBudgets, foldGl, lookThroughOwnership, type GlLine } from './fold';
import { agingAsOf, closeSeries, headcountSeries, jobSnapshot, subledgerSeries, unitSeries, warrantySeries, type SubledgerDoc } from './subledger';

const acct = (id: string, number: string, name: string, type: string, subType: string, isBank = false): AccountMeta => ({ id, number, name, type, subType, isBank, isCreditCard: false });

const COA: AccountMeta[] = [
  acct('bank', '1000', 'Operating Bank', 'ASSET', 'CURRENT_ASSET', true),
  acct('ar', '1100', 'Accounts Receivable', 'ASSET', 'CURRENT_ASSET'),
  acct('inv', '1200', 'Inventory - Raw Materials', 'ASSET', 'CURRENT_ASSET'),
  acct('equip', '1500', 'Equipment', 'ASSET', 'FIXED_ASSET'),
  acct('accum', '1510', 'Accumulated Depreciation - Equipment', 'ASSET', 'FIXED_ASSET'),
  acct('ap', '2000', 'Accounts Payable', 'LIABILITY', 'CURRENT_LIABILITY'),
  acct('loan', '2500', 'Term Loan', 'LIABILITY', 'LONG_TERM_LIABILITY'),
  acct('draw', '3010', 'Owner Draw', 'EQUITY', 'EQUITY'),
  acct('rev', '4000', 'Service Revenue', 'REVENUE', 'REVENUE'),
  acct('cogs', '5000', 'Direct Labor', 'COGS', 'COST_OF_GOODS_SOLD'),
  acct('wages', '6000', 'Salaries & Wages', 'OPEX', 'OPERATING_EXPENSE'),
  acct('dep', '6500', 'Depreciation Expense', 'OPEX', 'OPERATING_EXPENSE'),
  acct('int', '8000', 'Interest Expense', 'OTHER', 'OTHER_EXPENSE'),
];

describe('classifyAccounts — by role, type and name, never a hard-coded number', () => {
  const m = classifyAccounts(COA, new Map([['NOTES_PAYABLE', ['loan']]]));
  it('resolves each class', () => {
    expect(m.cash?.accountIds).toEqual(['bank']);
    expect(m.ar).toEqual({ accountIds: ['ar'], via: ['role_default_number'] });
    expect(m.inventory?.accountIds).toEqual(['inv']);
    expect(m.capex?.accountIds).toEqual(['equip']); // accumulated depreciation excluded
    expect(m.total_debt?.accountIds).toEqual(['loan']);
    expect(m.total_debt?.via).toContain('role');
    expect(m.da_operating?.accountIds).toEqual(['dep']);
    expect(m.da_opex?.accountIds).toEqual(['dep']);
    expect(m.interest_expense?.accountIds).toEqual(['int']);
    expect(m.payroll_expense?.accountIds).toEqual(['wages']);
    expect(m.distributions?.accountIds).toEqual(['draw']);
    expect(m.revenue?.accountIds).toEqual(['rev']);
    expect(m.total_assets?.accountIds).toHaveLength(5);
    expect(m.retainage_receivable).toBeUndefined();
  });
  it('an account_roles row beats the default number', () => {
    const remapped = classifyAccounts([...COA, acct('ar2', '1105', 'AR - Trade', 'ASSET', 'CURRENT_ASSET')], new Map([['AR_CONTROL', ['ar2']]]));
    expect(remapped.ar).toEqual({ accountIds: ['ar2'], via: ['role'] });
  });
});

describe('foldGl', () => {
  const mapping = classifyAccounts(COA, new Map());
  const lines: GlLine[] = [
    { companyId: 'a', accountId: 'bank', month: null, kind: 'STANDARD', debitCents: 5_000, creditCents: 0 },
    { companyId: 'a', accountId: 'bank', month: '2026-12', kind: 'STANDARD', debitCents: 1_000, creditCents: 0 },
    { companyId: 'a', accountId: 'rev', month: '2026-12', kind: 'STANDARD', debitCents: 0, creditCents: 1_000 },
    // Year-end close: revenue to retained earnings. Must NOT erase December revenue.
    { companyId: 'a', accountId: 'rev', month: '2026-12', kind: 'CLOSING', debitCents: 1_000, creditCents: 0 },
    { companyId: 'a', accountId: 'equip', month: '2026-12', kind: 'STANDARD', debitCents: 700, creditCents: 0 },
    { companyId: 'a', accountId: 'equip', month: '2026-12', kind: 'STANDARD', debitCents: 0, creditCents: 200 }, // disposal
    { companyId: 'a', accountId: 'rev', month: '2025-06', kind: 'STANDARD', debitCents: 0, creditCents: 9 }, // before range
  ];
  const g = foldGl(lines, mapping, '2026-01');
  const a = g.byCompany.get('a')!;
  it('P&L flows exclude the year-end close', () => {
    expect(a.revenue?.months['2026-12']).toBe(1_000);
    expect(a.revenue?.opening).toBe(0);
  });
  it('balances carry the opening bucket', () => {
    expect(a.cash).toEqual({ opening: 5_000, months: { '2026-12': 1_000 } });
  });
  it('capex counts gross additions only', () => {
    expect(a.capex?.months['2026-12']).toBe(700);
    expect(a.total_assets?.months['2026-12']).toBe(1_000 + 700 - 200);
  });
  it('records the earliest month seen', () => {
    expect(g.firstMonth.get('a')).toBe('2025-06');
  });
});

describe('budgets', () => {
  it('maps fiscal_year + period_number to a calendar month', () => {
    expect(budgetMonth(2026, 1, 1)).toBe('2026-01');
    expect(budgetMonth(2026, 12, 1)).toBe('2026-12');
    expect(budgetMonth(2026, 1, 7)).toBe('2025-07');
    expect(budgetMonth(2026, 13, 7)).toBe('2026-06');
  });
  it('folds income-statement budgets only', () => {
    const mapping = classifyAccounts(COA, new Map());
    const b = foldBudgets(
      [
        { companyId: 'a', accountId: 'rev', month: '2026-09', naturalCents: 900 },
        { companyId: 'a', accountId: 'bank', month: '2026-09', naturalCents: 50 },
      ],
      mapping,
    );
    expect(b.get('a')?.revenue).toEqual({ '2026-09': 900 });
    expect(b.get('a')?.cash).toBeUndefined();
  });
});

describe('lookThroughOwnership', () => {
  const rows = [
    { parentId: 'root', childId: 'x', percent: 80, method: 'FULL' as const, effectiveStart: '2020-01-01', effectiveEnd: null },
    { parentId: 'x', childId: 'y', percent: 100, method: 'FULL' as const, effectiveStart: '2020-01-01', effectiveEnd: null },
    { parentId: 'root', childId: 'z', percent: 30, method: 'EQUITY' as const, effectiveStart: '2020-01-01', effectiveEnd: null },
    { parentId: 'root', childId: 'w', percent: 15, method: 'NONE' as const, effectiveStart: '2020-01-01', effectiveEnd: null },
    { parentId: 'root', childId: 'v', percent: 60, method: 'FULL' as const, effectiveStart: '2020-01-01', effectiveEnd: '2025-12-31' },
    { parentId: 'root', childId: 'v', percent: 90, method: 'FULL' as const, effectiveStart: '2026-01-01', effectiveEnd: null },
    { parentId: 'root', childId: 'late', percent: 70, method: 'FULL' as const, effectiveStart: '2027-01-01', effectiveEnd: null },
  ];
  const o = lookThroughOwnership(rows, '2026-09-30');
  it('multiplies along the chain', () => {
    expect(o.get('root')).toBe(100);
    expect(o.get('x')).toBe(80);
    expect(o.get('y')).toBe(80);
    expect(o.get('z')).toBe(30);
    expect(o.get('w')).toBe(0);
  });
  it('uses the row in effect, else the latest row', () => {
    expect(o.get('v')).toBe(90);
    expect(lookThroughOwnership(rows, '2025-06-30').get('v')).toBe(60);
    expect(o.get('late')).toBe(70);
  });
});

const doc = (over: Partial<SubledgerDoc>): SubledgerDoc => ({
  id: 'i1',
  counterpartyId: 'c1',
  issueDate: '2026-08-01',
  dueDate: '2026-08-31',
  totalCents: 1_000,
  paidCents: 0,
  status: 'SENT',
  payments: [],
  lastChangedDate: '2026-08-01',
  ...over,
});

describe('aging', () => {
  const today = '2026-10-24';
  it('buckets by days past due at each month end', () => {
    const d = doc({ paidCents: 400, payments: [{ date: '2026-09-10', cents: 400 }], status: 'PARTIALLY_PAID', lastChangedDate: '2026-09-10' });
    expect(agingAsOf([d], '2026-08-31', { today })).toMatchObject({ open: 1_000, current: 1_000 });
    expect(agingAsOf([d], '2026-09-30', { today })).toMatchObject({ open: 600, d1_30: 600 });
    expect(agingAsOf([d], '2026-12-31', { today: '2027-01-15' })).toMatchObject({ open: 600, over90: 600 });
  });
  it('omits a past month when an undated settlement happened after it (never guesses)', () => {
    const d = doc({ paidCents: 1_000, status: 'PAID', lastChangedDate: '2026-09-15' });
    expect(agingAsOf([d], '2026-08-31', { today })).toBeNull();
    expect(agingAsOf([d], '2026-09-30', { today })).toMatchObject({ open: 0 });
  });
  it('void and draft documents never count; write-offs settle', () => {
    expect(agingAsOf([doc({ status: 'VOIDED' }), doc({ status: 'DRAFT' })], '2026-09-30', { today })).toMatchObject({ open: 0 });
    expect(agingAsOf([doc({ status: 'WRITTEN_OFF', lastChangedDate: '2026-09-01' })], '2026-09-30', { today })).toMatchObject({ open: 0 });
  });
  it('monthly series: sales by issue month, days to pay by final payment month, concentration', () => {
    const d = doc({ paidCents: 1_000, status: 'PAID', payments: [{ date: '2026-08-20', cents: 600 }, { date: '2026-09-10', cents: 400 }], lastChangedDate: '2026-09-10' });
    const s = subledgerSeries([d, doc({ id: 'i2', counterpartyId: 'c2', issueDate: '2026-09-05', dueDate: '2026-10-05', totalCents: 500 })], { side: 'ar', from: '2026-08', to: '2026-10', today });
    expect(s.series.credit_sales).toEqual({ '2026-08': 1_000, '2026-09': 500, '2026-10': 0 });
    expect(s.series.customer_days_to_pay_weighted?.['2026-09']).toBe(40 * 1_000);
    expect(s.series.customer_paid_amount?.['2026-09']).toBe(1_000);
    expect(s.series.ar_open?.['2026-09']).toBe(500);
    expect(s.series.ar_over_90?.['2026-10']).toBe(0);
    expect(s.series.ar_1_30?.['2026-10']).toBe(500); // as of today, 19 days late
    expect(s.byCounterparty['2026-09']).toEqual({ c2: 500 });
  });
});

describe('jobs, dealer, people, close', () => {
  it('job snapshot mirrors the WIP schedule arithmetic', () => {
    const s = jobSnapshot([
      { status: 'ACTIVE', contractCents: 1_000_000, estimatedRevenueCents: null, estimatedCostCents: 800_000, budgetSumCents: 0, actualCostCents: 400_000, billedToDateCents: 450_000, pctComplete: null },
      { status: 'COMPLETE', contractCents: 250, estimatedRevenueCents: null, estimatedCostCents: 200, budgetSumCents: 0, actualCostCents: 200, billedToDateCents: 300, pctComplete: 100 },
      { status: 'BID', contractCents: 9_999, estimatedRevenueCents: null, estimatedCostCents: 1, budgetSumCents: 0, actualCostCents: 0, billedToDateCents: 0, pctComplete: null },
    ]);
    expect(s).toEqual({
      jobs_active: 1,
      backlog: 500_000,
      wip_underbillings: 50_000,
      wip_overbillings: 50,
      cost_to_complete: 400_000,
      gp_in_backlog: 100_000,
      job_contract_value: 1_000_000,
      job_estimated_gp: 200_000,
    });
    expect(jobSnapshot([])).toBeNull();
  });
  it('units in stock and age at each month end', () => {
    const s = unitSeries(
      [
        { status: 'IN_STOCK', receivedDate: '2026-01-01', soldDate: null },
        { status: 'SOLD', receivedDate: '2026-08-01', soldDate: '2026-09-15' },
        { status: 'WRITTEN_OFF', receivedDate: '2026-01-01', soldDate: null },
      ],
      '2026-08',
      '2026-09',
      '2026-10-24',
    );
    expect(s.units_in_stock).toEqual({ '2026-08': 2, '2026-09': 1 });
    expect(s.units_aged).toEqual({ '2026-08': 1, '2026-09': 1 });
    expect(s.unit_days_in_stock?.['2026-09']).toBe(272);
  });
  it('warranty: claims by submission month, open only for the latest month', () => {
    const s = warrantySeries([{ status: 'SUBMITTED', submittedDate: '2026-09-02', claimedCents: 900, settledCents: 300, writtenOffCents: 0, debitedCents: 0 }], '2026-08', '2026-09');
    expect(s.warranty_claimed).toEqual({ '2026-08': 0, '2026-09': 900 });
    expect(s.warranty_open).toEqual({ '2026-09': 600 });
  });
  it('headcount = distinct people paid in the month', () => {
    expect(headcountSeries([{ employeeId: 'e1', payDate: '2026-09-05' }, { employeeId: 'e1', payDate: '2026-09-19' }, { employeeId: 'e2', payDate: '2026-09-19' }])).toEqual({ '2026-09': 2 });
  });
  it('close cycle days and books closed through', () => {
    const c = closeSeries([
      { month: '2026-07', status: 'HARD_CLOSE', closedAt: '2026-08-09T15:00:00Z' },
      { month: '2026-08', status: 'HARD_CLOSE', closedAt: '2026-09-12T15:00:00Z' },
      { month: '2026-09', status: 'SOFT_CLOSE', closedAt: null },
    ]);
    expect(c.closeDays).toEqual({ '2026-07': 9, '2026-08': 12 });
    expect(c.closedThrough).toBe('2026-08');
  });
});
