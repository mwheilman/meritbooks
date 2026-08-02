import { describe, it, expect } from 'vitest';
import {
  mapCoverageType,
  mapPremiumFrequency,
  dollarsToCentsOrNull,
  toIsoDateOrNull,
  normalizePolicyExtraction,
} from './parse-policy';

describe('mapCoverageType', () => {
  it('passes through the exact enum values', () => {
    expect(mapCoverageType('GL')).toBe('GL');
    expect(mapCoverageType('cyber')).toBe('CYBER');
  });
  it('maps free-form coverage language onto the register enum', () => {
    expect(mapCoverageType('Commercial General Liability')).toBe('GL');
    expect(mapCoverageType('Workers Compensation & Employers Liability')).toBe('WC');
    expect(mapCoverageType('Commercial Property — Building & Contents')).toBe('PROPERTY');
    expect(mapCoverageType('Business Auto / Fleet')).toBe('AUTO');
    expect(mapCoverageType('Cyber & Data Breach')).toBe('CYBER');
    expect(mapCoverageType('Commercial Umbrella / Excess Liability')).toBe('UMBRELLA');
    expect(mapCoverageType('Professional Liability (E&O)')).toBe('PROFESSIONAL');
  });
  it('orders WC and umbrella ahead of the broad liability catch', () => {
    expect(mapCoverageType('Employers Liability')).toBe('WC');
    expect(mapCoverageType('Excess Liability')).toBe('UMBRELLA');
  });
  it('falls back to OTHER for unknown / non-string input', () => {
    expect(mapCoverageType('Kidnap & Ransom')).toBe('OTHER');
    expect(mapCoverageType('')).toBe('OTHER');
    expect(mapCoverageType(null)).toBe('OTHER');
    expect(mapCoverageType(42)).toBe('OTHER');
  });
});

describe('mapPremiumFrequency', () => {
  it('maps cadences, defaulting unknown to ANNUAL', () => {
    expect(mapPremiumFrequency('monthly')).toBe('MONTHLY');
    expect(mapPremiumFrequency('Quarterly')).toBe('QUARTERLY');
    expect(mapPremiumFrequency('semi-annual')).toBe('SEMIANNUAL');
    expect(mapPremiumFrequency('per annum')).toBe('ANNUAL');
    expect(mapPremiumFrequency('one-time')).toBe('ONE_TIME');
    expect(mapPremiumFrequency('whatever')).toBe('ANNUAL');
    expect(mapPremiumFrequency(null)).toBe('ANNUAL');
  });
});

describe('dollarsToCentsOrNull', () => {
  it('converts dollars to integer cents, tolerating $ and commas', () => {
    expect(dollarsToCentsOrNull('$1,000,000')).toBe(100_000_000);
    expect(dollarsToCentsOrNull('1,000,000.00')).toBe(100_000_000);
    expect(dollarsToCentsOrNull(2500)).toBe(250_000);
  });
  it('handles M / K shorthand', () => {
    expect(dollarsToCentsOrNull('$1M')).toBe(100_000_000);
    expect(dollarsToCentsOrNull('2.5M')).toBe(250_000_000);
    expect(dollarsToCentsOrNull('$500K')).toBe(50_000_000);
  });
  it('returns null for missing / non-positive / unparseable values', () => {
    expect(dollarsToCentsOrNull(null)).toBeNull();
    expect(dollarsToCentsOrNull('')).toBeNull();
    expect(dollarsToCentsOrNull(0)).toBeNull();
    expect(dollarsToCentsOrNull(-5)).toBeNull();
    expect(dollarsToCentsOrNull('n/a')).toBeNull();
  });
});

describe('toIsoDateOrNull', () => {
  it('accepts valid ISO dates and rejects impossible ones', () => {
    expect(toIsoDateOrNull('2026-03-15')).toBe('2026-03-15');
    expect(toIsoDateOrNull('2026-02-30')).toBeNull();
    expect(toIsoDateOrNull('03/15/2026')).toBeNull();
    expect(toIsoDateOrNull(null)).toBeNull();
  });
});

describe('normalizePolicyExtraction', () => {
  it('maps model JSON into validated proposals (dollars → cents, enums normalized)', () => {
    const [p] = normalizePolicyExtraction({
      policies: [
        {
          carrier: 'The Hartford',
          policy_number: 'GL-99123',
          coverage_type: 'Commercial General Liability',
          coverage_limit: '2,000,000',
          deductible: 5000,
          premium: '$18,000',
          premium_frequency: 'annual',
          effective_date: '2026-01-01',
          expiration_date: '2026-12-31',
          broker: 'Marsh',
          confidence: { carrier: 0.95, coverage_type: 0.9, coverage_limit: 0.9, premium: 0.85, dates: 0.9 },
        },
      ],
    });
    expect(p.carrier).toBe('The Hartford');
    expect(p.coverage_type).toBe('GL');
    expect(p.coverage_limit_cents).toBe(200_000_000);
    expect(p.deductible_cents).toBe(500_000);
    expect(p.premium_cents).toBe(1_800_000);
    expect(p.premium_frequency).toBe('ANNUAL');
    expect(p.expiration_date).toBe('2026-12-31');
    expect(p.lowConfidenceFields).toHaveLength(0);
  });

  it('accepts a single `policy` object (declarations page) as well as a list', () => {
    const out = normalizePolicyExtraction({ policy: { carrier: 'Chubb', coverage_type: 'CYBER' } });
    expect(out).toHaveLength(1);
    expect(out[0].coverage_type).toBe('CYBER');
  });

  it('leaves undeterminable fields blank and flags them (never guesses)', () => {
    const [p] = normalizePolicyExtraction({ policies: [{ coverage_type: 'Something odd' }] });
    expect(p.carrier).toBeNull();
    expect(p.coverage_type).toBe('OTHER');
    expect(p.coverage_limit_cents).toBeNull();
    expect(p.premium_cents).toBeNull();
    expect(p.expiration_date).toBeNull();
    expect(p.lowConfidenceFields).toEqual(
      expect.arrayContaining(['carrier', 'coverage_type', 'coverage_limit', 'premium', 'expiration_date']),
    );
  });

  it('never throws on a malformed shape and yields an empty list', () => {
    expect(() => normalizePolicyExtraction(null)).not.toThrow();
    expect(() => normalizePolicyExtraction('garbage')).not.toThrow();
    expect(normalizePolicyExtraction({ policies: 'nope' })).toEqual([]);
    expect(normalizePolicyExtraction({})).toEqual([]);
  });
});
