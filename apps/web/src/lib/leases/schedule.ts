/**
 * Lease schedule math (ASC 842) — PURE and unit-tested, no I/O.
 *
 * Given the lease terms (payment, frequency, term, discount rate, classification),
 * this computes:
 *   - the initial lease LIABILITY = present value of the remaining lease payments,
 *   - the initial RIGHT-OF-USE (ROU) asset = the liability at commencement, and
 *   - the full amortization SCHEDULE: for each payment period the interest accreted
 *     on the liability, the principal reduction, the closing liability balance, the
 *     ROU amortization, the closing ROU balance, and the period lease expense.
 *
 * OPERATING lease — a single straight-line lease expense (the ASC 842 model for
 * lessee operating leases). The ROU amortization is the PLUG that makes the period
 * expense straight-line: rou_amortization = lease_expense − interest. This keeps the
 * monthly journal balanced by construction (see `lease-posting.ts`) and, because the
 * straight-line expense sums to the total payments and the interest sums to
 * (total payments − liability), the ROU asset clears to exactly zero at the end.
 *
 * FINANCE lease — interest expense (rate × opening liability) PLUS straight-line ROU
 * amortization, so the total period cost is front-loaded. Both the liability and the
 * ROU asset amortize to zero over the term.
 *
 * All money is bigint-range integer CENTS; rounding is absorbed into the final period
 * so every balance ties out exactly. Never uses floating point for stored amounts.
 */

export type LeaseClassification = 'OPERATING' | 'FINANCE';
export type LeaseFrequency = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type PaymentTiming = 'ARREARS' | 'ADVANCE';

export interface LeaseTerms {
  classification: LeaseClassification;
  /** Per-period payment, integer cents, > 0. */
  paymentCents: number;
  frequency: LeaseFrequency;
  /** Total lease term in whole months; must be a multiple of the period length. */
  termMonths: number;
  /** Annual discount / incremental borrowing rate as a decimal (e.g. 0.06 = 6%). >= 0. */
  annualDiscountRate: number;
  /** Payment at period end (ARREARS, default) or period start (ADVANCE). */
  paymentTiming?: PaymentTiming;
}

export interface LeaseScheduleLine {
  /** 1-based payment period. */
  period: number;
  /** Whole months from commencement to the start of this period. */
  monthOffset: number;
  paymentCents: number;
  /** Interest accreted on the liability this period. */
  interestCents: number;
  /** Payment − interest; reduces the lease liability. */
  principalReductionCents: number;
  /** Closing lease-liability balance after this period. */
  liabilityBalanceCents: number;
  /** ROU asset reduction booked this period. */
  rouAmortizationCents: number;
  /** Closing ROU-asset balance after this period. */
  rouBalanceCents: number;
  /** OPERATING: the single straight-line lease expense. FINANCE: interest + amortization. */
  leaseExpenseCents: number;
}

export interface LeaseSchedule {
  classification: LeaseClassification;
  paymentsPerYear: number;
  periods: number;
  /** Per-period rate = annualDiscountRate / paymentsPerYear. */
  periodRate: number;
  /** Present value of the payments at commencement (cents). */
  liabilityCents: number;
  /** ROU asset at commencement (cents) — equals the liability in this model. */
  rouAssetCents: number;
  totalPaymentsCents: number;
  totalInterestCents: number;
  totalLeaseExpenseCents: number;
  lines: LeaseScheduleLine[];
}

export class LeaseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseInputError';
  }
}

const MONTHS_PER_PERIOD: Record<LeaseFrequency, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  ANNUAL: 12,
};

/**
 * Present value of an annuity of `paymentCents` for `n` periods at per-period rate
 * `r`. ARREARS = ordinary annuity; ADVANCE = annuity-due (first payment at t=0).
 * Returned in cents (float — the caller rounds once).
 */
export function presentValueCents(
  paymentCents: number,
  n: number,
  r: number,
  timing: PaymentTiming,
): number {
  if (n <= 0) return 0;
  if (r === 0) return paymentCents * n;
  const ordinary = paymentCents * ((1 - Math.pow(1 + r, -n)) / r);
  return timing === 'ADVANCE' ? ordinary * (1 + r) : ordinary;
}

/**
 * Build the full ASC 842 schedule from the lease terms. Pure — deterministic, no I/O.
 * Throws `LeaseInputError` on invalid terms so callers surface a clear message.
 */
export function buildLeaseSchedule(terms: LeaseTerms): LeaseSchedule {
  const timing: PaymentTiming = terms.paymentTiming ?? 'ARREARS';

  if (!Number.isInteger(terms.paymentCents) || terms.paymentCents <= 0) {
    throw new LeaseInputError('paymentCents must be a positive integer number of cents');
  }
  if (!Number.isInteger(terms.termMonths) || terms.termMonths <= 0) {
    throw new LeaseInputError('termMonths must be a positive whole number of months');
  }
  if (!Number.isFinite(terms.annualDiscountRate) || terms.annualDiscountRate < 0) {
    throw new LeaseInputError('annualDiscountRate must be a finite, non-negative decimal');
  }
  const monthsPerPeriod = MONTHS_PER_PERIOD[terms.frequency];
  if (terms.termMonths % monthsPerPeriod !== 0) {
    throw new LeaseInputError(
      `termMonths (${terms.termMonths}) must be a multiple of the ${terms.frequency.toLowerCase()} period length (${monthsPerPeriod})`,
    );
  }

  const paymentsPerYear = 12 / monthsPerPeriod;
  const periods = terms.termMonths / monthsPerPeriod;
  const periodRate = terms.annualDiscountRate / paymentsPerYear;

  const liabilityCents = Math.round(
    presentValueCents(terms.paymentCents, periods, periodRate, timing),
  );
  const rouAssetCents = liabilityCents; // ROU = liability at commencement (no IDC/incentives in v1)

  const totalPaymentsCents = terms.paymentCents * periods;
  const straightLineExpense = Math.round(totalPaymentsCents / periods);
  const straightLineAmort = Math.round(rouAssetCents / periods);

  const lines: LeaseScheduleLine[] = [];
  let openLiability = liabilityCents;
  let openRou = rouAssetCents;
  let totalInterest = 0;
  let totalLeaseExpense = 0;

  for (let period = 1; period <= periods; period++) {
    const isLast = period === periods;

    // Liability leg: on the last period, clear the balance exactly (rounding lands here).
    let interestCents: number;
    let principalCents: number;
    if (isLast) {
      principalCents = openLiability;
      interestCents = terms.paymentCents - principalCents;
    } else {
      interestCents = Math.round(openLiability * periodRate);
      principalCents = terms.paymentCents - interestCents;
    }
    const closeLiability = openLiability - principalCents;

    // Expense + ROU amortization leg.
    let leaseExpenseCents: number;
    let rouAmortizationCents: number;
    if (terms.classification === 'OPERATING') {
      // Single straight-line lease expense; ROU amort is the plug that keeps the
      // period expense straight-line AND keeps the journal balanced.
      leaseExpenseCents = isLast
        ? totalPaymentsCents - straightLineExpense * (periods - 1)
        : straightLineExpense;
      rouAmortizationCents = leaseExpenseCents - interestCents;
    } else {
      // Finance: straight-line ROU amortization; last period clears the ROU balance.
      rouAmortizationCents = isLast ? openRou : straightLineAmort;
      leaseExpenseCents = interestCents + rouAmortizationCents;
    }
    const closeRou = openRou - rouAmortizationCents;

    lines.push({
      period,
      monthOffset: (period - 1) * monthsPerPeriod,
      paymentCents: terms.paymentCents,
      interestCents,
      principalReductionCents: principalCents,
      liabilityBalanceCents: closeLiability,
      rouAmortizationCents,
      rouBalanceCents: closeRou,
      leaseExpenseCents,
    });

    totalInterest += interestCents;
    totalLeaseExpense += leaseExpenseCents;
    openLiability = closeLiability;
    openRou = closeRou;
  }

  return {
    classification: terms.classification,
    paymentsPerYear,
    periods,
    periodRate,
    liabilityCents,
    rouAssetCents,
    totalPaymentsCents,
    totalInterestCents: totalInterest,
    totalLeaseExpenseCents: totalLeaseExpense,
    lines,
  };
}
