/**
 * Query-parser tests — amount, date, type, number-token, and term extraction.
 * A fixed `now` keeps relative-date parsing deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  dollarStringToCents,
  hasNoConstraint,
  isAmbiguous,
  parseAmounts,
  parseDates,
  parseNumberTokens,
  parseQuery,
  parseTerms,
  parseTypes,
} from './parse';

const NOW = new Date('2026-08-15T00:00:00Z');

describe('dollarStringToCents', () => {
  it('handles thousands, decimals, and k/m suffixes', () => {
    expect(dollarStringToCents('1,500.99')).toBe(150099);
    expect(dollarStringToCents('4200')).toBe(420000);
    expect(dollarStringToCents('1.5', 'k')).toBe(150000);
    expect(dollarStringToCents('2', 'm')).toBe(200000000);
  });
});

describe('parseAmounts', () => {
  it('extracts an explicit dollar amount', () => {
    expect(parseAmounts('$4,200 rent').exact).toEqual([420000]);
  });
  it('does NOT treat a bare integer as money', () => {
    expect(parseAmounts('invoice 1042').exact).toEqual([]);
  });
  it('parses over / above as a minimum', () => {
    const a = parseAmounts('charges over $1000');
    expect(a.min).toBe(100000);
    expect(a.exact).toEqual([]);
  });
  it('parses under / below as a maximum', () => {
    expect(parseAmounts('bills under $50').max).toBe(5000);
  });
  it('parses a between-range', () => {
    const a = parseAmounts('between $100 and $200');
    expect(a.min).toBe(10000);
    expect(a.max).toBe(20000);
  });
  it('parses k suffix as thousands', () => {
    expect(parseAmounts('payments of $1.5k').exact).toEqual([150000]);
  });
});

describe('parseNumberTokens', () => {
  it('captures a bare invoice number', () => {
    expect(parseNumberTokens('invoice 1042')).toContain('1042');
  });
  it('captures an alphanumeric reference', () => {
    expect(parseNumberTokens('find INV-1001')).toContain('INV-1001');
  });
  it('does not capture a 4-digit year', () => {
    expect(parseNumberTokens('entries in 2026')).not.toContain('2026');
  });
});

describe('parseDates', () => {
  it('parses ISO dates', () => {
    expect(parseDates('posted 2026-07-15', NOW)).toEqual({ from: '2026-07-15', to: '2026-07-15' });
  });
  it('parses a month name with year to a full-month range', () => {
    expect(parseDates('July 2026', NOW)).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });
  it('defaults a bare month to the current year', () => {
    expect(parseDates('in july', NOW)).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });
  it('parses "last month" relative to now', () => {
    expect(parseDates('last month', NOW)).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });
  it('parses "this year"', () => {
    expect(parseDates('this year', NOW)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('parses a quarter with year', () => {
    expect(parseDates('Q3 2026', NOW)).toEqual({ from: '2026-07-01', to: '2026-09-30' });
  });
  it('parses a bare year', () => {
    expect(parseDates('all of 2025', NOW)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
  it('returns null when there is no date', () => {
    expect(parseDates('home depot', NOW)).toBeNull();
  });
});

describe('parseTypes', () => {
  it('detects a single type', () => {
    expect(parseTypes('invoices from acme')).toEqual(['invoice']);
  });
  it('detects multiple types', () => {
    expect(parseTypes('bills and vendors')).toEqual(expect.arrayContaining(['bill', 'vendor']));
  });
  it('returns null when no type word is present', () => {
    expect(parseTypes('acme corp')).toBeNull();
  });
});

describe('parseTerms', () => {
  it('drops stopwords, type words, amounts, and dates', () => {
    expect(parseTerms('Home Depot charges over $500 last month')).toEqual(['home', 'depot']);
  });
  it('keeps the entity name after a type word', () => {
    expect(parseTerms('invoices from acme')).toEqual(['acme']);
  });
});

describe('parseQuery', () => {
  it('produces a full structured parse', () => {
    const p = parseQuery('Home Depot charges over $500 last month', NOW);
    expect(p.types).toEqual(['bank_transaction']);
    expect(p.amounts.min).toBe(50000);
    expect(p.dateRange).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(p.terms).toEqual(['home', 'depot']);
  });
});

describe('hasNoConstraint', () => {
  it('is true for an all-stopword query', () => {
    expect(hasNoConstraint(parseQuery('show me all', NOW))).toBe(true);
  });
  it('is false when a term survives', () => {
    expect(hasNoConstraint(parseQuery('acme', NOW))).toBe(false);
  });
});

describe('isAmbiguous', () => {
  it('is true for a structureless multi-word question', () => {
    expect(isAmbiguous(parseQuery('anything about the smith project deal', NOW))).toBe(true);
  });
  it('is false when a date anchors the query', () => {
    expect(isAmbiguous(parseQuery('why did opex jump last month', NOW))).toBe(false);
  });
  it('is false for a one-word query', () => {
    expect(isAmbiguous(parseQuery('acme', NOW))).toBe(false);
  });
});
