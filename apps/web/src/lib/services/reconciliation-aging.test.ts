/**
 * Reconciliation aging + difference-decomposition (FPB Bank Reconciliation).
 * Proves: outstanding items bucket into the right age bands with correct totals,
 * oldest band first and oldest-item-first within a band; and the difference
 * decomposer attributes the gap to its lines and surfaces the residual (plug)
 * without ever forcing it to $0.
 */

import { describe, it, expect } from 'vitest';
import {
  AGING_BUCKETS,
  bucketOutstandingByAge,
  decomposeDifference,
} from './reconciliation-aging';
import type { OutstandingItem } from './reconciliation-plug';

const item = (over: Partial<OutstandingItem>): OutstandingItem => ({
  id: 'i1',
  description: 'Check 1001',
  amountCents: -50_00,
  transactionDate: '2026-03-01',
  ...over,
});

describe('bucketOutstandingByAge', () => {
  it('places each item in the correct age band', () => {
    // as-of 2026-04-30.
    const items = [
      item({ id: 'a', transactionDate: '2026-04-20' }), // 10d -> 0–30
      item({ id: 'b', transactionDate: '2026-03-20' }), // 41d -> 31–60
      item({ id: 'c', transactionDate: '2026-02-20' }), // 69d -> 61–90
      item({ id: 'd', transactionDate: '2025-12-01' }), // 150d -> 90+
    ];
    const report = bucketOutstandingByAge(items, { asOfDate: '2026-04-30' });
    const idsByKey = Object.fromEntries(report.buckets.map((b) => [b.key, b.items.map((i) => i.id)]));
    expect(idsByKey['0_30']).toEqual(['a']);
    expect(idsByKey['31_60']).toEqual(['b']);
    expect(idsByKey['61_90']).toEqual(['c']);
    expect(idsByKey['90_plus']).toEqual(['d']);
  });

  it('emits the oldest band first and sorts items oldest-first within a band', () => {
    const items = [
      item({ id: 'young', transactionDate: '2026-01-05', amountCents: 10_00 }),
      item({ id: 'old', transactionDate: '2026-01-01', amountCents: 20_00 }),
    ]; // both land in 90+ as of mid-year
    const report = bucketOutstandingByAge(items, { asOfDate: '2026-06-01' });
    expect(report.buckets[0].key).toBe('90_plus'); // oldest band leads
    const band = report.buckets.find((b) => b.key === '90_plus')!;
    expect(band.items.map((i) => i.id)).toEqual(['old', 'young']); // oldest-first
  });

  it('splits outflow (checks) from inflow (deposits) and nets per band + overall', () => {
    const items = [
      item({ id: 'chk', amountCents: -100_00, transactionDate: '2026-01-01' }),
      item({ id: 'dep', amountCents: 40_00, transactionDate: '2026-01-01' }),
    ];
    const report = bucketOutstandingByAge(items, { asOfDate: '2026-06-01' });
    const band = report.buckets.find((b) => b.key === '90_plus')!;
    expect(band.outflowCents).toBe(100_00);
    expect(band.inflowCents).toBe(40_00);
    expect(band.netCents).toBe(-60_00);
    expect(report.totals).toEqual({ count: 2, netCents: -60_00, outflowCents: 100_00, inflowCents: 40_00 });
    expect(report.oldestAgeDays).toBeGreaterThan(90);
  });

  it('returns all four empty bands (stable grid) when there are no items', () => {
    const report = bucketOutstandingByAge([], { asOfDate: '2026-06-01' });
    expect(report.buckets).toHaveLength(AGING_BUCKETS.length);
    expect(report.buckets.every((b) => b.count === 0 && b.items.length === 0)).toBe(true);
    expect(report.totals.count).toBe(0);
    expect(report.oldestAgeDays).toBe(0);
  });
});

describe('decomposeDifference', () => {
  it('fully explains a difference equal to the net of the outstanding items', () => {
    // Two outstanding checks net -125.00; a difference of -125.00 is fully explained.
    const outstandingItems = [
      item({ id: 'c1', amountCents: -100_00, transactionDate: '2026-01-01' }),
      item({ id: 'c2', amountCents: -25_00, transactionDate: '2026-02-01' }),
    ];
    const d = decomposeDifference({ differenceCents: -125_00, outstandingItems, asOfDate: '2026-03-01' });
    expect(d.outstandingNetCents).toBe(-125_00);
    expect(d.residualCents).toBe(0);
    expect(d.fullyExplained).toBe(true);
    expect(d.outstandingChecksCents).toBe(125_00);
    expect(d.depositsInTransitCents).toBe(0);
    // Largest-absolute first.
    expect(d.components.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(d.components[0].reducesDifferenceBy).toBe(-100_00);
  });

  it('surfaces a residual (plug) when the items do not explain the whole gap — never forcing $0', () => {
    const outstandingItems = [item({ id: 'c1', amountCents: -100_00, transactionDate: '2026-01-01' })];
    const d = decomposeDifference({ differenceCents: -137_50, outstandingItems, asOfDate: '2026-03-01' });
    expect(d.outstandingNetCents).toBe(-100_00);
    expect(d.residualCents).toBe(-37_50); // unexplained remainder, shown not plugged
    expect(d.fullyExplained).toBe(false);
  });

  it('handles a zero difference with no outstanding items (a clean tie)', () => {
    const d = decomposeDifference({ differenceCents: 0, outstandingItems: [], asOfDate: '2026-03-01' });
    expect(d.residualCents).toBe(0);
    expect(d.fullyExplained).toBe(true);
    expect(d.components).toHaveLength(0);
  });
});
