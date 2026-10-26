/**
 * Wave 3 live-audit fixes (budgets): plain-English template rules, no F/U without a budget,
 * honest department status next to a non-draft version + the approval gate counting
 * unreviewed department lines, and a "Through" month that is never in the future.
 */
import { describe, expect, it } from 'vitest';
import { defaultMonth, maxThroughMonth } from '@/app/(app)/budgets/budget-format';
import { bvaVerdict, cellKey, departmentBva, latestActualMonthOf } from './bva';
import { boardStatus, checkVersionAction, openDepartmentCount } from './lifecycle';
import { describeParams, describeSelector, patternWords } from './templates/describe';
import { SYSTEM_TEMPLATES } from './templates/system';
import type { AccountLite } from './types';

describe('template rules in plain English (#8)', () => {
  it('renders safe patterns as quoted words, never pattern syntax', () => {
    expect(patternWords('salar|wage')).toBe('“salar” or “wage”');
    expect(patternWords('workers*comp')).toBe('“workers … comp”');
    expect(patternWords('  ')).toBeNull();
    expect(patternWords(undefined)).toBeNull();
  });

  it('describes name / group / exclusion selectors like the matcher reads them', () => {
    expect(describeSelector({ selector: { types: ['OPEX'], name: 'salar|wage', notName: 'payable|accrued' } })).toBe(
      'Operating expense accounts whose name mentions “salar” or “wage” — except names mentioning “payable” or “accrued”',
    );
    expect(describeSelector({ selector: { types: ['REVENUE'], notName: 'interdep|intercompany|elimin' } })).toBe(
      'Any revenue account — except names mentioning “interdep”, “intercompany” or “elimin”',
    );
    expect(describeSelector({ selector: { types: ['OPEX', 'COGS'], group: 'vehicle', name: 'vehicle|fuel' } })).toBe(
      'Operating expense or cost of sales accounts whose name mentions “vehicle” or “fuel”, or in a group mentioning “vehicle”',
    );
    expect(describeSelector({ selector: { types: ['OPEX'], group: 'marketing|ads' } })).toBe('Operating expense accounts in a group mentioning “marketing” or “ads”');
    expect(describeSelector({ selector: { types: ['OTHER'], subTypes: ['OTHER_INCOME'] } })).toBe('Any other income or expense account (other income only)');
  });

  it('every system template line reads without raw syntax', () => {
    for (const t of SYSTEM_TEMPLATES) {
      for (const l of t.lines) {
        const text = `${describeSelector(l)} ${describeParams(l)}`;
        expect(text).not.toMatch(/[|~/]|\bnot \/|REVENUE|OPEX|COGS|Bps|Cents/);
      }
    }
  });

  it('describes driver defaults', () => {
    expect(describeParams({ params: { growthBps: 400 } })).toBe('growth 4%');
    expect(describeParams({ params: { growthBps: 0 } })).toBe('no growth');
    expect(describeParams({ params: { pctBps: 150 } })).toBe('1.5% of revenue');
    expect(describeParams({ params: { headcount: 1, monthlyRateCents: 0, burdenBps: 1500, startMonth: 1 } })).toBe('1 person × monthly rate (set it) + 15% burden, from Jan');
    expect(describeParams({ params: { headcount: 3, monthlyRateCents: 650_000, burdenBps: 0, startMonth: 4 } })).toBe('3 people × $6,500 a month, from Apr');
    expect(describeParams({ params: { unitsPerMonth: 0, rateCents: 0, growthBps: 0 } })).toBe('Units (set them) a month × rate (set it), no growth');
    expect(describeParams({ params: { monthlyCents: 125_050 } })).toBe('$1,250.50 a month');
    expect(describeParams({ params: {} })).toBe('');
  });
});

describe('no F/U call without a budget (#10)', () => {
  const accts = new Map<string, AccountLite>([
    ['r', { id: 'r', number: '4000', name: 'Revenue', type: 'REVENUE', subType: 'REVENUE', groupName: null }],
    ['e', { id: 'e', number: '6100', name: 'Wages', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupName: null }],
  ]);

  it('bvaVerdict: zero budget → no_budget; otherwise favourable / unfavourable by nature', () => {
    expect(bvaVerdict('expense', 120_000, 0)).toBe('no_budget');
    expect(bvaVerdict('income', 120_000, 0)).toBe('no_budget');
    expect(bvaVerdict('expense', 120_000, 100_000)).toBe('unfavourable');
    expect(bvaVerdict('income', 120_000, 100_000)).toBe('favourable');
    expect(bvaVerdict('expense', 100_000, 100_000)).toBe('on_budget');
  });

  it('an unbudgeted line keeps its variance amount and materiality but gets no F/U', () => {
    const o = departmentBva({
      accounts: accts,
      actual: new Map([[cellKey('e', '2026-03'), 900_000], [cellKey('r', '2026-03'), 100_000]]),
      budget: new Map([[cellKey('r', '2026-03'), 80_000]]),
      months: ['2026-03'],
      pyMonths: ['2025-03'],
      materialityCents: 500_000,
      materialityBps: 0,
    });
    const wages = o.lines.find((l) => l.accountId === 'e')!;
    expect(wages.verdict).toBe('no_budget');
    expect(wages.varianceCents).toBe(900_000);
    expect(wages.variancePct).toBeNull();
    expect(wages.material).toBe(true); // unbudgeted spend over materiality still needs a note
    expect(o.lines.find((l) => l.accountId === 'r')!.verdict).toBe('favourable');
  });
});

describe('department status vs the version; approval gate (#10)', () => {
  it('a plan row wins; no plan in a draft = not started; no plan past draft = not in / no review', () => {
    expect(boardStatus('SUBMITTED', 'APPROVED', false)).toBe('SUBMITTED');
    expect(boardStatus(null, 'DRAFT', false)).toBe('NOT_STARTED');
    expect(boardStatus(null, 'APPROVED', false)).toBe('NOT_IN_VERSION');
    expect(boardStatus(null, 'LOCKED', true)).toBe('NO_REVIEW');
    expect(boardStatus(null, 'IN_REVIEW', false)).toBe('NOT_IN_VERSION');
  });

  it('openDepartmentCount: unapproved plans + departments with lines but no plan; company-level lines never count', () => {
    const plans = [{ departmentId: 'sales', status: 'APPROVED' as const }, { departmentId: 'ops', status: 'DRAFT' as const }];
    expect(openDepartmentCount(plans, [null, null, 'sales', 'ops'])).toBe(1);
    expect(openDepartmentCount(plans, ['mkt', 'mkt', 'admin'])).toBe(3);
    expect(openDepartmentCount([], [null])).toBe(0);
  });

  it('a version cannot be approved while a department with lines skipped review', () => {
    const openPlans = openDepartmentCount([{ departmentId: 'sales', status: 'APPROVED' }], ['sales', 'mkt']);
    expect(() =>
      checkVersionAction({ action: 'approve', status: 'IN_REVIEW', kind: 'BUDGET', actor: 'u_cfo', submittedBy: 'u_ctl', openPlans, currentIsLockedOther: false, isCurrent: false }),
    ).toThrow(/1 department budget is not approved yet/);
  });
});

describe('department view opens on a month that is never in the future (#10)', () => {
  const oct26 = new Date(2026, 9, 26);
  it('maxThroughMonth: past 12, current = this month, future 0', () => {
    expect(maxThroughMonth(2025, oct26)).toBe(12);
    expect(maxThroughMonth(2026, oct26)).toBe(10);
    expect(maxThroughMonth(2027, oct26)).toBe(0);
  });

  it('defaultMonth: future year → null (not Jan 2027); current → last full month pulled back to actuals; past → latest actuals', () => {
    expect(defaultMonth(2027, oct26)).toBeNull();
    expect(defaultMonth(2026, oct26)).toBe(9);
    expect(defaultMonth(2026, oct26, 7)).toBe(7);
    expect(defaultMonth(2026, oct26, 10)).toBe(9);
    expect(defaultMonth(2026, new Date(2026, 0, 15))).toBe(1);
    expect(defaultMonth(2025, oct26)).toBe(12);
    expect(defaultMonth(2025, oct26, 6)).toBe(6);
  });

  it('latestActualMonthOf: latest non-zero month inside the fiscal year', () => {
    const fy = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
    const actual = new Map([[cellKey('a', '2026-03'), 5], [cellKey('b', '2026-07'), 0], [cellKey('a', '2027-01'), 9], [cellKey('c', '2026-06'), -4]]);
    expect(latestActualMonthOf(actual, fy)).toBe(6);
    expect(latestActualMonthOf(new Map(), fy)).toBeNull();
  });
});
