/**
 * Debt amortization — the pure, deterministic schedule generator.
 *
 * Given a loan's principal, annual rate, frequency and either a term (number of
 * periods) OR a fixed level payment, this builds the full amortization schedule:
 * for every period the interest, the principal reduction, and the remaining
 * balance. Standard amortizing loans AND interest-only (balloon at maturity) are
 * supported.
 *
 * All money is bigint cents (integers). The periodic rate is applied to the
 * outstanding balance and interest is rounded to the nearest cent each period;
 * the FINAL period trues up the principal so the schedule closes to exactly zero
 * (AMORTIZING) — no floating-point drift ever reaches the ledger. This module has
 * NO database or model dependency and is unit-tested against hand-computed loans.
 */

export type AmortizationMethod = 'AMORTIZING' | 'INTEREST_ONLY';
export type PaymentFrequency = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';

/** Amortization periods per year for each supported frequency. */
export const PERIODS_PER_YEAR: Record<PaymentFrequency, number> = {
  MONTHLY: 12,
  QUARTERLY: 4,
  SEMIANNUAL: 2,
  ANNUAL: 1,
};

/** Month step per period, used to stamp each line's scheduled date. */
export const MONTHS_PER_PERIOD: Record<PaymentFrequency, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  ANNUAL: 12,
};

/** Hard cap so a payment that barely amortizes can never loop forever. */
const MAX_PERIODS = 1200;

export interface AmortizationInput {
  principalCents: number;
  /** Annual interest rate as a PERCENT, e.g. 7.5 means 7.5%. */
  annualRatePercent: number;
  frequency: PaymentFrequency;
  method: AmortizationMethod;
  /** Number of amortization periods (the term). Required for INTEREST_ONLY. */
  termPeriods?: number | null;
  /** A fixed level payment in cents. If set (and no term), the term is derived. */
  paymentCents?: number | null;
  /** Optional origination date (YYYY-MM-DD) to stamp each line's scheduled date. */
  originationDate?: string | null;
}

export interface ScheduleLine {
  period: number; // 1-based
  periodDate: string | null; // YYYY-MM-DD or null
  paymentCents: number;
  interestCents: number;
  principalCents: number;
  /** Remaining principal AFTER this period. */
  principalBalanceCents: number;
}

export interface AmortizationSchedule {
  lines: ScheduleLine[];
  /** The regular level payment (cents) — the last line may differ by a true-up. */
  regularPaymentCents: number;
  totalInterestCents: number;
  totalPaymentCents: number;
  periods: number;
}

export class AmortizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmortizationError';
  }
}

function assertInt(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new AmortizationError(`${label} must be an integer number of cents`);
  }
}

/** Periodic rate as a fraction, e.g. 7.5% annual monthly => 0.00625. */
export function periodicRate(annualRatePercent: number, frequency: PaymentFrequency): number {
  if (!Number.isFinite(annualRatePercent) || annualRatePercent < 0) {
    throw new AmortizationError('annualRatePercent must be a non-negative number');
  }
  return annualRatePercent / 100 / PERIODS_PER_YEAR[frequency];
}

/**
 * The level payment (cents) for a standard amortizing loan:
 *   pmt = P * r / (1 - (1+r)^-n)   (r>0)   |   P / n   (r=0)
 * Rounded to the nearest cent.
 */
export function levelPaymentCents(
  principalCents: number,
  ratePerPeriod: number,
  periods: number,
): number {
  assertInt(principalCents, 'principal');
  if (!Number.isInteger(periods) || periods <= 0) {
    throw new AmortizationError('periods must be a positive integer');
  }
  if (ratePerPeriod === 0) return Math.round(principalCents / periods);
  const factor = Math.pow(1 + ratePerPeriod, -periods);
  const pmt = (principalCents * ratePerPeriod) / (1 - factor);
  return Math.round(pmt);
}

export function addMonthsIso(iso: string, months: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Anchor to the 1st, advance whole months, then clamp the day to month length.
  const base = new Date(Date.UTC(year, month - 1 + months, 1));
  const daysInMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  const d = Math.min(day, daysInMonth);
  const y = base.getUTCFullYear();
  const mo = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mo}-${dd}`;
}

function lineDate(originationDate: string | null | undefined, frequency: PaymentFrequency, period: number): string | null {
  if (!originationDate) return null;
  return addMonthsIso(originationDate, MONTHS_PER_PERIOD[frequency] * period);
}

/**
 * Build the full amortization schedule. Debits/credits are NOT computed here — this
 * is the pure math the posting layer reads from. The schedule always closes to a
 * zero balance for AMORTIZING loans (final-period true-up) and to a balloon of the
 * full principal at maturity for INTEREST_ONLY.
 */
export function buildAmortizationSchedule(input: AmortizationInput): AmortizationSchedule {
  assertInt(input.principalCents, 'principal');
  if (input.principalCents <= 0) throw new AmortizationError('principal must be greater than zero');

  const r = periodicRate(input.annualRatePercent, input.frequency);
  const lines: ScheduleLine[] = [];

  if (input.method === 'INTEREST_ONLY') {
    const n = input.termPeriods ?? null;
    if (!n || !Number.isInteger(n) || n <= 0) {
      throw new AmortizationError('INTEREST_ONLY requires a positive term (number of periods)');
    }
    let balance = input.principalCents;
    for (let p = 1; p <= n; p++) {
      const interest = Math.round(balance * r);
      const isLast = p === n;
      const principal = isLast ? balance : 0; // balloon of full principal at maturity
      const payment = interest + principal;
      balance -= principal;
      lines.push({
        period: p,
        periodDate: lineDate(input.originationDate, input.frequency, p),
        paymentCents: payment,
        interestCents: interest,
        principalCents: principal,
        principalBalanceCents: balance,
      });
    }
    return summarize(lines, lines[0]?.paymentCents ?? 0);
  }

  // AMORTIZING — need a level payment: use the supplied one, else derive from term.
  let payment: number;
  let cap: number;
  if (input.paymentCents != null && input.paymentCents > 0) {
    assertInt(input.paymentCents, 'payment');
    payment = input.paymentCents;
    // A payment that doesn't even cover the first period's interest never amortizes.
    const firstInterest = Math.round(input.principalCents * r);
    if (payment <= firstInterest) {
      throw new AmortizationError(
        'payment does not cover the first period interest — the loan would never amortize',
      );
    }
    cap = input.termPeriods && input.termPeriods > 0 ? input.termPeriods : MAX_PERIODS;
  } else {
    const n = input.termPeriods ?? null;
    if (!n || !Number.isInteger(n) || n <= 0) {
      throw new AmortizationError('provide a term (number of periods) or a fixed payment');
    }
    payment = levelPaymentCents(input.principalCents, r, n);
    cap = n;
  }

  let balance = input.principalCents;
  for (let p = 1; p <= cap && balance > 0; p++) {
    const interest = Math.round(balance * r);
    let principal = payment - interest;
    // Final period (or a term-driven last period): pay off the exact remaining balance.
    const willOverpay = principal >= balance;
    const isTermEnd = cap !== MAX_PERIODS && p === cap;
    if (willOverpay || isTermEnd) {
      principal = balance;
    }
    const linePayment = interest + principal;
    balance -= principal;
    lines.push({
      period: p,
      periodDate: lineDate(input.originationDate, input.frequency, p),
      paymentCents: linePayment,
      interestCents: interest,
      principalCents: principal,
      principalBalanceCents: balance,
    });
  }

  if (balance > 0) {
    throw new AmortizationError('schedule did not fully amortize within the period cap');
  }
  return summarize(lines, payment);
}

function summarize(lines: ScheduleLine[], regularPaymentCents: number): AmortizationSchedule {
  let totalInterest = 0;
  let totalPayment = 0;
  for (const l of lines) {
    totalInterest += l.interestCents;
    totalPayment += l.paymentCents;
  }
  return {
    lines,
    regularPaymentCents,
    totalInterestCents: totalInterest,
    totalPaymentCents: totalPayment,
    periods: lines.length,
  };
}
