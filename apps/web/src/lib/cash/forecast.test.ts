/**
 * 13-Week Cash Forecast engine — deterministic projection assertions.
 *
 * The engine is pure (no I/O): given a starting balance and open AR/AP timed by
 * due date, it buckets each item into one of 13 forward weeks and rolls opening
 * → net → closing. These tests pin the bucketing rules (past-due → week 1,
 * beyond-horizon excluded) and the running-balance / low-water-mark math.
 */

import { describe, it, expect } from 'vitest';
import {
  buildForecast, bucketIndex, mondayOf, HORIZON_WEEKS,
  type ForecastCashflowItem,
} from './forecast';

// Fixed anchor: Wednesday 2026-08-05. Its Monday is 2026-08-03.
const TODAY = new Date(Date.UTC(2026, 7, 5));
const ANCHOR = new Date(Date.UTC(2026, 7, 3));

const item = (over: Partial<ForecastCashflowItem> & { dueDate: string; amountCents: number }): ForecastCashflowItem => ({
  id: over.id ?? `${over.dueDate}-${over.amountCents}`,
  label: over.label ?? 'DOC-1',
  party: over.party ?? 'Acme',
  status: over.status ?? 'OPEN',
  overdue: over.overdue ?? false,
  ...over,
});

describe('mondayOf', () => {
  it('returns the Monday on/before the date', () => {
    expect(mondayOf(TODAY).toISOString().slice(0, 10)).toBe('2026-08-03');
    // A Sunday should roll back to the prior Monday.
    expect(mondayOf(new Date(Date.UTC(2026, 7, 9))).toISOString().slice(0, 10)).toBe('2026-08-03');
    // A Monday maps to itself.
    expect(mondayOf(ANCHOR).toISOString().slice(0, 10)).toBe('2026-08-03');
  });
});

describe('bucketIndex', () => {
  it('places past-due items in week 1 (index 0)', () => {
    expect(bucketIndex('2026-07-01', ANCHOR)).toBe(0);
    expect(bucketIndex('2026-08-02', ANCHOR)).toBe(0); // day before anchor
  });
  it('places same-week and forward items correctly', () => {
    expect(bucketIndex('2026-08-03', ANCHOR)).toBe(0); // anchor Monday
    expect(bucketIndex('2026-08-09', ANCHOR)).toBe(0); // end of week 1 (Sun)
    expect(bucketIndex('2026-08-10', ANCHOR)).toBe(1); // start of week 2
    expect(bucketIndex('2026-08-16', ANCHOR)).toBe(1); // end of week 2
  });
  it('excludes items beyond the 13-week horizon', () => {
    const beyond = new Date(ANCHOR);
    beyond.setUTCDate(beyond.getUTCDate() + HORIZON_WEEKS * 7); // first day past horizon
    expect(bucketIndex(beyond.toISOString().slice(0, 10), ANCHOR)).toBe(-1);
  });
});

describe('buildForecast', () => {
  it('produces 13 weeks and rolls the running balance', () => {
    const r = buildForecast({
      startingCashCents: 100_00,
      inflows: [item({ dueDate: '2026-08-05', amountCents: 50_00 })], // week 1
      outflows: [item({ dueDate: '2026-08-12', amountCents: 30_00 })], // week 2
      today: TODAY,
    });
    expect(r.weeks).toHaveLength(13);
    expect(r.weeks[0].openingCents).toBe(100_00);
    expect(r.weeks[0].inflowsCents).toBe(50_00);
    expect(r.weeks[0].closingCents).toBe(150_00);
    expect(r.weeks[1].openingCents).toBe(150_00);
    expect(r.weeks[1].outflowsCents).toBe(30_00);
    expect(r.weeks[1].closingCents).toBe(120_00);
    expect(r.endingCashCents).toBe(120_00);
    expect(r.totalInflowsCents).toBe(50_00);
    expect(r.totalOutflowsCents).toBe(30_00);
  });

  it('flags negative weeks and the low-water mark', () => {
    const r = buildForecast({
      startingCashCents: 10_00,
      inflows: [],
      outflows: [
        item({ dueDate: '2026-08-05', amountCents: 40_00 }), // week 1 → -30.00
        item({ dueDate: '2026-08-12', amountCents: 5_00 }),  // week 2 → -35.00 (low)
      ],
      today: TODAY,
    });
    expect(r.weeks[0].closingCents).toBe(-30_00);
    expect(r.weeks[1].closingCents).toBe(-35_00);
    expect(r.negativeWeekCount).toBe(13); // stays negative for the rest of the horizon
    expect(r.lowWaterMarkCents).toBe(-35_00);
    expect(r.lowWaterWeekIndex).toBe(1); // first week the minimum is reached
  });

  it('excludes beyond-horizon cash from the projection but reports it', () => {
    const r = buildForecast({
      startingCashCents: 0,
      inflows: [item({ dueDate: '2027-01-01', amountCents: 99_00 })],
      outflows: [],
      today: TODAY,
    });
    expect(r.totalInflowsCents).toBe(0);
    expect(r.beyondHorizonInflowsCents).toBe(99_00);
    expect(r.endingCashCents).toBe(0);
  });

  it('sorts drill-down items by amount descending', () => {
    const r = buildForecast({
      startingCashCents: 0,
      inflows: [
        item({ id: 'a', dueDate: '2026-08-05', amountCents: 10_00 }),
        item({ id: 'b', dueDate: '2026-08-06', amountCents: 90_00 }),
      ],
      outflows: [],
      today: TODAY,
    });
    expect(r.weeks[0].inflowItems.map((i) => i.id)).toEqual(['b', 'a']);
  });
});
