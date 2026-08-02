import { describe, it, expect } from 'vitest';
import { normalizePrepaidExtraction, dollarsToCentsOrNull, monthsBetween } from './extract';

describe('dollarsToCentsOrNull', () => {
  it('converts dollars to integer cents, tolerating $ and commas', () => {
    expect(dollarsToCentsOrNull('$12,000.00')).toBe(1_200_000);
    expect(dollarsToCentsOrNull(1200)).toBe(120_000);
  });
  it('returns null for missing / non-positive amounts', () => {
    expect(dollarsToCentsOrNull(null)).toBeNull();
    expect(dollarsToCentsOrNull('')).toBeNull();
    expect(dollarsToCentsOrNull(0)).toBeNull();
    expect(dollarsToCentsOrNull(-5)).toBeNull();
  });
});

describe('monthsBetween', () => {
  it('counts whole months of coverage inclusive of a full end', () => {
    expect(monthsBetween('2026-01-01', '2026-12-31')).toBe(12);
    expect(monthsBetween('2026-01-01', '2026-06-30')).toBe(6);
  });
  it('returns null for missing or inverted dates', () => {
    expect(monthsBetween(null, '2026-06-30')).toBeNull();
    expect(monthsBetween('2026-06-30', '2026-01-01')).toBeNull();
  });
});

describe('normalizePrepaidExtraction', () => {
  it('maps the model JSON into a validated proposal (dollars → cents)', () => {
    const p = normalizePrepaidExtraction({
      description: 'Annual liability insurance',
      vendor_name: 'Acme Insurance',
      total_amount: '12000',
      term_months: 12,
      start_date: '2026-01-01',
      expense_category: 'Insurance expense',
      confidence: { total: 0.9, term: 0.9, dates: 0.8, vendor: 0.7 },
    });
    expect(p.total_cents).toBe(1_200_000);
    expect(p.term_months).toBe(12);
    expect(p.expense_hint).toBe('Insurance expense');
    expect(p.lowConfidenceFields).not.toContain('total');
  });

  it('derives the term from start+end when the model omits a month count', () => {
    const p = normalizePrepaidExtraction({ total_amount: 6000, start_date: '2026-01-01', end_date: '2026-06-30' });
    expect(p.term_months).toBe(6);
  });

  it('leaves undeterminable fields blank and flags them (never guesses)', () => {
    const p = normalizePrepaidExtraction({ description: 'Something', document_note: 'not clearly a prepaid' });
    expect(p.total_cents).toBeNull();
    expect(p.term_months).toBeNull();
    expect(p.lowConfidenceFields).toEqual(expect.arrayContaining(['total', 'term', 'start_date']));
  });

  it('never throws on a malformed shape', () => {
    expect(() => normalizePrepaidExtraction(null)).not.toThrow();
    expect(() => normalizePrepaidExtraction('garbage')).not.toThrow();
  });
});
