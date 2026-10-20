import { describe, it, expect } from 'vitest';
import { CronParseError, isValidCron, latestSlotAtOrBefore, nextSlotAfter, parseCron } from './cron';

const at = (iso: string) => new Date(iso);

describe('parseCron', () => {
  it('parses wildcards, lists, ranges and steps', () => {
    const s = parseCron('*/15 8-10 1,15 * 1-5');
    expect([...s.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toEqual([8, 9, 10]);
    expect([...s.daysOfMonth]).toEqual([1, 15]);
    expect(s.months.size).toBe(12);
    expect([...s.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(s.domRestricted).toBe(true);
    expect(s.dowRestricted).toBe(true);
  });

  it('treats 7 as Sunday', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it.each(['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', 'a * * * *', '*/0 * * * *', '5-1 * * * *', '1,,2 * * * *'])(
    'rejects %j',
    (expr) => {
      expect(() => parseCron(expr)).toThrow(CronParseError);
      expect(isValidCron(expr)).toBe(false);
    },
  );
});

describe('latestSlotAtOrBefore / nextSlotAfter (UTC)', () => {
  it('daily at 08:10', () => {
    const s = parseCron('10 8 * * *');
    expect(latestSlotAtOrBefore(s, at('2026-10-20T08:12:30Z'))?.toISOString()).toBe('2026-10-20T08:10:00.000Z');
    expect(latestSlotAtOrBefore(s, at('2026-10-20T08:10:00Z'))?.toISOString()).toBe('2026-10-20T08:10:00.000Z');
    expect(latestSlotAtOrBefore(s, at('2026-10-20T08:09:59Z'))?.toISOString()).toBe('2026-10-19T08:10:00.000Z');
    expect(nextSlotAfter(s, at('2026-10-20T08:10:00Z'))?.toISOString()).toBe('2026-10-21T08:10:00.000Z');
  });

  it('every 5 minutes', () => {
    const s = parseCron('*/5 * * * *');
    expect(latestSlotAtOrBefore(s, at('2026-10-20T13:07:00Z'))?.toISOString()).toBe('2026-10-20T13:05:00.000Z');
    expect(nextSlotAfter(s, at('2026-10-20T13:55:00Z'))?.toISOString()).toBe('2026-10-20T14:00:00.000Z');
  });

  it('monthly on the 1st crosses month and year boundaries', () => {
    const s = parseCron('0 7 1 * *');
    expect(latestSlotAtOrBefore(s, at('2026-10-20T00:00:00Z'))?.toISOString()).toBe('2026-10-01T07:00:00.000Z');
    expect(latestSlotAtOrBefore(s, at('2027-01-01T06:59:00Z'))?.toISOString()).toBe('2026-12-01T07:00:00.000Z');
    expect(nextSlotAfter(s, at('2026-12-15T00:00:00Z'))?.toISOString()).toBe('2027-01-01T07:00:00.000Z');
  });

  it('weekdays only (dow restricted)', () => {
    const s = parseCron('0 13 * * 1-5');
    // 2026-10-24 is a Saturday → latest is Friday 10-23.
    expect(latestSlotAtOrBefore(s, at('2026-10-24T20:00:00Z'))?.toISOString()).toBe('2026-10-23T13:00:00.000Z');
    expect(nextSlotAfter(s, at('2026-10-24T20:00:00Z'))?.toISOString()).toBe('2026-10-26T13:00:00.000Z');
  });

  it('dom AND dow restricted match either (standard cron)', () => {
    const s = parseCron('0 0 1 * 1'); // the 1st OR any Monday
    expect(latestSlotAtOrBefore(s, at('2026-10-20T12:00:00Z'))?.toISOString()).toBe('2026-10-19T00:00:00.000Z'); // Monday
  });

  it('returns null for a spec that never fires', () => {
    const s = parseCron('0 0 30 2 *');
    expect(latestSlotAtOrBefore(s, at('2026-10-20T00:00:00Z'))).toBeNull();
    expect(nextSlotAfter(s, at('2026-10-20T00:00:00Z'))).toBeNull();
  });
});
