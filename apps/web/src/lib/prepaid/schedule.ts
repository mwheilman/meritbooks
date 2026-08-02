/**
 * Prepaid-expense amortization schedule — PURE, deterministic, unit-tested.
 *
 * Given a prepaid amount (bigint cents), a start date, and either a number of
 * monthly periods OR a coverage end date, produce the straight-line amortization
 * schedule: for each period, the amount amortized and the prepaid-asset balance
 * REMAINING after that period. Two modes:
 *
 *   - even split (default): each of `months` calendar buckets amortizes
 *     floor(total / months); the FINAL period absorbs the rounding remainder so
 *     the schedule always sums to exactly `total` and ends at a zero balance.
 *     This is what the reused `posting_schedules` table persists (a single
 *     `amount_per_period_cents` + remainder-on-last), so the runner can recompute
 *     an identical schedule from (total, start, months) on every run.
 *
 *   - prorated first/last (`prorateFirstPeriod`): a mid-month start day-prorates
 *     (actual/actual) — the first calendar bucket covers only from the start day
 *     to month end, full months in the middle, and a partial trailing bucket.
 *     Cents are allocated by CUMULATIVE rounding so they never drift and the last
 *     bucket is exact. (Preview/ää proposal math; the persisted schedule is even
 *     split — see the module note in `amortize.ts`.)
 *
 * All money is bigint cents; nothing here does floating-point money arithmetic
 * beyond a single ratio that is immediately rounded back to integer cents.
 */

export interface AmortizationLine {
  /** 0-based period index. */
  index: number;
  year: number;
  /** 1..12 */
  month: number;
  /** 'YYYY-MM' fiscal bucket. */
  period: string;
  /** last calendar day of the bucket month, 'YYYY-MM-DD' — the JE post date. */
  postDate: string;
  /** cents amortized (DR expense / CR prepaid asset) this period. */
  amountCents: number;
  /** prepaid-asset balance remaining AFTER this period. Ends at 0. */
  remainingCents: number;
}

export interface BuildAmortizationInput {
  totalCents: number;
  /** 'YYYY-MM-DD'. */
  startDate: string;
  /** number of monthly periods (>= 1). Supply this OR `endDate`. */
  months?: number;
  /** inclusive coverage end 'YYYY-MM-DD' — an alternative to `months`. */
  endDate?: string;
  /** day-prorate a mid-month start (actual/actual). Ignored when start is the 1st. */
  prorateFirstPeriod?: boolean;
}

/** Thrown for an un-buildable schedule (bad amount / term). */
export class PrepaidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepaidScheduleError';
  }
}

function parseUTC(date: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new PrepaidScheduleError(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    dt.getUTCFullYear() !== Number(y) ||
    dt.getUTCMonth() !== Number(mo) - 1 ||
    dt.getUTCDate() !== Number(d)
  ) {
    throw new PrepaidScheduleError(`Impossible calendar date "${date}"`);
  }
  return dt;
}

/** Year+month (1-based) `n` months after the given start month. */
function addMonths(startYear: number, startMonth1: number, n: number): { year: number; month: number } {
  const base = startYear * 12 + (startMonth1 - 1) + n;
  return { year: Math.floor(base / 12), month: (base % 12) + 1 };
}

function lastDayOfMonth(year: number, month1: number): string {
  return new Date(Date.UTC(year, month1, 0)).toISOString().slice(0, 10);
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** inclusive whole-day count between two UTC dates. */
function daysInclusive(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

/**
 * Derive the number of monthly buckets that a [start, endInclusive] window spans,
 * counting any partial start/end month as a bucket. Always >= 1.
 */
export function derivePeriods(startDate: string, endDateInclusive: string): number {
  const s = parseUTC(startDate);
  const e = parseUTC(endDateInclusive);
  if (e.getTime() < s.getTime()) {
    throw new PrepaidScheduleError('Coverage end is before the start date');
  }
  const months =
    (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  return months + 1;
}

/**
 * Build the straight-line amortization schedule. Never returns an empty array for
 * a valid input; always sums to exactly `totalCents` and ends at a zero balance.
 */
export function buildAmortizationSchedule(input: BuildAmortizationInput): AmortizationLine[] {
  const total = Math.trunc(input.totalCents);
  if (!Number.isFinite(total) || total <= 0) {
    throw new PrepaidScheduleError('Prepaid amount must be a positive number of cents');
  }
  const start = parseUTC(input.startDate);
  const startDay = start.getUTCDate();

  // Resolve the number of monthly buckets.
  let months: number;
  if (typeof input.months === 'number') {
    months = Math.trunc(input.months);
  } else if (input.endDate) {
    months = derivePeriods(input.startDate, input.endDate);
  } else {
    throw new PrepaidScheduleError('Provide either `months` or `endDate`');
  }
  if (months < 1) throw new PrepaidScheduleError('Term must be at least one period');

  const prorate = Boolean(input.prorateFirstPeriod) && startDay > 1;

  return prorate
    ? buildProrated(total, start, months)
    : buildEvenSplit(total, start.getUTCFullYear(), start.getUTCMonth() + 1, months);
}

/** Even split: floor per period, remainder on the last period. */
function buildEvenSplit(total: number, startYear: number, startMonth1: number, months: number): AmortizationLine[] {
  const per = Math.floor(total / months);
  const lines: AmortizationLine[] = [];
  let remaining = total;
  for (let i = 0; i < months; i++) {
    const { year, month } = addMonths(startYear, startMonth1, i);
    const amount = i === months - 1 ? remaining : per;
    remaining -= amount;
    lines.push({
      index: i,
      year,
      month,
      period: `${year}-${String(month).padStart(2, '0')}`,
      postDate: lastDayOfMonth(year, month),
      amountCents: amount,
      remainingCents: remaining,
    });
  }
  return lines;
}

/**
 * Prorated actual/actual over the coverage window [start, start+months−1 day].
 * Cumulative rounding keeps cents exact and makes the last bucket self-correcting.
 */
function buildProrated(total: number, start: Date, months: number): AmortizationLine[] {
  // Coverage of `months` whole months from `start`: end = start + months months − 1 day.
  const endExclusive = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate()),
  );
  const endInclusive = new Date(endExclusive.getTime() - 86_400_000);
  const totalDays = daysInclusive(start, endInclusive);

  const lines: AmortizationLine[] = [];
  let cumDays = 0;
  let cumAmount = 0;
  let cursor = new Date(start.getTime());
  let idx = 0;

  while (cursor.getTime() <= endInclusive.getTime()) {
    const y = cursor.getUTCFullYear();
    const m1 = cursor.getUTCMonth() + 1;
    const monthEnd = new Date(Date.UTC(y, m1 - 1, daysInMonth(y, m1)));
    const bucketEnd = monthEnd.getTime() < endInclusive.getTime() ? monthEnd : endInclusive;

    cumDays += daysInclusive(cursor, bucketEnd);
    const targetCum = Math.round((total * cumDays) / totalDays);
    const amount = targetCum - cumAmount;
    cumAmount = targetCum;
    const remaining = total - cumAmount;

    lines.push({
      index: idx,
      year: y,
      month: m1,
      period: `${y}-${String(m1).padStart(2, '0')}`,
      postDate: lastDayOfMonth(y, m1),
      amountCents: amount,
      remainingCents: remaining,
    });

    idx += 1;
    cursor = new Date(Date.UTC(y, m1, 1)); // first day of next month
  }

  // Cumulative rounding guarantees the last remaining is 0, but be defensive.
  if (lines.length > 0 && lines[lines.length - 1].remainingCents !== 0) {
    const last = lines[lines.length - 1];
    last.amountCents += last.remainingCents;
    last.remainingCents = 0;
  }
  return lines;
}

/** Convenience: the even-split per-period amount the persisted schedule stores. */
export function evenPerPeriodCents(totalCents: number, months: number): number {
  if (months < 1) throw new PrepaidScheduleError('Term must be at least one period');
  return Math.floor(Math.trunc(totalCents) / months);
}
