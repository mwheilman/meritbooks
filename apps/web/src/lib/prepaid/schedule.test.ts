import { describe, it, expect } from 'vitest';
import {
  buildAmortizationSchedule,
  derivePeriods,
  evenPerPeriodCents,
  PrepaidScheduleError,
} from './schedule';

const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);

describe('buildAmortizationSchedule — even split (clean divisor)', () => {
  const lines = buildAmortizationSchedule({ totalCents: 120_000, startDate: '2026-01-01', months: 12 });

  it('produces one line per period', () => {
    expect(lines).toHaveLength(12);
  });

  it('amortizes an equal amount each period with no remainder', () => {
    for (const l of lines) expect(l.amountCents).toBe(10_000);
  });

  it('sums to exactly the total and ends at a zero balance', () => {
    expect(sum(lines.map((l) => l.amountCents))).toBe(120_000);
    expect(lines[lines.length - 1].remainingCents).toBe(0);
  });

  it('runs the remaining balance down monotonically', () => {
    expect(lines[0].remainingCents).toBe(110_000);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].remainingCents).toBeLessThan(lines[i - 1].remainingCents);
    }
  });

  it('buckets by calendar month with last-day post dates', () => {
    expect(lines[0].period).toBe('2026-01');
    expect(lines[0].postDate).toBe('2026-01-31');
    expect(lines[1].period).toBe('2026-02');
    expect(lines[1].postDate).toBe('2026-02-28');
    expect(lines[11].period).toBe('2026-12');
  });
});

describe('buildAmortizationSchedule — even split with rounding remainder', () => {
  // 100.00 over 3 months: 33.33, 33.33, 33.34 (final absorbs the remainder).
  const lines = buildAmortizationSchedule({ totalCents: 10_000, startDate: '2026-01-01', months: 3 });

  it('floors each period and puts the remainder on the final period', () => {
    expect(lines.map((l) => l.amountCents)).toEqual([3_333, 3_333, 3_334]);
    expect(evenPerPeriodCents(10_000, 3)).toBe(3_333);
  });

  it('sums to the total and ends at zero', () => {
    expect(sum(lines.map((l) => l.amountCents))).toBe(10_000);
    expect(lines[lines.length - 1].remainingCents).toBe(0);
  });

  it('crosses a year boundary correctly', () => {
    const yearEnd = buildAmortizationSchedule({ totalCents: 30_000, startDate: '2026-11-01', months: 4 });
    expect(yearEnd.map((l) => l.period)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
});

describe('buildAmortizationSchedule — prorated partial first period', () => {
  // 12 months of coverage from mid-month; actual/actual day proration.
  const lines = buildAmortizationSchedule({
    totalCents: 120_000,
    startDate: '2026-01-15',
    months: 12,
    prorateFirstPeriod: true,
  });

  it('spans one extra bucket (partial first + partial last)', () => {
    expect(lines).toHaveLength(13);
    expect(lines[0].period).toBe('2026-01');
    expect(lines[lines.length - 1].period).toBe('2027-01');
  });

  it('amortizes LESS in the partial first period than a full middle month', () => {
    const fullMonth = lines[1].amountCents; // February — a full bucket
    expect(lines[0].amountCents).toBeLessThan(fullMonth);
    expect(lines[0].amountCents).toBeGreaterThan(0);
  });

  it('still sums to exactly the total and ends at a zero balance', () => {
    expect(sum(lines.map((l) => l.amountCents))).toBe(120_000);
    expect(lines[lines.length - 1].remainingCents).toBe(0);
  });

  it('never produces a negative remaining balance', () => {
    for (const l of lines) expect(l.remainingCents).toBeGreaterThanOrEqual(0);
  });

  it('proration is a no-op when the start is the 1st of the month', () => {
    const a = buildAmortizationSchedule({ totalCents: 120_000, startDate: '2026-01-01', months: 12, prorateFirstPeriod: true });
    const b = buildAmortizationSchedule({ totalCents: 120_000, startDate: '2026-01-01', months: 12 });
    expect(a).toEqual(b);
  });
});

describe('buildAmortizationSchedule — endDate derivation + validation', () => {
  it('derives the period count from a coverage end date', () => {
    expect(derivePeriods('2026-01-01', '2026-06-30')).toBe(6);
    const lines = buildAmortizationSchedule({ totalCents: 60_000, startDate: '2026-01-01', endDate: '2026-06-30' });
    expect(lines).toHaveLength(6);
    expect(sum(lines.map((l) => l.amountCents))).toBe(60_000);
  });

  it('rejects a non-positive amount', () => {
    expect(() => buildAmortizationSchedule({ totalCents: 0, startDate: '2026-01-01', months: 12 })).toThrow(PrepaidScheduleError);
    expect(() => buildAmortizationSchedule({ totalCents: -5, startDate: '2026-01-01', months: 12 })).toThrow(PrepaidScheduleError);
  });

  it('rejects a term under one period and a missing term', () => {
    expect(() => buildAmortizationSchedule({ totalCents: 10_000, startDate: '2026-01-01', months: 0 })).toThrow(PrepaidScheduleError);
    expect(() => buildAmortizationSchedule({ totalCents: 10_000, startDate: '2026-01-01' })).toThrow(PrepaidScheduleError);
  });

  it('rejects a malformed start date', () => {
    expect(() => buildAmortizationSchedule({ totalCents: 10_000, startDate: '2026-13-40', months: 3 })).toThrow(PrepaidScheduleError);
  });
});
