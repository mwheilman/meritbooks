/**
 * Driver-based budgeting — expansion engine assertions.
 *
 * Pins the math for each driver type (volume×rate, %-of-revenue, fixed, growth),
 * the revenue-base dependency, per-account roll-up, and the exact-sum guarantee
 * of the annual spread. All amounts are integer cents.
 */

import { describe, it, expect } from 'vitest';
import {
  expandDrivers,
  spreadAnnual,
  expansionToBudgetCells,
  MONTHS_IN_YEAR,
  type BudgetDriver,
} from './drivers';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('spreadAnnual', () => {
  it('spreads evenly with the remainder in January and ties to the annual total', () => {
    const out = spreadAnnual(100); // 100 cents / 12
    expect(out).toHaveLength(MONTHS_IN_YEAR);
    expect(sum(out)).toBe(100);
    expect(out[0]).toBe(8 + 4); // base 8, remainder 4 → Jan
    expect(out[1]).toBe(8);
  });

  it('spreads by seasonal weights and absorbs rounding drift, still tying exactly', () => {
    const weights = [3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3]; // Q1/Q4 skew
    const out = spreadAnnual(1_000_000, weights);
    expect(sum(out)).toBe(1_000_000);
    expect(out[0]).toBeGreaterThan(out[1]); // heavier January
    expect(out[11]).toBeGreaterThan(out[10]); // heavier December
  });

  it('falls back to even spread when weights are the wrong length or all zero', () => {
    expect(sum(spreadAnnual(1200, [1, 2, 3]))).toBe(1200);
    expect(spreadAnnual(1200, new Array(12).fill(0))[0]).toBe(100);
  });
});

describe('expandDrivers — volume × rate', () => {
  it('multiplies monthly volume by the unit rate (cents)', () => {
    const drivers: BudgetDriver[] = [
      {
        id: 'd1',
        label: 'Widget sales',
        accountId: 'rev-1',
        accountType: 'REVENUE',
        driverType: 'volume_x_rate',
        unitRateCents: 5000, // $50.00 / unit
        volumeByMonth: [10, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    ];
    const r = expandDrivers(drivers);
    expect(r.drivers[0].monthlyCents[0]).toBe(50_000); // 10 × $50
    expect(r.drivers[0].monthlyCents[1]).toBe(100_000); // 20 × $50
    expect(r.drivers[0].annualCents).toBe(150_000);
    // Revenue base reflects the revenue driver.
    expect(r.revenueByMonth[1]).toBe(100_000);
    expect(r.totalRevenueCents).toBe(150_000);
  });
});

describe('expandDrivers — percent of revenue', () => {
  it('applies basis points to the revenue base per month (COGS as % of rev)', () => {
    const drivers: BudgetDriver[] = [
      {
        id: 'rev',
        label: 'Service revenue',
        accountId: 'rev-1',
        accountType: 'REVENUE',
        driverType: 'fixed',
        annualAmountCents: 1_200_000, // $12k/yr → $1k/mo even
      },
      {
        id: 'cogs',
        label: 'COGS @ 30%',
        accountId: 'cogs-1',
        accountType: 'COGS',
        driverType: 'percent_of_revenue',
        percentBps: 3000, // 30.00%
      },
    ];
    const r = expandDrivers(drivers);
    const cogs = r.drivers.find((d) => d.driverId === 'cogs')!;
    expect(cogs.monthlyCents[0]).toBe(30_000); // 30% of $1,000.00
    expect(cogs.annualCents).toBe(360_000); // 30% of $12k
  });

  it('does not let a percent-of-revenue driver feed the revenue base', () => {
    const drivers: BudgetDriver[] = [
      {
        id: 'rev-pct',
        label: 'Bad self-referential revenue',
        accountId: 'rev-1',
        accountType: 'REVENUE',
        driverType: 'percent_of_revenue',
        percentBps: 5000,
      },
    ];
    const r = expandDrivers(drivers);
    // No non-percent revenue driver ⇒ base is zero ⇒ output is zero.
    expect(r.totalRevenueCents).toBe(0);
    expect(r.drivers[0].annualCents).toBe(0);
  });
});

describe('expandDrivers — growth rate', () => {
  it('compounds month over month from the base', () => {
    const drivers: BudgetDriver[] = [
      {
        id: 'g',
        label: 'Growing MRR',
        accountId: 'rev-1',
        accountType: 'REVENUE',
        driverType: 'growth_rate',
        baseMonthlyCents: 100_000, // $1,000 in Jan
        monthlyGrowthBps: 1000, // +10%/mo
      },
    ];
    const r = expandDrivers(drivers);
    expect(r.drivers[0].monthlyCents[0]).toBe(100_000);
    expect(r.drivers[0].monthlyCents[1]).toBe(110_000); // ×1.10
    expect(r.drivers[0].monthlyCents[2]).toBe(121_000); // ×1.10 again
  });
});

describe('expandDrivers — account roll-up', () => {
  it('sums multiple drivers that target the same account into one line', () => {
    const drivers: BudgetDriver[] = [
      {
        id: 'a',
        label: 'Base salaries',
        accountId: 'opex-payroll',
        accountType: 'OPEX',
        driverType: 'fixed',
        annualAmountCents: 1_200_000,
      },
      {
        id: 'b',
        label: 'New hire',
        accountId: 'opex-payroll',
        accountType: 'OPEX',
        driverType: 'fixed',
        annualAmountCents: 600_000,
      },
    ];
    const r = expandDrivers(drivers);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].accountId).toBe('opex-payroll');
    expect(r.lines[0].annualCents).toBe(1_800_000);
    expect(r.lines[0].monthlyCents[1]).toBe(100_000 + 50_000);
  });

  it('flattens to budget cells (12 per account, 1-based periods)', () => {
    const r = expandDrivers([
      {
        id: 'a',
        label: 'Rent',
        accountId: 'opex-rent',
        accountType: 'OPEX',
        driverType: 'fixed',
        annualAmountCents: 120_000,
      },
    ]);
    const cells = expansionToBudgetCells(r);
    expect(cells).toHaveLength(12);
    expect(cells[0]).toMatchObject({ account_id: 'opex-rent', period_number: 1 });
    expect(cells[11].period_number).toBe(12);
    expect(sum(cells.map((c) => c.amount_cents))).toBe(120_000);
  });
});
