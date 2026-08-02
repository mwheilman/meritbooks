import { describe, it, expect } from 'vitest';
import { buildAmortizationSchedule, levelPaymentCents, AmortizationError } from './amortization';
import {
  rebuildScheduleFromReset,
  computeRefinanceRollover,
  computePayoffSettlement,
} from './reset';

// A shared base loan: $10,000 @ 12% annual (1%/mo), 12 months, amortizing.
// Its schedule is hand-verified in amortization.test.ts; here we reuse it as the
// "already-posted" head against which resets are computed.
const base = buildAmortizationSchedule({
  principalCents: 1_000_000,
  annualRatePercent: 12,
  frequency: 'MONTHLY',
  method: 'AMORTIZING',
  termPeriods: 12,
  originationDate: '2026-01-15',
});

describe('rebuildScheduleFromReset — RECALC_PAYMENT (amortizing)', () => {
  const result = rebuildScheduleFromReset({
    existingLines: base.lines,
    resetAtPeriod: 7,
    newAnnualRatePercent: 24, // 2%/mo
    frequency: 'MONTHLY',
    method: 'AMORTIZING',
    mode: 'RECALC_PAYMENT',
  });

  it('carries the hand-computed outstanding balance into the reset', () => {
    // Balance after period 6 of the base loan = $5,149.20.
    expect(result.outstandingBalanceCents).toBe(514_920);
  });

  it('preserves periods 1..6 exactly (already-posted head untouched)', () => {
    expect(result.preservedLines).toHaveLength(6);
    expect(result.preservedLines).toEqual(base.lines.slice(0, 6));
  });

  it('recomputes a 6-period tail starting at period 7', () => {
    expect(result.remainingPeriods).toBe(6);
    expect(result.newLines).toHaveLength(6);
    expect(result.newLines[0].period).toBe(7);
    expect(result.newLines[5].period).toBe(12);
  });

  it('re-strikes the level payment at the new rate', () => {
    // pmt for $5,149.20 at 2%/mo over 6 periods (uses the same primitive).
    expect(result.newPaymentCents).toBe(levelPaymentCents(514_920, 0.02, 6));
  });

  it('the new tail amortizes to exactly zero and repays the outstanding balance', () => {
    expect(result.newLines[5].principalBalanceCents).toBe(0);
    const principalRepaid = result.newLines.reduce((s, l) => s + l.principalCents, 0);
    expect(principalRepaid).toBe(514_920);
  });

  it('every new line balances (payment = interest + principal)', () => {
    for (const l of result.newLines) expect(l.paymentCents).toBe(l.interestCents + l.principalCents);
  });

  it('reuses the original scheduled dates for the unchanged periods', () => {
    expect(result.newLines[0].periodDate).toBe(base.lines[6].periodDate);
  });
});

describe('rebuildScheduleFromReset — zero-rate, fully hand-computable', () => {
  const flat = buildAmortizationSchedule({
    principalCents: 1_200_000,
    annualRatePercent: 0,
    frequency: 'MONTHLY',
    method: 'AMORTIZING',
    termPeriods: 12,
  });
  const result = rebuildScheduleFromReset({
    existingLines: flat.lines,
    resetAtPeriod: 5,
    newAnnualRatePercent: 0,
    frequency: 'MONTHLY',
    method: 'AMORTIZING',
  });

  it('outstanding after 4 even payments of $1,000 is $8,000', () => {
    expect(result.outstandingBalanceCents).toBe(800_000);
  });

  it('splits the remaining $8,000 over 8 periods at $1,000 each to zero', () => {
    expect(result.remainingPeriods).toBe(8);
    expect(result.newLines.every((l) => l.principalCents === 100_000 && l.interestCents === 0)).toBe(true);
    expect(result.newLines[7].principalBalanceCents).toBe(0);
  });
});

describe('rebuildScheduleFromReset — KEEP_PAYMENT extends/shortens the term', () => {
  const result = rebuildScheduleFromReset({
    existingLines: base.lines,
    resetAtPeriod: 7,
    newAnnualRatePercent: 6, // lower rate: holding the old payment shortens the term
    frequency: 'MONTHLY',
    method: 'AMORTIZING',
    mode: 'KEEP_PAYMENT',
  });

  it('holds the prior level payment on the regular lines', () => {
    expect(result.previousPaymentCents).toBe(88_849);
    // All but the final true-up line keep the old payment.
    for (const l of result.newLines.slice(0, -1)) expect(l.paymentCents).toBe(88_849);
  });

  it('a lower rate with the same payment retires the loan in <= the original remaining term', () => {
    expect(result.remainingPeriods).toBeLessThanOrEqual(6);
    expect(result.newLines[result.newLines.length - 1].principalBalanceCents).toBe(0);
  });
});

describe('rebuildScheduleFromReset — interest-only re-strikes interest, keeps the balloon', () => {
  const io = buildAmortizationSchedule({
    principalCents: 10_000_000, // $100,000
    annualRatePercent: 6, // $500/mo
    frequency: 'MONTHLY',
    method: 'INTEREST_ONLY',
    termPeriods: 12,
  });
  const result = rebuildScheduleFromReset({
    existingLines: io.lines,
    resetAtPeriod: 7,
    newAnnualRatePercent: 12, // 1%/mo -> $1,000/mo
    frequency: 'MONTHLY',
    method: 'INTEREST_ONLY',
  });

  it('interest re-strikes to $1,000/mo on the remaining 6 periods', () => {
    expect(result.remainingPeriods).toBe(6);
    for (const l of result.newLines.slice(0, -1)) {
      expect(l.interestCents).toBe(100_000);
      expect(l.principalCents).toBe(0);
      expect(l.principalBalanceCents).toBe(10_000_000);
    }
  });

  it('the final period still repays the full principal balloon', () => {
    const last = result.newLines[5];
    expect(last.principalCents).toBe(10_000_000);
    expect(last.interestCents).toBe(100_000);
    expect(last.principalBalanceCents).toBe(0);
  });
});

describe('rebuildScheduleFromReset — guardrails', () => {
  it('rejects a reset past the end of the schedule', () => {
    expect(() =>
      rebuildScheduleFromReset({
        existingLines: base.lines,
        resetAtPeriod: 20,
        newAnnualRatePercent: 6,
        frequency: 'MONTHLY',
        method: 'AMORTIZING',
      }),
    ).toThrow(AmortizationError);
  });

  it('rejects a non-positive reset period', () => {
    expect(() =>
      rebuildScheduleFromReset({
        existingLines: base.lines,
        resetAtPeriod: 0,
        newAnnualRatePercent: 6,
        frequency: 'MONTHLY',
        method: 'AMORTIZING',
      }),
    ).toThrow(AmortizationError);
  });
});

describe('computeRefinanceRollover — balanced debt rollover', () => {
  it('cash-out: new note exceeds the old balance -> DR cash for the difference', () => {
    const r = computeRefinanceRollover(514_920, 600_000);
    expect(r.drOldLiabilityCents).toBe(514_920);
    expect(r.crNewLiabilityCents).toBe(600_000);
    expect(r.cashDebitCents).toBe(85_080);
    expect(r.cashCreditCents).toBe(0);
    expect(r.drOldLiabilityCents + r.cashDebitCents).toBe(r.crNewLiabilityCents + r.cashCreditCents);
  });

  it('cash-in: old balance exceeds the new note -> CR cash for the difference', () => {
    const r = computeRefinanceRollover(514_920, 400_000);
    expect(r.cashDebitCents).toBe(0);
    expect(r.cashCreditCents).toBe(114_920);
    expect(r.drOldLiabilityCents + r.cashDebitCents).toBe(r.crNewLiabilityCents + r.cashCreditCents);
  });

  it('straight refinance: equal balances net to no cash', () => {
    const r = computeRefinanceRollover(514_920, 514_920);
    expect(r.cashDebitCents).toBe(0);
    expect(r.cashCreditCents).toBe(0);
  });

  it('rejects a non-positive balance or principal', () => {
    expect(() => computeRefinanceRollover(0, 500_000)).toThrow(AmortizationError);
    expect(() => computeRefinanceRollover(500_000, 0)).toThrow(AmortizationError);
  });
});

describe('computePayoffSettlement', () => {
  it('totals principal + accrued payable + per-diem interest', () => {
    const s = computePayoffSettlement(514_920, 5_000, 300);
    expect(s.totalCashCents).toBe(520_220);
  });

  it('rejects an empty settlement', () => {
    expect(() => computePayoffSettlement(0, 0, 0)).toThrow(AmortizationError);
  });
});
