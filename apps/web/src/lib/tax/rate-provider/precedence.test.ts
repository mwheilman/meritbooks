import { describe, it, expect } from 'vitest';
import {
  resolveBestRate,
  recordApplies,
  recordEffectiveOn,
  recordSpecificity,
  type TaxRateRecord,
  type MatchAddress,
} from './precedence';
import { computeTaxCents } from '../sales-tax-calc';

const rec = (over: Partial<TaxRateRecord>): TaxRateRecord => ({
  id: over.id ?? 'r',
  country: over.country ?? null,
  state: over.state ?? 'IA',
  county: over.county ?? null,
  city: over.city ?? null,
  postalCode: over.postalCode ?? null,
  category: over.category ?? null,
  jurisdictionLabel: over.jurisdictionLabel ?? 'label',
  ratePct: over.ratePct ?? 7,
  effectiveDate: over.effectiveDate ?? '2020-01-01',
  endDate: over.endDate ?? null,
  ...over,
});

const iaMidDataDate = '2026-06-15';

describe('most-specific-wins precedence (postal > city > county > state)', () => {
  it('a matching postal row beats city, county, and bare-state rows', () => {
    const stateRow = rec({ id: 'state', ratePct: 6, jurisdictionLabel: 'IA' });
    const countyRow = rec({ id: 'county', county: 'Polk', ratePct: 6.5, jurisdictionLabel: 'Polk County' });
    const cityRow = rec({ id: 'city', county: 'Polk', city: 'Des Moines', ratePct: 7, jurisdictionLabel: 'Des Moines' });
    const postalRow = rec({ id: 'postal', postalCode: '50309', ratePct: 7.25, jurisdictionLabel: 'DSM 50309' });
    const addr: MatchAddress = { state: 'IA', county: 'Polk', city: 'Des Moines', postalCode: '50309' };

    const best = resolveBestRate([stateRow, countyRow, cityRow, postalRow], addr, iaMidDataDate);
    expect(best?.id).toBe('postal');
    expect(recordSpecificity(postalRow)).toBeGreaterThan(recordSpecificity(cityRow));
    expect(recordSpecificity(cityRow)).toBeGreaterThan(recordSpecificity(countyRow));
    expect(recordSpecificity(countyRow)).toBeGreaterThan(recordSpecificity(stateRow));
  });

  it('falls to the city row when no postal row matches the destination', () => {
    const cityRow = rec({ id: 'city', county: 'Polk', city: 'Des Moines', ratePct: 7 });
    const postalRow = rec({ id: 'postal', postalCode: '99999', ratePct: 9 }); // different zip
    const addr: MatchAddress = { state: 'IA', county: 'Polk', city: 'Des Moines', postalCode: '50309' };
    const best = resolveBestRate([cityRow, postalRow], addr, iaMidDataDate);
    expect(best?.id).toBe('city');
  });
});

describe('effective-date windowing', () => {
  it('excludes not-yet-effective and expired rows; picks the row in effect', () => {
    const expired = rec({ id: 'old', ratePct: 6, effectiveDate: '2020-01-01', endDate: '2025-12-31' });
    const current = rec({ id: 'new', ratePct: 7, effectiveDate: '2026-01-01', endDate: null });
    const future = rec({ id: 'future', ratePct: 8, effectiveDate: '2027-01-01', endDate: null });
    const addr: MatchAddress = { state: 'IA' };

    expect(recordEffectiveOn(expired, iaMidDataDate)).toBe(false);
    expect(recordEffectiveOn(future, iaMidDataDate)).toBe(false);
    const best = resolveBestRate([expired, current, future], addr, iaMidDataDate);
    expect(best?.id).toBe('new');
    expect(best?.ratePct).toBe(7);
  });

  it('same-specificity tie breaks to the LATEST effective date', () => {
    const a = rec({ id: 'a', ratePct: 6.9, effectiveDate: '2024-01-01' });
    const b = rec({ id: 'b', ratePct: 7.1, effectiveDate: '2026-01-01' });
    const best = resolveBestRate([a, b], { state: 'IA' }, iaMidDataDate);
    expect(best?.id).toBe('b');
  });
});

describe('applicability guards', () => {
  it('a category-specific row only applies to that category (else wildcard row wins)', () => {
    const generic = rec({ id: 'generic', ratePct: 7, category: null });
    const foodRow = rec({ id: 'food', ratePct: 1, category: 'FOOD' });
    const addr: MatchAddress = { state: 'IA' };
    // No category requested → the category-specific row must NOT apply.
    expect(recordApplies(foodRow, addr, iaMidDataDate, null)).toBe(false);
    expect(resolveBestRate([generic, foodRow], addr, iaMidDataDate, null)?.id).toBe('generic');
    // FOOD requested → the category row applies and, being more specific, wins.
    expect(recordApplies(foodRow, addr, iaMidDataDate, 'food')).toBe(true);
    expect(resolveBestRate([generic, foodRow], addr, iaMidDataDate, 'food')?.id).toBe('food');
  });

  it('a wrong-state destination resolves to null (no rate → caller charges no tax)', () => {
    const iaRow = rec({ id: 'ia', state: 'IA', ratePct: 7 });
    expect(resolveBestRate([iaRow], { state: 'MN' }, iaMidDataDate)).toBeNull();
    expect(resolveBestRate([iaRow], { state: null }, iaMidDataDate)).toBeNull();
    expect(resolveBestRate([], { state: 'IA' }, iaMidDataDate)).toBeNull();
  });
});

describe('resolved percent applies correctly to a cents base', () => {
  it('7.0% of $1,000.00 (100000c) = $70.00 (7000c)', () => {
    const best = resolveBestRate([rec({ ratePct: 7 })], { state: 'IA' }, iaMidDataDate);
    expect(best).not.toBeNull();
    expect(computeTaxCents(100000, best!.ratePct)).toBe(7000);
  });
});
