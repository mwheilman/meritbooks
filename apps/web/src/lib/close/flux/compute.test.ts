/** AC-3E.2 — comparison bases, BS ending balance vs P&L activity, normal-balance signing. */

import { describe, it, expect } from 'vitest';
import { computeFluxLines, lineKeyFor, monthBounds, parseLineKey, roundedMean, shiftPeriod, type ActivityCell } from './compute';
import { DEFAULT_FLUX_POLICY } from './materiality';
import type { FluxAccount, FluxPolicy } from './types';

const ACCTS: FluxAccount[] = [
  { id: 'rev', number: '4000', name: 'Revenue', type: 'REVENUE', subType: 'REVENUE', groupId: 'g-rev', groupName: 'Sales' },
  { id: 'rent', number: '6100', name: 'Rent', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupId: 'g-occ', groupName: 'Occupancy' },
  { id: 'cash', number: '1000', name: 'Operating cash', type: 'ASSET', subType: 'CURRENT_ASSET', groupId: 'g-cash', groupName: 'Cash' },
  { id: 'ap', number: '2000', name: 'Accounts payable', type: 'LIABILITY', subType: 'CURRENT_LIABILITY', groupId: 'g-ap', groupName: 'AP' },
  { id: 'oi', number: '7000', name: 'Interest income', type: 'OTHER', subType: 'OTHER_INCOME', groupId: null, groupName: null },
];

const cell = (accountId: string, periodKey: string, netDebitCents: number, departmentId: string | null = null): ActivityCell => ({ accountId, periodKey, netDebitCents, departmentId, classId: null });
const P = (over: Partial<FluxPolicy> = {}): FluxPolicy => ({ ...DEFAULT_FLUX_POLICY, ...over });

describe('period helpers', () => {
  it('shifts across years and bounds months', () => {
    expect(shiftPeriod('2026-01', -1)).toBe('2025-12');
    expect(shiftPeriod('2026-10', -12)).toBe('2025-10');
    expect(shiftPeriod('2025-12', 1)).toBe('2026-01');
    expect(monthBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthBounds('2028-02').end).toBe('2028-02-29');
  });

  it('rounds the mean half away from zero in integer cents', () => {
    expect(roundedMean([1, 1, 2])).toBe(1);
    expect(roundedMean([1, 2, 2])).toBe(2); // 1.667
    expect(roundedMean([-1, -2, -2])).toBe(-2);
    expect(roundedMean([0, 0, 1])).toBe(0);
    expect(roundedMean([2, 2, 2, 1])).toBe(2); // 1.75
    expect(roundedMean([1, 2])).toBe(2); // 1.5 rounds away from zero
    expect(roundedMean([-1, -2])).toBe(-2);
  });

  it('builds and parses line keys', () => {
    expect(lineKeyFor('rent', 'PNL', 'ACCOUNT_DEPARTMENT', 'd1', null)).toBe('rent|d:d1');
    expect(lineKeyFor('rent', 'PNL', 'ACCOUNT_CLASS', null, null)).toBe('rent|c:none');
    expect(lineKeyFor('cash', 'BS', 'ACCOUNT_DEPARTMENT', 'd1', null)).toBe('cash');
    expect(parseLineKey('rent|d:d1')).toEqual({ accountId: 'rent', departmentId: 'd1', classId: null, dim: 'd' });
    expect(parseLineKey('rent|c:none')).toEqual({ accountId: 'rent', departmentId: null, classId: null, dim: 'c' });
  });
});

describe('computeFluxLines', () => {
  const activity: ActivityCell[] = [
    // Revenue (credit-normal): Sep 100k, Oct 160k credits.
    cell('rev', '2026-09', -10_000_000), cell('rev', '2026-10', -16_000_000),
    cell('rev', '2026-08', -9_000_000), cell('rev', '2026-07', -8_000_000), cell('rev', '2025-10', -12_000_000),
    // Rent (debit-normal): flat 10k.
    cell('rent', '2026-09', 1_000_000), cell('rent', '2026-10', 1_000_000),
    // Cash activity: Oct +20k, Sep -5k.
    cell('cash', '2026-10', 2_000_000), cell('cash', '2026-09', -500_000),
    // Interest income (OTHER_INCOME ⇒ credit-normal), new this month.
    cell('oi', '2026-10', -700_000),
  ];
  const closing = new Map([['cash', 50_000_000], ['ap', -3_000_000]]);

  it('P&L lines compare activity, signed by normal balance (revenue up is positive)', () => {
    const { lines } = computeFluxLines({ periodKey: '2026-10', accounts: ACCTS, policy: P(), activity, closingBalanceDebit: closing });
    const rev = lines.find((l) => l.accountId === 'rev')!;
    expect(rev).toMatchObject({ statement: 'PNL', currentCents: 16_000_000, comparisonCents: 10_000_000, changeCents: 6_000_000, changePctBps: 6_000, material: true, basisUsed: 'PRIOR_MONTH' });
    expect(rev.trailing.map((t) => t.periodKey)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(rev.trailing.at(-1)!.cents).toBe(16_000_000);
    const rent = lines.find((l) => l.accountId === 'rent')!;
    expect(rent).toMatchObject({ changeCents: 0, material: false });
  });

  it('BS lines compare ending balances (closing minus later activity)', () => {
    const { lines } = computeFluxLines({ periodKey: '2026-10', accounts: ACCTS, policy: P(), activity, closingBalanceDebit: closing });
    const cash = lines.find((l) => l.accountId === 'cash')!;
    expect(cash).toMatchObject({ statement: 'BS', currentCents: 50_000_000, comparisonCents: 48_000_000, changeCents: 2_000_000 });
    // Sep end 48m, Aug end 48m + 5k = 48.5m (Sep activity was −5k).
    expect(cash.trailing.at(-3)!.cents).toBe(48_500_000);
    const ap = lines.find((l) => l.accountId === 'ap')!;
    expect(ap).toMatchObject({ currentCents: 3_000_000, comparisonCents: 3_000_000, changeCents: 0 }); // credit-normal ⇒ positive
  });

  it('OTHER_INCOME is credit-normal; a zero base gives a null % and still breaches on $ (EITHER)', () => {
    const { lines } = computeFluxLines({ periodKey: '2026-10', accounts: ACCTS, policy: P(), activity, closingBalanceDebit: closing });
    const oi = lines.find((l) => l.accountId === 'oi')!;
    expect(oi).toMatchObject({ currentCents: 700_000, comparisonCents: 0, changePctBps: null, material: true, breaches: ['ABS'] });
  });

  it('PRIOR_YEAR_MONTH compares the same month last year', () => {
    const { lines } = computeFluxLines({ periodKey: '2026-10', accounts: ACCTS, policy: P({ comparisonBasis: 'PRIOR_YEAR_MONTH' }), activity, closingBalanceDebit: closing });
    expect(lines.find((l) => l.accountId === 'rev')).toMatchObject({ comparisonCents: 12_000_000, changeCents: 4_000_000, basisUsed: 'PRIOR_YEAR_MONTH' });
  });

  it('TRAILING_3_AVG averages the prior three months (integer cents)', () => {
    const { lines } = computeFluxLines({ periodKey: '2026-10', accounts: ACCTS, policy: P({ comparisonBasis: 'TRAILING_3_AVG' }), activity, closingBalanceDebit: closing });
    // (100k + 90k + 80k) / 3 = 90k
    expect(lines.find((l) => l.accountId === 'rev')).toMatchObject({ comparisonCents: 9_000_000, changeCents: 7_000_000 });
  });

  it('BUDGET compares P&L to budget; BS lines fall back to prior month', () => {
    const budget = new Map([['rev', 15_000_000], ['rent', 1_200_000]]);
    const { lines } = computeFluxLines({ periodKey: '2026-10', accounts: ACCTS, policy: P({ comparisonBasis: 'BUDGET' }), activity, closingBalanceDebit: closing, budget });
    expect(lines.find((l) => l.accountId === 'rev')).toMatchObject({ comparisonCents: 15_000_000, changeCents: 1_000_000, basisUsed: 'BUDGET', material: true, breaches: ['ABS'] });
    expect(lines.find((l) => l.accountId === 'rent')).toMatchObject({ comparisonCents: 1_200_000, changeCents: -200_000, changePctBps: -1_667, material: true });
    expect(lines.find((l) => l.accountId === 'cash')).toMatchObject({ basisUsed: 'PRIOR_MONTH' });
  });

  it('splits P&L by department, keeps BS per account', () => {
    const act = [cell('rent', '2026-10', 600_000, 'd1'), cell('rent', '2026-10', 400_000, 'd2'), cell('rent', '2026-09', 1_000_000, 'd1'), cell('cash', '2026-10', 100, 'd1')];
    const names = new Map([['d1', 'Service'], ['d2', 'Install']]);
    const { lines } = computeFluxLines({ periodKey: '2026-10', accounts: ACCTS, policy: P({ dimension: 'ACCOUNT_DEPARTMENT' }), activity: act, closingBalanceDebit: new Map([['cash', 100]]), dimensionNames: names });
    const d1 = lines.find((l) => l.lineKey === 'rent|d:d1')!;
    const d2 = lines.find((l) => l.lineKey === 'rent|d:d2')!;
    expect(d1).toMatchObject({ currentCents: 600_000, comparisonCents: 1_000_000, changeCents: -400_000, dimensionLabel: 'Service', departmentId: 'd1' });
    expect(d2).toMatchObject({ currentCents: 400_000, comparisonCents: 0, dimensionLabel: 'Install' });
    expect(lines.find((l) => l.lineKey === 'cash')).toBeTruthy();
  });

  it('honours include toggles and exclusions; material lines sort first', () => {
    const { lines, excludedCount } = computeFluxLines({
      periodKey: '2026-10', accounts: ACCTS, policy: P({ includeBalanceSheet: false, excludedAccountIds: ['oi'] }), activity, closingBalanceDebit: closing,
    });
    expect(lines.some((l) => l.statement === 'BS')).toBe(false);
    expect(lines.find((l) => l.accountId === 'oi')).toMatchObject({ material: false, threshold: { excluded: true } });
    expect(excludedCount).toBe(1);
    expect(lines[0].accountId).toBe('rev');
  });

  it('omits all-zero lines', () => {
    const { lines } = computeFluxLines({ periodKey: '2026-10', accounts: ACCTS, policy: P(), activity: [cell('rent', '2025-01', 5)], closingBalanceDebit: new Map() });
    expect(lines).toHaveLength(0);
  });
});
