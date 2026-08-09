import { describe, it, expect } from 'vitest';
import {
  buildStockValuationReport,
  computeGlTieOut,
  type ValuationItemInput,
} from './stock-valuation';

function item(over: Partial<ValuationItemInput> = {}): ValuationItemInput {
  return {
    id: 'i1',
    sku: 'SKU1',
    name: 'Widget',
    uom: 'each',
    valuationMethod: 'WEIGHTED_AVG',
    qtyOnHand: 10,
    avgCostCents: 250,
    totalValueCents: 2500,
    locationId: 'loc-a',
    isActive: true,
    ...over,
  };
}

describe('buildStockValuationReport', () => {
  it('totals value from total_value_cents (never re-multiplies qty × unit cost)', () => {
    // total_value_cents is authoritative even if qty × avg drifts by a cent.
    const r = buildStockValuationReport([
      item({ id: 'a', sku: 'A', qtyOnHand: 3, avgCostCents: 333, totalValueCents: 1000 }),
    ]);
    expect(r.summary.totalValueCents).toBe(1000);
    expect(r.groups[0].lines[0].valueCents).toBe(1000);
  });

  it('groups by location, sorts groups by descending subtotal', () => {
    const r = buildStockValuationReport(
      [
        item({ id: 'a', sku: 'A', locationId: 'loc-a', totalValueCents: 1000 }),
        item({ id: 'b', sku: 'B', locationId: 'loc-b', totalValueCents: 5000 }),
        item({ id: 'c', sku: 'C', locationId: 'loc-a', totalValueCents: 500 }),
      ],
      { locationNames: { 'loc-a': 'Alpha', 'loc-b': 'Bravo' } },
    );
    expect(r.groups.map((g) => g.locationName)).toEqual(['Bravo', 'Alpha']);
    expect(r.groups[0].totalValueCents).toBe(5000);
    expect(r.groups[1].totalValueCents).toBe(1500);
    expect(r.summary.totalValueCents).toBe(6500);
  });

  it('sorts lines within a group by descending value then SKU', () => {
    const r = buildStockValuationReport([
      item({ id: 'a', sku: 'ZZZ', totalValueCents: 100 }),
      item({ id: 'b', sku: 'AAA', totalValueCents: 900 }),
    ]);
    expect(r.groups[0].lines.map((l) => l.sku)).toEqual(['AAA', 'ZZZ']);
  });

  it('computes percent-of-total per line (0 when total is 0)', () => {
    const r = buildStockValuationReport([
      item({ id: 'a', sku: 'A', totalValueCents: 7500 }),
      item({ id: 'b', sku: 'B', totalValueCents: 2500 }),
    ]);
    const byId = Object.fromEntries(r.groups.flatMap((g) => g.lines).map((l) => [l.sku, l.pctOfTotal]));
    expect(byId.A).toBeCloseTo(0.75);
    expect(byId.B).toBeCloseTo(0.25);
  });

  it('labels null-location items as Unassigned', () => {
    const r = buildStockValuationReport([item({ locationId: null })]);
    expect(r.groups[0].locationName).toBe('Unassigned');
    expect(r.groups[0].locationId).toBeNull();
  });

  it('excludes zero-on-hand, zero-value items by default; keeps them when asked', () => {
    const rows = [
      item({ id: 'a', sku: 'A', qtyOnHand: 0, totalValueCents: 0 }),
      item({ id: 'b', sku: 'B', qtyOnHand: 5, totalValueCents: 1000 }),
    ];
    expect(buildStockValuationReport(rows).summary.itemCount).toBe(1);
    expect(buildStockValuationReport(rows, { excludeZero: false }).summary.itemCount).toBe(2);
  });

  it('breaks the total down by valuation method', () => {
    const r = buildStockValuationReport([
      item({ id: 'a', sku: 'A', valuationMethod: 'WEIGHTED_AVG', totalValueCents: 1000 }),
      item({ id: 'b', sku: 'B', valuationMethod: 'FIFO', totalValueCents: 4000 }),
      item({ id: 'c', sku: 'C', valuationMethod: 'FIFO', totalValueCents: 1000 }),
    ]);
    const fifo = r.summary.byMethod.find((m) => m.method === 'FIFO')!;
    const wavg = r.summary.byMethod.find((m) => m.method === 'WEIGHTED_AVG')!;
    expect(fifo.totalValueCents).toBe(5000);
    expect(fifo.itemCount).toBe(2);
    expect(wavg.totalValueCents).toBe(1000);
    // sorted by descending value → FIFO first
    expect(r.summary.byMethod[0].method).toBe('FIFO');
  });

  it('counts items actually on hand separately from item count', () => {
    const r = buildStockValuationReport(
      [
        item({ id: 'a', sku: 'A', qtyOnHand: 0, totalValueCents: 500 }), // value but no qty (rounding residue)
        item({ id: 'b', sku: 'B', qtyOnHand: 5, totalValueCents: 1000 }),
      ],
      { excludeZero: false },
    );
    expect(r.summary.itemCount).toBe(2);
    expect(r.summary.itemsOnHand).toBe(1);
  });
});

describe('computeGlTieOut', () => {
  it('in sync when subledger equals GL', () => {
    const t = computeGlTieOut(10000, 10000);
    expect(t.inSync).toBe(true);
    expect(t.varianceCents).toBe(0);
  });

  it('variance is subledger minus GL', () => {
    const t = computeGlTieOut(12000, 10000);
    expect(t.varianceCents).toBe(2000);
    expect(t.inSync).toBe(false);
  });

  it('negative variance when GL carries more than the stock ledger', () => {
    const t = computeGlTieOut(8000, 10000);
    expect(t.varianceCents).toBe(-2000);
  });

  it('rounds fractional inputs to whole cents', () => {
    const t = computeGlTieOut(100.4, 100.6);
    expect(t.subledgerCents).toBe(100);
    expect(t.glCents).toBe(101);
    expect(t.varianceCents).toBe(-1);
  });
});
