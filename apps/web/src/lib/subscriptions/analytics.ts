/**
 * Subscription analytics — PURE, deterministic, I/O-free, unit-tested. No DB, no clock
 * (an `asOf` is always passed). Builds the deepened Subscription-Catcher views ENTIRELY
 * from data the detector already produced (amount, prior amount, cadence, first-seen /
 * last-charged dates, creep flags, status) — it never re-detects, never writes, never
 * posts. All money is bigint cents.
 *
 *   • monthlyRunRateTrend — a trailing month-by-month recurring-spend run-rate series,
 *     rebuilt from each subscription's first-seen date (when the commitment appeared) and,
 *     when a price increase is known, stepped up at the last-charged date. This is the
 *     "spend trend" behind the run-rate summary.
 *   • priceCreepList — every subscription whose charge rose vs its prior steady amount,
 *     with the per-charge delta, the % jump, and the ANNUALIZED impact of the increase.
 *   • annualized / monthly-equivalent helpers shared by the summary + creep views.
 */

export const CADENCE_ANNUAL_FACTOR: Record<string, number> = {
  MONTHLY: 12,
  QUARTERLY: 4,
  ANNUAL: 1,
  OTHER: 12,
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isoToUtc(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

/** Charges-per-year multiplier for a cadence (unknown ⇒ treated as monthly). */
export function annualFactor(cadence: string | null | undefined): number {
  return CADENCE_ANNUAL_FACTOR[(cadence ?? '').toUpperCase()] ?? 12;
}

/** Monthly-equivalent of a per-charge amount at a cadence (cents). Never negative. */
export function monthlyEquivalentCents(amountCents: number | null | undefined, cadence: string): number {
  const amt = typeof amountCents === 'number' ? amountCents : 0;
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  return Math.round((amt * annualFactor(cadence)) / 12);
}

/** Annualized run-rate of a per-charge amount at a cadence (cents). Never negative. */
export function annualizedFromAmount(amountCents: number | null | undefined, cadence: string): number {
  const amt = typeof amountCents === 'number' ? amountCents : 0;
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  return Math.round(amt * annualFactor(cadence));
}

// ─────────────────────────────────────────────────────────────────────────────
// Run-rate trend (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface TrendSubscription {
  amount_cents: number | null;
  prior_amount_cents: number | null;
  billing_cadence: string;
  first_seen_date: string | null;
  last_charged_date: string | null;
  status: string;
}

export interface TrendPoint {
  /** yyyy-mm bucket key (UTC). */
  month: string;
  /** Short month label, e.g. "Aug". */
  label: string;
  /** Recurring monthly run-rate committed as of the END of this month (cents). */
  totalCents: number;
  /** How many live subscriptions were contributing that month. */
  count: number;
}

/**
 * Rebuild a trailing monthly run-rate series ending at `asOf`'s month.
 *
 * For each month M we sum the monthly-equivalent of every subscription that was live by
 * the end of M — "live" = first_seen_date on/before end-of-M and status ≠ CANCELLED. When
 * a subscription carries a known price increase (prior_amount_cents set) and its latest
 * charge is AFTER month M, we use the PRIOR amount for M — so the trend shows the step-up
 * where the creep actually landed. Deterministic; never throws.
 */
export function monthlyRunRateTrend(
  subs: readonly TrendSubscription[],
  asOf: string,
  monthsBack = 12,
): TrendPoint[] {
  const anchor = isoToUtc(asOf);
  if (anchor === null || !Array.isArray(subs)) return [];
  const a = new Date(anchor);
  const n = Math.max(1, Math.min(36, Math.trunc(monthsBack)));

  const points: TrendPoint[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const first = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() - i, 1));
    const year = first.getUTCFullYear();
    const monthIdx = first.getUTCMonth();
    const endMs = Date.UTC(year, monthIdx + 1, 0); // last day of the month, UTC midnight

    let total = 0;
    let count = 0;
    for (const s of subs) {
      if (!s || s.status === 'CANCELLED') continue;
      const amt = s.amount_cents ?? 0;
      if (!Number.isFinite(amt) || amt <= 0) continue;

      const seen = isoToUtc(s.first_seen_date);
      if (seen !== null && seen > endMs) continue; // hadn't appeared yet

      let effective = amt;
      const prior = s.prior_amount_cents;
      const lastCharged = isoToUtc(s.last_charged_date);
      if (typeof prior === 'number' && prior > 0 && lastCharged !== null && lastCharged > endMs) {
        effective = prior; // the increase hadn't taken effect by end of this month
      }

      total += monthlyEquivalentCents(effective, s.billing_cadence);
      count += 1;
    }

    points.push({
      month: `${year}-${String(monthIdx + 1).padStart(2, '0')}`,
      label: MONTH_LABELS[monthIdx],
      totalCents: total,
      count,
    });
  }
  return points;
}

export interface TrendDelta {
  firstCents: number;
  lastCents: number;
  deltaCents: number;
  pct: number;
}

/** First→last change across a trend series (for the "up X% over N months" readout). */
export function trendDelta(points: readonly TrendPoint[]): TrendDelta {
  if (!points || points.length === 0) return { firstCents: 0, lastCents: 0, deltaCents: 0, pct: 0 };
  const firstCents = points[0].totalCents;
  const lastCents = points[points.length - 1].totalCents;
  const deltaCents = lastCents - firstCents;
  const pct = firstCents > 0 ? deltaCents / firstCents : 0;
  return { firstCents, lastCents, deltaCents, pct };
}

// ─────────────────────────────────────────────────────────────────────────────
// Price-creep list (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreepSubscription {
  id: string;
  vendor_name: string;
  product: string | null;
  category: string | null;
  billing_cadence: string;
  amount_cents: number | null;
  prior_amount_cents: number | null;
  next_renewal_date: string | null;
  last_charged_date: string | null;
  status: string;
  creep_flags?: string[] | null;
}

export interface PriceCreepItem {
  id: string;
  vendor_name: string;
  product: string | null;
  category: string | null;
  billing_cadence: string;
  priorCents: number;
  currentCents: number;
  /** Per-charge increase (currentCents − priorCents), always > 0. */
  deltaCents: number;
  /** Relative jump (delta / prior). */
  pct: number;
  /** Annualized cost of the increase at this cadence (cents). */
  annualizedDeltaCents: number;
  next_renewal_date: string | null;
  last_charged_date: string | null;
  status: string;
}

/**
 * Every LIVE subscription whose latest charge rose over its prior steady amount, ranked by
 * the ANNUALIZED cost of the increase (biggest bleed first). Uses the detector's
 * `prior_amount_cents` (set only when a material increase was found); cancelled
 * subscriptions are excluded. Pure; never throws.
 */
export function priceCreepList(subs: readonly CreepSubscription[]): PriceCreepItem[] {
  if (!Array.isArray(subs)) return [];
  const out: PriceCreepItem[] = [];
  for (const s of subs) {
    if (!s || s.status === 'CANCELLED') continue;
    const currentCents = s.amount_cents ?? 0;
    const priorCents = s.prior_amount_cents;
    if (typeof priorCents !== 'number' || priorCents <= 0) continue;
    if (!Number.isFinite(currentCents) || currentCents <= priorCents) continue;

    const deltaCents = currentCents - priorCents;
    out.push({
      id: s.id,
      vendor_name: s.vendor_name,
      product: s.product ?? null,
      category: s.category ?? null,
      billing_cadence: s.billing_cadence,
      priorCents,
      currentCents,
      deltaCents,
      pct: priorCents > 0 ? deltaCents / priorCents : 0,
      annualizedDeltaCents: annualizedFromAmount(deltaCents, s.billing_cadence),
      next_renewal_date: s.next_renewal_date ?? null,
      last_charged_date: s.last_charged_date ?? null,
      status: s.status,
    });
  }
  out.sort((x, y) => y.annualizedDeltaCents - x.annualizedDeltaCents || x.vendor_name.localeCompare(y.vendor_name));
  return out;
}

/** Total annualized cost of all detected price increases (cents). */
export function totalAnnualizedCreepCents(items: readonly PriceCreepItem[]): number {
  return (items ?? []).reduce((sum, i) => sum + (i.annualizedDeltaCents || 0), 0);
}
