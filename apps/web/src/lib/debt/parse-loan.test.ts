import { describe, it, expect } from 'vitest';
import {
  normalizeLoanExtraction,
  mapFrequency,
  mapRateType,
  mapMethod,
} from './parse-loan';

describe('mapFrequency', () => {
  it('maps free-form cadence to the enum', () => {
    expect(mapFrequency('monthly')).toBe('MONTHLY');
    expect(mapFrequency('per quarter')).toBe('QUARTERLY');
    expect(mapFrequency('semi-annual')).toBe('SEMIANNUAL');
    expect(mapFrequency('annually')).toBe('ANNUAL');
    expect(mapFrequency(null)).toBe('MONTHLY');
    expect(mapFrequency('gibberish')).toBe('MONTHLY');
  });
});

describe('mapRateType / mapMethod', () => {
  it('detects variable rates by index name', () => {
    expect(mapRateType('SOFR + 3%')).toBe('VARIABLE');
    expect(mapRateType('Prime + 1.5')).toBe('VARIABLE');
    expect(mapRateType('fixed')).toBe('FIXED');
    expect(mapRateType(null)).toBe('FIXED');
  });
  it('detects interest-only / balloon structures', () => {
    expect(mapMethod('interest only')).toBe('INTEREST_ONLY');
    expect(mapMethod('balloon at maturity')).toBe('INTEREST_ONLY');
    expect(mapMethod('fully amortizing')).toBe('AMORTIZING');
    expect(mapMethod(null)).toBe('AMORTIZING');
  });
});

describe('normalizeLoanExtraction', () => {
  it('maps a well-formed extraction and cleans money/percent strings', () => {
    const loan = normalizeLoanExtraction({
      loan: {
        loan_name: 'Term Loan A',
        lender: 'Northwest Bank',
        facility: '$5M Senior Secured',
        principal: '$5,000,000',
        interest_rate: '7.5%',
        rate_type: 'fixed',
        amortization_method: 'amortizing',
        payment_frequency: 'monthly',
        term_months: 60,
        payment: '100,208',
        origination_date: '2026-01-15',
        maturity_date: '2031-01-15',
        snippet: 'Borrower shall repay $5,000,000 at 7.5% over 60 months',
        confidence: { loan_name: 0.98, principal: 0.95, interest_rate: 0.9, payment: 0.8, term: 0.9, dates: 0.85 },
      },
    });
    expect(loan.loan_name).toBe('Term Loan A');
    expect(loan.lender).toBe('Northwest Bank');
    expect(loan.principal).toBe(5_000_000); // whole dollars, not cents
    expect(loan.interest_rate).toBe(7.5);
    expect(loan.rate_type).toBe('FIXED');
    expect(loan.amortization_method).toBe('AMORTIZING');
    expect(loan.payment_frequency).toBe('MONTHLY');
    expect(loan.term_periods).toBe(60); // months -> periods when monthly
    expect(loan.payment).toBe(100_208);
    expect(loan.origination_date).toBe('2026-01-15');
    expect(loan.maturity_date).toBe('2031-01-15');
    expect(loan.lowConfidenceFields).toHaveLength(0);
  });

  it('leaves undeterminable fields blank and flags them', () => {
    const loan = normalizeLoanExtraction({
      loan: {
        loan_name: 'Unknown Note',
        principal: null,
        interest_rate: null,
        confidence: { loan_name: 0.9 },
      },
    });
    expect(loan.principal).toBeNull();
    expect(loan.interest_rate).toBeNull();
    expect(loan.term_periods).toBeNull();
    expect(loan.payment).toBeNull();
    expect(loan.lowConfidenceFields).toContain('principal');
    expect(loan.lowConfidenceFields).toContain('interest_rate');
    // Neither term nor payment present -> both flagged so the schedule can't be built blindly.
    expect(loan.lowConfidenceFields).toContain('term_periods');
    expect(loan.lowConfidenceFields).toContain('payment');
  });

  it('does not map term_months to periods when the frequency is not monthly', () => {
    const loan = normalizeLoanExtraction({
      loan: { loan_name: 'Quarterly Note', payment_frequency: 'quarterly', term_months: 60 },
    });
    expect(loan.payment_frequency).toBe('QUARTERLY');
    expect(loan.term_periods).toBeNull();
  });

  it('rejects malformed dates', () => {
    const loan = normalizeLoanExtraction({
      loan: { loan_name: 'X', origination_date: '15/01/2026', maturity_date: '2026-02-30' },
    });
    expect(loan.origination_date).toBeNull();
    expect(loan.maturity_date).toBeNull();
  });

  it('never throws on a malformed shape', () => {
    expect(() => normalizeLoanExtraction(null)).not.toThrow();
    expect(() => normalizeLoanExtraction('nonsense')).not.toThrow();
    const loan = normalizeLoanExtraction({});
    expect(loan.loan_name).toBe('');
  });
});
