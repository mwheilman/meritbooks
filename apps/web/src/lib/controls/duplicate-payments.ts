/**
 * Financial Control Exception EC-1 — Duplicate payment / duplicate-vendor detection.
 *
 * A continuous control that scans the owned AP ledger and surfaces $-quantified
 * exceptions into the unified /exceptions queue. It NEVER moves money, voids a
 * payment, merges a vendor, or edits the ledger — it DETECTS and DRAFTS a
 * remediation for a human to apply (canon §3: AI proposes facts; a human acts).
 *
 * How it reaches the queue WITHOUT touching the aggregator: each hit is written
 * as a PROPOSED row in public.ai_decisions with feature 'DUPLICATE_PAYMENT'. The
 * existing /exceptions route already folds PROPOSED ai_decisions in as an
 * `ai_proposal` source (input_summary → title, feature → subtitle, confidence →
 * bar). This mirrors the Session-40 Vendor Compliance escalation exactly.
 *
 * Three detection rules (see the scorers below for exact thresholds):
 *   A. Duplicate BILLS      — same vendor + same/near amount + near date OR same
 *                             invoice number (a re-keyed invoice not yet paid).
 *   B. Duplicate PAYMENTS   — a bill whose POSTED settlements exceed its total
 *                             (paid twice), or a duplicate-bill pair where BOTH
 *                             bills already disbursed cash (money is already out).
 *   C. Duplicate VENDOR     — near-duplicate vendor masters (matching TIN, or
 *      masters                highly similar name + shared email/address) that
 *                             fragment spend and defeat duplicate-bill controls.
 *
 * The pure scorers (`scoreDuplicateBills`, `scoreDuplicateVendors`,
 * `assessBillPayments`) are I/O-free and unit-tested. The `scanDuplicatePayments`
 * orchestrator does the RLS-scoped reads/writes and is idempotent: a `dedup_key`
 * per subject pair means a re-scan never double-queues the same exception, and an
 * already-resolved (APPROVED/REJECTED) exception does not resurface.
 *
 * All money is bigint cents. Confidence is clamped into numeric(5,4).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import { vendorSimilarity, normalizeText } from '@/lib/services/reconciliation-match';
import { formatMoney } from '@meritbooks/shared';

export const DUP_FEATURE = 'DUPLICATE_PAYMENT';

// ── Tunable thresholds (single source of truth; kept here so they can't drift) ──
export const DUP_THRESHOLDS = {
  /** relative amount diff at/under which two amounts are "the same" (half a bp). */
  amountExactRel: 0.0005,
  /** relative amount diff at/under which two amounts are "near" (1%). */
  amountNearRel: 0.01,
  /** invoice re-key almost always lands within a billing cycle. */
  dateTightDays: 7,
  dateWideDays: 45,
  /** POSTED settlements over total by more than this fraction ⇒ overpaid. */
  paymentOverpayRel: 0.005,
  /** vendor-name similarity cut-lines (reuses the reconciliation matcher curve). */
  vendorNameStrong: 0.9,
  vendorNameNear: 0.85,
  /** below this a hit is noise — never surfaced. Matches the review cut-line. */
  minSurface: 0.7,
  /** normalized invoice numbers shorter than this are ignored (too weak a key). */
  minInvoiceLen: 3,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface DupBillInput {
  id: string;
  vendorId: string;
  locationId: string | null;
  billNumber: string | null;
  billDate: string; // ISO date
  totalCents: number;
  /** cash already disbursed against this bill (bills.amount_paid_cents ⊔ POSTED payments). */
  paidCents: number;
}

export interface DupVendorInput {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  /** tin_encrypted — compared only for exact equality (both present). */
  tin: string | null;
  addressLine1: string | null;
  zip: string | null;
  /** total AP spend booked under this master (for $-at-risk when fragmented). */
  spendCents: number;
  isActive: boolean;
}

export interface PaymentAgg {
  count: number;
  paidCents: number;
}

export interface DupSignal {
  confidence: number; // 0..1 (pre-clamp)
  reason: string; // plain-language, audit-ready
}

// ── small local helpers ─────────────────────────────────────────────────────

function daysApart(a: string, b: string): number {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.POSITIVE_INFINITY;
  return Math.abs(ta - tb) / 86_400_000;
}

function relAmountDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(Math.abs(a) - Math.abs(b)) / denom;
}

/** Uppercase alphanumerics only — a stable invoice-number key. */
export function normalizeInvoiceNumber(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Deterministic dedup key for an unordered pair (order-independent). */
export function pairKey(prefix: string, a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${prefix}:${lo}:${hi}`;
}

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule A — Duplicate bills (same vendor). Pure.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Score two bills FROM THE SAME VENDOR as duplicates of one another. Returns null
 * when there is no meaningful duplicate signal (below the surfacing floor).
 *
 * Thresholds (T = DUP_THRESHOLDS):
 *   same invoice# + exact amount               → 0.98  (near-certain re-key)
 *   same invoice#                              → 0.86
 *   exact amount + dates ≤ dateTightDays       → 0.92
 *   exact amount + dates ≤ dateWideDays        → 0.80
 *   near amount  + dates ≤ dateTightDays       → 0.74
 *   otherwise                                  → null
 */
export function scoreDuplicateBills(a: DupBillInput, b: DupBillInput): DupSignal | null {
  if (a.id === b.id || a.vendorId !== b.vendorId) return null;
  const T = DUP_THRESHOLDS;

  const invA = normalizeInvoiceNumber(a.billNumber);
  const invB = normalizeInvoiceNumber(b.billNumber);
  const sameInvoice =
    invA.length >= T.minInvoiceLen && invA === invB;

  const rel = relAmountDiff(a.totalCents, b.totalCents);
  const amountExact = rel <= T.amountExactRel;
  const amountNear = rel <= T.amountNearRel;
  const dateDays = daysApart(a.billDate, b.billDate);

  const amt = formatMoney(Math.min(a.totalCents, b.totalCents));
  const dateFrag = Number.isFinite(dateDays)
    ? `${Math.round(dateDays)} day(s) apart`
    : 'undated';

  if (sameInvoice && amountExact) {
    return {
      confidence: 0.98,
      reason: `Two bills share invoice #${invA} and the same amount (${amt}) — almost certainly the same invoice entered twice.`,
    };
  }
  if (sameInvoice) {
    return {
      confidence: 0.86,
      reason: `Two bills share invoice #${invA} for this vendor (amounts differ) — likely a re-keyed invoice.`,
    };
  }
  if (amountExact && dateDays <= T.dateTightDays) {
    return {
      confidence: 0.92,
      reason: `Two bills for the identical amount (${amt}), ${dateFrag}, same vendor — probable duplicate.`,
    };
  }
  if (amountExact && dateDays <= T.dateWideDays) {
    return {
      confidence: 0.8,
      reason: `Two bills for the identical amount (${amt}), ${dateFrag}, same vendor — possible duplicate.`,
    };
  }
  if (amountNear && dateDays <= T.dateTightDays) {
    return {
      confidence: 0.74,
      reason: `Two bills for near-identical amounts (~${amt}), ${dateFrag}, same vendor — review for duplication.`,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule B — Duplicate payment against a single bill. Pure.
// ─────────────────────────────────────────────────────────────────────────────
export interface PaymentAssessment {
  isOverpaid: boolean;
  overpaidCents: number;
  paymentCount: number;
  paidCents: number;
}

/**
 * Detect a bill settled beyond its own total via multiple POSTED payments — the
 * classic "paid twice." A single payment, or several partials that sum to the
 * total, is NOT flagged; only settlements exceeding the total beyond tolerance.
 */
export function assessBillPayments(
  bill: Pick<DupBillInput, 'totalCents'>,
  agg: PaymentAgg,
): PaymentAssessment {
  const T = DUP_THRESHOLDS;
  const tolerance = Math.max(0, bill.totalCents) * (1 + T.paymentOverpayRel);
  const overpaidCents = Math.max(0, agg.paidCents - Math.max(0, bill.totalCents));
  const isOverpaid = agg.count >= 2 && agg.paidCents > tolerance;
  return { isOverpaid, overpaidCents, paymentCount: agg.count, paidCents: agg.paidCents };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule C — Duplicate vendor masters. Pure.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Score two vendor masters as duplicates. Returns null below the surfacing floor.
 *
 *   matching TIN (both present)                       → 0.95
 *   name ≥ strong + shared email/address              → 0.90
 *   name ≥ strong                                     → 0.82
 *   name ≥ near   + shared email/address              → 0.84
 *   otherwise                                         → null
 */
export function scoreDuplicateVendors(a: DupVendorInput, b: DupVendorInput): DupSignal | null {
  if (a.id === b.id) return null;
  const T = DUP_THRESHOLDS;

  const sameTin =
    !!a.tin && !!b.tin && a.tin.trim().length > 0 && a.tin.trim() === b.tin.trim();

  // Best name similarity across name/display_name on both sides.
  const namesA = [a.name, a.displayName].filter((x): x is string => !!x);
  const namesB = [b.name, b.displayName].filter((x): x is string => !!x);
  let nameSim = 0;
  for (const na of namesA) for (const nb of namesB) nameSim = Math.max(nameSim, vendorSimilarity(na, nb));

  const sameEmail =
    !!a.email && !!b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase();
  const sameAddr =
    !!a.zip && !!b.zip && a.zip.trim() === b.zip.trim() &&
    normalizeText(a.addressLine1) !== '' &&
    normalizeText(a.addressLine1) === normalizeText(b.addressLine1);
  const sharedContact = sameEmail || sameAddr;

  const label = `"${a.name}" ↔ "${b.name}"`;

  if (sameTin) {
    return {
      confidence: 0.95,
      reason: `${label} share the same tax ID — the same vendor is recorded under two masters, fragmenting spend and 1099 reporting.`,
    };
  }
  if (nameSim >= T.vendorNameStrong && sharedContact) {
    return {
      confidence: 0.9,
      reason: `${label} have near-identical names and a shared ${sameEmail ? 'email' : 'remit address'} — probable duplicate vendor.`,
    };
  }
  if (nameSim >= T.vendorNameStrong) {
    return {
      confidence: 0.82,
      reason: `${label} have near-identical names — likely duplicate vendor masters fragmenting spend.`,
    };
  }
  if (nameSim >= T.vendorNameNear && sharedContact) {
    return {
      confidence: 0.84,
      reason: `${label} have similar names and a shared ${sameEmail ? 'email' : 'remit address'} — review for duplication.`,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiering — never auto-suppress a control exception.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Map a duplicate's confidence + $-at-risk to a surfacing tier. A control
 * exception must ALWAYS reach a human — so scoreToTier's `auto` (advisory/
 * suppress) is floored up to `review`. When cash is already out the door (a bill
 * paid twice / a duplicate that already disbursed) it is always ESCALATE — the
 * #1 AP-fraud/leak pattern (EC-1 in the FPB is an ESCALATE control).
 */
export function resolveDupTier(
  confidence: number,
  amountAtRiskCents: number,
  policy: TierPolicy,
  moneyAlreadyOut: boolean,
): Tier {
  if (moneyAlreadyOut) return 'escalate';
  const { tier } = scoreToTier({ confidence, amountCents: amountAtRiskCents }, policy);
  return tier === 'auto' ? 'review' : tier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate exception (pre-persistence) + scan orchestration (I/O)
// ─────────────────────────────────────────────────────────────────────────────

export type DupKind = 'duplicate_bill' | 'duplicate_payment' | 'duplicate_vendor';

export interface DupCandidate {
  dedupKey: string;
  kind: DupKind;
  confidence: number;
  amountAtRiskCents: number;
  moneyAlreadyOut: boolean;
  locationId: string | null;
  title: string; // → ai_decisions.input_summary
  reason: string; // → ai_decisions.reasoning
  clarifyingQuestion: string;
  subjects: Record<string, unknown>; // ids for drill-down + remediation
}

export interface DuplicateScanSummary {
  scanned: { bills: number; vendors: number; payments: number };
  detected: number; // candidates found this pass (incl. already-queued)
  queued: number; // NEW exception-queue rows inserted (deduped)
  byKind: Record<DupKind, number>; // NEW rows by kind
  byTier: Record<Tier, number>; // NEW rows by tier
  errors: number;
}

const REMEDIATION_QUESTION: Record<DupKind, string> = {
  duplicate_bill:
    'Void the duplicate bill draft, or confirm these are two genuinely separate invoices?',
  duplicate_payment:
    'Recover the overpayment / void the duplicate disbursement, or confirm the extra payment was intended?',
  duplicate_vendor:
    'Merge vendor B into vendor A, or confirm these are genuinely different vendors?',
};

/**
 * Scan AP for EC-1 duplicates and queue new exceptions into /exceptions. Never
 * throws — a control scan must not break the maintenance pass it rides on.
 */
export async function scanDuplicatePayments(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DuplicateScanSummary> {
  const summary: DuplicateScanSummary = {
    scanned: { bills: 0, vendors: 0, payments: 0 },
    detected: 0,
    queued: 0,
    byKind: { duplicate_bill: 0, duplicate_payment: 0, duplicate_vendor: 0 },
    byTier: { auto: 0, review: 0, escalate: 0 },
    errors: 0,
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  // ── Load AP: non-void bills, POSTED payments, active-or-recent vendors ───────
  const { data: billsRaw, error: billErr } = await supabase
    .from('bills')
    .select('id, vendor_id, location_id, bill_number, bill_date, total_cents, amount_paid_cents, status')
    .neq('status', 'VOIDED')
    .order('bill_date', { ascending: false })
    .limit(3000);
  if (billErr) {
    console.warn('[controls/dup] bills load failed:', billErr.message);
    return summary;
  }
  const bills = (billsRaw ?? []) as Array<{
    id: string;
    vendor_id: string;
    location_id: string | null;
    bill_number: string | null;
    bill_date: string;
    total_cents: number | string;
    amount_paid_cents: number | string;
    status: string;
  }>;
  summary.scanned.bills = bills.length;

  const billIds = bills.map((b) => b.id);
  const paymentAgg = new Map<string, PaymentAgg>();
  if (billIds.length > 0) {
    for (let i = 0; i < billIds.length; i += 500) {
      const slice = billIds.slice(i, i + 500);
      const { data: pays } = await supabase
        .from('bill_payments')
        .select('bill_id, amount_cents, status')
        .in('bill_id', slice)
        .eq('status', 'POSTED');
      for (const p of (pays ?? []) as Array<{ bill_id: string; amount_cents: number | string }>) {
        const cur = paymentAgg.get(p.bill_id) ?? { count: 0, paidCents: 0 };
        cur.count += 1;
        cur.paidCents += Number(p.amount_cents) || 0;
        paymentAgg.set(p.bill_id, cur);
        summary.scanned.payments += 1;
      }
    }
  }

  const { data: vendorsRaw } = await supabase
    .schema('core')
    .from('vendors')
    .select('id, name, display_name, email, tin_encrypted, address_line1, zip, ytd_spend_cents, is_active')
    .limit(2000);
  const vendors = (vendorsRaw ?? []) as Array<{
    id: string;
    name: string;
    display_name: string | null;
    email: string | null;
    tin_encrypted: string | null;
    address_line1: string | null;
    zip: string | null;
    ytd_spend_cents: number | string | null;
    is_active: boolean;
  }>;
  summary.scanned.vendors = vendors.length;

  const vendorNameById = new Map<string, string>();
  for (const v of vendors) vendorNameById.set(v.id, v.display_name || v.name);

  // Normalize bills to pure inputs; paidCents = max(bill field, POSTED payments).
  const billInputs: DupBillInput[] = bills.map((b) => {
    const agg = paymentAgg.get(b.id);
    const fieldPaid = Number(b.amount_paid_cents) || 0;
    return {
      id: b.id,
      vendorId: b.vendor_id,
      locationId: b.location_id,
      billNumber: b.bill_number,
      billDate: b.bill_date,
      totalCents: Number(b.total_cents) || 0,
      paidCents: Math.max(fieldPaid, agg?.paidCents ?? 0),
    };
  });

  const candidates: DupCandidate[] = [];

  // ── Rule A + B2: duplicate bills, grouped by vendor (O(n²) within a vendor) ──
  const byVendor = new Map<string, DupBillInput[]>();
  for (const b of billInputs) {
    const arr = byVendor.get(b.vendorId) ?? [];
    arr.push(b);
    byVendor.set(b.vendorId, arr);
  }
  for (const [vendorId, group] of byVendor) {
    if (group.length < 2) continue;
    const vendorName = vendorNameById.get(vendorId) ?? 'Unknown vendor';
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const sig = scoreDuplicateBills(a, b);
        if (!sig || sig.confidence < DUP_THRESHOLDS.minSurface) continue;

        // If BOTH bills already disbursed cash, the duplicate is money OUT the
        // door — escalate as a duplicate PAYMENT, not just a duplicate bill.
        const moneyOut = a.paidCents > 0 && b.paidCents > 0;
        const overlap = Math.min(a.totalCents, b.totalCents);
        const kind: DupKind = moneyOut ? 'duplicate_payment' : 'duplicate_bill';
        const atRisk = moneyOut ? Math.min(a.paidCents, b.paidCents) || overlap : overlap;

        candidates.push({
          dedupKey: pairKey(moneyOut ? 'dup_pay_pair' : 'dup_bill', a.id, b.id),
          kind,
          confidence: sig.confidence,
          amountAtRiskCents: atRisk,
          moneyAlreadyOut: moneyOut,
          locationId: a.locationId ?? b.locationId,
          title: `${moneyOut ? 'Duplicate payment' : 'Possible duplicate bill'}: ${vendorName} · ${formatMoney(atRisk)} at risk`,
          reason: moneyOut
            ? `${sig.reason} Both bills have disbursed cash — ${formatMoney(atRisk)} likely paid twice.`
            : sig.reason,
          clarifyingQuestion: REMEDIATION_QUESTION[kind],
          subjects: { bill_id_a: a.id, bill_id_b: b.id, vendor_id: vendorId },
        });
      }
    }
  }

  // ── Rule B1: a single bill paid beyond its total (paid twice) ────────────────
  for (const b of billInputs) {
    const agg = paymentAgg.get(b.id);
    if (!agg) continue;
    const pa = assessBillPayments(b, agg);
    if (!pa.isOverpaid) continue;
    const vendorName = vendorNameById.get(b.vendorId) ?? 'Unknown vendor';
    candidates.push({
      dedupKey: `dup_pay:${b.id}`,
      kind: 'duplicate_payment',
      confidence: 0.9,
      amountAtRiskCents: pa.overpaidCents,
      moneyAlreadyOut: true,
      locationId: b.locationId,
      title: `Duplicate payment: ${vendorName} · ${formatMoney(pa.overpaidCents)} overpaid`,
      reason: `Bill ${b.billNumber ?? b.id} received ${pa.paymentCount} POSTED payments totaling ${formatMoney(pa.paidCents)} against a ${formatMoney(b.totalCents)} bill — ${formatMoney(pa.overpaidCents)} over its balance.`,
      clarifyingQuestion: REMEDIATION_QUESTION.duplicate_payment,
      subjects: { bill_id: b.id, vendor_id: b.vendorId, payment_count: pa.paymentCount },
    });
  }

  // ── Rule C: duplicate vendor masters. Block by TIN + first name token to cut
  // the pair space; still O(bucket²) per bucket. ───────────────────────────────
  const vendorInputs: DupVendorInput[] = vendors.map((v) => ({
    id: v.id,
    name: v.name,
    displayName: v.display_name,
    email: v.email,
    tin: v.tin_encrypted,
    addressLine1: v.address_line1,
    zip: v.zip,
    spendCents: Number(v.ytd_spend_cents) || 0,
    isActive: v.is_active,
  }));
  const buckets = new Map<string, DupVendorInput[]>();
  for (const v of vendorInputs) {
    const firstTok = normalizeText(v.name).split(' ')[0] ?? '';
    // A vendor joins its name-prefix bucket AND (if present) its TIN bucket, so
    // TIN-equal masters with different names still land together.
    const keys = new Set<string>();
    if (firstTok) keys.add(`n:${firstTok.slice(0, 4)}`);
    if (v.tin && v.tin.trim()) keys.add(`t:${v.tin.trim()}`);
    if (keys.size === 0) keys.add('n:_');
    for (const k of keys) {
      const arr = buckets.get(k) ?? [];
      arr.push(v);
      buckets.set(k, arr);
    }
  }
  const vendorPairSeen = new Set<string>();
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const key = pairKey('dup_vendor', a.id, b.id);
        if (vendorPairSeen.has(key)) continue; // same pair via two buckets
        vendorPairSeen.add(key);
        const sig = scoreDuplicateVendors(a, b);
        if (!sig || sig.confidence < DUP_THRESHOLDS.minSurface) continue;
        const atRisk = Math.min(a.spendCents, b.spendCents);
        candidates.push({
          dedupKey: key,
          kind: 'duplicate_vendor',
          confidence: sig.confidence,
          amountAtRiskCents: atRisk,
          moneyAlreadyOut: false,
          locationId: null,
          title: `Duplicate vendor: "${a.name}" ≈ "${b.name}"${atRisk > 0 ? ` · ${formatMoney(atRisk)} fragmented` : ''}`,
          reason: sig.reason,
          clarifyingQuestion: REMEDIATION_QUESTION.duplicate_vendor,
          subjects: { vendor_id_a: a.id, vendor_id_b: b.id },
        });
      }
    }
  }

  summary.detected = candidates.length;
  if (candidates.length === 0) return summary;

  // ── Idempotency: skip any dedup_key already open OR already resolved ─────────
  const existingKeys = new Set<string>();
  try {
    const { data: open } = await supabase
      .from('ai_decisions')
      .select('proposed_output')
      .eq('feature', DUP_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of open ?? []) {
      const po = (row as { proposed_output?: { dedup_key?: string } }).proposed_output;
      if (po?.dedup_key) existingKeys.add(po.dedup_key);
    }
  } catch {
    /* best-effort — worst case we rely on nothing and may re-queue */
  }

  // ── Insert new exceptions + write the AI audit trail ─────────────────────────
  for (const c of candidates) {
    if (existingKeys.has(c.dedupKey)) continue;
    const tier = resolveDupTier(c.confidence, c.amountAtRiskCents, policy, c.moneyAlreadyOut);
    const confidence = toConfidence(c.confidence);

    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      location_id: c.locationId,
      feature: DUP_FEATURE,
      input_summary: c.title,
      proposed_output: {
        control: 'EC-1',
        kind: c.kind,
        dedup_key: c.dedupKey,
        amount_at_risk_cents: c.amountAtRiskCents,
        tier,
        money_already_out: c.moneyAlreadyOut,
        subjects: c.subjects,
        reason: c.reason,
      },
      confidence,
      reasoning: c.reason,
      clarifying_question: c.clarifyingQuestion,
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      console.warn('[controls/dup] could not queue exception:', error.message);
      summary.errors += 1;
      continue;
    }
    existingKeys.add(c.dedupKey);
    summary.queued += 1;
    summary.byKind[c.kind] += 1;
    summary.byTier[tier] += 1;

    // Trust audit trail — the AI's detection, actor = AI (canon §3 / FPB D7).
    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'controls.duplicate_payment.detect',
      subjectTable: c.kind === 'duplicate_vendor' ? 'vendors' : 'bills',
      subjectId:
        (c.subjects.bill_id as string) ??
        (c.subjects.bill_id_a as string) ??
        (c.subjects.vendor_id_a as string) ??
        null,
      summary: c.title,
      locationId: c.locationId,
      confidence,
      tier,
      metadata: {
        kind: c.kind,
        dedup_key: c.dedupKey,
        amount_at_risk_cents: c.amountAtRiskCents,
        money_already_out: c.moneyAlreadyOut,
      },
    });
  }

  return summary;
}
