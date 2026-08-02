import { describe, it, expect } from 'vitest';
import {
  buildAmortizationSchedule,
  levelPaymentCents,
  periodicRate,
  AmortizationError,
} from './amortization';

describe('periodicRate', () => {
  it('divides the annual percent by periods per year', () => {
    expect(periodicRate(12, 'MONTHLY')).toBeCloseTo(0.01, 10);
    expect(periodicRate(6, 'MONTHLY')).toBeCloseTo(0.005, 10);
    expect(periodicRate(8, 'QUARTERLY')).toBeCloseTo(0.02, 10);
    expect(periodicRate(0, 'ANNUAL')).toBe(0);
  });
});

describe('levelPaymentCents — hand-computed', () => {
  it('$10,000 @ 12% annual (1%/mo) over 12 months = $888.49', () => {
    // pmt = 100 / (1 - 1.01^-12) = 888.4879... -> $888.49
    expect(levelPaymentCents(1_000_000, 0.01, 12)).toBe(88_849);
  });

  it('zero-rate loan splits principal evenly', () => {
    expect(levelPaymentCents(1_200_000, 0, 12)).toBe(100_000);
  });
});

describe('buildAmortizationSchedule — standard amortizing (term-driven)', () => {
  const schedule = buildAmortizationSchedule({
    principalCents: 1_000_000, // $10,000
    annualRatePercent: 12,
    frequency: 'MONTHLY',
    method: 'AMORTIZING',
    termPeriods: 12,
    originationDate: '2026-01-15',
  });

  it('computes the level payment and 12 periods', () => {
    expect(schedule.regularPaymentCents).toBe(88_849);
    expect(schedule.periods).toBe(12);
    expect(schedule.lines).toHaveLength(12);
  });

  it('first period: $100.00 interest, $788.49 principal, $9,211.51 balance', () => {
    const first = schedule.lines[0];
    expect(first.period).toBe(1);
    expect(first.interestCents).toBe(10_000);
    expect(first.principalCents).toBe(78_849);
    expect(first.principalBalanceCents).toBe(921_151);
    expect(first.periodDate).toBe('2026-02-15');
  });

  it('closes to exactly a zero balance (final-period true-up)', () => {
    const last = schedule.lines[schedule.lines.length - 1];
    expect(last.principalBalanceCents).toBe(0);
  });

  it('sum of principal equals the original principal', () => {
    const totalPrincipal = schedule.lines.reduce((s, l) => s + l.principalCents, 0);
    expect(totalPrincipal).toBe(1_000_000);
  });

  it('every line balances: payment = interest + principal', () => {
    for (const l of schedule.lines) {
      expect(l.paymentCents).toBe(l.interestCents + l.principalCents);
    }
  });

  it('total interest is positive and total paid = principal + interest', () => {
    expect(schedule.totalInterestCents).toBeGreaterThan(0);
    expect(schedule.totalPaymentCents).toBe(1_000_000 + schedule.totalInterestCents);
  });
});

describe('buildAmortizationSchedule — zero interest', () => {
  it('splits principal evenly with no interest', () => {
    const s = buildAmortizationSchedule({
      principalCents: 1_200_000,
      annualRatePercent: 0,
      frequency: 'MONTHLY',
      method: 'AMORTIZING',
      termPeriods: 12,
    });
    expect(s.regularPaymentCents).toBe(100_000);
    expect(s.lines.every((l) => l.interestCents === 0)).toBe(true);
    expect(s.lines.every((l) => l.principalCents === 100_000)).toBe(true);
    expect(s.lines[11].principalBalanceCents).toBe(0);
  });
});

describe('buildAmortizationSchedule — interest-only (balloon)', () => {
  const s = buildAmortizationSchedule({
    principalCents: 10_000_000, // $100,000
    annualRatePercent: 6,
    frequency: 'MONTHLY',
    method: 'INTEREST_ONLY',
    termPeriods: 12,
  });

  it('every period charges only interest until the final balloon', () => {
    for (let i = 0; i < 11; i++) {
      expect(s.lines[i].interestCents).toBe(50_000); // $500/mo
      expect(s.lines[i].principalCents).toBe(0);
      expect(s.lines[i].principalBalanceCents).toBe(10_000_000);
    }
  });

  it('final period repays the full principal balloon', () => {
    const last = s.lines[11];
    expect(last.interestCents).toBe(50_000);
    expect(last.principalCents).toBe(10_000_000);
    expect(last.paymentCents).toBe(10_050_000);
    expect(last.principalBalanceCents).toBe(0);
  });

  it('total interest = 12 x $500 = $6,000', () => {
    expect(s.totalInterestCents).toBe(600_000);
  });
});

describe('buildAmortizationSchedule — payment-driven (term derived)', () => {
  it('amortizes to zero given a fixed level payment and no term', () => {
    const s = buildAmortizationSchedule({
      principalCents: 1_000_000,
      annualRatePercent: 12,
      frequency: 'MONTHLY',
      method: 'AMORTIZING',
      paymentCents: 88_849,
    });
    expect(s.periods).toBe(12);
    expect(s.lines[s.lines.length - 1].principalBalanceCents).toBe(0);
    const totalPrincipal = s.lines.reduce((sum, l) => sum + l.principalCents, 0);
    expect(totalPrincipal).toBe(1_000_000);
  });
});

describe('buildAmortizationSchedule — guardrails', () => {
  it('rejects a payment that cannot cover the first interest', () => {
    expect(() =>
      buildAmortizationSchedule({
        principalCents: 1_000_000,
        annualRatePercent: 12,
        frequency: 'MONTHLY',
        method: 'AMORTIZING',
        paymentCents: 5_000, // < $100 first-period interest
      }),
    ).toThrow(AmortizationError);
  });

  it('rejects INTEREST_ONLY without a term', () => {
    expect(() =>
      buildAmortizationSchedule({
        principalCents: 1_000_000,
        annualRatePercent: 6,
        frequency: 'MONTHLY',
        method: 'INTEREST_ONLY',
      }),
    ).toThrow(AmortizationError);
  });

  it('rejects a non-positive principal', () => {
    expect(() =>
      buildAmortizationSchedule({
        principalCents: 0,
        annualRatePercent: 6,
        frequency: 'MONTHLY',
        method: 'AMORTIZING',
        termPeriods: 12,
      }),
    ).toThrow(AmortizationError);
  });

  it('rejects amortizing with neither term nor payment', () => {
    expect(() =>
      buildAmortizationSchedule({
        principalCents: 1_000_000,
        annualRatePercent: 6,
        frequency: 'MONTHLY',
        method: 'AMORTIZING',
      }),
    ).toThrow(AmortizationError);
  });
});
