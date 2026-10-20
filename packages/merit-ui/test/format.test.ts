import { describe, expect, it } from 'vitest';
import {
  CentsError,
  clockTime,
  compactMoney,
  countdown,
  dayCount,
  dayDate,
  daysBetween,
  groupDigits,
  isoWeek,
  longDate,
  money,
  monthYear,
  parseMoneyToCents,
  pct,
  pts,
  shortDate,
  sumCents,
} from '../src/format';

describe('money (integer cents in, string out)', () => {
  it('formats with grouping and two decimals', () => {
    expect(money(318462)).toBe('3,184.62');
    expect(money(0)).toBe('0.00');
    expect(money(5)).toBe('0.05');
    expect(money(123456789012)).toBe('1,234,567,890.12');
  });

  it('puts negatives in parentheses — never a minus, never red', () => {
    expect(money(-445442)).toBe('(4,454.42)');
    expect(money(-1)).toBe('(0.01)');
  });

  it('rounds half-up to whole units with integer arithmetic', () => {
    expect(money(2140049, { decimals: 0 })).toBe('21,400');
    expect(money(2140050, { decimals: 0 })).toBe('21,401');
    expect(money(-9650000, { decimals: 0 })).toBe('(96,500)');
    expect(money(-49, { decimals: 0 })).toBe('0'); // rounds to zero: no "(0)"
  });

  it('supports delta and minus styles for comparison lines', () => {
    expect(money(61203400, { decimals: 0, sign: 'delta' })).toBe('+612,034');
    expect(money(-9650000, { decimals: 0, sign: 'delta' })).toBe('−96,500');
    expect(money(-120, { sign: 'minus' })).toBe('−1.20');
    expect(money(0, { sign: 'delta' })).toBe('0.00');
  });

  it('dash for zero and optional symbol', () => {
    expect(money(0, { zeroAsDash: true })).toBe('—');
    expect(money(8400, { symbol: '$' })).toBe('$84.00');
    expect(money(-8400, { symbol: '$' })).toBe('($84.00)');
  });

  it('refuses floats — money is integer cents', () => {
    expect(() => money(12.5)).toThrow(CentsError);
    expect(() => money(Number.NaN)).toThrow(CentsError);
    expect(() => sumCents([100, 0.1])).toThrow(CentsError);
    expect(sumCents([100, 250, -50])).toBe(300);
  });

  it('groups digits', () => {
    expect(groupDigits('1')).toBe('1');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits('100000')).toBe('100,000');
    expect(groupDigits('1000000')).toBe('1,000,000');
  });
});

describe('compactMoney', () => {
  it('scales by K/M with one decimal under 10', () => {
    expect(compactMoney(61200)).toBe('612');
    expect(compactMoney(840000)).toBe('8.4K');
    expect(compactMoney(8425000)).toBe('84K');
    expect(compactMoney(61200000)).toBe('612K');
    expect(compactMoney(120000000)).toBe('1.2M');
    expect(compactMoney(1200000000)).toBe('12M');
    expect(compactMoney(100000)).toBe('1K');
    expect(compactMoney(-8425000)).toBe('(84K)');
    expect(compactMoney(8425000, { sign: 'delta', symbol: '$' })).toBe('+$84K');
  });
});

describe('parseMoneyToCents', () => {
  it('parses without floats', () => {
    expect(parseMoneyToCents('3,184.62')).toBe(318462);
    expect(parseMoneyToCents('$84')).toBe(8400);
    expect(parseMoneyToCents('1234.5')).toBe(123450);
    expect(parseMoneyToCents('.07')).toBe(7);
    expect(parseMoneyToCents('(1,240.00)')).toBe(-124000);
    expect(parseMoneyToCents('-12')).toBe(-1200);
    expect(parseMoneyToCents('−3.10')).toBe(-310);
    expect(parseMoneyToCents('0.1') ).toBe(10);
  });
  it('rejects junk and sub-cent precision', () => {
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
    expect(parseMoneyToCents('1.234')).toBeNull();
    expect(parseMoneyToCents('1.2.3')).toBeNull();
    expect(parseMoneyToCents('.')).toBeNull();
  });
  it('round-trips with money()', () => {
    for (const c of [0, 1, 99, 100, 318462, -445442, 123456789]) {
      expect(parseMoneyToCents(money(c))).toBe(c);
    }
  });
});

describe('pct / pts', () => {
  it('formats fractions with parentheses for negatives', () => {
    expect(pct(0.217)).toBe('21.7%');
    expect(pct(-0.027)).toBe('(2.7%)');
    expect(pct(-0.0001)).toBe('0.0%');
    expect(pct(0.05, { decimals: 0 })).toBe('5%');
    expect(pct(0.019, { sign: 'delta' })).toBe('+1.9%');
    expect(pct(Number.NaN)).toBe('—');
  });
  it('formats point deltas with a typographic minus', () => {
    expect(pts(-2.3)).toBe('−2.3 pts');
    expect(pts(1)).toBe('+1.0 pts');
    expect(pts(0)).toBe('0.0 pts');
  });
});

describe('dates (local calendar days, one format per screen)', () => {
  it('reads ISO date-only strings as local days', () => {
    expect(shortDate('2026-10-14')).toBe('Oct 14');
    expect(dayDate('2026-10-19')).toBe('Mon Oct 19');
    expect(longDate('2026-10-19')).toBe('Oct 19, 2026');
    expect(monthYear('2026-09-30')).toBe('Sep 2026');
    expect(monthYear('2026-09-30', true)).toBe('September 2026');
    expect(shortDate('2025-12-31', '2026-01-02')).toBe('Dec 31, 2025');
  });
  it('ISO week numbers', () => {
    expect(isoWeek('2026-10-19')).toBe(43);
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2027-01-01')).toBe(53);
  });
  it('day math and counts', () => {
    expect(daysBetween('2026-10-14', '2026-10-20')).toBe(6);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // across US DST change
    expect(dayCount(1)).toBe('1 day');
    expect(dayCount(6)).toBe('6 days');
  });
  it('clock and countdown', () => {
    expect(clockTime(new Date(2026, 9, 19, 9, 38))).toBe('9:38 AM');
    expect(clockTime(new Date(2026, 9, 19, 0, 5))).toBe('12:05 AM');
    expect(clockTime(new Date(2026, 9, 19, 16, 0))).toBe('4:00 PM');
    expect(countdown(2520)).toBe('42:00');
    expect(countdown(3725)).toBe('1:02:05');
  });
});
