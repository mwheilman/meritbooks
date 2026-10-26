/**
 * Wave-3 audit fixes #2–#4: ONE cash definition (balance sheet = cash flow = canonical book cash),
 * intercompany balances on their own lines, and the current ratio as a multiple.
 */
import { describe, expect, it } from 'vitest';
import { buildReport, cashFlowCategory } from './build';
import { planReport } from './plan';
import { formatCell } from './format';
import { isCashAccount, presentAccounts, presentationLine, withEffectiveRoles } from './presentation';
import type { AccountMeta, BalanceRow, EngineData, ReportRequest, ReportResult } from './types';

const CO = '11111111-1111-4111-8111-111111111111';
const acct = (id: string, number: string, name: string, type: AccountMeta['type'], subType: string, group: string, groupOrder: number, normal: 'DEBIT' | 'CREDIT', extra: Partial<AccountMeta> = {}): AccountMeta => ({
  id, number, name, type, subType, subTypeName: subType, subTypeOrder: type === 'ASSET' ? 1 : 2, groupId: `g-${group}`, groupName: group, groupOrder, order: Number(number),
  normalBalance: normal, isBank: false, isEliminating: false, isActive: true, roles: [], cashFlowCategory: null, ...extra,
});
// A chart like the live tenant's: processor clearing sits in the "Cash & Cash Equivalents" group
// and the intercompany payable in the "Accounts Payable" group.
const ACCOUNTS: AccountMeta[] = [
  acct('bank', '1000', 'Operating Checking', 'ASSET', 'CURRENT_ASSET', 'Cash & Cash Equivalents', 1, 'DEBIT', { isBank: true }),
  acct('petty', '1050', 'Petty Cash', 'ASSET', 'CURRENT_ASSET', 'Cash & Cash Equivalents', 1, 'DEBIT'),
  acct('clear', '1095', 'Payment Processor Clearing', 'ASSET', 'CURRENT_ASSET', 'Cash & Cash Equivalents', 1, 'DEBIT'),
  acct('ar', '1100', 'Accounts Receivable', 'ASSET', 'CURRENT_ASSET', 'Accounts Receivable', 2, 'DEBIT', { roles: ['AR_CONTROL'] }),
  acct('ap', '2000', 'Accounts Payable', 'LIABILITY', 'CURRENT_LIABILITY', 'Accounts Payable', 1, 'CREDIT', { roles: ['AP_CONTROL'] }),
  acct('icap', '2020', 'Intercompany Payable', 'LIABILITY', 'CURRENT_LIABILITY', 'Accounts Payable', 1, 'CREDIT', { roles: ['INTERCOMPANY_AP'] }),
  acct('cap', '3000', 'Capital', 'EQUITY', 'EQUITY', 'Equity', 1, 'CREDIT'),
  acct('rev', '4000', 'Sales', 'REVENUE', 'REVENUE', 'Revenue', 1, 'CREDIT'),
  acct('rent', '6100', 'Rent', 'OPEX', 'OPERATING_EXPENSE', 'Occupancy', 1, 'DEBIT'),
];
const row = (accountId: string, period: string | null, debit: number, credit: number): BalanceRow => ({
  companyId: CO, accountId, period, kind: 'STANDARD', departmentId: null, classId: null, jobId: null, itemId: null, counterpartyId: null, debit, credit,
});
function data(): EngineData {
  return {
    orgFiscalYearStartMonth: 1,
    accounts: ACCOUNTS,
    companies: [{ id: CO, name: 'Northwind', shortCode: 'NW', fiscalYearStartMonth: 1 }],
    companyIds: [CO],
    balances: [
      // opening: 50,000.00 in the bank from capital
      row('bank', null, 5_000_000, 0), row('cap', null, 0, 5_000_000),
      // Jun 2026: a 1,500.00 sale, 97.00 of it still at the processor; 500.00 billed on account;
      // 50,000.00 borrowed from a sister company (intercompany payable), 400.00 petty cash float.
      row('clear', '2026-06-01', 9_700, 0), row('bank', '2026-06-01', 140_300, 0), row('rev', '2026-06-01', 0, 150_000),
      row('ar', '2026-06-01', 50_000, 0), row('rev', '2026-06-01', 0, 50_000),
      row('bank', '2026-06-01', 5_000_000, 0), row('icap', '2026-06-01', 0, 5_000_000),
      row('petty', '2026-06-01', 40_000, 0), row('bank', '2026-06-01', 0, 40_000),
      // a 200.00 rent bill, unpaid (trade AP)
      row('rent', '2026-06-01', 20_000, 0), row('ap', '2026-06-01', 0, 20_000),
    ],
    budgets: [],
    basisDeltas: [],
    periodStatus: [],
    dimensions: {},
    ownership: [],
    accumulatedDepreciationIds: [],
    today: '2026-10-24',
  };
}
function run(req: Partial<ReportRequest>): ReportResult {
  const r: ReportRequest = { statement: 'balance_sheet', scope: { companyIds: [CO] }, period: { preset: 'month', asOf: '2026-06-30' }, columns: 'single', compare: [], basis: 'ACCRUAL', rounding: 'cents', ...req };
  const d = data();
  const plan = planReport(r, { companies: d.companies, companyIds: [CO], orgFiscalYearStartMonth: 1, dimensions: {} });
  return buildReport(r, plan, d, '2026-10-24T00:00:00Z');
}
const valueOf = (res: ReportResult, id: string) => res.rows.find((r) => r.id === id)?.values[0] ?? null;

describe('effective roles + canonical cash', () => {
  it('a role with no mapping falls back to its standard number (1050 = cash on hand)', () => {
    const eff = withEffectiveRoles(ACCOUNTS);
    expect(eff.find((a) => a.id === 'petty')!.roles).toContain('CASH_ON_HAND');
    expect(eff.find((a) => a.id === 'clear')!.roles).toContain('SETTLEMENT_CLEARING');
    // mapped roles are never duplicated onto the default number
    expect(eff.find((a) => a.id === 'ar')!.roles).toEqual(['AR_CONTROL']);
  });
  it('processor clearing is NOT cash; bank + petty cash are', () => {
    const eff = new Map(withEffectiveRoles(ACCOUNTS).map((a) => [a.id, a]));
    expect(isCashAccount(eff.get('bank')!)).toBe(true);
    expect(isCashAccount(eff.get('petty')!)).toBe(true);
    expect(isCashAccount(eff.get('clear')!)).toBe(false);
    expect(presentationLine(eff.get('clear')!)).toBe('inTransit');
    expect(presentationLine(eff.get('icap')!)).toBe('icAp');
    expect(cashFlowCategory(eff.get('petty')!, new Set())).toBe('CASH');
    expect(cashFlowCategory(eff.get('clear')!, new Set())).toBe('OPERATING');
  });
  it('a tenant override cannot make a non-cash account cash (the tie would break)', () => {
    const eff = withEffectiveRoles(ACCOUNTS).find((a) => a.id === 'clear')!;
    expect(cashFlowCategory({ ...eff, cashFlowCategory: 'CASH' }, new Set())).toBe('OPERATING');
  });
  it('presentAccounts keeps the source group for layout selectors', () => {
    const p = presentAccounts(ACCOUNTS).find((a) => a.id === 'icap')!;
    expect(p.groupName).toMatch(/intercompany/i);
    expect(p.sourceGroupId).toBe('g-Accounts Payable');
  });
});

describe('balance sheet, cash flow and the tie read the SAME cash', () => {
  it('BS cash line = bank + petty cash; processor clearing on its own line', () => {
    const bs = run({});
    expect(valueOf(bs, 'ca:g:__pres_cash')).toBe(5_000_000 + 140_300 + 5_000_000 - 40_000 + 40_000);
    expect(valueOf(bs, 'ca:g:__pres_in_transit')).toBe(9_700);
    expect(bs.rows.find((r) => r.id === 'ca:g:__pres_cash')!.label).toBe('Cash & cash equivalents');
  });
  it('intercompany payable is its own line, not inside trade accounts payable', () => {
    const bs = run({});
    expect(valueOf(bs, 'cl:g:__pres_ic_ap')).toBe(5_000_000);
    expect(valueOf(bs, 'cl:g:g-Accounts Payable')).toBe(20_000);
    expect(bs.rows.find((r) => r.id === 'cl:g:g-Accounts Payable')?.accountIds ?? []).not.toContain('icap');
  });
  it('cash flow ending cash = BS cash line, and the check compares that number', () => {
    const bs = run({});
    const cf = run({ statement: 'cash_flow' });
    expect(valueOf(cf, 'end')).toBe(valueOf(bs, 'ca:g:__pres_cash'));
    expect(valueOf(cf, 'bs_cash')).toBe(valueOf(bs, 'ca:g:__pres_cash'));
    expect(cf.checks.every((c) => c.ok)).toBe(true);
  });
  it('current ratio is a multiple, formatted ×, never a percent', () => {
    const bs = run({});
    const cr = bs.rows.find((r) => r.id === 'cr')!;
    expect(cr.ratio).toBe(true);
    expect(cr.percent).toBeUndefined();
    const ca = valueOf(bs, 'ca')!;
    const cl = valueOf(bs, 'cl')!;
    expect(cr.values[0]).toBeCloseTo(ca / cl, 4);
    expect(formatCell(cr, bs.columns[0], cr.values[0], 'cents')).toBe(`${(ca / cl).toFixed(2)}×`);
  });
});
