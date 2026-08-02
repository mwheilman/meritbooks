/**
 * Rolling reforecast — blend engine assertions.
 *
 * Pins the core rule: closed months use ACTUALS, open months use a projection
 * (original budget, or the closed-month run-rate), and the full-year variance is
 * measured against the original budget with the right favorability direction.
 */

import { describe, it, expect } from 'vitest';
import {
  buildReforecast,
  blendMonthly,
  type ReforecastAccountInput,
} from './reforecast';

const flat = (v: number) => new Array(12).fill(v);

describe('blendMonthly', () => {
  it('uses actuals for closed months and budget for open months', () => {
    const budget = flat(1000);
    const actual = flat(1200);
    const out = blendMonthly(budget, actual, 3, 'budget_remaining');
    expect(out.slice(0, 3)).toEqual([1200, 1200, 1200]); // closed → actual
    expect(out.slice(3)).toEqual(new Array(9).fill(1000)); // open → budget
  });

  it('run_rate projects open months from the mean closed-month actual', () => {
    const budget = flat(1000);
    const actual = [900, 1100, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const out = blendMonthly(budget, actual, 3, 'run_rate');
    expect(out.slice(0, 3)).toEqual([900, 1100, 1000]);
    // mean of 900,1100,1000 = 1000
    expect(out.slice(3)).toEqual(new Array(9).fill(1000));
  });

  it('run_rate falls back to budget when nothing is closed', () => {
    const out = blendMonthly(flat(1000), flat(9999), 0, 'run_rate');
    expect(out).toEqual(flat(1000));
  });

  it('clamps closedThroughPeriod into 0..12', () => {
    expect(blendMonthly(flat(1000), flat(500), 20, 'budget_remaining')).toEqual(flat(500));
    expect(blendMonthly(flat(1000), flat(500), -5, 'budget_remaining')).toEqual(flat(1000));
  });
});

describe('buildReforecast', () => {
  const revenue: ReforecastAccountInput = {
    accountId: 'rev-1',
    accountNumber: '4000',
    accountName: 'Revenue',
    accountType: 'REVENUE',
    budgetByMonth: flat(1000), // $120/yr budget (in cents-as-units for the test)
    actualByMonth: [1200, 1200, 1200, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  const opex: ReforecastAccountInput = {
    accountId: 'opex-1',
    accountNumber: '6000',
    accountName: 'Opex',
    accountType: 'OPEX',
    budgetByMonth: flat(1000),
    actualByMonth: [800, 800, 800, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };

  it('blends full-year: actuals to date + budget remaining', () => {
    const r = buildReforecast([revenue], { closedThroughPeriod: 3, method: 'budget_remaining' });
    const acct = r.accounts[0];
    expect(acct.actualToDateCents).toBe(3600); // 3 × 1200
    expect(acct.projectedRemainingCents).toBe(9000); // 9 × 1000
    expect(acct.reforecastFullYearCents).toBe(12600);
    expect(acct.budgetFullYearCents).toBe(12000);
    expect(acct.varianceCents).toBe(600); // reforecast − budget
    expect(acct.variancePct).toBe(5); // 600/12000
  });

  it('marks revenue over plan as favorable and expense under plan as favorable', () => {
    const r = buildReforecast([revenue, opex], {
      closedThroughPeriod: 3,
      method: 'budget_remaining',
    });
    const rev = r.accounts.find((a) => a.accountId === 'rev-1')!;
    const ope = r.accounts.find((a) => a.accountId === 'opex-1')!;
    // revenue reforecast 12600 > budget 12000 → favorable
    expect(rev.isFavorable).toBe(true);
    // opex reforecast = 3×800 + 9×1000 = 11400 < 12000 → favorable
    expect(ope.reforecastFullYearCents).toBe(11400);
    expect(ope.isFavorable).toBe(true);
  });

  it('rolls totals by type and grand totals', () => {
    const r = buildReforecast([revenue, opex], {
      closedThroughPeriod: 3,
      method: 'budget_remaining',
    });
    expect(r.totalsByType.REVENUE.reforecastFullYearCents).toBe(12600);
    expect(r.totalsByType.OPEX.reforecastFullYearCents).toBe(11400);
    expect(r.grandTotals.reforecastFullYearCents).toBe(24000);
    expect(r.grandTotals.budgetFullYearCents).toBe(24000);
  });

  it('with nothing closed the reforecast equals the budget (zero variance)', () => {
    const r = buildReforecast([revenue], { closedThroughPeriod: 0, method: 'budget_remaining' });
    expect(r.accounts[0].reforecastFullYearCents).toBe(r.accounts[0].budgetFullYearCents);
    expect(r.accounts[0].varianceCents).toBe(0);
  });

  it('run_rate reforecast projects the observed trend forward', () => {
    const r = buildReforecast([revenue], { closedThroughPeriod: 3, method: 'run_rate' });
    // run rate = 1200; full year = 12 × 1200
    expect(r.accounts[0].reforecastFullYearCents).toBe(14400);
    expect(r.accounts[0].varianceCents).toBe(2400);
  });
});
