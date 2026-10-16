import { describe, it, expect } from 'vitest';
import { deriveOrgSlug, isValidTimezone, splitFullName, lastDayOfPreviousMonth } from './org-setup';

describe('deriveOrgSlug', () => {
  it('lowercases and dashes a company name', () => {
    expect(deriveOrgSlug('Heritage Interiors, LLC')).toBe('heritage-interiors-llc');
  });
  it('strips accents and trims dashes', () => {
    expect(deriveOrgSlug('  Café Ñandú!! ')).toBe('cafe-nandu');
  });
  it('appends a suffix and stays within 50 chars', () => {
    const s = deriveOrgSlug('a'.repeat(80), 'x9k2');
    expect(s.endsWith('-x9k2')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(50);
  });
  it('never returns an empty or 1-char slug', () => {
    expect(deriveOrgSlug('!!!')).toBe('org');
    expect(deriveOrgSlug('Z')).toBe('z-org');
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA zones and rejects junk', () => {
    expect(isValidTimezone('America/Chicago')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('splitFullName', () => {
  it('splits first and the rest', () => {
    expect(splitFullName('Jane Q. Doe')).toEqual({ firstName: 'Jane', lastName: 'Q. Doe' });
    expect(splitFullName('Cher')).toEqual({ firstName: 'Cher', lastName: '' });
    expect(splitFullName('   ')).toEqual({ firstName: '', lastName: '' });
    expect(splitFullName(undefined)).toEqual({ firstName: '', lastName: '' });
  });
});

describe('lastDayOfPreviousMonth', () => {
  it('handles month and year boundaries and leap years', () => {
    expect(lastDayOfPreviousMonth(new Date(2026, 9, 16))).toBe('2026-09-30');
    expect(lastDayOfPreviousMonth(new Date(2026, 0, 5))).toBe('2025-12-31');
    expect(lastDayOfPreviousMonth(new Date(2028, 2, 1))).toBe('2028-02-29');
  });
});
