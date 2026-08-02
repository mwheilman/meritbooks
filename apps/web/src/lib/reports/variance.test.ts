import { describe, it, expect } from 'vitest';
import { computeVariances, pctChange, type VarianceLine } from './variance';

// Fixed numbers in → correct ranked drivers out. This is the correctness
// guarantee for the AI flux narrative: the model only ever phrases what these
// deterministic computations produce, so this suite pins the figures.

const current: VarianceLine[] = [
  { key: '4000', label: 'Consulting Revenue', section: 'REVENUE', amountCents: 1_200_000 },
  { key: '4100', label: 'Product Revenue', section: 'REVENUE', amountCents: 300_000 },
  { key: '5000', label: 'Direct Labor', section: 'COGS', amountCents: 400_000 },
  { key: '6000', label: 'Rent', section: 'OPEX', amountCents: 100_000 },
  { key: '6100', label: 'Marketing', section: 'OPEX', amountCents: 250_000 },
];

const prior: VarianceLine[] = [
  { key: '4000', label: 'Consulting Revenue', section: 'REVENUE', amountCents: 1_000_000 },
  { key: '4100', label: 'Product Revenue', section: 'REVENUE', amountCents: 300_000 },
  { key: '5000', label: 'Direct Labor', section: 'COGS', amountCents: 350_000 },
  { key: '6000', label: 'Rent', section: 'OPEX', amountCents: 100_000 },
  // Marketing (6100) is new this period — absent from prior.
];

describe('pctChange', () => {
  it('computes a rounded percentage change', () => {
    expect(pctChange(1_200_000, 1_000_000)).toBe(20);
    expect(pctChange(350_000, 400_000)).toBe(-12.5);
  });
  it('returns null when the prior base is zero (not Infinity / not 0)', () => {
    expect(pctChange(250_000, 0)).toBeNull();
  });
});

describe('computeVariances — ranking', () => {
  const r = computeVariances(current, prior);

  it('ranks drivers by absolute dollar delta, largest first', () => {
    expect(r.drivers.map((d) => d.key)).toEqual(['6100', '4000', '5000']);
  });

  it('excludes lines that did not move', () => {
    // Product Revenue (4100) and Rent (6000) are unchanged → not drivers.
    expect(r.drivers.some((d) => d.key === '4100')).toBe(false);
    expect(r.drivers.some((d) => d.key === '6000')).toBe(false);
  });

  it('computes exact deltas and directions', () => {
    const consulting = r.drivers.find((d) => d.key === '4000')!;
    expect(consulting.deltaCents).toBe(200_000);
    expect(consulting.pct).toBe(20);
    expect(consulting.direction).toBe('up');

    const labor = r.drivers.find((d) => d.key === '5000')!;
    expect(labor.deltaCents).toBe(50_000);
    expect(labor.direction).toBe('up');
  });

  it('surfaces a new line as a driver with pct = null and prior 0', () => {
    const mkt = r.drivers.find((d) => d.key === '6100')!;
    expect(mkt.priorCents).toBe(0);
    expect(mkt.currentCents).toBe(250_000);
    expect(mkt.pct).toBeNull();
  });
});

describe('computeVariances — favorability (pnl mode)', () => {
  const r = computeVariances(current, prior);

  it('marks a revenue increase favorable and a cost increase unfavorable', () => {
    expect(r.drivers.find((d) => d.key === '4000')!.favorable).toBe(true); // revenue up
    expect(r.drivers.find((d) => d.key === '5000')!.favorable).toBe(false); // cost up
    expect(r.drivers.find((d) => d.key === '6100')!.favorable).toBe(false); // opex up
  });
});

describe('computeVariances — net income + section totals', () => {
  const r = computeVariances(current, prior);

  it('computes net income for each period (revenue − costs)', () => {
    // current: 1,500,000 rev − (400,000 + 350,000) = 750,000
    expect(r.netCurrentCents).toBe(750_000);
    // prior: 1,300,000 rev − (350,000 + 100,000) = 850,000
    expect(r.netPriorCents).toBe(850_000);
    expect(r.netDeltaCents).toBe(-100_000);
  });

  it('rolls up section totals with deltas', () => {
    const rev = r.sectionTotals.find((s) => s.section === 'REVENUE')!;
    expect(rev.currentCents).toBe(1_500_000);
    expect(rev.priorCents).toBe(1_300_000);
    expect(rev.deltaCents).toBe(200_000);
  });
});

describe('computeVariances — options', () => {
  it('respects topN', () => {
    expect(computeVariances(current, prior, { topN: 1 }).drivers).toHaveLength(1);
  });

  it('neutral mode yields null favorability and null net income (balance sheet)', () => {
    const bsCur: VarianceLine[] = [{ key: '1000', label: 'Cash', section: 'ASSET', amountCents: 500_000 }];
    const bsPri: VarianceLine[] = [{ key: '1000', label: 'Cash', section: 'ASSET', amountCents: 300_000 }];
    const r = computeVariances(bsCur, bsPri, { mode: 'neutral' });
    expect(r.drivers[0].favorable).toBeNull();
    expect(r.netCurrentCents).toBeNull();
    expect(r.netDeltaCents).toBeNull();
  });
});
