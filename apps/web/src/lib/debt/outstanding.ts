/**
 * Debt outstanding balance as of a date — the ONE derivation the debt register
 * (/debt) and the board package share (audit L7: the board package used original
 * principal, $1.46M, vs $897.8K outstanding on /debt; a matured revolver showed
 * $400K there but $0.00 on /debt). PURE.
 *
 * outstanding(asOf) = principal balance after the latest schedule period whose
 * period_date ≤ asOf; before any period has elapsed it is the schedule's OPENING
 * balance (period 1 balance + period 1 principal — exact for new loans and for
 * loans brought over at a cutover balance). With no schedule, the instrument's
 * recorded principal is used.
 */

export interface DebtScheduleLine {
  period: number;
  period_date: string | null;
  payment_cents: number;
  interest_cents: number;
  principal_cents: number;
  principal_balance_cents: number;
}

export interface OutstandingResult {
  outstandingCents: number;
  /** The next scheduled period after `asOf` (null when none). */
  nextPayment: DebtScheduleLine | null;
  /** True when derived from the amortization schedule (vs recorded principal). */
  fromSchedule: boolean;
}

export function scheduledOutstandingAsOf(
  lines: readonly DebtScheduleLine[],
  asOf: string,
  fallbackPrincipalCents: number,
): OutstandingResult {
  const sorted = [...lines].sort((a, b) => a.period - b.period);
  if (sorted.length === 0) {
    return { outstandingCents: Math.max(0, Math.round(fallbackPrincipalCents)), nextPayment: null, fromSchedule: false };
  }
  let outstanding = Number(sorted[0].principal_balance_cents) + Number(sorted[0].principal_cents);
  let next: DebtScheduleLine | null = null;
  for (const l of sorted) {
    if (l.period_date && l.period_date <= asOf) outstanding = Number(l.principal_balance_cents);
    else if (!next) next = l;
  }
  return { outstandingCents: Math.max(0, Math.round(outstanding)), nextPayment: next, fromSchedule: true };
}
