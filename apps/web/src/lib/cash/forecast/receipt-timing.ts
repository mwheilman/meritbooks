/**
 * Predicted customer pay dates (AI8 / AC-CF1) — pure, deterministic.
 *
 * Each customer's paid history (payment application × invoice due date × payment date) gives an
 * AMOUNT-WEIGHTED MEDIAN days-late (negative = pays early). An open invoice is expected on
 *   due date + the customer's median days-late
 * using the org-wide profile when the customer has fewer than MIN_SAMPLES payments, and the due date
 * itself when the org has no usable history either. Nothing is expected before today; an invoice
 * already later than the customer's usual lateness is expected within a week (FOLLOW_UP_DAYS).
 *
 * Probability = age-bucket base × customer reliability (1 − written-off share of resolved cents,
 * floored at 0.5) × 0.5 when the invoice is disputed. Expected cents = round(balance × p); the
 * remainder is "at risk" — reported, never counted.
 */

import { addDays, daysBetween, maxIso } from './dates';

export const MIN_SAMPLES = 3;
export const FOLLOW_UP_DAYS = 7;
const MIN_RELIABILITY = 0.5;
const DISPUTE_FACTOR = 0.5;

export interface PaidHistoryRow {
  customerId: string | null;
  /** The invoice's due date. */
  dueDate: string;
  /** The payment's date. */
  paidDate: string;
  /** Cents applied to the invoice by this payment (weight). */
  amountCents: number;
}

export interface OutcomeRow {
  customerId: string | null;
  /** PAID cents or WRITTEN_OFF cents over the history window. */
  outcome: 'PAID' | 'WRITTEN_OFF';
  cents: number;
}

export interface PayProfile {
  /** Amount-weighted median days late (negative = early). */
  medianDaysLate: number;
  samples: number;
  /** 0.5..1 */
  reliability: number;
  basis: 'CUSTOMER' | 'ORG' | 'DUE_DATE';
}

export interface PayProfiles {
  byCustomer: Map<string, { medianDaysLate: number; samples: number }>;
  org: { medianDaysLate: number; samples: number } | null;
  reliability: Map<string, number>;
}

/** Amount-weighted median of (value, weight) pairs; ties go to the lower value. */
export function weightedMedian(pairs: ReadonlyArray<{ value: number; weight: number }>): number | null {
  const usable = pairs.filter((p) => Number.isFinite(p.value) && p.weight > 0).sort((a, b) => a.value - b.value);
  if (usable.length === 0) return null;
  const total = usable.reduce((s, p) => s + p.weight, 0);
  let run = 0;
  for (const p of usable) {
    run += p.weight;
    if (run * 2 >= total) return p.value;
  }
  return usable[usable.length - 1].value;
}

export function buildPayProfiles(history: readonly PaidHistoryRow[], outcomes: readonly OutcomeRow[] = []): PayProfiles {
  const groups = new Map<string, Array<{ value: number; weight: number }>>();
  const all: Array<{ value: number; weight: number }> = [];
  for (const h of history) {
    if (!h.dueDate || !h.paidDate || !(h.amountCents > 0)) continue;
    const late = daysBetween(h.dueDate.slice(0, 10), h.paidDate.slice(0, 10));
    const pair = { value: late, weight: h.amountCents };
    all.push(pair);
    if (h.customerId) {
      const g = groups.get(h.customerId) ?? [];
      g.push(pair);
      groups.set(h.customerId, g);
    }
  }
  const byCustomer = new Map<string, { medianDaysLate: number; samples: number }>();
  for (const [id, pairs] of groups) {
    const m = weightedMedian(pairs);
    if (m !== null) byCustomer.set(id, { medianDaysLate: m, samples: pairs.length });
  }
  const orgMedian = weightedMedian(all);
  const org = orgMedian === null ? null : { medianDaysLate: orgMedian, samples: all.length };

  const paid = new Map<string, number>();
  const lost = new Map<string, number>();
  for (const o of outcomes) {
    if (!o.customerId || !(o.cents > 0)) continue;
    const m = o.outcome === 'PAID' ? paid : lost;
    m.set(o.customerId, (m.get(o.customerId) ?? 0) + o.cents);
  }
  const reliability = new Map<string, number>();
  for (const id of new Set([...paid.keys(), ...lost.keys()])) {
    const p = paid.get(id) ?? 0;
    const l = lost.get(id) ?? 0;
    if (p + l <= 0) continue;
    reliability.set(id, Math.max(MIN_RELIABILITY, p / (p + l)));
  }
  return { byCustomer, org, reliability };
}

export function profileFor(profiles: PayProfiles, customerId: string | null): PayProfile {
  const reliability = (customerId && profiles.reliability.get(customerId)) || 1;
  const own = customerId ? profiles.byCustomer.get(customerId) : undefined;
  if (own && own.samples >= MIN_SAMPLES) return { medianDaysLate: own.medianDaysLate, samples: own.samples, reliability, basis: 'CUSTOMER' };
  if (profiles.org && profiles.org.samples >= MIN_SAMPLES) {
    return { medianDaysLate: profiles.org.medianDaysLate, samples: profiles.org.samples, reliability, basis: 'ORG' };
  }
  return { medianDaysLate: 0, samples: 0, reliability, basis: 'DUE_DATE' };
}

/** Base collection probability by days past due (≤ 0 = not yet due). */
export function ageProbability(daysPastDue: number): number {
  if (daysPastDue <= 0) return 0.98;
  if (daysPastDue <= 30) return 0.95;
  if (daysPastDue <= 60) return 0.85;
  if (daysPastDue <= 90) return 0.7;
  if (daysPastDue <= 120) return 0.5;
  return 0.25;
}

export interface ReceiptExpectation {
  expectedDate: string;
  probability: number;
  expectedCents: number;
  atRiskCents: number;
  daysPastDue: number;
  profile: PayProfile;
}

export function expectReceipt(input: {
  dueDate: string;
  balanceCents: number;
  today: string;
  profile: PayProfile;
  disputed?: boolean;
}): ReceiptExpectation {
  const due = input.dueDate.slice(0, 10);
  const daysPastDue = daysBetween(due, input.today);
  const predicted = addDays(due, input.profile.medianDaysLate);
  // Already later than this customer usually pays → expect it within a week, not "today".
  const expectedDate = predicted < input.today ? (daysPastDue > 0 ? addDays(input.today, FOLLOW_UP_DAYS) : input.today) : maxIso(predicted, input.today);
  let p = ageProbability(daysPastDue) * input.profile.reliability;
  if (input.disputed) p *= DISPUTE_FACTOR;
  p = Math.max(0, Math.min(1, Math.round(p * 10_000) / 10_000));
  const gross = Math.max(0, Math.round(input.balanceCents));
  const expectedCents = Math.round(gross * p);
  return { expectedDate, probability: p, expectedCents, atRiskCents: gross - expectedCents, daysPastDue, profile: input.profile };
}
