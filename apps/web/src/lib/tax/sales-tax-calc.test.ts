import { describe, it, expect } from 'vitest';
import {
  resolveRate,
  rateApplies,
  isEffectiveOn,
  specificity,
  computeTaxCents,
  computeInvoiceTax,
  type SalesTaxRate,
} from './sales-tax-calc';

const rate = (over: Partial<SalesTaxRate>): SalesTaxRate => ({
  id: over.id ?? 'r',
  state: over.state ?? 'IA',
  county: over.county ?? null,
  city: over.city ?? null,
  jurisdictionLabel: over.jurisdictionLabel ?? 'label',
  combinedRatePct: over.combinedRatePct ?? 7,
  effectiveDate: over.effectiveDate ?? '2020-01-01',
  endDate: over.endDate ?? null,
  ...over,
});

describe('isEffectiveOn', () => {
  it('includes both bounds inclusively', () => {
    const r = rate({ effectiveDate: '2026-01-01', endDate: '2026-12-31' });
    expect(isEffectiveOn(r, '2026-01-01')).toBe(true);
    expect(isEffectiveOn(r, '2026-12-31')).toBe(true);
    expect(isEffectiveOn(r, '2026-06-15')).toBe(true);
  });
  it('excludes not-yet-effective and expired', () => {
    const r = rate({ effectiveDate: '2026-01-01', endDate: '2026-12-31' });
    expect(isEffectiveOn(r, '2025-12-31')).toBe(false);
    expect(isEffectiveOn(r, '2027-01-01')).toBe(false);
  });
  it('open-ended end date never expires', () => {
    const r = rate({ effectiveDate: '2020-01-01', endDate: null });
    expect(isEffectiveOn(r, '2099-01-01')).toBe(true);
  });
});

describe('rateApplies', () => {
  it('state-wide row (null city/county) matches any city in that state', () => {
    const r = rate({ state: 'IA' });
    expect(rateApplies(r, { state: 'IA', city: 'Anywhere', onDate: '2026-06-01' })).toBe(true);
  });
  it('normalizes state names on both sides', () => {
    const r = rate({ state: 'Iowa' });
    expect(rateApplies(r, { state: 'IA', onDate: '2026-06-01' })).toBe(true);
  });
  it('a city-specific row only matches that city (case-insensitive)', () => {
    const r = rate({ state: 'IA', city: 'Des Moines' });
    expect(rateApplies(r, { state: 'IA', city: 'des moines', onDate: '2026-06-01' })).toBe(true);
    expect(rateApplies(r, { state: 'IA', city: 'Ames', onDate: '2026-06-01' })).toBe(false);
    expect(rateApplies(r, { state: 'IA', city: null, onDate: '2026-06-01' })).toBe(false);
  });
  it('no destination state → never applies', () => {
    const r = rate({ state: 'IA' });
    expect(rateApplies(r, { state: null, onDate: '2026-06-01' })).toBe(false);
  });
});

describe('specificity', () => {
  it('city beats county beats state', () => {
    expect(specificity(rate({ city: 'X', county: 'Y' }))).toBe(3);
    expect(specificity(rate({ city: 'X' }))).toBe(2);
    expect(specificity(rate({ county: 'Y' }))).toBe(1);
    expect(specificity(rate({}))).toBe(0);
  });
});

describe('resolveRate — most-specific-wins, effective-dated', () => {
  it('picks the city row over the state row', () => {
    const rates = [
      rate({ id: 'state', state: 'IA', combinedRatePct: 6 }),
      rate({ id: 'city', state: 'IA', city: 'Des Moines', combinedRatePct: 7 }),
    ];
    const r = resolveRate(rates, { state: 'IA', city: 'Des Moines', onDate: '2026-06-01' });
    expect(r?.id).toBe('city');
    expect(r?.combinedRatePct).toBe(7);
  });
  it('falls back to the state row when the city has no specific row', () => {
    const rates = [
      rate({ id: 'state', state: 'IA', combinedRatePct: 6 }),
      rate({ id: 'city', state: 'IA', city: 'Des Moines', combinedRatePct: 7 }),
    ];
    const r = resolveRate(rates, { state: 'IA', city: 'Cedar Rapids', onDate: '2026-06-01' });
    expect(r?.id).toBe('state');
  });
  it('excludes expired rows and picks the currently-effective one', () => {
    const rates = [
      rate({ id: 'old', state: 'IA', combinedRatePct: 6, effectiveDate: '2020-01-01', endDate: '2025-12-31' }),
      rate({ id: 'new', state: 'IA', combinedRatePct: 7, effectiveDate: '2026-01-01', endDate: null }),
    ];
    const r = resolveRate(rates, { state: 'IA', onDate: '2026-06-01' });
    expect(r?.id).toBe('new');
  });
  it('returns null when nothing applies (degrade-safe → no tax)', () => {
    const rates = [rate({ state: 'IA' })];
    expect(resolveRate(rates, { state: 'CA', onDate: '2026-06-01' })).toBeNull();
    expect(resolveRate([], { state: 'IA', onDate: '2026-06-01' })).toBeNull();
  });
  it('same specificity ties break to the latest effective date', () => {
    const rates = [
      rate({ id: 'a', state: 'IA', combinedRatePct: 6, effectiveDate: '2026-01-01' }),
      rate({ id: 'b', state: 'IA', combinedRatePct: 7, effectiveDate: '2026-04-01' }),
    ];
    const r = resolveRate(rates, { state: 'IA', onDate: '2026-06-01' });
    expect(r?.id).toBe('b');
  });
});

describe('computeTaxCents', () => {
  it('rounds once, non-negative', () => {
    expect(computeTaxCents(100_00, 7)).toBe(7_00); // $100 @ 7% = $7.00
    expect(computeTaxCents(12_345, 7)).toBe(864); // 12345 * 0.07 = 864.15 → 864
    expect(computeTaxCents(100_00, 0)).toBe(0);
    expect(computeTaxCents(-500, 7)).toBe(0);
    expect(computeTaxCents(100_00, null)).toBe(0);
    expect(computeTaxCents(100_00, NaN)).toBe(0);
  });
});

describe('computeInvoiceTax', () => {
  it('computes invoice-level tax on the taxable subtotal (single round)', () => {
    const res = computeInvoiceTax({ lineAmountsCents: [100_00, 50_00], ratePct: 7 });
    expect(res.taxableSubtotalCents).toBe(150_00);
    expect(res.taxCents).toBe(10_50); // $150 @ 7% = $10.50
    expect(res.ratePct).toBe(7);
    expect(res.exempt).toBe(false);
  });
  it('returns per-line tax breakdown', () => {
    const res = computeInvoiceTax({ lineAmountsCents: [3_33, 3_33, 3_34], ratePct: 7 });
    expect(res.perLineCents).toEqual([23, 23, 23]);
    // invoice-level rounds the sum once (authoritative accrual)
    expect(res.taxCents).toBe(computeTaxCents(10_00, 7));
  });
  it('exempt customer → zero tax and zero taxable base (no regression)', () => {
    const res = computeInvoiceTax({ lineAmountsCents: [100_00], ratePct: 7, exempt: true });
    expect(res.taxCents).toBe(0);
    expect(res.taxableSubtotalCents).toBe(0);
    expect(res.exempt).toBe(true);
  });
  it('no rate → zero tax, taxable base preserved (degrade-safe)', () => {
    const res = computeInvoiceTax({ lineAmountsCents: [100_00], ratePct: null });
    expect(res.taxCents).toBe(0);
    expect(res.taxableSubtotalCents).toBe(100_00);
    expect(res.perLineCents).toEqual([0]);
  });
});
