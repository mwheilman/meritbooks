/**
 * Debt lifecycle — the pure, deterministic math for a variable-rate RESET, a
 * REFINANCE rollover, and a PAYOFF settlement. No database, no model, no dates
 * pulled from the clock: every figure is derived from its inputs so the whole
 * thing is unit-testable against hand-computed loans. All money is bigint cents.
 *
 *  - `rebuildScheduleFromReset` rebuilds ONLY the remaining amortization schedule
 *    from the current outstanding balance at a new rate. Already-elapsed periods
 *    (period < resetAtPeriod) are returned untouched; the new tail is renumbered so
 *    it appends cleanly to the preserved head.
 *  - `computeRefinanceRollover` splits the balanced debt-rollover entry (old debt
 *    extinguished, new debt booked, the difference settled in cash either way).
 *  - `computePayoffSettlement` totals the final settlement (remaining principal +
 *    accrued interest payable + any per-diem interest, all against cash).
 *
 * The debit/credit SIDES are assigned by the posting layer from account TYPE
 * (canon §3) — this module only computes the AMOUNTS and the schedule.
 */

import {
  buildAmortizationSchedule,
  AmortizationError,
  addMonthsIso,
  MONTHS_PER_PERIOD,
  type ScheduleLine,
  type PaymentFrequency,
  type AmortizationMethod,
} from './amortization';

// ── Variable-rate reset ────────────────────────────────────────────────────────

/**
 * How the remaining schedule is recast at the new rate:
 *  - RECALC_PAYMENT — keep the remaining term, recompute the level payment (a
 *    standard ARM recast). Interest-only always uses this (the interest payment is
 *    simply re-struck at the new rate; the balloon stays at maturity).
 *  - KEEP_PAYMENT — hold the existing payment and let the term extend/shorten so the
 *    loan still fully amortizes at the new rate (AMORTIZING only).
 */
export type ResetMode = 'RECALC_PAYMENT' | 'KEEP_PAYMENT';

export interface ResetInput {
  /** The FULL current schedule, ordered by period ascending. */
  existingLines: ScheduleLine[];
  /** 1-based period at which the reset takes effect (first recomputed period). */
  resetAtPeriod: number;
  /** New annual rate as a PERCENT, e.g. 8.25 means 8.25%. */
  newAnnualRatePercent: number;
  frequency: PaymentFrequency;
  method: AmortizationMethod;
  mode?: ResetMode;
  /** Date (YYYY-MM-DD) of the first recomputed period, for stamping new dates. */
  resetDate?: string | null;
}

export interface ResetResult {
  /** Periods before the reset — returned exactly as they were. */
  preservedLines: ScheduleLine[];
  /** The recomputed tail, renumbered to continue from the preserved head. */
  newLines: ScheduleLine[];
  /** preservedLines + newLines. */
  fullSchedule: ScheduleLine[];
  /** Outstanding principal entering the reset (the new schedule's opening balance). */
  outstandingBalanceCents: number;
  /** The level payment in effect immediately before the reset. */
  previousPaymentCents: number;
  /** The recomputed level payment (INTEREST_ONLY: the new interest payment). */
  newPaymentCents: number;
  remainingPeriods: number;
  mode: ResetMode;
}

/** Outstanding principal entering `period` (1-based), derived from the schedule. */
function outstandingBeforePeriod(lines: ScheduleLine[], period: number): number {
  if (period <= 1) {
    const first = lines[0];
    if (!first) throw new AmortizationError('cannot reset: the schedule has no lines');
    // Balance before period 1 = balance after period 1 + principal repaid in period 1.
    return first.principalBalanceCents + first.principalCents;
  }
  const prior = lines.find((l) => l.period === period - 1);
  if (!prior) throw new AmortizationError(`cannot reset at period ${period}: no line for period ${period - 1}`);
  return prior.principalBalanceCents;
}

/**
 * Rebuild the remaining amortization schedule at a new rate. Pure and deterministic;
 * throws AmortizationError on impossible inputs (e.g. a held payment that no longer
 * covers interest at the higher rate).
 */
export function rebuildScheduleFromReset(input: ResetInput): ResetResult {
  const mode: ResetMode = input.mode ?? 'RECALC_PAYMENT';
  if (!Number.isInteger(input.resetAtPeriod) || input.resetAtPeriod < 1) {
    throw new AmortizationError('resetAtPeriod must be a positive integer');
  }
  const lines = [...input.existingLines].sort((a, b) => a.period - b.period);
  if (lines.length === 0) throw new AmortizationError('cannot reset: the schedule has no lines');
  if (input.resetAtPeriod > lines.length + 1) {
    throw new AmortizationError('resetAtPeriod is past the end of the schedule — nothing remains to reset');
  }

  const preservedLines = lines.filter((l) => l.period < input.resetAtPeriod);
  const outstanding = outstandingBeforePeriod(lines, input.resetAtPeriod);
  if (outstanding <= 0) throw new AmortizationError('cannot reset: the outstanding balance is zero');

  const atReset = lines.find((l) => l.period === input.resetAtPeriod);
  const previousPaymentCents = atReset?.paymentCents ?? preservedLines[preservedLines.length - 1]?.paymentCents ?? 0;

  // Remaining term = original total periods minus the periods already elapsed.
  const remainingTerm = lines.length - (input.resetAtPeriod - 1);
  if (remainingTerm < 1) throw new AmortizationError('no periods remain to reset');

  let sub;
  if (input.method === 'INTEREST_ONLY') {
    sub = buildAmortizationSchedule({
      principalCents: outstanding,
      annualRatePercent: input.newAnnualRatePercent,
      frequency: input.frequency,
      method: 'INTEREST_ONLY',
      termPeriods: remainingTerm,
    });
  } else if (mode === 'KEEP_PAYMENT') {
    if (previousPaymentCents <= 0) throw new AmortizationError('cannot keep payment: no prior payment on the schedule');
    sub = buildAmortizationSchedule({
      principalCents: outstanding,
      annualRatePercent: input.newAnnualRatePercent,
      frequency: input.frequency,
      method: 'AMORTIZING',
      paymentCents: previousPaymentCents,
    });
  } else {
    sub = buildAmortizationSchedule({
      principalCents: outstanding,
      annualRatePercent: input.newAnnualRatePercent,
      frequency: input.frequency,
      method: 'AMORTIZING',
      termPeriods: remainingTerm,
    });
  }

  const monthsPerPeriod = MONTHS_PER_PERIOD[input.frequency];
  const newLines: ScheduleLine[] = sub.lines.map((l) => {
    const globalPeriod = input.resetAtPeriod + (l.period - 1);
    // Prefer the original date for that period (unchanged payment dates); else step
    // from the reset date; else null.
    const original = lines.find((o) => o.period === globalPeriod)?.periodDate ?? null;
    const stamped = input.resetDate ? addMonthsIso(input.resetDate, monthsPerPeriod * (l.period - 1)) : null;
    return {
      period: globalPeriod,
      periodDate: original ?? stamped,
      paymentCents: l.paymentCents,
      interestCents: l.interestCents,
      principalCents: l.principalCents,
      principalBalanceCents: l.principalBalanceCents,
    };
  });

  return {
    preservedLines,
    newLines,
    fullSchedule: [...preservedLines, ...newLines],
    outstandingBalanceCents: outstanding,
    previousPaymentCents,
    newPaymentCents: sub.regularPaymentCents,
    remainingPeriods: newLines.length,
    mode,
  };
}

// ── Refinance rollover ──────────────────────────────────────────────────────────

export interface RefinanceRollover {
  oldBalanceCents: number;
  newPrincipalCents: number;
  /** DR the old liability to extinguish it (= oldBalanceCents). */
  drOldLiabilityCents: number;
  /** CR the new liability to book the new note (= newPrincipalCents). */
  crNewLiabilityCents: number;
  /** Cash-OUT refi: proceeds received when the new note exceeds the old balance. */
  cashDebitCents: number;
  /** Cash-IN at close: paid down when the old balance exceeds the new note. */
  cashCreditCents: number;
}

function assertNonNegInt(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new AmortizationError(`${label} must be a non-negative integer number of cents`);
  }
}

/**
 * Split the balanced debt-rollover entry. The old note is extinguished at its
 * outstanding balance, the new note is booked at its principal, and the difference
 * is settled in cash (received when borrowing more, paid when borrowing less). The
 * returned amounts always balance: drOld + cashDebit === crNew + cashCredit.
 */
export function computeRefinanceRollover(oldBalanceCents: number, newPrincipalCents: number): RefinanceRollover {
  assertNonNegInt(oldBalanceCents, 'old balance');
  assertNonNegInt(newPrincipalCents, 'new principal');
  if (oldBalanceCents <= 0) throw new AmortizationError('refinance requires a positive outstanding balance');
  if (newPrincipalCents <= 0) throw new AmortizationError('refinance requires a positive new principal');
  const diff = newPrincipalCents - oldBalanceCents;
  return {
    oldBalanceCents,
    newPrincipalCents,
    drOldLiabilityCents: oldBalanceCents,
    crNewLiabilityCents: newPrincipalCents,
    cashDebitCents: diff > 0 ? diff : 0,
    cashCreditCents: diff < 0 ? -diff : 0,
  };
}

// ── Payoff settlement ─────────────────────────────────────────────────────────

export interface PayoffSettlement {
  remainingPrincipalCents: number;
  /** Interest already accrued to Interest Payable that this payoff clears. */
  accruedPayableCents: number;
  /** Extra (per-diem) interest recognized at payoff, expensed directly. */
  additionalInterestCents: number;
  /** Total cash out = principal + accrued payable + additional interest. */
  totalCashCents: number;
}

/**
 * Total the payoff. DR remaining principal (liability) + DR accrued interest
 * (payable, then any per-diem to expense) / CR cash for the whole settlement.
 */
export function computePayoffSettlement(
  remainingPrincipalCents: number,
  accruedPayableCents: number,
  additionalInterestCents: number,
): PayoffSettlement {
  assertNonNegInt(remainingPrincipalCents, 'remaining principal');
  assertNonNegInt(accruedPayableCents, 'accrued payable');
  assertNonNegInt(additionalInterestCents, 'additional interest');
  const total = remainingPrincipalCents + accruedPayableCents + additionalInterestCents;
  if (total <= 0) throw new AmortizationError('payoff has nothing to settle');
  return {
    remainingPrincipalCents,
    accruedPayableCents,
    additionalInterestCents,
    totalCashCents: total,
  };
}
