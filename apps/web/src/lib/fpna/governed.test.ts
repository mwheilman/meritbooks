import { describe, expect, it } from 'vitest';
import { governedClosedThrough, governedNetIncomeSeries, lastShownMonth, MAX_FPNA_WINDOW_MONTHS, withholdActualBuckets } from './governed';

const shown = [true, true, true, false, false, false, false, false, false, false, false, false];

describe('fpna governance helpers', () => {
  it('zeroes withheld months only', () => {
    const accts = [{ actual: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }];
    withholdActualBuckets(accts, shown);
    expect(accts[0].actual).toEqual([1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('caps the reforecast cut-off at the latest shown month for non-finance', () => {
    expect(lastShownMonth(shown)).toBe(3);
    expect(governedClosedThrough(9, shown, false)).toBe(3);
    expect(governedClosedThrough(2, shown, false)).toBe(2);
    expect(governedClosedThrough(9, shown, true)).toBe(9);
    expect(governedClosedThrough(9, new Array(12).fill(false), false)).toBe(0);
  });
  it('feeds the burn average shown, elapsed months only', () => {
    expect(governedNetIncomeSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 9, shown)).toEqual([1, 2, 3]);
  });
  it('caps the window at five years', () => {
    expect(MAX_FPNA_WINDOW_MONTHS).toBe(60);
  });
});
