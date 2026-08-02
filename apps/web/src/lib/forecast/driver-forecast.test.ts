/**
 * Driver-based cash forecast — projection assertions.
 *
 * Pure engine: given opening cash, receivables, payables, recurring obligations
 * and optional what-if adjustments, it rolls a weekly opening → collections −
 * disbursements → closing balance. These tests pin bucketing (past-due → week 0,
 * DSO/payment lag, recurring expansion, beyond-horizon), the running balance,
 * the low-water mark and the shortfall flag.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDriverForecast,
  DEFAULT_HORIZON_WEEKS,
  type DriverForecastInput,
} from './driver-forecast';

// Fixed anchor: Wednesday 2026-08-05 → Monday 2026-08-03 (week 0 start).
const TODAY = new Date(Date.UTC(2026, 7, 5));

const base = (over: Partial<DriverForecastInput>): DriverForecastInput => ({
  openingCashCents: 0,
  receivables: [],
  payables: [],
  today: TODAY,
  ...over,
});

describe('buildDriverForecast', () => {
  it('produces the horizon length of weeks anchored on Monday', () => {
    const r = buildDriverForecast(base({ openingCashCents: 1_000 }));
    expect(r.weeks.length).toBe(DEFAULT_HORIZON_WEEKS);
    expect(r.anchorDate).toBe('2026-08-03');
    expect(r.weeks[0].startDate).toBe('2026-08-03');
    expect(r.endingCashCents).toBe(1_000);
  });

  it('buckets a receivable due this week into week 0 as a collection', () => {
    const r = buildDriverForecast(base({
      openingCashCents: 0,
      receivables: [{ id: 'i1', label: 'INV-1', party: 'Acme', amountCents: 5_000, dueDate: '2026-08-05' }],
    }));
    expect(r.weeks[0].collectionsCents).toBe(5_000);
    expect(r.weeks[0].closingCents).toBe(5_000);
    expect(r.totalCollectionsCents).toBe(5_000);
    expect(r.weeks[0].byCategory.AR).toBe(5_000);
  });

  it('shifts a collection forward by the collection lag (DSO drift)', () => {
    // Due 2026-08-05 + 14 days lag → 2026-08-19, which is week 2.
    const r = buildDriverForecast(base({
      receivables: [{ id: 'i1', label: 'INV-1', party: 'Acme', amountCents: 3_000, dueDate: '2026-08-05' }],
      collectionLagDays: 14,
    }));
    expect(r.weeks[0].collectionsCents).toBe(0);
    expect(r.weeks[2].collectionsCents).toBe(3_000);
  });

  it('pulls a past-due payable into week 0', () => {
    const r = buildDriverForecast(base({
      openingCashCents: 10_000,
      payables: [{ id: 'b1', label: 'BILL-1', party: 'Vendor', amountCents: 2_000, dueDate: '2026-07-01' }],
    }));
    expect(r.weeks[0].disbursementsCents).toBe(2_000);
    expect(r.weeks[0].closingCents).toBe(8_000);
  });

  it('expands a recurring outflow across the horizon by cadence', () => {
    // Weekly payroll of 1,000 out starting week 0 → 13 occurrences.
    const r = buildDriverForecast(base({
      openingCashCents: 50_000,
      recurring: [{ id: 'pr', label: 'Payroll', amountCents: -1_000, cadence: 'WEEKLY', nextDate: '2026-08-03', category: 'PAYROLL' }],
    }));
    expect(r.totalDisbursementsCents).toBe(13_000);
    expect(r.weeks[0].disbursementsCents).toBe(1_000);
    expect(r.weeks[12].disbursementsCents).toBe(1_000);
    expect(r.endingCashCents).toBe(50_000 - 13_000);
    expect(r.weeks[0].byCategory.PAYROLL).toBe(-1_000);
  });

  it('rolls the running balance and finds the low-water mark', () => {
    const r = buildDriverForecast(base({
      openingCashCents: 1_000,
      payables: [
        { id: 'b1', label: 'B1', party: 'V', amountCents: 3_000, dueDate: '2026-08-05' }, // week 0
        { id: 'b2', label: 'B2', party: 'V', amountCents: 500, dueDate: '2026-08-19' }, // week 2
      ],
      receivables: [
        { id: 'i1', label: 'I1', party: 'C', amountCents: 5_000, dueDate: '2026-08-12' }, // week 1
      ],
    }));
    // Wk0: 1000 - 3000 = -2000 (low). Wk1: +5000 = 3000. Wk2: -500 = 2500.
    expect(r.weeks[0].closingCents).toBe(-2_000);
    expect(r.lowWaterMarkCents).toBe(-2_000);
    expect(r.lowWaterWeekIndex).toBe(0);
    expect(r.endingCashCents).toBe(2_500);
  });

  it('flags a shortfall when a week ends below the minimum buffer', () => {
    const r = buildDriverForecast(base({
      openingCashCents: 1_000,
      minimumBufferCents: 500,
      payables: [{ id: 'b1', label: 'B1', party: 'V', amountCents: 800, dueDate: '2026-08-05' }],
    }));
    // Wk0 closing 200 < 500 buffer → shortfall.
    expect(r.hasShortfall).toBe(true);
    expect(r.firstShortfallWeekIndex).toBe(0);
    expect(r.weeks[0].belowBuffer).toBe(true);
  });

  it('excludes items beyond the horizon and reports them separately', () => {
    const r = buildDriverForecast(base({
      receivables: [{ id: 'i1', label: 'I1', party: 'C', amountCents: 9_000, dueDate: '2027-01-01' }],
    }));
    expect(r.totalCollectionsCents).toBe(0);
    expect(r.beyondHorizonCollectionsCents).toBe(9_000);
  });

  it('applies a manual what-if adjustment at the given week', () => {
    const r = buildDriverForecast(base({
      openingCashCents: 10_000,
      adjustments: [{ id: 'a1', label: 'Tax refund', weekIndex: 3, amountCents: 4_000, category: 'OTHER' }],
    }));
    expect(r.weeks[3].collectionsCents).toBe(4_000);
    expect(r.endingCashCents).toBe(14_000);
  });
});
