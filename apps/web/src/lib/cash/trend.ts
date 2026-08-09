/**
 * Cash balance trend — pure, deterministic reconstruction.
 *
 * We don't store a balance-history table; instead we reconstruct historical
 * closing balances from the live bank balance and the dated transaction feed.
 * Given the current consolidated balance (as of `asOf`) and every bank
 * transaction over the look-back window, the closing balance at the end of any
 * past day D is:
 *
 *     closing(D) = currentTotalCents − Σ amountCents  for every txn dated after D
 *
 * (`amount_cents` is signed in the feed: positive = money in, negative = out, so
 * subtracting the post-D net "rewinds" the balance to that day.)
 *
 * This is exact to the extent the feed is complete; it is transparent and needs
 * no new schema. Money is bigint cents throughout — never floating point.
 */

export interface TrendTxn {
  /** yyyy-mm-dd (transaction/posted date). */
  date: string;
  /** Signed cents: positive = inflow, negative = outflow. */
  amountCents: number;
}

export interface TrendPoint {
  /** yyyy-mm-dd of the week-ending boundary. */
  date: string;
  /** Projected closing balance at end of that day (cents). */
  closingCents: number;
}

export interface BalanceTrend {
  points: TrendPoint[];
  /** First point's balance (start of the window). */
  startCents: number;
  /** Last point's balance (== current total). */
  endCents: number;
  /** end − start over the window. */
  changeCents: number;
  /** Percent change vs the window start; null when start is 0. */
  changePct: number | null;
  minCents: number;
  maxCents: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseIso(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

export interface BuildTrendParams {
  currentTotalCents: number;
  /** Transactions across the accounts in scope (any window ≥ the look-back). */
  txns: TrendTxn[];
  /** Number of weekly points to emit (default 13). */
  weeks?: number;
  /** Override "today"/as-of anchor (tests). Defaults to now. */
  today?: Date;
}

/**
 * Build a weekly balance trend ending at today's current total. Emits `weeks`+1
 * points (one per week-ending boundary, oldest → newest); the final point equals
 * `currentTotalCents`.
 */
export function buildBalanceTrend(params: BuildTrendParams): BalanceTrend {
  const weeks = params.weeks ?? 13;
  const today = params.today ? new Date(params.today) : new Date();
  const anchor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  // Boundary dates: today, today-7, ... today-weeks*7 (ascending after reverse).
  const boundaries: Date[] = [];
  for (let i = weeks; i >= 0; i--) boundaries.push(addDays(anchor, -i * 7));

  // Suffix-net helper: Σ amount for txns strictly after a boundary date.
  const dated = params.txns
    .filter((t) => t && typeof t.amountCents === 'number' && Number.isFinite(t.amountCents))
    .map((t) => ({ t: parseIso(t.date).getTime(), a: Math.trunc(t.amountCents) }))
    .sort((a, b) => a.t - b.t);

  const points: TrendPoint[] = boundaries.map((b) => {
    const cutoff = b.getTime();
    let netAfter = 0;
    // txns are sorted ascending; sum those strictly after the boundary day.
    for (let i = dated.length - 1; i >= 0; i--) {
      if (dated[i].t <= cutoff) break;
      netAfter += dated[i].a;
    }
    return { date: isoDate(b), closingCents: params.currentTotalCents - netAfter };
  });

  const startCents = points[0]?.closingCents ?? params.currentTotalCents;
  const endCents = points[points.length - 1]?.closingCents ?? params.currentTotalCents;
  const changeCents = endCents - startCents;
  const changePct = startCents !== 0 ? (changeCents / Math.abs(startCents)) * 100 : null;
  const minCents = points.reduce((m, p) => Math.min(m, p.closingCents), points[0]?.closingCents ?? 0);
  const maxCents = points.reduce((m, p) => Math.max(m, p.closingCents), points[0]?.closingCents ?? 0);

  return { points, startCents, endCents, changeCents, changePct, minCents, maxCents };
}
