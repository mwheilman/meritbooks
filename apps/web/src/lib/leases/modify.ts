/**
 * Lease remeasurement math (ASC 842) — PURE and unit-tested, no I/O.
 *
 * Extends the leases module with the three post-commencement events every real
 * lease portfolio has:
 *
 *   1. MODIFICATION  — a change to the contract (revised payment, extended/shortened
 *      term, revised discount rate) effective from a period forward. The lease
 *      liability is REMEASURED to the present value of the revised remaining payments
 *      at the revised discount rate, and the ROU asset is adjusted by the SAME delta
 *      (ASC 842-10-25-11). A *reduction in scope* (shorter term / reduced payments)
 *      is a partial termination: the ROU is reduced in proportion to the reduction in
 *      the liability and the difference is a P&L gain/loss (ASC 842-10-25-13).
 *
 *   2. CPI / INDEX RESET — an index/CPI-based payment change at a reset date. For an
 *      operating lease this is a remeasurement of the liability using the revised
 *      payments discounted at the ORIGINAL rate (the discount rate is NOT updated for
 *      an index-only change); the ROU is adjusted by the same amount, no P&L. It is
 *      the modification remeasurement with rate + remaining term held constant.
 *
 *   3. EARLY TERMINATION — end the lease at a period: write off the remaining ROU and
 *      liability, book any termination penalty in cash, and recognize the balancing
 *      gain/loss.
 *
 * Every result carries the exact balanced journal legs (by ROLE) so the API can both
 * PREVIEW the numbers for a human and POST them unchanged on confirm. All money is
 * integer CENTS; never floating point for stored amounts.
 */

import {
  presentValueCents,
  LeaseInputError,
  type LeaseClassification,
  type LeaseFrequency,
  type PaymentTiming,
} from './schedule';
import type { LeaseRoleKey } from './lease-accounts';

/** Roles a remeasurement leg can address (lease families + gain/loss + cash). */
export type RemeasureLegRole =
  | LeaseRoleKey
  | 'GAIN_ON_DISPOSAL'
  | 'LOSS_ON_DISPOSAL'
  | 'OPERATING_BANK';

export interface RemeasureLeg {
  role: RemeasureLegRole;
  debitCents: number;
  creditCents: number;
  memo: string;
}

export type ModificationTreatment = 'REMEASUREMENT' | 'SCOPE_REDUCTION';

const MONTHS_PER_PERIOD: Record<LeaseFrequency, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  ANNUAL: 12,
};

/** The lease's carrying state at the effective (remeasurement) date. */
export interface LeaseCarryingState {
  classification: LeaseClassification;
  frequency: LeaseFrequency;
  paymentTiming: PaymentTiming;
  /** Remaining lease-liability balance immediately before the remeasurement. */
  carryingLiabilityCents: number;
  /** Remaining ROU-asset balance immediately before the remeasurement. */
  carryingRouCents: number;
}

/** The revised remaining terms proposed by the modification. */
export interface RevisedTerms {
  /** Revised per-period payment, integer cents, > 0. */
  paymentCents: number;
  /** Revised number of remaining periods, > 0. */
  remainingPeriods: number;
  /** Revised annual discount rate as a decimal (>= 0). */
  annualDiscountRate: number;
}

export interface RemeasurementResult {
  treatment: ModificationTreatment;
  /** Remeasured liability = PV of the revised remaining payments at the revised rate. */
  revisedLiabilityCents: number;
  /** ROU-asset balance AFTER the adjustment (opening for the rebuilt schedule). */
  newRouCents: number;
  /** revisedLiability − carryingLiability (signed). */
  liabilityDeltaCents: number;
  /** newRou − carryingRou (signed). */
  rouDeltaCents: number;
  /** + gain / − loss recognized in P&L (nonzero only for a scope reduction or ROU floor). */
  gainLossCents: number;
  /** The balanced adjusting journal legs (empty when the remeasurement is a no-op). */
  legs: RemeasureLeg[];
}

function paymentsPerYear(frequency: LeaseFrequency): number {
  return 12 / MONTHS_PER_PERIOD[frequency];
}

/** PV of the revised remaining payments (rounded to whole cents). */
export function revisedLiabilityCents(
  state: Pick<LeaseCarryingState, 'frequency' | 'paymentTiming'>,
  revised: RevisedTerms,
): number {
  if (!Number.isInteger(revised.paymentCents) || revised.paymentCents <= 0) {
    throw new LeaseInputError('revised paymentCents must be a positive integer number of cents');
  }
  if (!Number.isInteger(revised.remainingPeriods) || revised.remainingPeriods <= 0) {
    throw new LeaseInputError('revised remainingPeriods must be a positive whole number');
  }
  if (!Number.isFinite(revised.annualDiscountRate) || revised.annualDiscountRate < 0) {
    throw new LeaseInputError('revised annualDiscountRate must be a finite, non-negative decimal');
  }
  const periodRate = revised.annualDiscountRate / paymentsPerYear(state.frequency);
  return Math.round(
    presentValueCents(revised.paymentCents, revised.remainingPeriods, periodRate, state.paymentTiming),
  );
}

/**
 * Remeasure a lease liability + ROU asset for a modification or CPI reset.
 *
 * `scopeReduction` forces the partial-termination (proportionate) treatment; when
 * omitted it is INFERRED — a strictly smaller remeasured liability that also drops the
 * remaining-period count is treated as a reduction in scope. A pure repricing (rate or
 * index change, or an increase in scope) is an ordinary remeasurement with no P&L.
 */
export function remeasureLease(
  state: LeaseCarryingState,
  revised: RevisedTerms,
  currentRemainingPeriods: number,
  scopeReduction?: boolean,
): RemeasurementResult {
  if (state.carryingLiabilityCents < 0 || state.carryingRouCents < 0) {
    throw new LeaseInputError('carrying balances must be non-negative');
  }
  const revisedLiability = revisedLiabilityCents(state, revised);

  const isScopeReduction =
    scopeReduction ??
    (revised.remainingPeriods < currentRemainingPeriods && revisedLiability < state.carryingLiabilityCents);

  if (isScopeReduction) {
    // Partial termination (ASC 842-10-25-13): reduce ROU in proportion to the decrease
    // in the liability; the difference is a gain/loss. A negative decrease (the "reduced
    // scope" actually raised the liability) is impossible to treat proportionately, so
    // guard it back to an ordinary remeasurement.
    const liabilityReduction = state.carryingLiabilityCents - revisedLiability;
    if (liabilityReduction <= 0 || state.carryingLiabilityCents === 0) {
      return remeasureLease(state, revised, currentRemainingPeriods, false);
    }
    const proportion = liabilityReduction / state.carryingLiabilityCents;
    const rouReduction = Math.round(state.carryingRouCents * proportion);
    const newRou = state.carryingRouCents - rouReduction;
    // Gain when the liability written off exceeds the ROU written off; loss otherwise.
    const gainLoss = liabilityReduction - rouReduction;

    const legs: RemeasureLeg[] = [
      { role: 'LEASE_LIABILITY', debitCents: liabilityReduction, creditCents: 0, memo: 'Partial termination — reduce lease liability' },
      { role: 'ROU_ASSET', debitCents: 0, creditCents: rouReduction, memo: 'Partial termination — reduce ROU asset' },
    ];
    if (gainLoss > 0) {
      legs.push({ role: 'GAIN_ON_DISPOSAL', debitCents: 0, creditCents: gainLoss, memo: 'Gain on lease scope reduction' });
    } else if (gainLoss < 0) {
      legs.push({ role: 'LOSS_ON_DISPOSAL', debitCents: -gainLoss, creditCents: 0, memo: 'Loss on lease scope reduction' });
    }

    return {
      treatment: 'SCOPE_REDUCTION',
      revisedLiabilityCents: revisedLiability,
      newRouCents: newRou,
      liabilityDeltaCents: revisedLiability - state.carryingLiabilityCents,
      rouDeltaCents: newRou - state.carryingRouCents,
      gainLossCents: gainLoss,
      legs: legs.filter((l) => l.debitCents !== 0 || l.creditCents !== 0),
    };
  }

  // Ordinary remeasurement: adjust ROU by the same amount as the liability, no P&L —
  // UNLESS a downward remeasurement would drive the ROU below zero, in which case the
  // ROU floors at zero and the excess is recognized as a gain (ASC 842-10-35-4).
  const liabilityDelta = revisedLiability - state.carryingLiabilityCents;
  let newRou = state.carryingRouCents + liabilityDelta;
  let gainLoss = 0;
  const legs: RemeasureLeg[] = [];

  if (newRou < 0) {
    gainLoss = -newRou; // gain: the write-down exceeded the ROU carrying amount
    newRou = 0;
    legs.push({ role: 'LEASE_LIABILITY', debitCents: -liabilityDelta, creditCents: 0, memo: 'Remeasure — reduce lease liability' });
    legs.push({ role: 'ROU_ASSET', debitCents: 0, creditCents: state.carryingRouCents, memo: 'Remeasure — write ROU to zero' });
    legs.push({ role: 'GAIN_ON_DISPOSAL', debitCents: 0, creditCents: gainLoss, memo: 'Gain on lease remeasurement' });
  } else if (liabilityDelta > 0) {
    legs.push({ role: 'ROU_ASSET', debitCents: liabilityDelta, creditCents: 0, memo: 'Remeasure — increase ROU asset' });
    legs.push({ role: 'LEASE_LIABILITY', debitCents: 0, creditCents: liabilityDelta, memo: 'Remeasure — increase lease liability' });
  } else if (liabilityDelta < 0) {
    legs.push({ role: 'LEASE_LIABILITY', debitCents: -liabilityDelta, creditCents: 0, memo: 'Remeasure — reduce lease liability' });
    legs.push({ role: 'ROU_ASSET', debitCents: 0, creditCents: -liabilityDelta, memo: 'Remeasure — reduce ROU asset' });
  }

  return {
    treatment: 'REMEASUREMENT',
    revisedLiabilityCents: revisedLiability,
    newRouCents: newRou,
    liabilityDeltaCents: liabilityDelta,
    rouDeltaCents: newRou - state.carryingRouCents,
    gainLossCents: gainLoss,
    legs: legs.filter((l) => l.debitCents !== 0 || l.creditCents !== 0),
  };
}

export interface TerminationResult {
  /** Lease liability written off (the carrying balance). */
  writeoffLiabilityCents: number;
  /** ROU asset written off (the carrying balance). */
  writeoffRouCents: number;
  /** Termination penalty paid in cash (>= 0). */
  penaltyCents: number;
  /** + gain / − loss = liability − ROU − penalty. */
  gainLossCents: number;
  legs: RemeasureLeg[];
}

/**
 * Early termination at a period: write off the remaining ROU + liability, pay any
 * penalty, and recognize the balancing gain/loss. The entry balances by construction:
 *   DR Lease Liability (carrying)  CR ROU Asset (carrying)  CR Cash (penalty)  ± gain/loss.
 */
export function computeTermination(
  state: Pick<LeaseCarryingState, 'carryingLiabilityCents' | 'carryingRouCents'>,
  penaltyCents = 0,
): TerminationResult {
  if (!Number.isInteger(penaltyCents) || penaltyCents < 0) {
    throw new LeaseInputError('penaltyCents must be a non-negative integer number of cents');
  }
  if (state.carryingLiabilityCents < 0 || state.carryingRouCents < 0) {
    throw new LeaseInputError('carrying balances must be non-negative');
  }

  const gainLoss = state.carryingLiabilityCents - state.carryingRouCents - penaltyCents;

  const legs: RemeasureLeg[] = [];
  if (state.carryingLiabilityCents > 0) {
    legs.push({ role: 'LEASE_LIABILITY', debitCents: state.carryingLiabilityCents, creditCents: 0, memo: 'Terminate lease — write off liability' });
  }
  if (state.carryingRouCents > 0) {
    legs.push({ role: 'ROU_ASSET', debitCents: 0, creditCents: state.carryingRouCents, memo: 'Terminate lease — write off ROU asset' });
  }
  if (penaltyCents > 0) {
    legs.push({ role: 'OPERATING_BANK', debitCents: 0, creditCents: penaltyCents, memo: 'Termination penalty paid' });
  }
  if (gainLoss > 0) {
    legs.push({ role: 'GAIN_ON_DISPOSAL', debitCents: 0, creditCents: gainLoss, memo: 'Gain on lease termination' });
  } else if (gainLoss < 0) {
    legs.push({ role: 'LOSS_ON_DISPOSAL', debitCents: -gainLoss, creditCents: 0, memo: 'Loss on lease termination' });
  }

  return {
    writeoffLiabilityCents: state.carryingLiabilityCents,
    writeoffRouCents: state.carryingRouCents,
    penaltyCents,
    gainLossCents: gainLoss,
    legs,
  };
}

/** Assert a set of legs balances (debits === credits and non-empty). Used in tests + posting. */
export function legsBalance(legs: RemeasureLeg[]): boolean {
  if (legs.length < 2) return false;
  const dr = legs.reduce((s, l) => s + l.debitCents, 0);
  const cr = legs.reduce((s, l) => s + l.creditCents, 0);
  return dr === cr && dr > 0;
}
