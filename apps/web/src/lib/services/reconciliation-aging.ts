/**
 * Bank-reconciliation VISIBILITY analytics — the pure, I/O-free core of the
 * "make the outstanding items legible" layer (FPB Bank Reconciliation, deepen
 * Wave B). Two deterministic, unit-testable pieces that sit on top of the same
 * outstanding-item feed the plug/stale detector already loads:
 *
 *   1. AGING. Bucket the outstanding (never-cleared) reconciling items by age as
 *      of the statement date — 0-30 / 31-60 / 61-90 / 90+ — with a count and a
 *      dollar total per bucket, oldest bucket first. This is how a controller
 *      sees, at a glance, how long money has been sitting uncleared: an aged
 *      outstanding check is a void/lost check; an aged deposit-in-transit never
 *      landed.
 *
 *   2. DIFFERENCE DECOMPOSITION. Given the current statement-vs-book difference,
 *      break it into its constituent uncleared lines so the user sees exactly
 *      what makes up the gap. Clearing an outstanding line moves the cleared
 *      balance by its signed amount, so it reduces the difference by that amount.
 *      Whatever the outstanding items do NOT explain is the residual (the plug) —
 *      surfaced for investigation, NEVER forced to $0 (canon §3).
 *
 * All amounts are bigint cents. Line amounts are SIGNED: negative = outflow
 * (payment / check), positive = inflow (deposit). No Supabase, no Date.now — the
 * caller passes the as-of date so the same helper drives the route and the test.
 */

import { ageDaysBetween, type OutstandingItem } from './reconciliation-plug';

// ── 1. Aging ────────────────────────────────────────────────────────────────────

/** One aging band. `maxDays` null = the open-ended oldest band (90+). */
export interface AgingBucketDef {
  key: string;
  label: string;
  minDays: number;
  maxDays: number | null;
}

/**
 * The four standard aging bands, oldest-first is applied at report time; the
 * definitions are listed youngest→oldest. Mirrors the AR/AP aging bands so the
 * whole product reads the same way.
 */
export const AGING_BUCKETS: readonly AgingBucketDef[] = [
  { key: '0_30', label: '0–30 days', minDays: 0, maxDays: 30 },
  { key: '31_60', label: '31–60 days', minDays: 31, maxDays: 60 },
  { key: '61_90', label: '61–90 days', minDays: 61, maxDays: 90 },
  { key: '90_plus', label: '90+ days', minDays: 91, maxDays: null },
] as const;

/** An outstanding item with its computed age + direction. */
export interface AgedItem extends OutstandingItem {
  ageDays: number;
  isOutflow: boolean;
}

/** A single aging band with its rolled-up totals and member items (oldest-first). */
export interface AgingBucket extends AgingBucketDef {
  count: number;
  /** Σ signed amounts in the band. */
  netCents: number;
  /** Σ |negative amounts| — outstanding checks (money out that has not left). */
  outflowCents: number;
  /** Σ positive amounts — deposits in transit (money in that has not landed). */
  inflowCents: number;
  items: AgedItem[];
}

export interface AgingReport {
  asOfDate: string;
  buckets: AgingBucket[];
  totals: { count: number; netCents: number; outflowCents: number; inflowCents: number };
  /** Age of the single oldest outstanding item (0 when there are none). */
  oldestAgeDays: number;
}

/** Pick the band an age (in whole days) falls into. Ages are clamped ≥ 0. */
function bucketDefForAge(ageDays: number): AgingBucketDef {
  for (const b of AGING_BUCKETS) {
    if (ageDays >= b.minDays && (b.maxDays == null || ageDays <= b.maxDays)) return b;
  }
  // Unreachable given the bands span [0, ∞), but fall back to the oldest band.
  return AGING_BUCKETS[AGING_BUCKETS.length - 1];
}

/**
 * Bucket outstanding reconciling items by age as of `asOfDate`. Every band is
 * present in the output (even when empty) so the UI renders a stable grid;
 * within a band items are sorted oldest-first. Pure.
 */
export function bucketOutstandingByAge(
  items: OutstandingItem[],
  opts: { asOfDate: string },
): AgingReport {
  const byKey = new Map<string, AgingBucket>();
  for (const def of AGING_BUCKETS) {
    byKey.set(def.key, { ...def, count: 0, netCents: 0, outflowCents: 0, inflowCents: 0, items: [] });
  }

  let totNet = 0;
  let totOut = 0;
  let totIn = 0;
  let oldestAgeDays = 0;

  for (const it of items) {
    const ageDays = ageDaysBetween(it.transactionDate, opts.asOfDate);
    const cents = Math.trunc(it.amountCents);
    const isOutflow = cents < 0;
    const def = bucketDefForAge(ageDays);
    const bucket = byKey.get(def.key)!;

    bucket.count += 1;
    bucket.netCents += cents;
    if (cents < 0) bucket.outflowCents += -cents;
    else bucket.inflowCents += cents;
    bucket.items.push({ ...it, ageDays, isOutflow });

    totNet += cents;
    if (cents < 0) totOut += -cents;
    else totIn += cents;
    if (ageDays > oldestAgeDays) oldestAgeDays = ageDays;
  }

  // Oldest-first inside each band.
  for (const bucket of byKey.values()) {
    bucket.items.sort((a, b) => b.ageDays - a.ageDays);
  }

  // Oldest band first in the report.
  const buckets = [...AGING_BUCKETS].reverse().map((def) => byKey.get(def.key)!);

  return {
    asOfDate: opts.asOfDate,
    buckets,
    totals: { count: items.length, netCents: totNet, outflowCents: totOut, inflowCents: totIn },
    oldestAgeDays,
  };
}

// ── 2. Difference decomposition ─────────────────────────────────────────────────

/** One line that makes up part of the statement-vs-book difference. */
export interface DifferenceComponent extends AgedItem {
  /**
   * The amount by which clearing this line would move the difference toward $0.
   * Equals the line's signed amount (clearing adds it to the cleared balance,
   * shrinking `statement − cleared`). Positive/negative are informational.
   */
  reducesDifferenceBy: number;
}

export interface DifferenceDecomposition {
  /** The reconciliation difference we are explaining (statement ending − cleared). */
  differenceCents: number;
  /** Σ signed amounts of the outstanding items — the portion the items explain. */
  outstandingNetCents: number;
  /** difference − outstandingNet: what NO outstanding item explains (the plug). */
  residualCents: number;
  /** True when the outstanding items fully account for the difference. */
  fullyExplained: boolean;
  /** Σ |negative| outstanding amounts (aged/current outstanding checks). */
  outstandingChecksCents: number;
  /** Σ positive outstanding amounts (deposits in transit). */
  depositsInTransitCents: number;
  /** The constituent lines, largest absolute amount first. */
  components: DifferenceComponent[];
}

/**
 * Decompose a reconciliation difference into the outstanding lines that make it
 * up, plus the residual no line explains. `differenceCents` is the difference the
 * balance math already computed (statement ending − cleared balance). Pure —
 * decides nothing, posts nothing; it only attributes and labels.
 */
export function decomposeDifference(input: {
  differenceCents: number;
  outstandingItems: OutstandingItem[];
  asOfDate: string;
}): DifferenceDecomposition {
  const diff = Math.trunc(input.differenceCents);
  let net = 0;
  let checks = 0;
  let deposits = 0;

  const components: DifferenceComponent[] = input.outstandingItems.map((it) => {
    const cents = Math.trunc(it.amountCents);
    const isOutflow = cents < 0;
    net += cents;
    if (cents < 0) checks += -cents;
    else deposits += cents;
    return {
      ...it,
      ageDays: ageDaysBetween(it.transactionDate, input.asOfDate),
      isOutflow,
      reducesDifferenceBy: cents,
    };
  });

  // Largest absolute amount first — the biggest reconciling items lead.
  components.sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));

  const residual = diff - net;
  return {
    differenceCents: diff,
    outstandingNetCents: net,
    residualCents: residual,
    fullyExplained: residual === 0,
    outstandingChecksCents: checks,
    depositsInTransitCents: deposits,
    components,
  };
}
