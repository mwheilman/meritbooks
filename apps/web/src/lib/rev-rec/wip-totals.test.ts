import { describe, it, expect } from 'vitest';
import { wipColumnTotals, type WipTotalsLine } from './wip-totals';

const line = (over: Partial<WipTotalsLine> = {}): WipTotalsLine => ({
  contractCents: 100_000_00, eacCents: 80_000_00, costToDateCents: 40_000_00, earnedCents: 50_000_00, billedCents: 45_000_00,
  retainageCents: 2_250_00, underCents: 5_000_00, overCents: 0, lossProvisionCents: 0, estGrossProfitCents: 20_000_00,
  fadeGainCents: null, ...over,
});

describe('wipColumnTotals — every money column totals (1G-8)', () => {
  it('Est. GP totals (it was blank) and every other column sums exactly', () => {
    const t = wipColumnTotals([line(), line({ estGrossProfitCents: -3_000_00, overCents: 1_000_00, underCents: 0, lossProvisionCents: 3_000_00 })]);
    expect(t.estGrossProfitCents).toBe(17_000_00);
    expect(t.contractCents).toBe(200_000_00);
    expect(t.underCents).toBe(5_000_00);
    expect(t.overCents).toBe(1_000_00);
    expect(t.lossProvisionCents).toBe(3_000_00);
    expect(t.retainageCents).toBe(4_500_00);
    expect(t.pctComplete).toBeCloseTo(0.5);
  });
  it('Fade / gain sums the jobs that have a prior month; none → null, never a fake 0', () => {
    expect(wipColumnTotals([line(), line()]).fadeGainCents).toBeNull();
    const t = wipColumnTotals([line({ fadeGainCents: -5_000_00 }), line({ fadeGainCents: 1_500_00 }), line()]);
    expect(t.fadeGainCents).toBe(-3_500_00);
    expect(t.fadeComparedJobs).toBe(2);
  });
  it('% done total = Σ earned ÷ Σ contract, matching the rows (a 66.7% job with no cost is not 0.0%)', () => {
    const t = wipColumnTotals([line({ contractCents: 300_000_00, earnedCents: 200_010_00, costToDateCents: 0, eacCents: 0 })]);
    expect(t.pctComplete).toBeCloseTo(0.6667, 4);
    const mixed = wipColumnTotals([line({ contractCents: 100_000_00, earnedCents: 100_000_00 }), line({ contractCents: 300_000_00, earnedCents: 0 })]);
    expect(mixed.pctComplete).toBeCloseTo(0.25);
    expect(wipColumnTotals([line({ contractCents: 0, earnedCents: 0 })]).pctComplete).toBeNull();
  });
  it('an empty table totals to zero with no % complete', () => {
    expect(wipColumnTotals([])).toMatchObject({ jobs: 0, estGrossProfitCents: 0, fadeGainCents: null, pctComplete: null });
  });
});
