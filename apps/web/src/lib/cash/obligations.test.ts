/**
 * Near-term cash obligations — PURE horizon bucketing proof (no I/O, anchored clock).
 *
 * Pins: cumulative 7/30/60/90-day buckets (each horizon is inclusive of everything due
 * on/before its end), positive-outflow-only filtering, past-due items counting against
 * every bucket ("due now"), exclusion of anything beyond the widest (90d) horizon with
 * the exact-90-day edge INCLUDED, dueDate-ascending ordering, cashAfter = cash − total,
 * and firstShortfallDays (first bucket to go negative, else null).
 */

import { describe, it, expect } from 'vitest';
import { summarizeObligations, type ObligationItem } from './obligations';

const AS_OF = new Date(Date.UTC(2026, 7, 9)); // 2026-08-09 (anchor)

const item = (over: Partial<ObligationItem> & { id: string; dueDate: string; amountCents: number }): ObligationItem => ({
  kind: 'OTHER',
  label: over.id,
  party: null,
  ...over,
});

describe('summarizeObligations — cumulative horizon buckets', () => {
  const items: ObligationItem[] = [
    item({ id: 'past', dueDate: '2026-08-01', amountCents: 5000, kind: 'DEBT' }), // past due → "due now"
    item({ id: 'd7', dueDate: '2026-08-12', amountCents: 20000, kind: 'DEBT' }), // within 7d
    item({ id: 'd30', dueDate: '2026-08-25', amountCents: 30000, kind: 'RECURRING' }), // within 30d
    item({ id: 'd60', dueDate: '2026-10-01', amountCents: 40000, kind: 'LEASE' }), // within 60d
    item({ id: 'beyond', dueDate: '2026-12-01', amountCents: 99999, kind: 'OTHER' }), // beyond 90d → dropped
    item({ id: 'zero', dueDate: '2026-08-10', amountCents: 0 }), // non-positive → dropped
    item({ id: 'neg', dueDate: '2026-08-10', amountCents: -1000 }), // non-positive → dropped
  ];

  it('buckets are cumulative and each is inclusive of on/before-end due dates', () => {
    const s = summarizeObligations({ currentCashCents: 100000, items, today: AS_OF });
    const byDays = Object.fromEntries(s.buckets.map((b) => [b.days, b]));

    expect(byDays[7].totalCents).toBe(25000); // past(5000) + d7(20000)
    expect(byDays[7].count).toBe(2);
    expect(byDays[30].totalCents).toBe(55000); // + d30(30000)
    expect(byDays[30].count).toBe(3);
    expect(byDays[60].totalCents).toBe(95000); // + d60(40000)
    expect(byDays[60].count).toBe(4);
    expect(byDays[90].totalCents).toBe(95000); // 'beyond' excluded → unchanged from 60d
    expect(byDays[90].count).toBe(4);
  });

  it('drops non-positive amounts and anything past the 90-day horizon', () => {
    const s = summarizeObligations({ currentCashCents: 100000, items, today: AS_OF });
    const ids = s.items.map((i) => i.id);
    expect(ids).not.toContain('zero');
    expect(ids).not.toContain('neg');
    expect(ids).not.toContain('beyond');
    expect(s.items).toHaveLength(4);
  });

  it('orders the kept items by due date ascending', () => {
    const s = summarizeObligations({ currentCashCents: 100000, items, today: AS_OF });
    expect(s.items.map((i) => i.id)).toEqual(['past', 'd7', 'd30', 'd60']);
  });

  it('totalWithinHorizonCents sums every kept obligation', () => {
    const s = summarizeObligations({ currentCashCents: 100000, items, today: AS_OF });
    expect(s.totalWithinHorizonCents).toBe(95000);
  });

  it('computes cashAfter = currentCash − bucket total for each bucket', () => {
    const s = summarizeObligations({ currentCashCents: 100000, items, today: AS_OF });
    const byDays = Object.fromEntries(s.buckets.map((b) => [b.days, b]));
    expect(byDays[7].cashAfterCents).toBe(75000);
    expect(byDays[30].cashAfterCents).toBe(45000);
    expect(byDays[60].cashAfterCents).toBe(5000);
    expect(byDays[90].cashAfterCents).toBe(5000);
  });

  it('reports the anchored as-of date', () => {
    const s = summarizeObligations({ currentCashCents: 100000, items, today: AS_OF });
    expect(s.asOfDate).toBe('2026-08-09');
  });
});

describe('summarizeObligations — shortfall detection', () => {
  const items: ObligationItem[] = [
    item({ id: 'past', dueDate: '2026-08-01', amountCents: 5000 }),
    item({ id: 'd7', dueDate: '2026-08-12', amountCents: 20000 }),
    item({ id: 'd30', dueDate: '2026-08-25', amountCents: 30000 }),
  ];

  it('firstShortfallDays is the first bucket whose cashAfter goes negative', () => {
    // cash 30000: 7d total 25000 (ok, +5000), 30d total 55000 (−25000 → shortfall).
    const s = summarizeObligations({ currentCashCents: 30000, items, today: AS_OF });
    expect(s.firstShortfallDays).toBe(30);
  });

  it('firstShortfallDays is null when cash covers every horizon', () => {
    const s = summarizeObligations({ currentCashCents: 10_000_000, items, today: AS_OF });
    expect(s.firstShortfallDays).toBeNull();
  });
});

describe('summarizeObligations — horizon edge', () => {
  it('INCLUDES an obligation due exactly 90 days out; EXCLUDES one day past', () => {
    const items: ObligationItem[] = [
      item({ id: 'exactly90', dueDate: '2026-11-07', amountCents: 1000 }), // anchor + 90d
      item({ id: 'day91', dueDate: '2026-11-08', amountCents: 2000 }), // anchor + 91d
    ];
    const s = summarizeObligations({ currentCashCents: 100000, items, today: AS_OF });
    const ids = s.items.map((i) => i.id);
    expect(ids).toContain('exactly90');
    expect(ids).not.toContain('day91');
    const b90 = s.buckets.find((b) => b.days === 90)!;
    expect(b90.totalCents).toBe(1000);
  });

  it('an empty obligation set yields zeroed buckets and no shortfall', () => {
    const s = summarizeObligations({ currentCashCents: 50000, items: [], today: AS_OF });
    expect(s.items).toHaveLength(0);
    expect(s.buckets.map((b) => b.days)).toEqual([7, 30, 60, 90]);
    expect(s.buckets.every((b) => b.totalCents === 0 && b.count === 0 && b.cashAfterCents === 50000)).toBe(true);
    expect(s.totalWithinHorizonCents).toBe(0);
    expect(s.firstShortfallDays).toBeNull();
  });
});
