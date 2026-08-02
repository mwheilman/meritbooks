/**
 * Subscription Catcher — recurrence detection + creep classification. PURE, I/O-free,
 * deterministic, unit-tested. No DB, no gateway, no clock (an `asOf` is always passed).
 *
 * The catch a bolt-on can't make: from the tenant's OWN bank-feed + AP history we group
 * charges by normalized vendor, infer a regular billing cadence, and surface each
 * recurring subscription with its typical amount and computed next-renewal date. Then we
 * flag "creep" with DETERMINISTIC signals:
 *   • NEW               — first charge is recent (a subscription that just appeared).
 *   • PRICE_INCREASE    — the latest charge rose materially vs the prior steady amount.
 *   • DUPLICATE_CATEGORY— two+ live subscriptions in the same SaaS category (overlap).
 *   • STALE             — no charge for materially longer than the expected interval
 *                          (a zombie: still "on the books" but possibly abandoned).
 *
 * Nothing here writes, posts, or cancels — it returns proposals. A human keeps/cancels
 * downstream (canon §3: AI proposes facts; a human acts). All money is bigint cents.
 */

import { normalizeText } from '@/lib/services/reconciliation-match';

export const BILLING_CADENCES = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'OTHER'] as const;
export type BillingCadence = (typeof BILLING_CADENCES)[number];

export const CREEP_FLAGS = ['NEW', 'PRICE_INCREASE', 'DUPLICATE_CATEGORY', 'STALE'] as const;
export type CreepFlag = (typeof CREEP_FLAGS)[number];

// ── Tunable thresholds (single source of truth so they can't drift) ─────────────
export const SUB_THRESHOLDS = {
  /** a vendor needs at least this many charges to be a candidate subscription. */
  minCharges: 2,
  /** interval bands (days) that map to a named cadence. */
  monthlyMin: 24,
  monthlyMax: 38,
  quarterlyMin: 78,
  quarterlyMax: 105,
  annualMin: 330,
  annualMax: 400,
  /** fraction of intervals that must sit inside the modal band to call it regular. */
  minRegularity: 0.5,
  /** relative amount jump (latest vs prior steady) that counts as a price increase. */
  priceIncreaseRel: 0.05,
  /** a subscription first seen within this many days of `asOf` is NEW. */
  newWindowDays: 90,
  /** no charge for interval * this factor ⇒ STALE (zombie). */
  staleFactor: 1.6,
  /** cap on charge ids persisted per subscription (jsonb size guard). */
  maxTxnIds: 400,
} as const;

const CADENCE_DAYS: Record<Exclude<BillingCadence, 'OTHER'>, number> = {
  MONTHLY: 30,
  QUARTERLY: 91,
  ANNUAL: 365,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers (pure). Dates are yyyy-mm-dd; comparisons are UTC-midnight.
// ─────────────────────────────────────────────────────────────────────────────
function isoToUtc(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

/** Whole-day difference (b - a). Null if either is unparseable. */
export function daysBetween(aIso: string, bIso: string): number | null {
  const a = isoToUtc(aIso);
  const b = isoToUtc(bIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/** yyyy-mm-dd `n` days after `iso`. Null when `iso` is malformed. */
export function addDaysIso(iso: string, n: number): string | null {
  const base = isoToUtc(iso);
  if (base === null) return null;
  return new Date(base + n * MS_PER_DAY).toISOString().slice(0, 10);
}

function median(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cadence inference (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/** Map a per-charge interval (days) to a named cadence band. */
export function cadenceForInterval(intervalDays: number): BillingCadence {
  const T = SUB_THRESHOLDS;
  if (intervalDays >= T.monthlyMin && intervalDays <= T.monthlyMax) return 'MONTHLY';
  if (intervalDays >= T.quarterlyMin && intervalDays <= T.quarterlyMax) return 'QUARTERLY';
  if (intervalDays >= T.annualMin && intervalDays <= T.annualMax) return 'ANNUAL';
  return 'OTHER';
}

export interface Cadence {
  /** the modal interval between charges, in days. */
  intervalDays: number;
  /** the named cadence for that interval. */
  cadence: BillingCadence;
  /** fraction of intervals within ±25% of the modal interval (0..1). */
  regularity: number;
}

/**
 * Infer a billing cadence from charge dates (any order). Needs ≥2 dates (≥1 interval).
 * `intervalDays` is the median gap; `regularity` is how tightly the gaps cluster.
 */
export function detectCadence(datesIso: readonly string[]): Cadence | null {
  const times = datesIso
    .map(isoToUtc)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  if (times.length < 2) return null;

  const intervals: number[] = [];
  for (let i = 1; i < times.length; i++) {
    intervals.push(Math.round((times[i] - times[i - 1]) / MS_PER_DAY));
  }
  const nonZero = intervals.filter((d) => d > 0);
  if (nonZero.length === 0) return null;

  const intervalDays = median(nonZero);
  if (intervalDays <= 0) return null;

  const tol = Math.max(3, intervalDays * 0.25);
  const within = nonZero.filter((d) => Math.abs(d - intervalDays) <= tol).length;
  const regularity = within / nonZero.length;

  return { intervalDays, cadence: cadenceForInterval(intervalDays), regularity };
}

/** Next renewal date = last charge + one cadence interval. Null when undatable. */
export function nextRenewalDate(
  lastChargedIso: string,
  cadence: BillingCadence,
  intervalDays: number,
): string | null {
  const step = cadence === 'OTHER' ? Math.max(1, Math.round(intervalDays)) : CADENCE_DAYS[cadence];
  return addDaysIso(lastChargedIso, step);
}

/** Annualized run-rate (cents) for a per-charge amount at a cadence. */
export function annualizedCents(amountCents: number, cadence: BillingCadence, intervalDays: number): number {
  if (cadence === 'OTHER') {
    const perYear = intervalDays > 0 ? 365 / intervalDays : 0;
    return Math.round(amountCents * perYear);
  }
  return Math.round((amountCents * 365) / CADENCE_DAYS[cadence]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Price-increase detection (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────
export interface PriceChange {
  increased: boolean;
  /** the prior steady amount (median of all charges before the latest). */
  priorCents: number;
  /** the most recent charge amount. */
  currentCents: number;
  /** relative jump (current-prior)/prior; 0 when no prior. */
  pctIncrease: number;
}

/**
 * Given charge amounts in DATE ORDER (oldest→newest), decide whether the latest charge
 * is a material increase over the prior steady amount.
 */
export function detectPriceIncrease(amountsInDateOrder: readonly number[]): PriceChange {
  const amts = amountsInDateOrder.filter((n) => Number.isFinite(n) && n >= 0);
  if (amts.length < 2) {
    const only = amts[0] ?? 0;
    return { increased: false, priorCents: only, currentCents: only, pctIncrease: 0 };
  }
  const currentCents = amts[amts.length - 1];
  const priorCents = median(amts.slice(0, -1));
  const pctIncrease = priorCents > 0 ? (currentCents - priorCents) / priorCents : 0;
  return {
    increased: pctIncrease >= SUB_THRESHOLDS.priceIncreaseRel,
    priorCents,
    currentCents,
    pctIncrease,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection orchestrator (pure)
// ─────────────────────────────────────────────────────────────────────────────
export interface ChargeInput {
  /** bank_transactions.id or bills.id — for link-back. */
  id: string;
  /** raw vendor name or bank description (normalized internally). */
  vendorRaw: string;
  /** known vendor master id, if resolved. */
  vendorId?: string | null;
  /** positive magnitude of the charge, in cents (money out). */
  amountCents: number;
  /** yyyy-mm-dd charge date. */
  date: string;
  /** optional category (drives DUPLICATE_CATEGORY overlap). */
  category?: string | null;
}

export interface DetectedSubscription {
  dedupKey: string;
  vendorName: string;
  vendorId: string | null;
  category: string | null;
  amountCents: number;
  priorAmountCents: number | null;
  billingCadence: BillingCadence;
  intervalDays: number;
  regularity: number;
  firstSeenDate: string;
  lastChargedDate: string;
  nextRenewalDate: string | null;
  chargeCount: number;
  chargeTxnIds: string[];
  annualizedCents: number;
  creepFlags: CreepFlag[];
  confidence: number;
}

export interface DetectOptions {
  /** the "today" anchor (yyyy-mm-dd) for NEW/STALE windows. */
  asOf: string;
  minCharges?: number;
}

/** Stable natural key for idempotent upsert: vendor + cadence. */
export function subscriptionDedupKey(vendorName: string, cadence: BillingCadence): string {
  return `sub:${normalizeText(vendorName)}:${cadence}`;
}

function confidenceFor(chargeCount: number, regularity: number): number {
  const base = Math.min(0.95, 0.45 + 0.12 * chargeCount);
  return Math.max(0, Math.min(0.9999, Math.round(base * regularity * 10000) / 10000));
}

/**
 * Group charges by normalized vendor and detect recurring subscriptions. Charges from
 * the same vendor with a regular cadence and ≥ `minCharges` occurrences become one
 * detected subscription. Per-vendor creep flags (NEW / PRICE_INCREASE / STALE) are set
 * here; DUPLICATE_CATEGORY is a cross-subscription pass applied at the end.
 */
export function detectSubscriptions(
  charges: readonly ChargeInput[],
  opts: DetectOptions,
): DetectedSubscription[] {
  const minCharges = Math.max(2, opts.minCharges ?? SUB_THRESHOLDS.minCharges);

  // Group by normalized vendor.
  const groups = new Map<string, ChargeInput[]>();
  for (const c of charges) {
    if (!c || !c.vendorRaw || !c.date || !Number.isFinite(c.amountCents) || c.amountCents <= 0) continue;
    const key = normalizeText(c.vendorRaw);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }

  const out: DetectedSubscription[] = [];

  for (const group of groups.values()) {
    if (group.length < minCharges) continue;

    const sorted = [...group].sort((a, b) => (isoToUtc(a.date)! - isoToUtc(b.date)!));
    const dates = sorted.map((c) => c.date);
    const cadence = detectCadence(dates);
    if (!cadence || cadence.regularity < SUB_THRESHOLDS.minRegularity) continue;

    const amounts = sorted.map((c) => Math.round(c.amountCents));
    const price = detectPriceIncrease(amounts);
    const amountCents = median(amounts.slice(-3)); // typical = recent run-rate
    const firstSeenDate = dates[0];
    const lastChargedDate = dates[dates.length - 1];

    // Representative vendor display + category (most recent non-empty).
    const vendorName =
      [...sorted].reverse().find((c) => c.vendorRaw && c.vendorRaw.trim())?.vendorRaw?.trim() ??
      group[0].vendorRaw;
    const vendorId = [...sorted].reverse().find((c) => c.vendorId)?.vendorId ?? null;
    const category =
      [...sorted].reverse().find((c) => c.category && c.category.trim())?.category?.trim() ?? null;

    const creepFlags: CreepFlag[] = [];
    const ageDays = daysBetween(firstSeenDate, opts.asOf);
    if (ageDays !== null && ageDays <= SUB_THRESHOLDS.newWindowDays) creepFlags.push('NEW');
    if (price.increased) creepFlags.push('PRICE_INCREASE');
    const sinceLast = daysBetween(lastChargedDate, opts.asOf);
    if (sinceLast !== null && sinceLast > cadence.intervalDays * SUB_THRESHOLDS.staleFactor) {
      creepFlags.push('STALE');
    }

    out.push({
      dedupKey: subscriptionDedupKey(vendorName, cadence.cadence),
      vendorName,
      vendorId,
      category,
      amountCents,
      priorAmountCents: price.increased ? price.priorCents : null,
      billingCadence: cadence.cadence,
      intervalDays: cadence.intervalDays,
      regularity: cadence.regularity,
      firstSeenDate,
      lastChargedDate,
      nextRenewalDate: nextRenewalDate(lastChargedDate, cadence.cadence, cadence.intervalDays),
      chargeCount: sorted.length,
      chargeTxnIds: sorted.map((c) => c.id).slice(0, SUB_THRESHOLDS.maxTxnIds),
      annualizedCents: annualizedCents(amountCents, cadence.cadence, cadence.intervalDays),
      creepFlags,
      confidence: confidenceFor(sorted.length, cadence.regularity),
    });
  }

  return applyDuplicateCategory(out);
}

/**
 * Cross-subscription pass: flag DUPLICATE_CATEGORY on every subscription that shares a
 * (non-empty) category with at least one other live subscription — overlapping SaaS
 * spend the human should consolidate. Pure; returns a new array (never mutates input).
 */
export function applyDuplicateCategory(subs: readonly DetectedSubscription[]): DetectedSubscription[] {
  const counts = new Map<string, number>();
  for (const s of subs) {
    const cat = (s.category ?? '').trim().toLowerCase();
    if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return subs.map((s) => {
    const cat = (s.category ?? '').trim().toLowerCase();
    const dup = cat && (counts.get(cat) ?? 0) >= 2;
    if (dup && !s.creepFlags.includes('DUPLICATE_CATEGORY')) {
      return { ...s, creepFlags: [...s.creepFlags, 'DUPLICATE_CATEGORY'] };
    }
    return s;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Creep summary (pure) — the "creep guard" totals the UI shows.
// ─────────────────────────────────────────────────────────────────────────────
export interface CreepSummary {
  totalMonthlyCents: number;
  totalAnnualCents: number;
  count: number;
  newCount: number;
  priceIncreaseCount: number;
  duplicateCount: number;
  staleCount: number;
}

export interface Summarizable {
  billingCadence: BillingCadence;
  amountCents: number;
  intervalDays?: number;
  annualizedCents?: number;
  creepFlags: readonly CreepFlag[];
  status?: string;
}

/** Roll up live subscriptions into the creep dashboard totals. Never throws. */
export function summarizeCreep(subs: readonly Summarizable[]): CreepSummary {
  // Cancelled subscriptions no longer represent spend; everything else (incl. KEPT) does.
  const live = subs.filter((s) => s.status !== 'CANCELLED');
  const totalAnnualCents = live.reduce((sum, s) => {
    if (typeof s.annualizedCents === 'number') return sum + s.annualizedCents;
    return sum + annualizedCents(s.amountCents, s.billingCadence, s.intervalDays ?? 30);
  }, 0);
  return {
    count: live.length,
    totalAnnualCents,
    totalMonthlyCents: Math.round(totalAnnualCents / 12),
    newCount: live.filter((s) => s.creepFlags.includes('NEW')).length,
    priceIncreaseCount: live.filter((s) => s.creepFlags.includes('PRICE_INCREASE')).length,
    duplicateCount: live.filter((s) => s.creepFlags.includes('DUPLICATE_CATEGORY')).length,
    staleCount: live.filter((s) => s.creepFlags.includes('STALE')).length,
  };
}
