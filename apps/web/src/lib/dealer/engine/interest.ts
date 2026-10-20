/**
 * Floor-plan interest (FPB §3.2) — pure.
 *
 *   interest = Σ_day balance(day) × rate_bps(day) / 10,000 / basis
 *
 * summed exactly in BigInt over every interest-bearing day in the window and rounded
 * half-up to the cent ONCE per note per period (never per day — no drift).
 *
 * Day rules (documented so lender true-ups are explainable):
 *  - A day d is interest-bearing when d > free_floor_end_date (free floor end =
 *    floored date + free-floor days) and the end-of-day balance on d is > 0. So the
 *    flooring day itself never bears interest and a payoff on day d stops interest on d.
 *  - Balance on day d = original principal − every paydown dated ≤ d.
 *  - While a note is SOLD_UNPAID past its payoff due date, the program's sold-and-unpaid
 *    penalty rate (if any) replaces the base rate for those days.
 *  - Basis: ACT_365 (FPB default) or ACT_360 — a per-program setting because lenders
 *    differ [U].
 */

import { dayNumber } from '../dates';
import { divRoundHalfUp } from '../journal';
import { DealerEngineError, type DayCount } from '../types';

export interface PrincipalEvent {
  /** ISO date the balance changed. */
  date: string;
  /** Signed change in principal (curtailment / payoff are negative). */
  deltaCents: number;
}

export interface InterestInput {
  originalPrincipalCents: number;
  /** Principal changes after flooring (curtailments, payoffs, adjustments). */
  events: PrincipalEvent[];
  freeFloorEndDate: string;
  rateBps: number;
  dayCount: DayCount;
  /** Window: interest for days in (fromExclusive, toInclusive]. */
  fromExclusive: string;
  toInclusive: string;
  /** SOLD_UNPAID: days after this date use penaltyRateBps when set. */
  payoffDueDate?: string | null;
  penaltyRateBps?: number | null;
}

export interface InterestResult {
  interestCents: number;
  interestBearingDays: number;
  penaltyDays: number;
  /** Exact unrounded numerator / denominator, for audit + explain. */
  numerator: string;
  denominator: string;
}

export function basisDays(dayCount: DayCount): number {
  return dayCount === 'ACT_360' ? 360 : 365;
}

/** Effective annual rate for a program row (FIXED or INDEX_PLUS). */
export function effectiveRateBps(p: {
  rate_type: string;
  rate_bps: number;
  index_rate_bps?: number | null;
  spread_bps?: number | null;
}): number {
  if (p.rate_type === 'INDEX_PLUS') {
    if (p.index_rate_bps == null || p.spread_bps == null) {
      throw new DealerEngineError('INDEX_PLUS program needs index_rate_bps and spread_bps');
    }
    return Math.max(0, p.index_rate_bps + p.spread_bps);
  }
  return p.rate_bps;
}

export function computeInterest(input: InterestInput): InterestResult {
  const { originalPrincipalCents: P, rateBps } = input;
  if (!Number.isInteger(P) || P <= 0) throw new DealerEngineError('Principal must be a positive integer of cents');
  if (!Number.isInteger(rateBps) || rateBps < 0) throw new DealerEngineError('Rate must be a non-negative integer of bps');

  const from = dayNumber(input.fromExclusive);
  const to = dayNumber(input.toInclusive);
  const ffe = dayNumber(input.freeFloorEndDate);
  const due = input.payoffDueDate ? dayNumber(input.payoffDueDate) : null;
  const penalty = input.penaltyRateBps ?? null;

  const events = input.events
    .map((e) => ({ day: dayNumber(e.date), delta: e.deltaCents }))
    .sort((a, b) => a.day - b.day);

  let numerator = 0n;
  let days = 0;
  let penaltyDays = 0;
  let balance = P;
  let ei = 0;
  // Apply every event dated on/before the window start.
  while (ei < events.length && events[ei].day <= from) balance += events[ei++].delta;

  for (let d = from + 1; d <= to; d++) {
    while (ei < events.length && events[ei].day <= d) balance += events[ei++].delta;
    if (d <= ffe || balance <= 0) continue;
    const usePenalty = penalty != null && due != null && d > due;
    const rate = usePenalty ? penalty : rateBps;
    numerator += BigInt(balance) * BigInt(rate);
    days++;
    if (usePenalty) penaltyDays++;
  }

  const denominator = 10_000n * BigInt(basisDays(input.dayCount));
  return {
    interestCents: Number(divRoundHalfUp(numerator, denominator)),
    interestBearingDays: days,
    penaltyDays,
    numerator: numerator.toString(),
    denominator: denominator.toString(),
  };
}

export interface TrueUpInput {
  /** What the lender billed / debited for interest. */
  billedCents: number;
  /** The accrued (unbilled) interest this billing clears. */
  accruedCents: number;
  toleranceCents: number;
  toleranceBps: number;
}

export interface TrueUpResult {
  /** billed − accrued (signed): + = more expense, − = less. */
  trueUpCents: number;
  /** The tolerance applied: greater of the floor and bps × billed. */
  toleranceAppliedCents: number;
  withinTolerance: boolean;
}

/** FPB §3.2.3: tolerance = greater of $X or N% of the billed interest. */
export function interestTrueUp(input: TrueUpInput): TrueUpResult {
  for (const [k, v] of Object.entries(input)) {
    if (!Number.isInteger(v) || v < 0) throw new DealerEngineError(`${k} must be a non-negative integer`);
  }
  const trueUp = input.billedCents - input.accruedCents;
  const pct = Number(divRoundHalfUp(BigInt(input.billedCents) * BigInt(input.toleranceBps), 10_000n));
  const tol = Math.max(input.toleranceCents, pct);
  return { trueUpCents: trueUp, toleranceAppliedCents: tol, withinTolerance: Math.abs(trueUp) <= tol };
}
