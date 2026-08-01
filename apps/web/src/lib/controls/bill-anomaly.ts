/**
 * Financial Control Exception — Bill / AP anomaly detection (BEFORE it posts).
 *
 * A continuous control that scans UNAPPROVED, not-yet-posted bills (PENDING /
 * ON_HOLD) and surfaces $-quantified anomalies into the unified /exceptions queue
 * BEFORE the bill is approved and hits the ledger — the AP analogue of "flag a bill
 * 25% over its baseline before you pay it." It NEVER edits a bill, approves it,
 * blocks payment, or posts to the GL — it DETECTS and DRAFTS a review for a human
 * (canon §3: AI proposes facts; a human with the right role acts).
 *
 * How it reaches the queue WITHOUT touching the aggregator: each anomalous bill is
 * written as ONE PROPOSED row in public.ai_decisions with feature 'BILL_ANOMALY'.
 * The existing /exceptions route already folds PROPOSED ai_decisions in as an
 * `ai_proposal` source (input_summary → title, feature → subtitle, confidence →
 * bar). This mirrors the EC-1 duplicate-payment control exactly.
 *
 * Detection signals (see the pure scorers below for exact thresholds):
 *   A. VENDOR-AVERAGE variance (price/qty) — a PENDING bill materially above this
 *      vendor's historical average bill, once there is enough history to trust the
 *      baseline. This is the "materially over its normal cost" catch.
 *   C. FIRST-TIME / unusually-large vendor — a vendor's very first bill landing at
 *      or above a materiality floor (no baseline to sanity-check it against).
 *   D. ROUND-DOLLAR — a large bill for an exact round figure (a hallmark of an
 *      estimate keyed as an invoice, or a fabricated amount).
 *
 * >>> Signal B (bill-over-its-linked-PO) is NOT implemented: the owned Books ledger
 *     has NO bill↔PO link. `public.bills` carries no purchase_order_id, and the only
 *     PO model (`proj.commitments`, migration 1003) lives in the Projects module and
 *     is reachable only via the `core.events` JOB_COST seam by `commitment_line_id`,
 *     which is not carried on a bill. Reading `proj.*` from a Books control would
 *     violate the module boundary (FPB §0: "neither module reads the other's
 *     tables"). PO-variance needs a central change — see NEEDS CENTRAL in the report.
 *
 * The pure scorers (`scoreVendorVariance`, `scoreFirstTimeLarge`, `scoreRoundDollar`,
 * `assessBillAnomaly`) are I/O-free and unit-tested. `scanBillAnomalies` does the
 * RLS-scoped reads/writes and is idempotent: dedup_key = `billanom:<bill_id>` means a
 * re-scan never double-queues (migration 070's partial unique index is the DB
 * guarantor), and an already-resolved (APPROVED/REJECTED) exception does not resurface.
 *
 * All money is bigint cents. Confidence is clamped into numeric(5,4).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import { formatMoney } from '@meritbooks/shared';

export const BILL_ANOMALY_FEATURE = 'BILL_ANOMALY';

/** Bill statuses that are "before it posts" — unapproved, not yet on the ledger. */
export const UNPOSTED_BILL_STATUSES = ['PENDING', 'ON_HOLD'] as const;

// ── Tunable thresholds (single source of truth; kept here so they can't drift) ──
export const BILL_ANOM_THRESHOLDS = {
  /** need at least this many prior bills before a vendor average is trustworthy. */
  minHistoryForAverage: 3,
  /** target > avg × (1 + this) ⇒ a variance worth surfacing (25% over baseline). */
  overAverageRel: 0.25,
  /** target > avg × (1 + this) ⇒ a strong variance (double the normal bill). */
  strongOverAverageRel: 1.0,
  /** target ≥ avg × this ⇒ an extreme variance (near-certain anomaly). */
  extremeOverAverageMult: 3.0,
  /** a vendor's FIRST bill at/above this is worth a human glance ($5,000). */
  firstTimeMaterialityCents: 500_000,
  /** any bill at/above this is material regardless of history ($25,000). */
  largeAbsoluteCents: 2_500_000,
  /** round-dollar unit: an exact multiple of $1,000 reads as an estimate. */
  roundDollarUnitCents: 100_000,
  /** only surface round-dollar when the bill is also large ($5,000+). */
  roundDollarMinCents: 500_000,
  /** variance dollars below this are noise — never surfaced (anti-cry-wolf). */
  materialityFloorCents: 100_000,
  /** below this confidence a hit is noise — never surfaced. Matches the review cut-line. */
  minSurface: 0.7,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface BillInput {
  id: string;
  vendorId: string;
  locationId: string | null;
  billNumber: string | null;
  billDate: string; // ISO date
  totalCents: number;
  status: string;
}

/** Historical baseline for one vendor, computed from prior non-void bills. */
export interface VendorHistory {
  count: number;
  avgCents: number;
  maxCents: number;
}

export interface AnomalySignal {
  confidence: number; // 0..1 (pre-clamp)
  reason: string; // plain-language, audit-ready
  /** the dollars this signal puts at risk (the overage / the bill amount). */
  amountAtRiskCents: number;
}

// ── small local helpers ─────────────────────────────────────────────────────

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/** Stable dedup key — one open BILL_ANOMALY exception per bill (task contract). */
export function billAnomalyDedupKey(billId: string): string {
  return `billanom:${billId}`;
}

/** True when cents is a non-zero exact multiple of the round-dollar unit. */
export function isRoundDollar(cents: number, unitCents: number): boolean {
  if (cents <= 0 || unitCents <= 0) return false;
  return cents % unitCents === 0;
}

/**
 * Build a vendor's baseline from its prior bills. The target bill is excluded by
 * the caller. Uses the mean of prior bill totals as the "normal" cost; the max is
 * carried so a target that is merely at-or-below a prior peak can be de-weighted.
 */
export function computeVendorHistory(priorTotalsCents: number[]): VendorHistory {
  const totals = priorTotalsCents.filter((n) => Number.isFinite(n) && n > 0);
  if (totals.length === 0) return { count: 0, avgCents: 0, maxCents: 0 };
  const sum = totals.reduce((a, b) => a + b, 0);
  return {
    count: totals.length,
    avgCents: Math.round(sum / totals.length),
    maxCents: Math.max(...totals),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal A — vendor-average variance (price/qty). Pure.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Score a target bill against its vendor's historical average. Returns null when
 * there is no trustworthy baseline, the overage is immaterial, or the bill is not
 * meaningfully above normal.
 *
 * Thresholds (T = BILL_ANOM_THRESHOLDS), given avg = vendor mean prior bill:
 *   ratio ≥ extremeOverAverageMult (≥3×)      → 0.93
 *   ratio ≥ 1 + strongOverAverageRel (≥2×)    → 0.86
 *   ratio ≥ 1 + overAverageRel (≥1.25×)       → 0.74
 *   otherwise                                 → null
 * The overage in dollars must also clear the materiality floor.
 */
export function scoreVendorVariance(
  target: Pick<BillInput, 'totalCents'>,
  history: VendorHistory,
  vendorName: string,
): AnomalySignal | null {
  const T = BILL_ANOM_THRESHOLDS;
  if (history.count < T.minHistoryForAverage || history.avgCents <= 0) return null;

  const ratio = target.totalCents / history.avgCents;
  const overageCents = target.totalCents - history.avgCents;
  if (overageCents < T.materialityFloorCents) return null;
  if (ratio < 1 + T.overAverageRel) return null;

  const pctOver = Math.round((ratio - 1) * 100);
  const avg = formatMoney(history.avgCents);
  const amt = formatMoney(target.totalCents);
  const over = formatMoney(overageCents);

  let confidence: number;
  if (ratio >= T.extremeOverAverageMult) confidence = 0.93;
  else if (ratio >= 1 + T.strongOverAverageRel) confidence = 0.86;
  else confidence = 0.74;

  return {
    confidence,
    amountAtRiskCents: overageCents,
    reason: `This ${amt} bill from ${vendorName} is ${pctOver}% above the vendor's historical average of ${avg} across ${history.count} prior bills — ${over} over baseline. Review the price/quantity before approving.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal C — first-time / unusually-large vendor. Pure.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Score a bill from a vendor with no (or near-no) history. A first bill at/above
 * the materiality floor has no baseline to sanity-check it, so it is surfaced for
 * a human glance; a first bill at/above the large-absolute ceiling is stronger.
 */
export function scoreFirstTimeLarge(
  target: Pick<BillInput, 'totalCents'>,
  history: VendorHistory,
  vendorName: string,
): AnomalySignal | null {
  const T = BILL_ANOM_THRESHOLDS;
  if (history.count >= T.minHistoryForAverage) return null;
  if (target.totalCents < T.firstTimeMaterialityCents) return null;

  const amt = formatMoney(target.totalCents);
  const firstEver = history.count === 0;
  const confidence = target.totalCents >= T.largeAbsoluteCents ? 0.82 : 0.72;
  const baseline = firstEver
    ? `the first bill ever recorded for ${vendorName}`
    : `only the ${history.count === 1 ? '2nd' : `${history.count + 1}th`} bill for ${vendorName} (too little history to baseline)`;

  return {
    confidence,
    amountAtRiskCents: target.totalCents,
    reason: `${amt} on ${baseline} — a new or thinly-established vendor at a material amount. Verify the vendor and the invoice before approving.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal D — round-dollar large bill. Pure.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Score a large bill whose total is an exact round figure (a hallmark of an
 * estimate keyed as an invoice, or a fabricated amount). Advisory-strength.
 */
export function scoreRoundDollar(
  target: Pick<BillInput, 'totalCents'>,
  vendorName: string,
): AnomalySignal | null {
  const T = BILL_ANOM_THRESHOLDS;
  if (target.totalCents < T.roundDollarMinCents) return null;
  if (!isRoundDollar(target.totalCents, T.roundDollarUnitCents)) return null;

  const amt = formatMoney(target.totalCents);
  return {
    confidence: 0.71,
    amountAtRiskCents: target.totalCents,
    reason: `${amt} from ${vendorName} is an exact round-dollar amount — often an estimate or deposit keyed as a final invoice rather than an itemized bill. Confirm supporting detail before approving.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate the signals for one bill → a single exception (one dedup_key/bill).
// ─────────────────────────────────────────────────────────────────────────────
export type AnomalyKind = 'vendor_variance' | 'first_time_large' | 'round_dollar';

export interface BillAnomalyAssessment {
  /** the driving (highest-confidence) signal's kind. */
  kind: AnomalyKind;
  confidence: number; // max across firing signals
  amountAtRiskCents: number; // max $-at-risk across firing signals
  kinds: AnomalyKind[]; // every signal that fired
  reason: string; // combined, driving signal first
}

/**
 * Run every signal for one bill and fold them into a single assessment. Returns
 * null when nothing fires above the surfacing floor. Precedence for the "driving"
 * signal is by confidence, so the strongest reason leads the exception title.
 */
export function assessBillAnomaly(
  target: Pick<BillInput, 'totalCents'>,
  history: VendorHistory,
  vendorName: string,
): BillAnomalyAssessment | null {
  const T = BILL_ANOM_THRESHOLDS;
  const fired: Array<{ kind: AnomalyKind; sig: AnomalySignal }> = [];

  const variance = scoreVendorVariance(target, history, vendorName);
  if (variance && variance.confidence >= T.minSurface) fired.push({ kind: 'vendor_variance', sig: variance });

  const firstTime = scoreFirstTimeLarge(target, history, vendorName);
  if (firstTime && firstTime.confidence >= T.minSurface) fired.push({ kind: 'first_time_large', sig: firstTime });

  const round = scoreRoundDollar(target, vendorName);
  if (round && round.confidence >= T.minSurface) fired.push({ kind: 'round_dollar', sig: round });

  if (fired.length === 0) return null;

  // Driving signal = highest confidence; ties broken by larger $-at-risk.
  fired.sort((a, b) =>
    b.sig.confidence - a.sig.confidence || b.sig.amountAtRiskCents - a.sig.amountAtRiskCents,
  );
  const driver = fired[0];
  const confidence = fired.reduce((m, f) => Math.max(m, f.sig.confidence), 0);
  const amountAtRiskCents = fired.reduce((m, f) => Math.max(m, f.sig.amountAtRiskCents), 0);
  const reason = fired.map((f) => f.sig.reason).join(' ');

  return {
    kind: driver.kind,
    confidence,
    amountAtRiskCents,
    kinds: fired.map((f) => f.kind),
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiering — never auto-suppress a control exception.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Map a bill anomaly's confidence + $-at-risk to a surfacing tier. This is a
 * BEFORE-post advisory (money is NOT out yet), so it never auto-blocks — but a
 * control exception must ALWAYS reach a human, so scoreToTier's `auto` (advisory/
 * suppress) is floored up to `review`. A high-confidence variance whose dollars-
 * at-risk clear the large-absolute ceiling escalates so it can't be rubber-stamped.
 */
export function resolveBillAnomalyTier(
  confidence: number,
  amountAtRiskCents: number,
  policy: TierPolicy,
): Tier {
  const T = BILL_ANOM_THRESHOLDS;
  if (confidence >= policy.autoThreshold && amountAtRiskCents >= T.largeAbsoluteCents) {
    return 'escalate';
  }
  const { tier } = scoreToTier({ confidence, amountCents: amountAtRiskCents }, policy);
  return tier === 'auto' ? 'review' : tier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate exception (pre-persistence) + scan orchestration (I/O)
// ─────────────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<AnomalyKind, string> = {
  vendor_variance: 'Bill above vendor average',
  first_time_large: 'Large first-time vendor bill',
  round_dollar: 'Round-dollar bill',
};

const KIND_QUESTION: Record<AnomalyKind, string> = {
  vendor_variance:
    'Approve this bill as-is, or hold it pending a price/quantity check against the vendor’s prior invoices?',
  first_time_large:
    'Confirm this new vendor and invoice are legitimate, or hold pending vendor verification?',
  round_dollar:
    'Confirm this round-dollar amount is a genuine final invoice, or request itemized supporting detail?',
};

export interface BillAnomalyScanSummary {
  scanned: { bills: number; targets: number; vendors: number };
  detected: number; // anomalous target bills found (incl. already-queued)
  queued: number; // NEW exception rows inserted (deduped)
  byKind: Record<AnomalyKind, number>; // NEW rows by driving kind
  byTier: Record<Tier, number>; // NEW rows by tier
  errors: number;
}

/**
 * Scan unapproved (PENDING/ON_HOLD) bills for anomalies and queue new exceptions
 * into /exceptions. Never throws — a control scan must not break the pass it rides
 * on. Reads/writes go through the RLS-scoped client, so the DB enforces org scope.
 */
export async function scanBillAnomalies(
  supabase: SupabaseClient,
  orgId: string,
): Promise<BillAnomalyScanSummary> {
  const summary: BillAnomalyScanSummary = {
    scanned: { bills: 0, targets: 0, vendors: 0 },
    detected: 0,
    queued: 0,
    byKind: { vendor_variance: 0, first_time_large: 0, round_dollar: 0 },
    byTier: { auto: 0, review: 0, escalate: 0 },
    errors: 0,
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  // ── Load bills: all non-void bills (history + targets in one read) ───────────
  const { data: billsRaw, error: billErr } = await supabase
    .from('bills')
    .select('id, vendor_id, location_id, bill_number, bill_date, total_cents, status')
    .neq('status', 'VOIDED')
    .order('bill_date', { ascending: false })
    .limit(5000);
  if (billErr) {
    console.warn('[controls/bill-anomaly] bills load failed:', billErr.message);
    return summary;
  }
  const bills = (billsRaw ?? []) as Array<{
    id: string;
    vendor_id: string;
    location_id: string | null;
    bill_number: string | null;
    bill_date: string;
    total_cents: number | string;
    status: string;
  }>;
  summary.scanned.bills = bills.length;

  const billInputs: BillInput[] = bills.map((b) => ({
    id: b.id,
    vendorId: b.vendor_id,
    locationId: b.location_id,
    billNumber: b.bill_number,
    billDate: b.bill_date,
    totalCents: Number(b.total_cents) || 0,
    status: b.status,
  }));

  // Baseline per vendor = all this-vendor bills; the target is excluded per-bill.
  const byVendor = new Map<string, BillInput[]>();
  for (const b of billInputs) {
    const arr = byVendor.get(b.vendorId) ?? [];
    arr.push(b);
    byVendor.set(b.vendorId, arr);
  }
  summary.scanned.vendors = byVendor.size;

  // Vendor display names for readable reasons (core schema — stitched in JS).
  const vendorNameById = new Map<string, string>();
  const vendorIds = Array.from(byVendor.keys());
  if (vendorIds.length > 0) {
    try {
      const { data: vendorsRaw } = await supabase
        .schema('core')
        .from('vendors')
        .select('id, name, display_name')
        .in('id', vendorIds);
      for (const v of (vendorsRaw ?? []) as Array<{ id: string; name: string; display_name: string | null }>) {
        vendorNameById.set(v.id, v.display_name || v.name);
      }
    } catch {
      /* best-effort — fall back to a generic label below */
    }
  }

  // ── Assess each unposted target bill against its vendor baseline ──────────────
  const targets = billInputs.filter((b) =>
    (UNPOSTED_BILL_STATUSES as readonly string[]).includes(b.status),
  );
  summary.scanned.targets = targets.length;

  interface Candidate {
    bill: BillInput;
    vendorName: string;
    assessment: BillAnomalyAssessment;
  }
  const candidates: Candidate[] = [];

  for (const target of targets) {
    const group = byVendor.get(target.vendorId) ?? [];
    const priorTotals = group.filter((b) => b.id !== target.id).map((b) => b.totalCents);
    const history = computeVendorHistory(priorTotals);
    const vendorName = vendorNameById.get(target.vendorId) ?? 'this vendor';
    const assessment = assessBillAnomaly(target, history, vendorName);
    if (assessment) candidates.push({ bill: target, vendorName, assessment });
  }

  summary.detected = candidates.length;
  if (candidates.length === 0) return summary;

  // ── Idempotency: skip any dedup_key already open OR already resolved ─────────
  const existingKeys = new Set<string>();
  try {
    const { data: rows } = await supabase
      .from('ai_decisions')
      .select('proposed_output')
      .eq('feature', BILL_ANOMALY_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of rows ?? []) {
      const po = (row as { proposed_output?: { dedup_key?: string } }).proposed_output;
      if (po?.dedup_key) existingKeys.add(po.dedup_key);
    }
  } catch {
    /* best-effort — worst case migration 070's unique index rejects the dup insert */
  }

  // ── Insert new exceptions + write the AI audit trail ─────────────────────────
  for (const c of candidates) {
    const dedupKey = billAnomalyDedupKey(c.bill.id);
    if (existingKeys.has(dedupKey)) continue;

    const { assessment: a, bill, vendorName } = c;
    const tier = resolveBillAnomalyTier(a.confidence, a.amountAtRiskCents, policy);
    const confidence = toConfidence(a.confidence);
    const title = `${KIND_LABEL[a.kind]}: ${vendorName} · ${formatMoney(a.amountAtRiskCents)} at risk`;

    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      location_id: bill.locationId,
      feature: BILL_ANOMALY_FEATURE,
      input_summary: title,
      proposed_output: {
        control: 'BILL_ANOMALY',
        kind: a.kind,
        kinds: a.kinds,
        dedup_key: dedupKey,
        amount_at_risk_cents: a.amountAtRiskCents,
        bill_total_cents: bill.totalCents,
        tier,
        money_already_out: false, // before-post advisory
        subjects: { bill_id: bill.id, vendor_id: bill.vendorId, bill_number: bill.billNumber },
        reason: a.reason,
      },
      confidence,
      reasoning: a.reason,
      clarifying_question: KIND_QUESTION[a.kind],
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      // A concurrent scan may have won the unique index (migration 070) — not an error.
      console.warn('[controls/bill-anomaly] could not queue exception:', error.message);
      summary.errors += 1;
      continue;
    }
    existingKeys.add(dedupKey);
    summary.queued += 1;
    summary.byKind[a.kind] += 1;
    summary.byTier[tier] += 1;

    // Trust audit trail — the AI's detection, actor = AI (canon §3 / FPB D7).
    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'controls.bill_anomaly.detect',
      subjectTable: 'bills',
      subjectId: bill.id,
      summary: title,
      locationId: bill.locationId,
      confidence,
      tier,
      metadata: {
        kind: a.kind,
        kinds: a.kinds,
        dedup_key: dedupKey,
        amount_at_risk_cents: a.amountAtRiskCents,
        bill_total_cents: bill.totalCents,
      },
    });
  }

  return summary;
}
