import { describe, it, expect } from 'vitest';
import {
  normalizeExtraction,
  mapCovenantType,
  inferDirection,
  unitForType,
} from './parse-document';

describe('mapCovenantType — enum mapping from free text', () => {
  it('maps direct enum values through unchanged', () => {
    expect(mapCovenantType('DSCR')).toBe('DSCR');
    expect(mapCovenantType('leverage')).toBe('LEVERAGE');
    expect(mapCovenantType('MIN_LIQUIDITY')).toBe('MIN_LIQUIDITY');
  });

  it('maps common agreement phrasing to the enum', () => {
    expect(mapCovenantType('Debt Service Coverage Ratio')).toBe('DSCR');
    expect(mapCovenantType('Fixed Charge Coverage Ratio')).toBe('FCCR');
    expect(mapCovenantType('Total Net Leverage Ratio')).toBe('LEVERAGE');
    expect(mapCovenantType('Net Debt to EBITDA')).toBe('LEVERAGE');
    expect(mapCovenantType('Consolidated Current Ratio')).toBe('CURRENT_RATIO');
    expect(mapCovenantType('Minimum Liquidity')).toBe('MIN_LIQUIDITY');
    expect(mapCovenantType('Tangible Net Worth')).toBe('TNW');
  });

  it('prefers FCCR over DSCR when both "fixed charge" and "coverage" appear', () => {
    expect(mapCovenantType('Fixed Charge Coverage')).toBe('FCCR');
  });

  it('falls back to CUSTOM on unknown / unmappable language (blank-on-unknown)', () => {
    expect(mapCovenantType('warm blanket ratio')).toBe('CUSTOM');
    expect(mapCovenantType('')).toBe('CUSTOM');
    expect(mapCovenantType(null)).toBe('CUSTOM');
    expect(mapCovenantType(42)).toBe('CUSTOM');
  });
});

describe('inferDirection — mechanical from covenant type', () => {
  it('leverage is MAX; coverage/ratio/currency covenants are MIN', () => {
    expect(inferDirection('LEVERAGE')).toBe('MAX');
    expect(inferDirection('DSCR')).toBe('MIN');
    expect(inferDirection('FCCR')).toBe('MIN');
    expect(inferDirection('CURRENT_RATIO')).toBe('MIN');
    expect(inferDirection('MIN_LIQUIDITY')).toBe('MIN');
    expect(inferDirection('TNW')).toBe('MIN');
  });

  it('CUSTOM honors a valid model hint and defaults MIN otherwise', () => {
    expect(inferDirection('CUSTOM', 'MAX')).toBe('MAX');
    expect(inferDirection('CUSTOM', 'min')).toBe('MIN');
    expect(inferDirection('CUSTOM', 'garbage')).toBe('MIN');
    expect(inferDirection('CUSTOM')).toBe('MIN');
  });
});

describe('unitForType', () => {
  it('liquidity and TNW are CURRENCY; ratios are RATIO', () => {
    expect(unitForType('MIN_LIQUIDITY')).toBe('CURRENCY');
    expect(unitForType('TNW')).toBe('CURRENCY');
    expect(unitForType('DSCR')).toBe('RATIO');
    expect(unitForType('LEVERAGE')).toBe('RATIO');
  });

  it('CUSTOM respects a currency hint', () => {
    expect(unitForType('CUSTOM', 'currency')).toBe('CURRENCY');
    expect(unitForType('CUSTOM', 'ratio')).toBe('RATIO');
    expect(unitForType('CUSTOM')).toBe('RATIO');
  });
});

describe('normalizeExtraction — multi-covenant + field mapping', () => {
  const sample = {
    agreement: {
      loan_name: 'Term Loan A',
      facility: '$25M Senior Secured',
      lender_name: 'Northwest Bank',
    },
    covenants: [
      {
        covenant_type: 'Debt Service Coverage Ratio',
        threshold: 1.25,
        test_frequency: 'quarterly',
        trailing_months: 12,
        effective_date: '2026-01-01',
        maturity_date: '2031-01-01',
        measurement_note: 'Consolidated EBITDA / Fixed Charges; §7.1(a)',
        snippet: 'The Borrower shall maintain a DSCR of not less than 1.25 to 1.00.',
        confidence: { covenant_type: 0.95, threshold: 0.9, test_frequency: 0.8, loan_name: 0.9 },
      },
      {
        covenant_type: 'Total Leverage Ratio',
        threshold: '3.50',
        test_frequency: 'Quarterly',
        snippet: 'Total Leverage Ratio not to exceed 3.50x.',
        confidence: { covenant_type: 0.92, threshold: 0.88 },
      },
      {
        covenant_type: 'Minimum Liquidity',
        threshold: 5000000,
        threshold_unit: 'currency',
        confidence: { covenant_type: 0.9, threshold: 0.7 },
      },
    ],
  };

  it('returns ALL covenants in the document', () => {
    const out = normalizeExtraction(sample);
    expect(out).toHaveLength(3);
  });

  it('maps types and mechanically infers direction + unit', () => {
    const [dscr, lev, liq] = normalizeExtraction(sample);
    expect(dscr.covenant_type).toBe('DSCR');
    expect(dscr.direction).toBe('MIN');
    expect(dscr.threshold_unit).toBe('RATIO');
    expect(dscr.threshold).toBe(1.25);
    expect(dscr.test_frequency).toBe('QUARTERLY');
    expect(dscr.measurement.trailingMonths).toBe(12);

    expect(lev.covenant_type).toBe('LEVERAGE');
    expect(lev.direction).toBe('MAX');
    expect(lev.threshold).toBe(3.5); // string coerced

    expect(liq.covenant_type).toBe('MIN_LIQUIDITY');
    expect(liq.threshold_unit).toBe('CURRENCY');
    expect(liq.threshold).toBe(5000000);
  });

  it('inherits agreement-level loan/facility/lender when a covenant omits them', () => {
    const [dscr] = normalizeExtraction(sample);
    expect(dscr.loan_name).toBe('Term Loan A');
    expect(dscr.facility).toBe('$25M Senior Secured');
    expect(dscr.lender_name).toBe('Northwest Bank');
  });

  it('leaves undeterminable fields BLANK and flags them for review (never guessed)', () => {
    const out = normalizeExtraction({
      agreement: { loan_name: 'Revolver' },
      covenants: [
        {
          covenant_type: 'some bespoke test',
          // no threshold, no frequency, no dates
          confidence: {},
        },
      ],
    });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.covenant_type).toBe('CUSTOM');
    expect(c.threshold).toBeNull();
    expect(c.test_frequency).toBeNull();
    expect(c.effective_date).toBeNull();
    expect(c.maturity_date).toBeNull();
    expect(c.lowConfidenceFields).toContain('threshold');
    expect(c.lowConfidenceFields).toContain('covenant_type');
    expect(c.lowConfidenceFields).toContain('test_frequency');
  });

  it('rejects malformed dates rather than persisting them', () => {
    const out = normalizeExtraction({
      covenants: [{ covenant_type: 'DSCR', threshold: 1.1, effective_date: 'Jan 2026', maturity_date: '2031-13-99' }],
    });
    expect(out[0].effective_date).toBeNull();
    expect(out[0].maturity_date).toBeNull();
  });

  it('never throws on malformed input — returns an empty list', () => {
    expect(normalizeExtraction(null)).toEqual([]);
    expect(normalizeExtraction({})).toEqual([]);
    expect(normalizeExtraction({ covenants: 'nope' })).toEqual([]);
    expect(normalizeExtraction({ covenants: [null, 7, 'x'] })).toEqual([]);
  });
});
