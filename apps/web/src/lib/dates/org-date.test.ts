import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ORG_TIMEZONE,
  addDaysIso,
  daysBetweenIso,
  fiscalYearStartFor,
  formatIsoDateLong,
  monthBoundsIso,
  normalizeTimeZone,
  todayInTimeZone,
} from './org-date';

describe('todayInTimeZone — org calendar date, never the UTC date (audit L14)', () => {
  // 8:30pm Central on Oct 19 2026 is already Oct 20 in UTC.
  const usEvening = new Date('2026-10-20T01:30:00Z');

  it('a US-evening instant is still "today" in America/Chicago', () => {
    expect(usEvening.toISOString().slice(0, 10)).toBe('2026-10-20'); // the old (wrong) default
    expect(todayInTimeZone('America/Chicago', usEvening)).toBe('2026-10-19');
  });

  it('respects other zones', () => {
    expect(todayInTimeZone('America/Los_Angeles', usEvening)).toBe('2026-10-19');
    expect(todayInTimeZone('UTC', usEvening)).toBe('2026-10-20');
    expect(todayInTimeZone('Asia/Tokyo', usEvening)).toBe('2026-10-20');
  });

  it('falls back to the column default for a missing / invalid zone', () => {
    expect(normalizeTimeZone(null)).toBe(DEFAULT_ORG_TIMEZONE);
    expect(normalizeTimeZone('Not/AZone')).toBe(DEFAULT_ORG_TIMEZONE);
    expect(todayInTimeZone(undefined, usEvening)).toBe('2026-10-19');
  });

  it('crosses month and year boundaries correctly', () => {
    expect(todayInTimeZone('America/Chicago', new Date('2027-01-01T03:00:00Z'))).toBe('2026-12-31');
  });
});

describe('ISO date math (timezone-free)', () => {
  it('days between and add days', () => {
    expect(daysBetweenIso('2026-10-20', '2026-07-15')).toBe(97);
    expect(daysBetweenIso('2026-07-15', '2026-10-20')).toBe(-97);
    expect(addDaysIso('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('month bounds', () => {
    expect(monthBoundsIso('2026-10-19')).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(monthBoundsIso('2028-02-10')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });

  it('fiscal year start for calendar and July fiscal years', () => {
    expect(fiscalYearStartFor('2026-10-19', 1)).toBe('2026-01-01');
    expect(fiscalYearStartFor('2026-10-19', 7)).toBe('2026-07-01');
    expect(fiscalYearStartFor('2026-05-11', 7)).toBe('2025-07-01');
    expect(fiscalYearStartFor('2026-07-01', 7)).toBe('2026-07-01');
    expect(fiscalYearStartFor('2026-03-01', null)).toBe('2026-01-01');
  });

  it('long date label is the calendar date itself (deterministic server/client)', () => {
    expect(formatIsoDateLong('2026-10-19')).toBe('October 19, 2026');
  });
});
