import { describe, it, expect } from 'vitest';
import {
  computeKpis,
  computeKpiSet,
  computeDelta,
  computeRunway,
  computePlanVariance,
  computeTrend,
  marginPct,
  type KpiInputs,
  type PlanRow,
} from './dashboard';

const balance = {
  cashCents: 500_000_00,
  arCents: 120_000_00,
  apCents: 80_000_00,
  currentAssetsCents: 700_000_00,
  currentLiabilitiesCents: 350_000_00,
};

describe('computeKpis', () => {
  it('derives profit tiers, margins, working capital and current ratio', () => {
    const input: KpiInputs = {
      pnl: { revenueCents: 1_000_000_00, cogsCents: 400_000_00, opexCents: 300_000_00, otherCents: 50_000_00 },
      balance,
    };
    const k = computeKpis(input);
    expect(k.grossProfitCents).toBe(600_000_00); // 1,000,000 − 400,000
    expect(k.operatingIncomeCents).toBe(300_000_00); // GP − OpEx
    expect(k.netIncomeCents).toBe(250_000_00); // OpInc − Other
    expect(k.grossMarginPct).toBe(60); // 600k / 1,000k
    expect(k.operatingMarginPct).toBe(30);
    expect(k.netMarginPct).toBe(25);
    expect(k.workingCapitalCents).toBe(350_000_00); // 700k − 350k
    expect(k.currentRatio).toBe(2); // 700k / 350k
  });

  it('returns null margins when revenue is zero (never Infinity/NaN)', () => {
    const k = computeKpis({
      pnl: { revenueCents: 0, cogsCents: 0, opexCents: 20_000_00, otherCents: 0 },
      balance,
    });
    expect(k.grossMarginPct).toBeNull();
    expect(k.operatingMarginPct).toBeNull();
    expect(k.netMarginPct).toBeNull();
    expect(k.operatingIncomeCents).toBe(-20_000_00);
  });

  it('returns null current ratio when there are no current liabilities', () => {
    const k = computeKpis({
      pnl: { revenueCents: 100, cogsCents: 0, opexCents: 0, otherCents: 0 },
      balance: { ...balance, currentLiabilitiesCents: 0 },
    });
    expect(k.currentRatio).toBeNull();
  });

  it('marginPct rounds to two decimals', () => {
    expect(marginPct(1, 3)).toBe(33.33);
    expect(marginPct(0, 0)).toBeNull();
  });
});

describe('computeDelta / computeKpiSet', () => {
  it('computes signed delta and percent vs prior', () => {
    const d = computeDelta(120, 100);
    expect(d.deltaCents).toBe(20);
    expect(d.pct).toBe(20);
  });

  it('percent is null when the prior base is zero', () => {
    expect(computeDelta(50, 0).pct).toBeNull();
  });

  it('uses absolute base so a negative prior yields a sensible percent', () => {
    // current −50 vs prior −100 → +50 improvement over a base of 100 = +50%
    expect(computeDelta(-50, -100).pct).toBe(50);
  });

  it('emits deltas for every KPI when a prior period is supplied', () => {
    const cur: KpiInputs = {
      pnl: { revenueCents: 1_100_000_00, cogsCents: 400_000_00, opexCents: 300_000_00, otherCents: 0 },
      balance,
    };
    const pri: KpiInputs = {
      pnl: { revenueCents: 1_000_000_00, cogsCents: 400_000_00, opexCents: 300_000_00, otherCents: 0 },
      balance: { ...balance, cashCents: 450_000_00 },
    };
    const set = computeKpiSet(cur, pri);
    expect(set.prior).not.toBeNull();
    expect(set.deltas.revenue.deltaCents).toBe(100_000_00);
    expect(set.deltas.cash.deltaCents).toBe(50_000_00);
    expect(set.deltas.currentRatio.deltaCents).toBe(0);
  });

  it('has no deltas when there is no prior period', () => {
    const set = computeKpiSet(
      { pnl: { revenueCents: 1, cogsCents: 0, opexCents: 0, otherCents: 0 }, balance },
      null,
    );
    expect(set.prior).toBeNull();
    expect(Object.keys(set.deltas)).toHaveLength(0);
  });
});

describe('computeRunway', () => {
  it('computes burn and runway when losing money each month', () => {
    // avg monthly net income = −50,000 → burn 50,000; cash 500,000 → 10 months
    const r = computeRunway(500_000_00, [-40_000_00, -50_000_00, -60_000_00]);
    expect(r.cashGenerating).toBe(false);
    expect(r.monthlyBurnCents).toBe(50_000_00);
    expect(r.runwayMonths).toBe(10);
    expect(r.basisMonths).toBe(3);
  });

  it('reports cash-generating (null runway) when average net income is >= 0', () => {
    const r = computeRunway(500_000_00, [10_000_00, -5_000_00, 20_000_00]);
    expect(r.cashGenerating).toBe(true);
    expect(r.monthlyBurnCents).toBe(0);
    expect(r.runwayMonths).toBeNull();
  });

  it('runway is 0 when burning with a non-positive cash balance', () => {
    const r = computeRunway(0, [-10_000_00]);
    expect(r.runwayMonths).toBe(0);
  });

  it('handles an empty series without dividing by zero', () => {
    const r = computeRunway(100_000_00, []);
    expect(r.cashGenerating).toBe(true);
    expect(r.runwayMonths).toBeNull();
    expect(r.basisMonths).toBe(0);
  });

  it('rounds runway to one decimal', () => {
    // burn 30,000; cash 100,000 → 3.333... → 3.3
    const r = computeRunway(100_000_00, [-30_000_00]);
    expect(r.runwayMonths).toBe(3.3);
  });
});

describe('computePlanVariance', () => {
  const rows: PlanRow[] = [
    { key: '4000', label: 'Revenue', section: 'REVENUE', actualCents: 110_000_00, budgetCents: 100_000_00, forecastCents: 115_000_00 },
    { key: '5000', label: 'COGS', section: 'COGS', actualCents: 45_000_00, budgetCents: 40_000_00, forecastCents: 46_000_00 },
    { key: '6000', label: 'Payroll', section: 'OPEX', actualCents: 28_000_00, budgetCents: 30_000_00, forecastCents: 29_000_00 },
  ];

  it('computes budget and forecast variance per line', () => {
    const { rows: out } = computePlanVariance(rows);
    const rev = out.find((r) => r.key === '4000')!;
    expect(rev.budgetVarianceCents).toBe(10_000_00); // actual − budget
    expect(rev.budgetVariancePct).toBe(10);
    expect(rev.forecastVarianceCents).toBe(15_000_00); // forecast − budget
    expect(rev.favorable).toBe(true); // revenue above plan = good
  });

  it('marks a cost line over budget as unfavorable and under budget as favorable', () => {
    const { rows: out } = computePlanVariance(rows);
    expect(out.find((r) => r.key === '5000')!.favorable).toBe(false); // COGS over plan
    expect(out.find((r) => r.key === '6000')!.favorable).toBe(true); // OpEx under plan
  });

  it('rolls up net income across scenarios with correct favorability', () => {
    const { netIncome } = computePlanVariance(rows);
    // actual NI = 110,000 − (45,000 + 28,000) = 37,000
    expect(netIncome.actualCents).toBe(37_000_00);
    // budget NI = 100,000 − (40,000 + 30,000) = 30,000
    expect(netIncome.budgetCents).toBe(30_000_00);
    // forecast NI = 115,000 − (46,000 + 29,000) = 40,000
    expect(netIncome.forecastCents).toBe(40_000_00);
    expect(netIncome.budgetVarianceCents).toBe(7_000_00);
    expect(netIncome.favorable).toBe(true);
    // forecast NI (40,000) > budget NI (30,000) → forecast favorable
    expect(netIncome.forecastVarianceCents).toBe(10_000_00);
    expect(netIncome.forecastFavorable).toBe(true);
  });

  it('null variance percent when the budget base is zero', () => {
    const { rows: out } = computePlanVariance([
      { key: 'x', label: 'New line', section: 'OPEX', actualCents: 5_000_00, budgetCents: 0, forecastCents: 6_000_00 },
    ]);
    expect(out[0].budgetVariancePct).toBeNull();
  });
});

describe('computeTrend', () => {
  it('derives margins per period and passes cash through', () => {
    const t = computeTrend([
      { label: 'Jan', pnl: { revenueCents: 100_000_00, cogsCents: 40_000_00, opexCents: 30_000_00, otherCents: 0 }, cashCents: 200_000_00 },
      { label: 'Feb', pnl: { revenueCents: 0, cogsCents: 0, opexCents: 10_000_00, otherCents: 0 } },
    ]);
    expect(t[0].grossProfitCents).toBe(60_000_00);
    expect(t[0].netIncomeCents).toBe(30_000_00);
    expect(t[0].grossMarginPct).toBe(60);
    expect(t[0].cashCents).toBe(200_000_00);
    // zero-revenue month → null margins, null cash (no snapshot)
    expect(t[1].grossMarginPct).toBeNull();
    expect(t[1].cashCents).toBeNull();
    expect(t[1].netIncomeCents).toBe(-10_000_00);
  });
});
