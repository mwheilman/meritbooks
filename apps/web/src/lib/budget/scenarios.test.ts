/**
 * Scenario / what-if engine assertions.
 *
 * Pins override application (revenue growth ±%, cost change, headcount ±N), the
 * BEST/BASE/WORST three-case build + variance vs base, and the one-driver
 * sensitivity sweep. All amounts are integer cents; the engine reuses the driver
 * expansion, so a revenue-growth override must re-base percent-of-revenue costs.
 */

import { describe, it, expect } from 'vitest';
import type { BudgetDriver } from './drivers';
import {
  applyOverride,
  applyOverrides,
  buildScenarioCase,
  buildThreeCase,
  runSensitivity,
  summarizeExpansion,
  type ScenarioDefinition,
} from './scenarios';
import { expandDrivers } from './drivers';

// A tiny two-driver base model: $120k/yr revenue (fixed) + COGS at 25% of revenue.
const baseDrivers: BudgetDriver[] = [
  {
    id: 'rev',
    label: 'Sales',
    accountId: 'a-rev',
    accountType: 'REVENUE',
    driverType: 'fixed',
    annualAmountCents: 12_000_000, // $120,000
  },
  {
    id: 'cogs',
    label: 'Cost of sales',
    accountId: 'a-cogs',
    accountType: 'percent_of_revenue' as never, // placeholder, replaced below
    driverType: 'percent_of_revenue',
    percentBps: 2500, // 25%
  } as BudgetDriver,
  {
    id: 'opex',
    label: 'Rent',
    accountId: 'a-opex',
    accountType: 'OPEX',
    driverType: 'fixed',
    annualAmountCents: 2_400_000, // $24,000
  },
];
// Fix the cogs driver's accountType (discriminated union quirk above).
(baseDrivers[1] as { accountType: string }).accountType = 'COGS';

describe('applyOverride — revenue_growth', () => {
  it('scales revenue drivers and re-bases percent-of-revenue costs through the engine', () => {
    const drivers = applyOverride(baseDrivers, { kind: 'revenue_growth', deltaBps: 1000 }); // +10%
    const { summary } = buildScenarioCase(drivers, [], 0);
    // Revenue 120k → 132k
    expect(summary.revenueCents).toBe(13_200_000);
    // COGS is 25% of the NEW revenue base → 33k (auto re-based, not 30k)
    expect(summary.cogsCents).toBe(3_300_000);
    // Gross margin unchanged at 75% because COGS tracks revenue.
    expect(summary.grossMarginBps).toBe(7500);
  });

  it('does not mutate the input driver array', () => {
    const before = JSON.stringify(baseDrivers);
    applyOverride(baseDrivers, { kind: 'revenue_growth', deltaBps: -2000 });
    expect(JSON.stringify(baseDrivers)).toBe(before);
  });

  it('handles a negative growth (decline) correctly', () => {
    const { summary } = buildScenarioCase(
      applyOverride(baseDrivers, { kind: 'revenue_growth', deltaBps: -2500 }),
      [],
      0
    );
    expect(summary.revenueCents).toBe(9_000_000); // 120k − 25% = 90k
  });
});

describe('applyOverride — cost_change', () => {
  it('scales only cost drivers (COGS+OPEX), leaving revenue untouched', () => {
    const { summary } = buildScenarioCase(
      applyOverride(baseDrivers, { kind: 'cost_change', deltaBps: 2000 }), // +20% costs
      [],
      0
    );
    expect(summary.revenueCents).toBe(12_000_000); // unchanged
    expect(summary.cogsCents).toBe(3_600_000); // 30k × 1.2
    expect(summary.opexCents).toBe(2_880_000); // 24k × 1.2
  });

  it('can target a single cost type', () => {
    const { summary } = buildScenarioCase(
      applyOverride(baseDrivers, { kind: 'cost_change', deltaBps: 5000, costTypes: ['OPEX'] }),
      [],
      0
    );
    expect(summary.cogsCents).toBe(3_000_000); // untouched 30k
    expect(summary.opexCents).toBe(3_600_000); // 24k × 1.5
  });
});

describe('applyOverride — headcount', () => {
  it('adds a fixed OPEX line of heads × monthly cost × 12', () => {
    const { summary } = buildScenarioCase(
      applyOverride(baseDrivers, {
        kind: 'headcount',
        deltaHeads: 3,
        monthlyCostPerHeadCents: 800_000, // $8,000/mo
        accountId: 'a-opex',
      }),
      [],
      0
    );
    // Base OPEX 24k + 3 heads × $8k × 12 = 24k + 288k = 312k
    expect(summary.opexCents).toBe(2_400_000 + 28_800_000);
  });

  it('removes cost for negative heads and is a no-op at zero', () => {
    const cut = buildScenarioCase(
      applyOverride(baseDrivers, {
        kind: 'headcount',
        deltaHeads: -1,
        monthlyCostPerHeadCents: 500_000,
        accountId: 'a-opex',
      }),
      [],
      0
    ).summary;
    expect(cut.opexCents).toBe(2_400_000 - 6_000_000); // −$60k

    const noop = applyOverride(baseDrivers, {
      kind: 'headcount',
      deltaHeads: 0,
      monthlyCostPerHeadCents: 500_000,
      accountId: 'a-opex',
    });
    expect(noop).toHaveLength(baseDrivers.length);
  });
});

describe('summarizeExpansion — ending cash proxy', () => {
  it('rolls net income into a running ending-cash balance from beginning cash', () => {
    const summary = summarizeExpansion(expandDrivers(baseDrivers), 5_000_000);
    // Net income = 120k − 30k − 24k = 66k
    expect(summary.netIncomeCents).toBe(6_600_000);
    expect(summary.endingCashCents).toBe(5_000_000 + 6_600_000);
    // Ending-cash trajectory ends at the full-year ending cash.
    expect(summary.endingCashByMonth[11]).toBe(summary.endingCashCents);
    // Monthly net income ties to the annual figure.
    expect(summary.netIncomeByMonth.reduce((a, b) => a + b, 0)).toBe(summary.netIncomeCents);
  });
});

describe('applyOverrides — ordered fold', () => {
  it('composes multiple overrides left-to-right', () => {
    const drivers = applyOverrides(baseDrivers, [
      { kind: 'revenue_growth', deltaBps: 1000 }, // +10% rev → 132k
      { kind: 'cost_change', deltaBps: -1000, costTypes: ['OPEX'] }, // −10% opex → 21.6k
    ]);
    const { summary } = buildScenarioCase(drivers, [], 0);
    expect(summary.revenueCents).toBe(13_200_000);
    expect(summary.opexCents).toBe(2_160_000);
  });
});

describe('buildThreeCase — best/base/worst + variance vs base', () => {
  const def: ScenarioDefinition = {
    name: 'FY plan swing',
    baseDrivers,
    beginningCashCents: 1_000_000,
    cases: {
      best: [{ kind: 'revenue_growth', deltaBps: 1500 }], // +15%
      base: [],
      worst: [{ kind: 'revenue_growth', deltaBps: -1500 }], // −15%
    },
  };

  it('orders net income best ≥ base ≥ worst', () => {
    const r = buildThreeCase(def);
    expect(r.best.summary.netIncomeCents).toBeGreaterThan(r.base.summary.netIncomeCents);
    expect(r.base.summary.netIncomeCents).toBeGreaterThan(r.worst.summary.netIncomeCents);
  });

  it('computes variance vs base as signed deltas', () => {
    const r = buildThreeCase(def);
    expect(r.varianceVsBase.best.revenueCents).toBe(
      r.best.summary.revenueCents - r.base.summary.revenueCents
    );
    expect(r.varianceVsBase.best.revenueCents).toBeGreaterThan(0);
    expect(r.varianceVsBase.worst.revenueCents).toBeLessThan(0);
    // Ending cash variance mirrors net income variance (cash proxy = NI).
    expect(r.varianceVsBase.best.endingCashCents).toBe(r.varianceVsBase.best.netIncomeCents);
  });
});

describe('runSensitivity — one-driver sweep', () => {
  it('produces a monotonic net-income curve across a revenue-growth range', () => {
    const res = runSensitivity(
      baseDrivers,
      { axis: 'revenue_growth', points: [-2000, -1000, 0, 1000, 2000] },
      0
    );
    expect(res.axis).toBe('revenue_growth');
    expect(res.points).toHaveLength(5);
    // The zero point equals the untouched base net income (66k).
    expect(res.points[2].value).toBe(0);
    expect(res.points[2].netIncomeCents).toBe(6_600_000);
    // Strictly increasing net income as growth increases.
    for (let i = 1; i < res.points.length; i++) {
      expect(res.points[i].netIncomeCents).toBeGreaterThan(res.points[i - 1].netIncomeCents);
    }
  });

  it('sweeps headcount and reduces net income as heads rise', () => {
    const res = runSensitivity(
      baseDrivers,
      {
        axis: 'headcount',
        points: [0, 1, 2],
        monthlyCostPerHeadCents: 1_000_000, // $10k/mo
        accountId: 'a-opex',
      },
      0
    );
    // Each added head costs $120k/yr → net income drops by exactly that.
    expect(res.points[0].netIncomeCents - res.points[1].netIncomeCents).toBe(12_000_000);
    expect(res.points[1].netIncomeCents - res.points[2].netIncomeCents).toBe(12_000_000);
  });

  it('applies base overrides under every swept point', () => {
    const res = runSensitivity(
      baseDrivers,
      {
        axis: 'cost_change',
        points: [0, 1000],
        baseOverrides: [{ kind: 'revenue_growth', deltaBps: 1000 }], // +10% rev held constant
      },
      0
    );
    // Revenue is held at +10% across the sweep.
    expect(res.points[0].revenueCents).toBe(13_200_000);
    expect(res.points[1].revenueCents).toBe(13_200_000);
  });
});
