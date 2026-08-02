import { describe, it, expect } from 'vitest';
import {
  buildLeaseSchedule,
  presentValueCents,
  LeaseInputError,
  type LeaseTerms,
  type LeaseScheduleLine,
} from './schedule';

/**
 * A known lease, hand-computed:
 *   $1,000/mo (100,000 cents), 12 monthly payments, 6% annual (0.5%/mo), arrears.
 *   PV = 1000 · (1 − 1.005^-12) / 0.005 = $11,618.93  -> 1,161,893 cents.
 *   Period 1 interest = round(1,161,893 · 0.005) = 5,809 cents; principal = 94,191.
 *   Total interest over the term = 1,200,000 − 1,161,893 = 38,107 cents.
 */
const KNOWN: LeaseTerms = {
  classification: 'OPERATING',
  paymentCents: 100_000,
  frequency: 'MONTHLY',
  termMonths: 12,
  annualDiscountRate: 0.06,
  paymentTiming: 'ARREARS',
};

/** Sum helper over a schedule field. */
function sum(lines: LeaseScheduleLine[], f: (l: LeaseScheduleLine) => number): number {
  return lines.reduce((s, l) => s + f(l), 0);
}

describe('presentValueCents', () => {
  it('matches the hand-computed PV of the known lease', () => {
    expect(Math.round(presentValueCents(100_000, 12, 0.005, 'ARREARS'))).toBe(1_161_893);
  });

  it('zero-rate PV is just the undiscounted total', () => {
    expect(presentValueCents(100_000, 12, 0, 'ARREARS')).toBe(1_200_000);
  });

  it('annuity-due (ADVANCE) is (1+r)× the ordinary annuity', () => {
    const ord = presentValueCents(100_000, 12, 0.005, 'ARREARS');
    const due = presentValueCents(100_000, 12, 0.005, 'ADVANCE');
    expect(due).toBeCloseTo(ord * 1.005, 6);
  });
});

describe('buildLeaseSchedule — initial measurement', () => {
  it('computes the liability and ROU asset at commencement', () => {
    const s = buildLeaseSchedule(KNOWN);
    expect(s.liabilityCents).toBe(1_161_893);
    expect(s.rouAssetCents).toBe(1_161_893); // ROU = liability at commencement
    expect(s.periods).toBe(12);
    expect(s.paymentsPerYear).toBe(12);
    expect(s.periodRate).toBeCloseTo(0.005, 12);
  });

  it('period 1 interest/principal match the hand computation', () => {
    const s = buildLeaseSchedule(KNOWN);
    expect(s.lines[0].interestCents).toBe(5_809);
    expect(s.lines[0].principalReductionCents).toBe(94_191);
    expect(s.lines[0].liabilityBalanceCents).toBe(1_067_702);
  });
});

describe('buildLeaseSchedule — schedule ties out exactly (integer cents)', () => {
  it('OPERATING: liability + ROU both amortize to exactly zero', () => {
    const s = buildLeaseSchedule(KNOWN);
    const last = s.lines[s.lines.length - 1];
    expect(last.liabilityBalanceCents).toBe(0);
    expect(last.rouBalanceCents).toBe(0);
    // Principal reductions sum to the opening liability.
    expect(sum(s.lines, (l) => l.principalReductionCents)).toBe(1_161_893);
    // Interest sums to total payments − liability.
    expect(sum(s.lines, (l) => l.interestCents)).toBe(38_107);
    expect(s.totalInterestCents).toBe(38_107);
    // ROU amortization sums to the ROU asset.
    expect(sum(s.lines, (l) => l.rouAmortizationCents)).toBe(1_161_893);
  });

  it('OPERATING: single straight-line lease expense summing to total payments', () => {
    const s = buildLeaseSchedule(KNOWN);
    // Every period expense is the straight-line average ($1,000) here (no remainder).
    for (const l of s.lines) expect(l.leaseExpenseCents).toBe(100_000);
    expect(s.totalLeaseExpenseCents).toBe(1_200_000);
  });

  it('FINANCE: straight-line ROU amortization; both balances clear to zero', () => {
    const s = buildLeaseSchedule({ ...KNOWN, classification: 'FINANCE' });
    expect(s.liabilityCents).toBe(1_161_893);
    // Interest is identical to the operating case (same liability mechanics).
    expect(s.lines[0].interestCents).toBe(5_809);
    // ROU amortization is straight-line: round(1,161,893 / 12) = 96,824 each but the last.
    expect(s.lines[0].rouAmortizationCents).toBe(96_824);
    expect(s.lines[0].leaseExpenseCents).toBe(5_809 + 96_824); // interest + amortization
    const last = s.lines[s.lines.length - 1];
    expect(last.liabilityBalanceCents).toBe(0);
    expect(last.rouBalanceCents).toBe(0);
    expect(sum(s.lines, (l) => l.rouAmortizationCents)).toBe(1_161_893);
    // Total finance-lease P&L cost equals total cash paid (interest + amortization).
    expect(s.totalLeaseExpenseCents).toBe(1_200_000);
  });
});

/**
 * The monthly journal each classification posts MUST balance. Reproduce the exact
 * legs `lease-posting.ts` builds and assert debits === credits for every period.
 */
describe('buildLeaseSchedule — every period posts a balanced journal', () => {
  function operatingEntryBalances(l: LeaseScheduleLine): boolean {
    // DR Lease Expense + DR Lease Liability(principal) == CR ROU(amort) + CR Cash(payment)
    const debits = l.leaseExpenseCents + l.principalReductionCents;
    const credits = l.rouAmortizationCents + l.paymentCents;
    return debits === credits;
  }
  function financeEntryBalances(l: LeaseScheduleLine): boolean {
    // DR Interest + DR Liability(principal) + DR Amortization == CR Cash + CR ROU(amort)
    const debits = l.interestCents + l.principalReductionCents + l.rouAmortizationCents;
    const credits = l.paymentCents + l.rouAmortizationCents;
    return debits === credits;
  }

  it('OPERATING legs balance every period', () => {
    const s = buildLeaseSchedule(KNOWN);
    for (const l of s.lines) expect(operatingEntryBalances(l)).toBe(true);
  });

  it('FINANCE legs balance every period', () => {
    const s = buildLeaseSchedule({ ...KNOWN, classification: 'FINANCE' });
    for (const l of s.lines) expect(financeEntryBalances(l)).toBe(true);
  });
});

describe('buildLeaseSchedule — frequency + zero-rate + validation', () => {
  it('handles a quarterly lease (term must be a multiple of 3 months)', () => {
    const s = buildLeaseSchedule({
      classification: 'OPERATING',
      paymentCents: 300_000,
      frequency: 'QUARTERLY',
      termMonths: 36,
      annualDiscountRate: 0.08,
    });
    expect(s.periods).toBe(12);
    expect(s.paymentsPerYear).toBe(4);
    expect(s.periodRate).toBeCloseTo(0.02, 12);
    expect(s.lines[s.lines.length - 1].liabilityBalanceCents).toBe(0);
    expect(s.lines[1].monthOffset).toBe(3);
  });

  it('zero discount rate => liability equals undiscounted payments, no interest', () => {
    const s = buildLeaseSchedule({ ...KNOWN, annualDiscountRate: 0 });
    expect(s.liabilityCents).toBe(1_200_000);
    expect(s.totalInterestCents).toBe(0);
    for (const l of s.lines) expect(l.principalReductionCents).toBe(100_000);
  });

  it('rejects a term that is not a multiple of the period length', () => {
    expect(() =>
      buildLeaseSchedule({ ...KNOWN, frequency: 'QUARTERLY', termMonths: 12 + 1 }),
    ).toThrow(LeaseInputError);
  });

  it('rejects a non-positive payment', () => {
    expect(() => buildLeaseSchedule({ ...KNOWN, paymentCents: 0 })).toThrow(LeaseInputError);
  });
});
