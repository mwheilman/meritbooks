/**
 * EC-7 sales-tax nexus logic. Pins the period math, state normalization, per-state
 * aggregation (revenue + txn count + fallback share + persistence), the threshold
 * model (default $100k/200-txn + per-state overrides), the crossing rule, the
 * confidence discount for HQ-fallback attribution, tiering (REVIEW baseline, ESCALATE
 * when well-over or sustained), and the dedup-key stability (idempotency contract).
 * Pure logic only — no Supabase, no wall-clock.
 */

import { describe, it, expect } from 'vitest';
import {
  periodOf,
  periodToIndex,
  addPeriods,
  toConfidence,
  dedupKey,
  normalizeState,
  thresholdFor,
  aggregateByState,
  crossedThreshold,
  nexusConfidence,
  resolveNexusTier,
  DEFAULT_NEXUS_THRESHOLD,
  STATE_THRESHOLD_OVERRIDES,
  NEXUS_TUNABLES,
  type NexusInvoice,
  type StateAggregate,
} from './sales-tax-nexus';
import type { TierPolicy } from '@/lib/trust/score-tier';

const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };

// Helper: build a NexusInvoice quickly.
function inv(
  state: string | null,
  salesCents: number,
  source: NexusInvoice['source'],
  period: string | null,
  id = Math.random().toString(36).slice(2),
): NexusInvoice {
  return { invoiceId: id, state, source, salesCents, period, locationId: null };
}

// ── period math ───────────────────────────────────────────────────────────────
describe('period math', () => {
  it('periodOf buckets a date to YYYY-MM (or null)', () => {
    expect(periodOf('2026-03-17')).toBe('2026-03');
    expect(periodOf('2026-03-17T12:00:00Z')).toBe('2026-03');
    expect(periodOf(null)).toBeNull();
    expect(periodOf('garbage')).toBeNull();
  });

  it('addPeriods rolls the trailing-12 window start correctly', () => {
    // window end 2026-08 → start 11 months back = 2025-09
    expect(addPeriods('2026-08', -11)).toBe('2025-09');
    expect(periodToIndex('2026-08')! - periodToIndex('2025-09')!).toBe(11);
  });

  it('toConfidence clamps into the numeric(5,4) range', () => {
    expect(toConfidence(1.5)).toBe(0.9999);
    expect(toConfidence(-1)).toBe(0);
    expect(toConfidence(0.9)).toBe(0.9);
  });
});

// ── state normalization ─────────────────────────────────────────────────────────
describe('normalizeState', () => {
  it('accepts a 2-letter code (any case)', () => {
    expect(normalizeState('ca')).toBe('CA');
    expect(normalizeState(' TX ')).toBe('TX');
    expect(normalizeState('DC')).toBe('DC');
  });
  it('maps a full state name to its code', () => {
    expect(normalizeState('California')).toBe('CA');
    expect(normalizeState('new york')).toBe('NY');
    expect(normalizeState('District of Columbia')).toBe('DC');
  });
  it('rejects non-states and junk', () => {
    expect(normalizeState('ZZ')).toBeNull();
    expect(normalizeState('Ontario')).toBeNull();
    expect(normalizeState('')).toBeNull();
    expect(normalizeState(null)).toBeNull();
    expect(normalizeState(42 as unknown)).toBeNull();
  });
});

// ── threshold model ─────────────────────────────────────────────────────────────
describe('thresholdFor', () => {
  it('defaults to $100k OR 200 transactions', () => {
    expect(thresholdFor('FL')).toEqual(DEFAULT_NEXUS_THRESHOLD);
    expect(DEFAULT_NEXUS_THRESHOLD.salesCents).toBe(100_000_00);
    expect(DEFAULT_NEXUS_THRESHOLD.txnCount).toBe(200);
  });
  it('applies per-state overrides (CA/TX sales-only $500k)', () => {
    expect(thresholdFor('CA')).toBe(STATE_THRESHOLD_OVERRIDES.CA);
    expect(thresholdFor('CA').salesCents).toBe(500_000_00);
    expect(thresholdFor('CA').txnCount).toBeNull();
  });
});

// ── aggregation ─────────────────────────────────────────────────────────────────
describe('aggregateByState', () => {
  it('sums revenue + counts transactions per state, tracks months + fallback', () => {
    const rows: NexusInvoice[] = [
      inv('IA', 40_000_00, 'ship_to', '2026-01'),
      inv('IA', 30_000_00, 'customer', '2026-02'), // fallback-attributed
      inv('IA', 35_000_00, 'ship_to', '2026-03'),
      inv('MN', 10_000_00, 'bill_to', '2026-01'),
    ];
    const agg = aggregateByState(rows);
    const ia = agg.get('IA')!;
    expect(ia.salesCents).toBe(105_000_00);
    expect(ia.txnCount).toBe(3);
    expect(ia.fallbackSalesCents).toBe(30_000_00);
    expect(ia.monthsWithSales).toBe(3);
    expect(ia.invoiceIds).toHaveLength(3);
    expect(agg.get('MN')!.txnCount).toBe(1);
  });

  it('drops invoices with no resolvable destination state', () => {
    const agg = aggregateByState([inv(null, 99_00, null, '2026-01'), inv('IA', 100_00, 'ship_to', '2026-01')]);
    expect(agg.has('IA')).toBe(true);
    expect(agg.size).toBe(1);
  });

  it('picks the modal location for the exception', () => {
    const rows: NexusInvoice[] = [
      { ...inv('IA', 1, 'ship_to', '2026-01'), locationId: 'loc-a' },
      { ...inv('IA', 1, 'ship_to', '2026-02'), locationId: 'loc-a' },
      { ...inv('IA', 1, 'ship_to', '2026-03'), locationId: 'loc-b' },
    ];
    expect(aggregateByState(rows).get('IA')!.locationId).toBe('loc-a');
  });
});

// ── crossing rule ───────────────────────────────────────────────────────────────
function aggOf(partial: Partial<StateAggregate>): StateAggregate {
  return {
    state: 'IA',
    salesCents: 0,
    txnCount: 0,
    fallbackSalesCents: 0,
    monthsWithSales: 1,
    invoiceIds: [],
    locationId: null,
    ...partial,
  };
}

describe('crossedThreshold', () => {
  it('trips on the sales trigger alone', () => {
    const r = crossedThreshold(aggOf({ salesCents: 100_000_00, txnCount: 5 }), DEFAULT_NEXUS_THRESHOLD);
    expect(r.crossed).toBe(true);
    expect(r.basis).toEqual(['sales']);
  });

  it('trips on the transaction-count trigger alone', () => {
    const r = crossedThreshold(aggOf({ salesCents: 5_000_00, txnCount: 200 }), DEFAULT_NEXUS_THRESHOLD);
    expect(r.crossed).toBe(true);
    expect(r.basis).toEqual(['transactions']);
  });

  it('reports both bases when both trip', () => {
    const r = crossedThreshold(aggOf({ salesCents: 250_000_00, txnCount: 400 }), DEFAULT_NEXUS_THRESHOLD);
    expect(r.basis).toEqual(['sales', 'transactions']);
    expect(r.salesRatio).toBeCloseTo(2.5, 5);
    expect(r.txnRatio).toBeCloseTo(2, 5);
  });

  it('does not trip below either threshold', () => {
    expect(crossedThreshold(aggOf({ salesCents: 99_999_99, txnCount: 199 }), DEFAULT_NEXUS_THRESHOLD).crossed).toBe(false);
  });

  it('honors a sales-only override (CA: 200 txns is NOT nexus)', () => {
    const th = thresholdFor('CA');
    const r = crossedThreshold(aggOf({ state: 'CA', salesCents: 120_000_00, txnCount: 300 }), th);
    // $120k < $500k and CA has no txn trigger → no crossing
    expect(r.crossed).toBe(false);
    expect(r.txnRatio).toBe(0);
  });
});

// ── confidence ──────────────────────────────────────────────────────────────────
describe('nexusConfidence', () => {
  it('is at base when destination rests on true ship/bill-to (no fallback)', () => {
    const c = nexusConfidence(aggOf({ salesCents: 200_000_00, fallbackSalesCents: 0 }));
    expect(c).toBeCloseTo(NEXUS_TUNABLES.confidenceBase, 5);
  });

  it('is discounted toward the floor when revenue is HQ-fallback attributed', () => {
    const c = nexusConfidence(aggOf({ salesCents: 200_000_00, fallbackSalesCents: 200_000_00 }));
    expect(c).toBeCloseTo(NEXUS_TUNABLES.confidenceFloor, 5);
    expect(c).toBeLessThan(NEXUS_TUNABLES.confidenceBase);
  });

  it('never drops below the floor', () => {
    const c = nexusConfidence(aggOf({ salesCents: 0, fallbackSalesCents: 0 }));
    expect(c).toBeGreaterThanOrEqual(NEXUS_TUNABLES.confidenceFloor);
  });
});

// ── tiering ─────────────────────────────────────────────────────────────────────
describe('resolveNexusTier', () => {
  it('is REVIEW for a fresh, just-over crossing (not well-over, not sustained)', () => {
    const agg = aggOf({ salesCents: 110_000_00, txnCount: 20, monthsWithSales: 3 });
    const crossing = crossedThreshold(agg, DEFAULT_NEXUS_THRESHOLD);
    expect(resolveNexusTier(agg, crossing, 0.9, POLICY)).toBe('review');
  });

  it('ESCALATEs when well over threshold (≥2× sales)', () => {
    const agg = aggOf({ salesCents: 220_000_00, txnCount: 20, monthsWithSales: 3 });
    const crossing = crossedThreshold(agg, DEFAULT_NEXUS_THRESHOLD);
    expect(resolveNexusTier(agg, crossing, 0.9, POLICY)).toBe('escalate');
  });

  it('ESCALATEs when the nexus is sustained across most of the window', () => {
    const agg = aggOf({ salesCents: 110_000_00, txnCount: 20, monthsWithSales: 11 });
    const crossing = crossedThreshold(agg, DEFAULT_NEXUS_THRESHOLD);
    expect(resolveNexusTier(agg, crossing, 0.9, POLICY)).toBe('escalate');
  });

  it('never returns auto (existential-$ control)', () => {
    const agg = aggOf({ salesCents: 100_000_00, txnCount: 200, monthsWithSales: 1 });
    const crossing = crossedThreshold(agg, DEFAULT_NEXUS_THRESHOLD);
    expect(resolveNexusTier(agg, crossing, 0.99, POLICY)).not.toBe('auto');
  });
});

// ── dedup-key stability (idempotency contract) ───────────────────────────────────
describe('dedupKey', () => {
  it('is stable per (state, window-end)', () => {
    expect(dedupKey('IA', '2026-08')).toBe('nexus:IA:2026-08');
    expect(dedupKey('IA', '2026-08')).toBe(dedupKey('IA', '2026-08'));
  });
  it('differs by state and by window month', () => {
    expect(dedupKey('IA', '2026-08')).not.toBe(dedupKey('MN', '2026-08'));
    expect(dedupKey('IA', '2026-08')).not.toBe(dedupKey('IA', '2026-09'));
  });
});
