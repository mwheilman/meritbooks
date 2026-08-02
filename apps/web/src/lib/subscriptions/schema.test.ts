import { describe, it, expect } from 'vitest';
import { draftCancellation } from './schema';
import { normalizeAgreementExtraction, mapCadence, dollarsToCentsOrNull } from './parse-agreement';

describe('draftCancellation', () => {
  it('drafts a notice-aware cancellation request that never sends', () => {
    const draft = draftCancellation({
      vendor_name: 'Acme SaaS',
      product: 'Pro plan',
      amount_cents: 4999,
      billing_cadence: 'MONTHLY',
      next_renewal_date: '2026-10-01',
      notice_period_days: 30,
      cancellation_method: 'account portal',
    });
    expect(draft).toContain('Acme SaaS');
    expect(draft).toContain('Pro plan');
    expect(draft).toContain("30 days' notice");
    expect(draft).toContain('2026-10-01');
    expect(draft).toContain('account portal');
  });

  it('omits notice/renewal lines when unknown', () => {
    const draft = draftCancellation({ vendor_name: 'Acme' });
    expect(draft).toContain('Acme');
    expect(draft).not.toContain('notice');
  });
});

describe('parse-agreement normalizers', () => {
  it('maps cadence synonyms', () => {
    expect(mapCadence('monthly')).toBe('MONTHLY');
    expect(mapCadence('per year')).toBe('ANNUAL');
    expect(mapCadence('quarter')).toBe('QUARTERLY');
    expect(mapCadence('weekly')).toBe('OTHER');
  });

  it('converts dollars to cents', () => {
    expect(dollarsToCentsOrNull(49.99)).toBe(4999);
    expect(dollarsToCentsOrNull('$1,200')).toBe(120000);
    expect(dollarsToCentsOrNull(null)).toBeNull();
  });

  it('normalizes an extraction and marks low-confidence/blank fields', () => {
    const terms = normalizeAgreementExtraction({
      vendor_name: 'Acme',
      amount: 100,
      billing_cadence: 'annual',
      next_renewal_date: '2026-12-31',
      auto_renews: true,
      notice_period_days: 60,
      confidence: { vendor_name: 0.95, amount: 0.4 },
    });
    expect(terms.vendor_name).toBe('Acme');
    expect(terms.amount_cents).toBe(10000);
    expect(terms.billing_cadence).toBe('ANNUAL');
    expect(terms.auto_renews).toBe(true);
    expect(terms.notice_period_days).toBe(60);
    expect(terms.lowConfidenceFields).toContain('amount_cents'); // conf 0.4 < 0.6
    expect(terms.lowConfidenceFields).toContain('product'); // blank
  });
});
