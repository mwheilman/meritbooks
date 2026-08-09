/**
 * Treasury depth — balance-trend reconstruction + obligation bucketing.
 *
 * Both engines are pure (no I/O). These tests pin the deterministic math:
 *   • buildBalanceTrend rewinds the live balance through the dated feed so each
 *     week-ending point is exact, and the final point equals the current total.
 *   • summarizeObligations buckets outflows into 7/30/60/90-day horizons and
 *     computes cash-after / first-shortfall correctly.
 */

import { describe, it, expect } from 'vitest';
import { buildBalanceTrend, type TrendTxn } from './trend';
import { summarizeObligations, type ObligationItem } from './obligations';

// Fixed anchor: 2026-08-09 (a Sunday). All dates are UTC.
const TODAY = new Date(Date.UTC(2026, 7, 9));

describe('buildBalanceTrend', () => {
  it('ends at the current total and rewinds by the post-boundary net', () => {
    // Current total 100,000c. One inflow of 20,000c three days ago, one outflow
    // of 5,000c ten days ago.
    const txns: TrendTxn[] = [
      { date: '2026-08-06', amountCents: 20_000 }, // 3 days ago (in)
      { date: '2026-07-30', amountCents: -5_000 }, // 10 days ago (out)
    ];
    const trend = buildBalanceTrend({ currentTotalCents: 100_000, txns, weeks: 4, today: TODAY });

    // 5 points (weeks+1), oldest → newest; last equals current.
    expect(trend.points).toHaveLength(5);
    expect(trend.points[trend.points.length - 1].closingCents).toBe(100_000);
    expect(trend.endCents).toBe(100_000);

    // The most recent boundary before today is 2026-08-02; after it only the
    // +20,000 inflow occurred, so that point = 100,000 − 20,000 = 80,000.
    const aug2 = trend.points.find((p) => p.date === '2026-08-02');
    expect(aug2?.closingCents).toBe(80_000);

    // A boundary before the −5,000 outflow (2026-07-12): net after = +20,000 −
    // 5,000 = +15,000 → 100,000 − 15,000 = 85,000.
    expect(trend.points[0].date).toBe('2026-07-12');
    expect(trend.points[0].closingCents).toBe(85_000);
  });

  it('is flat when there are no transactions', () => {
    const trend = buildBalanceTrend({ currentTotalCents: 42_000, txns: [], weeks: 6, today: TODAY });
    expect(trend.points.every((p) => p.closingCents === 42_000)).toBe(true);
    expect(trend.changeCents).toBe(0);
    expect(trend.changePct).toBe(0);
  });

  it('reports change and percent vs the window start', () => {
    const txns: TrendTxn[] = [{ date: '2026-08-07', amountCents: 25_000 }];
    const trend = buildBalanceTrend({ currentTotalCents: 125_000, txns, weeks: 2, today: TODAY });
    // start = 100,000, end = 125,000 → +25,000, +25%.
    expect(trend.startCents).toBe(100_000);
    expect(trend.changeCents).toBe(25_000);
    expect(trend.changePct).toBeCloseTo(25, 5);
  });
});

const ob = (o: Partial<ObligationItem> & { dueDate: string; amountCents: number }): ObligationItem => ({
  id: o.id ?? `${o.dueDate}:${o.amountCents}`,
  kind: o.kind ?? 'DEBT',
  label: o.label ?? 'Loan',
  party: o.party ?? 'Bank',
  ...o,
});

describe('summarizeObligations', () => {
  it('buckets outflows into 7/30/60/90-day horizons cumulatively', () => {
    const items: ObligationItem[] = [
      ob({ dueDate: '2026-08-12', amountCents: 10_000 }), // +3d → in all buckets
      ob({ dueDate: '2026-09-01', amountCents: 20_000 }), // +23d → 30/60/90
      ob({ dueDate: '2026-10-20', amountCents: 30_000 }), // +72d → 90 only
      ob({ dueDate: '2026-12-01', amountCents: 99_000 }), // beyond 90d → excluded
    ];
    const s = summarizeObligations({ currentCashCents: 100_000, items, today: TODAY });

    const b7 = s.buckets.find((b) => b.days === 7)!;
    const b30 = s.buckets.find((b) => b.days === 30)!;
    const b90 = s.buckets.find((b) => b.days === 90)!;

    expect(b7.totalCents).toBe(10_000);
    expect(b30.totalCents).toBe(30_000);
    expect(b90.totalCents).toBe(60_000);
    expect(b90.count).toBe(3); // the Dec item is excluded
    expect(s.totalWithinHorizonCents).toBe(60_000);
    expect(b90.cashAfterCents).toBe(40_000);
  });

  it('flags the first horizon where cash goes negative', () => {
    const items: ObligationItem[] = [
      ob({ dueDate: '2026-08-15', amountCents: 60_000 }),
      ob({ dueDate: '2026-09-30', amountCents: 60_000 }),
    ];
    const s = summarizeObligations({ currentCashCents: 100_000, items, today: TODAY });
    // 30d bucket = 60k (cashAfter 40k, ok); 60d bucket = 120k (cashAfter −20k).
    expect(s.firstShortfallDays).toBe(60);
  });

  it('drops non-positive amounts and returns empty cleanly', () => {
    const s = summarizeObligations({ currentCashCents: 50_000, items: [], today: TODAY });
    expect(s.items).toHaveLength(0);
    expect(s.totalWithinHorizonCents).toBe(0);
    expect(s.firstShortfallDays).toBeNull();
  });
});
