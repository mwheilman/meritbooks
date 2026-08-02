import { describe, it, expect } from 'vitest';
import {
  remeasureLease,
  computeTermination,
  revisedLiabilityCents,
  legsBalance,
  type LeaseCarryingState,
} from './modify';
import { buildRemainingSchedule, presentValueCents } from './schedule';

/**
 * All scenarios use a ZERO discount rate where possible so every present value is the
 * undiscounted total (payment × periods) and the numbers are hand-computable.
 */

const MONTHLY_ZERO = {
  frequency: 'MONTHLY' as const,
  paymentTiming: 'ARREARS' as const,
};

function drCr(legs: { debitCents: number; creditCents: number }[]) {
  return {
    dr: legs.reduce((s, l) => s + l.debitCents, 0),
    cr: legs.reduce((s, l) => s + l.creditCents, 0),
  };
}

describe('remeasureLease — ordinary remeasurement (ROU adjusted by the liability delta, no P&L)', () => {
  const state: LeaseCarryingState = {
    classification: 'OPERATING',
    ...MONTHLY_ZERO,
    carryingLiabilityCents: 1_200_000,
    carryingRouCents: 1_200_000,
  };

  it('a CPI increase raises liability + ROU by the same amount, no gain/loss', () => {
    // payment 100,000 -> 110,000, 12 periods, rate 0. Revised liability = 110,000 * 12 = 1,320,000.
    const r = remeasureLease(state, { paymentCents: 110_000, remainingPeriods: 12, annualDiscountRate: 0 }, 12, false);
    expect(r.treatment).toBe('REMEASUREMENT');
    expect(r.revisedLiabilityCents).toBe(1_320_000);
    expect(r.liabilityDeltaCents).toBe(120_000);
    expect(r.newRouCents).toBe(1_320_000);
    expect(r.rouDeltaCents).toBe(120_000);
    expect(r.gainLossCents).toBe(0);
    // DR ROU 120,000 / CR Lease Liability 120,000.
    expect(legsBalance(r.legs)).toBe(true);
    const { dr, cr } = drCr(r.legs);
    expect(dr).toBe(120_000);
    expect(cr).toBe(120_000);
  });

  it('a downward remeasurement reduces liability + ROU equally, no P&L', () => {
    const r = remeasureLease(state, { paymentCents: 90_000, remainingPeriods: 12, annualDiscountRate: 0 }, 12, false);
    expect(r.revisedLiabilityCents).toBe(1_080_000);
    expect(r.liabilityDeltaCents).toBe(-120_000);
    expect(r.newRouCents).toBe(1_080_000);
    expect(r.gainLossCents).toBe(0);
    expect(legsBalance(r.legs)).toBe(true);
  });

  it('floors ROU at zero and recognizes the excess write-down as a gain', () => {
    const floorState: LeaseCarryingState = { ...state, carryingLiabilityCents: 1_000_000, carryingRouCents: 100_000 };
    // payment -> 50,000, 12 periods, rate 0 => revised liability 600,000; delta -400,000.
    const r = remeasureLease(floorState, { paymentCents: 50_000, remainingPeriods: 12, annualDiscountRate: 0 }, 12, false);
    expect(r.revisedLiabilityCents).toBe(600_000);
    expect(r.newRouCents).toBe(0);
    expect(r.gainLossCents).toBe(300_000); // 400,000 write-down − 100,000 ROU carrying
    // DR Lease Liability 400,000 / CR ROU 100,000 / CR Gain 300,000.
    const { dr, cr } = drCr(r.legs);
    expect(dr).toBe(400_000);
    expect(cr).toBe(400_000);
    expect(legsBalance(r.legs)).toBe(true);
  });
});

describe('remeasureLease — scope reduction (partial termination, proportionate ROU + gain/loss)', () => {
  it('proportionate write-down with zero gain/loss when ROU == liability', () => {
    const state: LeaseCarryingState = {
      classification: 'OPERATING',
      ...MONTHLY_ZERO,
      carryingLiabilityCents: 1_200_000,
      carryingRouCents: 1_200_000,
    };
    // Term halved: payment 100,000, 6 periods, rate 0 => revised liability 600,000.
    const r = remeasureLease(state, { paymentCents: 100_000, remainingPeriods: 6, annualDiscountRate: 0 }, 12);
    expect(r.treatment).toBe('SCOPE_REDUCTION');
    expect(r.revisedLiabilityCents).toBe(600_000);
    expect(r.newRouCents).toBe(600_000); // proportion 0.5 of 1,200,000
    expect(r.gainLossCents).toBe(0);
    expect(legsBalance(r.legs)).toBe(true);
  });

  it('recognizes a LOSS when the ROU written off exceeds the liability written off', () => {
    // ROU (1,200,000) > liability (1,000,000). Reduce to 4 periods @ 100,000 => revised 400,000.
    const state: LeaseCarryingState = {
      classification: 'OPERATING',
      ...MONTHLY_ZERO,
      carryingLiabilityCents: 1_000_000,
      carryingRouCents: 1_200_000,
    };
    const r = remeasureLease(state, { paymentCents: 100_000, remainingPeriods: 4, annualDiscountRate: 0 }, 10, true);
    // liabilityReduction 600,000; proportion 0.6; rouReduction 720,000; newRou 480,000.
    expect(r.revisedLiabilityCents).toBe(400_000);
    expect(r.newRouCents).toBe(480_000);
    expect(r.gainLossCents).toBe(-120_000); // 600,000 − 720,000 = loss 120,000
    // DR Lease Liability 600,000 + DR Loss 120,000 == CR ROU 720,000.
    const { dr, cr } = drCr(r.legs);
    expect(dr).toBe(720_000);
    expect(cr).toBe(720_000);
    expect(legsBalance(r.legs)).toBe(true);
  });

  it('recognizes a GAIN when the liability written off exceeds the ROU written off', () => {
    const state: LeaseCarryingState = {
      classification: 'OPERATING',
      ...MONTHLY_ZERO,
      carryingLiabilityCents: 1_200_000,
      carryingRouCents: 1_000_000,
    };
    const r = remeasureLease(state, { paymentCents: 100_000, remainingPeriods: 4, annualDiscountRate: 0 }, 10, true);
    // liabilityReduction 800,000; proportion 0.6667; rouReduction round(666,666.67)=666,667.
    expect(r.revisedLiabilityCents).toBe(400_000);
    expect(r.newRouCents).toBe(333_333);
    expect(r.gainLossCents).toBe(133_333); // 800,000 − 666,667
    const { dr, cr } = drCr(r.legs);
    expect(dr).toBe(800_000);
    expect(cr).toBe(800_000);
    expect(legsBalance(r.legs)).toBe(true);
  });

  it('infers scope reduction from a shortened term with a smaller liability', () => {
    const state: LeaseCarryingState = {
      classification: 'FINANCE',
      ...MONTHLY_ZERO,
      carryingLiabilityCents: 1_200_000,
      carryingRouCents: 1_200_000,
    };
    const r = remeasureLease(state, { paymentCents: 100_000, remainingPeriods: 6, annualDiscountRate: 0 }, 12);
    expect(r.treatment).toBe('SCOPE_REDUCTION');
  });
});

describe('computeTermination — write off remaining ROU + liability, book the gain/loss', () => {
  it('gain when the liability written off exceeds the ROU (no penalty)', () => {
    const r = computeTermination({ carryingLiabilityCents: 600_000, carryingRouCents: 500_000 }, 0);
    expect(r.gainLossCents).toBe(100_000);
    // DR Lease Liability 600,000 == CR ROU 500,000 + CR Gain 100,000.
    const { dr, cr } = drCr(r.legs);
    expect(dr).toBe(600_000);
    expect(cr).toBe(600_000);
    expect(legsBalance(r.legs)).toBe(true);
  });

  it('loss with a cash penalty', () => {
    const r = computeTermination({ carryingLiabilityCents: 600_000, carryingRouCents: 700_000 }, 50_000);
    expect(r.gainLossCents).toBe(-150_000); // 600,000 − 700,000 − 50,000
    // DR Lease Liability 600,000 + DR Loss 150,000 == CR ROU 700,000 + CR Cash 50,000.
    const { dr, cr } = drCr(r.legs);
    expect(dr).toBe(750_000);
    expect(cr).toBe(750_000);
    expect(legsBalance(r.legs)).toBe(true);
  });

  it('gain with a cash penalty', () => {
    const r = computeTermination({ carryingLiabilityCents: 800_000, carryingRouCents: 500_000 }, 100_000);
    expect(r.gainLossCents).toBe(200_000);
    const { dr, cr } = drCr(r.legs);
    expect(dr).toBe(800_000);
    expect(cr).toBe(800_000);
    expect(legsBalance(r.legs)).toBe(true);
  });
});

describe('buildRemainingSchedule — the rebuilt forward schedule ties out exactly', () => {
  it('OPERATING with ROU ≠ liability: both balances clear to zero', () => {
    // From the LOSS scope-reduction above: opening liability 400,000, opening ROU 480,000.
    const lines = buildRemainingSchedule({
      classification: 'OPERATING',
      openingLiabilityCents: 400_000,
      openingRouCents: 480_000,
      paymentCents: 100_000,
      frequency: 'MONTHLY',
      periods: 4,
      annualDiscountRate: 0,
      paymentTiming: 'ARREARS',
      startPeriod: 11,
      startMonthOffset: 10,
    });
    expect(lines).toHaveLength(4);
    expect(lines[0].period).toBe(11);
    expect(lines[0].monthOffset).toBe(10);
    expect(lines[3].period).toBe(14);
    expect(lines[3].liabilityBalanceCents).toBe(0);
    expect(lines[3].rouBalanceCents).toBe(0);
    // Operating single-line expense = (openingROU + payments − openingLiability)/n = 480,000/4.
    expect(lines[0].leaseExpenseCents).toBe(120_000);
    // Every period's journal balances: DR expense + DR principal == CR ROU amort + CR payment.
    for (const l of lines) {
      expect(l.leaseExpenseCents + l.principalReductionCents).toBe(l.rouAmortizationCents + l.paymentCents);
    }
  });

  it('FINANCE with ROU ≠ liability: straight-line amort, both balances clear', () => {
    const lines = buildRemainingSchedule({
      classification: 'FINANCE',
      openingLiabilityCents: 400_000,
      openingRouCents: 480_000,
      paymentCents: 100_000,
      frequency: 'MONTHLY',
      periods: 4,
      annualDiscountRate: 0,
      paymentTiming: 'ARREARS',
      startPeriod: 1,
      startMonthOffset: 0,
    });
    expect(lines[0].rouAmortizationCents).toBe(120_000); // round(480,000 / 4)
    expect(lines[3].liabilityBalanceCents).toBe(0);
    expect(lines[3].rouBalanceCents).toBe(0);
  });

  it('nonzero rate: opening liability = PV of revised payments clears to zero', () => {
    // Revised: 100,000/mo, 6 periods, 6% annual (0.5%/mo). Opening liability = that PV.
    const opening = Math.round(presentValueCents(100_000, 6, 0.005, 'ARREARS'));
    const lines = buildRemainingSchedule({
      classification: 'OPERATING',
      openingLiabilityCents: opening,
      openingRouCents: opening,
      paymentCents: 100_000,
      frequency: 'MONTHLY',
      periods: 6,
      annualDiscountRate: 0.06,
      paymentTiming: 'ARREARS',
      startPeriod: 7,
      startMonthOffset: 6,
    });
    expect(lines[5].liabilityBalanceCents).toBe(0);
    expect(lines[5].rouBalanceCents).toBe(0);
  });
});

describe('revisedLiabilityCents — PV helper', () => {
  it('zero rate is the undiscounted total', () => {
    expect(revisedLiabilityCents({ frequency: 'MONTHLY', paymentTiming: 'ARREARS' }, { paymentCents: 100_000, remainingPeriods: 6, annualDiscountRate: 0 })).toBe(600_000);
  });
});
