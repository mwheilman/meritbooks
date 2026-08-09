/**
 * Cash balance trend — PURE reconstruction proof (no I/O, no live clock).
 *
 * Pins the "balance rewind" invariant: closing(D) = currentTotal − Σ(txns strictly
 * after D). Anchors "today" so the math is deterministic. Covers the boundary being
 * exclusive of same-day txns, the emitted point count (weeks+1) with the final point
 * equal to the current total, invalid-amount filtering, fractional truncation, and the
 * start/end/change/pct/min/max summary — including changePct = null when the window
 * start is exactly zero.
 */

import { describe, it, expect } from 'vitest';
import { buildBalanceTrend, type TrendTxn } from './trend';

const AS_OF = new Date(Date.UTC(2026, 7, 9)); // 2026-08-09 (anchor)

describe('buildBalanceTrend — balance rewind math', () => {
  it('rewinds the current balance by the net of txns strictly AFTER each boundary', () => {
    const txns: TrendTxn[] = [
      { date: '2026-07-30', amountCents: -3000 }, // outflow before the -14d..-7d span
      { date: '2026-08-05', amountCents: 5000 }, // inflow inside the last week
    ];
    const trend = buildBalanceTrend({ currentTotalCents: 100000, txns, weeks: 2, today: AS_OF });

    // weeks+1 points, oldest → newest, at 7-day boundaries ending on the anchor.
    expect(trend.points.map((p) => p.date)).toEqual(['2026-07-26', '2026-08-02', '2026-08-09']);

    // 2026-08-09 (anchor): nothing after it → equals the current total.
    expect(trend.points[2].closingCents).toBe(100000);
    // 2026-08-02: only the +5000 (08-05) is after it → 100000 − 5000.
    expect(trend.points[1].closingCents).toBe(95000);
    // 2026-07-26: both txns are after it → net +2000 → 100000 − 2000.
    expect(trend.points[0].closingCents).toBe(98000);
  });

  it('emits weeks+1 points and the final point equals the current total', () => {
    const trend = buildBalanceTrend({ currentTotalCents: 42, txns: [], weeks: 13, today: AS_OF });
    expect(trend.points).toHaveLength(14);
    expect(trend.points[trend.points.length - 1].closingCents).toBe(42);
    expect(trend.endCents).toBe(42);
  });

  it('defaults to 13 weeks (14 points) when weeks is omitted', () => {
    const trend = buildBalanceTrend({ currentTotalCents: 0, txns: [], today: AS_OF });
    expect(trend.points).toHaveLength(14);
  });

  it('treats a boundary as INCLUSIVE of same-day txns (only strictly-after txns rewind)', () => {
    // A txn dated exactly on a boundary is considered already settled by that day,
    // so it must NOT be subtracted at that boundary, but IS subtracted at earlier ones.
    const txns: TrendTxn[] = [{ date: '2026-08-02', amountCents: 1000 }];
    const trend = buildBalanceTrend({ currentTotalCents: 100000, txns, weeks: 2, today: AS_OF });
    // 2026-08-02 boundary: same-day txn NOT after → closing stays 100000.
    expect(trend.points[1].closingCents).toBe(100000);
    // 2026-07-26 boundary: the 08-02 txn IS after → 100000 − 1000.
    expect(trend.points[0].closingCents).toBe(99000);
  });

  it('summarizes start/end/change/pct and min/max over the window', () => {
    const txns: TrendTxn[] = [
      { date: '2026-07-30', amountCents: -3000 },
      { date: '2026-08-05', amountCents: 5000 },
    ];
    const trend = buildBalanceTrend({ currentTotalCents: 100000, txns, weeks: 2, today: AS_OF });
    expect(trend.startCents).toBe(98000);
    expect(trend.endCents).toBe(100000);
    expect(trend.changeCents).toBe(2000);
    expect(trend.changePct).toBeCloseTo((2000 / 98000) * 100, 6);
    expect(trend.minCents).toBe(95000);
    expect(trend.maxCents).toBe(100000);
  });
});

describe('buildBalanceTrend — edge cases', () => {
  it('with no txns every point equals the current total (flat line)', () => {
    const trend = buildBalanceTrend({ currentTotalCents: 7500, txns: [], weeks: 4, today: AS_OF });
    expect(trend.points.every((p) => p.closingCents === 7500)).toBe(true);
    expect(trend.changeCents).toBe(0);
    expect(trend.changePct).toBe(0); // start (7500) ≠ 0 → defined, 0%
    expect(trend.minCents).toBe(7500);
    expect(trend.maxCents).toBe(7500);
  });

  it('returns changePct = null when the window START is exactly zero', () => {
    const trend = buildBalanceTrend({ currentTotalCents: 0, txns: [], weeks: 1, today: AS_OF });
    expect(trend.startCents).toBe(0);
    expect(trend.changePct).toBeNull();
  });

  it('ignores non-finite / non-numeric amounts instead of poisoning the balance to NaN', () => {
    const txns = [
      { date: '2026-08-05', amountCents: 5000 },
      { date: '2026-08-06', amountCents: Number.NaN },
      // deliberately malformed shape the filter must drop
      { date: '2026-08-07', amountCents: 'x' as unknown as number },
    ] as TrendTxn[];
    const trend = buildBalanceTrend({ currentTotalCents: 100000, txns, weeks: 2, today: AS_OF });
    // Only the valid +5000 rewinds the -7d boundary.
    expect(trend.points[1].closingCents).toBe(95000);
    expect(Number.isNaN(trend.points[0].closingCents)).toBe(false);
  });

  it('truncates fractional cents toward zero before summing', () => {
    const txns: TrendTxn[] = [{ date: '2026-08-05', amountCents: 100.9 }];
    const trend = buildBalanceTrend({ currentTotalCents: 100000, txns, weeks: 2, today: AS_OF });
    // Math.trunc(100.9) = 100 → 100000 − 100.
    expect(trend.points[1].closingCents).toBe(99900);
  });
});
