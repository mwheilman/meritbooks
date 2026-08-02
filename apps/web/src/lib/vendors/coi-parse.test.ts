import { describe, it, expect } from 'vitest';
import {
  normalizeCoiExtraction,
  mapCoverageType,
  coverageToDocType,
  parseLimitToCents,
  toIsoDate,
} from './coi-parse';

describe('mapCoverageType — coverage-line mapping', () => {
  it('maps direct enum values through unchanged', () => {
    expect(mapCoverageType('GENERAL_LIABILITY')).toBe('GENERAL_LIABILITY');
    expect(mapCoverageType('workers_comp')).toBe('WORKERS_COMP');
  });

  it('classifies free-form ACORD descriptions', () => {
    expect(mapCoverageType('Commercial General Liability')).toBe('GENERAL_LIABILITY');
    expect(mapCoverageType("Workers' Compensation and Employers' Liability")).toBe('WORKERS_COMP');
    expect(mapCoverageType('Umbrella / Excess Liability')).toBe('UMBRELLA');
    expect(mapCoverageType('Automobile Liability')).toBe('AUTO');
    expect(mapCoverageType('Professional Liability (E&O)')).toBe('PROFESSIONAL');
  });

  it("prefers workers-comp over the generic 'liability' catch", () => {
    expect(mapCoverageType("Employers' Liability")).toBe('WORKERS_COMP');
  });

  it('falls back to OTHER on unknown / non-string', () => {
    expect(mapCoverageType('crime bond')).toBe('OTHER');
    expect(mapCoverageType(null)).toBe('OTHER');
    expect(mapCoverageType(99)).toBe('OTHER');
  });
});

describe('coverageToDocType — only GL and WC persist to compliance docs', () => {
  it('maps GL and WC', () => {
    expect(coverageToDocType('GENERAL_LIABILITY')).toBe('GL_COI');
    expect(coverageToDocType('WORKERS_COMP')).toBe('WC_COI');
  });
  it('returns null for unmappable lines (reported, not persisted)', () => {
    expect(coverageToDocType('AUTO')).toBeNull();
    expect(coverageToDocType('UMBRELLA')).toBeNull();
    expect(coverageToDocType('OTHER')).toBeNull();
  });
});

describe('parseLimitToCents — dollar limits to integer cents', () => {
  it('parses plain and formatted dollar amounts', () => {
    expect(parseLimitToCents('1000000')).toBe(100_000_000);
    expect(parseLimitToCents('$1,000,000')).toBe(100_000_000);
    expect(parseLimitToCents('$2,000,000.00')).toBe(200_000_000);
    expect(parseLimitToCents(1_000_000)).toBe(100_000_000);
  });

  it('parses M/K shorthand', () => {
    expect(parseLimitToCents('$1M')).toBe(100_000_000);
    expect(parseLimitToCents('2.5M')).toBe(250_000_000);
    expect(parseLimitToCents('500K')).toBe(50_000_000);
  });

  it('is always an integer number of cents', () => {
    const v = parseLimitToCents('1234.567');
    expect(v).toBe(123_457); // rounded, integer
    expect(Number.isInteger(v)).toBe(true);
  });

  it('returns null on blank / non-numeric / negative', () => {
    expect(parseLimitToCents('')).toBeNull();
    expect(parseLimitToCents('n/a')).toBeNull();
    expect(parseLimitToCents(null)).toBeNull();
    expect(parseLimitToCents('-5')).toBeNull();
  });
});

describe('toIsoDate — strict ISO with calendar validation', () => {
  it('accepts a valid date', () => {
    expect(toIsoDate('2026-03-31')).toBe('2026-03-31');
  });
  it('rejects impossible and malformed dates', () => {
    expect(toIsoDate('2026-02-30')).toBeNull();
    expect(toIsoDate('03/31/2026')).toBeNull();
    expect(toIsoDate('2026-13-01')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
  });
});

describe('normalizeCoiExtraction — full proposal', () => {
  const NOW = new Date('2026-01-15T00:00:00Z');

  it('maps a clean COI with GL + WC, limits as integer cents, expiration read', () => {
    const coi = normalizeCoiExtraction(
      {
        carrier: 'Travelers Casualty',
        policy_number: 'GL-99201',
        named_insured: 'Acme Construction Inc',
        certificate_holder: 'Merit Management Group',
        additional_insured: 'Yes',
        coverages: [
          {
            coverage_type: 'Commercial General Liability',
            each_occurrence: 1_000_000,
            aggregate: 2_000_000,
            effective_date: '2025-06-01',
            expiration_date: '2026-06-01',
            confidence: { coverage_type: 0.97, each_occurrence: 0.95, dates: 0.95 },
          },
          {
            coverage_type: "Workers' Compensation",
            each_occurrence: 500_000,
            effective_date: '2025-06-01',
            expiration_date: '2026-06-01',
            confidence: { coverage_type: 0.96, each_occurrence: 0.9, dates: 0.95 },
          },
        ],
      },
      NOW,
    );

    expect(coi.carrier).toBe('Travelers Casualty');
    expect(coi.policy_number).toBe('GL-99201');
    expect(coi.additional_insured).toBe(true);
    expect(coi.coverages).toHaveLength(2);

    const gl = coi.coverages[0];
    expect(gl.coverage_type).toBe('GENERAL_LIABILITY');
    expect(gl.doc_type).toBe('GL_COI');
    expect(gl.each_occurrence_cents).toBe(100_000_000);
    expect(gl.aggregate_cents).toBe(200_000_000);
    expect(gl.expiration_date).toBe('2026-06-01');
    expect(gl.lowConfidenceFields).not.toContain('expiration_date');

    const wc = coi.coverages[1];
    expect(wc.coverage_type).toBe('WORKERS_COMP');
    expect(wc.doc_type).toBe('WC_COI');
  });

  it('flags an already-expired expiration date', () => {
    const coi = normalizeCoiExtraction(
      {
        coverages: [
          {
            coverage_type: 'General Liability',
            each_occurrence: 1_000_000,
            expiration_date: '2025-01-01', // before NOW
            confidence: { coverage_type: 0.9, dates: 0.9 },
          },
        ],
      },
      NOW,
    );
    expect(coi.coverages[0].lowConfidenceFields).toContain('expiration_date');
  });

  it('leaves undeterminable fields blank and flags them (never guessed)', () => {
    const coi = normalizeCoiExtraction(
      {
        carrier: null,
        coverages: [
          {
            coverage_type: 'some odd line',
            each_occurrence: null,
            aggregate: null,
            expiration_date: null,
            confidence: {},
          },
        ],
      },
      NOW,
    );
    expect(coi.carrier).toBeNull();
    expect(coi.additional_insured).toBeNull();
    const cov = coi.coverages[0];
    expect(cov.coverage_type).toBe('OTHER');
    expect(cov.doc_type).toBeNull();
    expect(cov.each_occurrence_cents).toBeNull();
    expect(cov.expiration_date).toBeNull();
    expect(cov.lowConfidenceFields).toEqual(
      expect.arrayContaining(['coverage_type', 'each_occurrence', 'expiration_date']),
    );
  });

  it('never throws on a malformed shape', () => {
    expect(() => normalizeCoiExtraction(null)).not.toThrow();
    expect(() => normalizeCoiExtraction('nope')).not.toThrow();
    const coi = normalizeCoiExtraction(undefined);
    expect(coi.coverages).toEqual([]);
  });
});
