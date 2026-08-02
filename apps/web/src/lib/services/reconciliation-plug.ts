/**
 * Bank-reconciliation plug + stale-item detector — the pure, I/O-free core of the
 * "make the unexplained visible" layer (FPB Bank Reconciliation, Wave B).
 *
 * Two deterministic, unit-testable pieces:
 *
 *   1. STALE outstanding items. A reconciling item (an outstanding check / deposit
 *      that the book records but the statement has not yet cleared) that has sat
 *      un-cleared for longer than a threshold is "stale" — a lost/void check, a
 *      deposit that never landed, or a data-entry error. We FLAG these; a human
 *      investigates. Nothing here voids or writes anything.
 *
 *   2. The PLUG. The residual difference-to-$0 that no adjustment explains. Canon
 *      §3: a reconciliation must tie legitimately, never by a manufactured plug. So
 *      the plug is SURFACED as a number to investigate — it is NEVER auto-posted.
 *      This module only computes and labels it.
 *
 * All amounts are bigint cents. Line amounts are SIGNED: negative = outflow
 * (payment / check), positive = inflow (deposit). No Supabase, no Date.now — the
 * caller passes the as-of date so the same helper drives the route and the test.
 */

/** Default staleness threshold: an outstanding item older than this is flagged. */
export const DEFAULT_STALE_THRESHOLD_DAYS = 30;

/** One outstanding (never-cleared) reconciling item, as loaded from the feed. */
export interface OutstandingItem {
  id: string;
  description: string;
  /** Signed cents: negative = outstanding check (outflow), positive = deposit in transit. */
  amountCents: number;
  /** ISO date (YYYY-MM-DD) the item is dated. */
  transactionDate: string;
}

/** An outstanding item that has aged past the staleness threshold. */
export interface StaleItem extends OutstandingItem {
  /** Whole days between the item date and the as-of date (never negative). */
  ageDays: number;
  /** True when the item is an outstanding check (money out); false = deposit in transit. */
  isOutflow: boolean;
}

/** Whole days from an ISO date to the as-of ISO date (clamped at 0). */
export function ageDaysBetween(itemDate: string, asOfDate: string): number {
  const from = Date.parse(`${itemDate}T00:00:00Z`);
  const to = Date.parse(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

/**
 * Flag every outstanding item whose age exceeds `thresholdDays` as of `asOfDate`.
 * Sorted oldest-first (largest age first) so the most-suspect items lead. Pure.
 */
export function detectStaleItems(
  items: OutstandingItem[],
  opts: { asOfDate: string; thresholdDays?: number },
): StaleItem[] {
  const threshold = opts.thresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;
  const flagged: StaleItem[] = [];
  for (const it of items) {
    const ageDays = ageDaysBetween(it.transactionDate, opts.asOfDate);
    if (ageDays > threshold) {
      flagged.push({ ...it, ageDays, isOutflow: Math.trunc(it.amountCents) < 0 });
    }
  }
  flagged.sort((a, b) => b.ageDays - a.ageDays);
  return flagged;
}

/** Rolled-up totals over a set of stale items (count + signed net + gross outflow/inflow). */
export interface StaleTotals {
  count: number;
  /** Σ signed amounts (net effect the stale items would have on cash if they cleared). */
  netCents: number;
  /** Σ |negative amounts| — aged outstanding checks (money that has not left). */
  outstandingChecksCents: number;
  /** Σ positive amounts — aged deposits in transit (money that has not landed). */
  depositsInTransitCents: number;
}

export function summarizeStaleItems(items: StaleItem[]): StaleTotals {
  let netCents = 0;
  let outstandingChecksCents = 0;
  let depositsInTransitCents = 0;
  for (const it of items) {
    const c = Math.trunc(it.amountCents);
    netCents += c;
    if (c < 0) outstandingChecksCents += -c;
    else depositsInTransitCents += c;
  }
  return { count: items.length, netCents, outstandingChecksCents, depositsInTransitCents };
}

/**
 * The plug assessment: the unexplained residual to $0. `differenceCents` is the
 * reconciliation difference already computed (statement ending − cleared balance);
 * a non-zero value is the plug — the amount that would have to be forced to make
 * the rec tie. We report it; we NEVER post it.
 */
export interface PlugAssessment {
  /** The residual difference-to-$0 (0 = ties). */
  differenceCents: number;
  /** The plug amount (== differenceCents; 0 when it ties). Surfaced, never posted. */
  plugCents: number;
  /** True when there is a non-zero unexplained residual. */
  hasPlug: boolean;
  /** True when the reconciliation ties exactly. */
  ties: boolean;
}

export function assessPlug(differenceCents: number): PlugAssessment {
  const diff = Math.trunc(differenceCents);
  return {
    differenceCents: diff,
    plugCents: diff,
    hasPlug: diff !== 0,
    ties: diff === 0,
  };
}
