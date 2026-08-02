/**
 * Payment-Run Fraud Screen — the highest single-event dollar-risk control.
 *
 * Screens a PENDING AP disbursement (a bill about to be paid, or a batch of them)
 * for the fraud/leak patterns that lose real money the moment a release happens,
 * and returns a risk VERDICT ({ level: 'clear'|'review'|'block', flags, explanation }).
 *
 * Canon §3 invariants this obeys:
 *   - The AI NEVER initiates a transfer and NEVER decides. Every flag here is
 *     computed DETERMINISTICALLY from the payment + the vendor's own history
 *     (numbers/rules in code below). The Core AI gateway is used ONLY, optionally,
 *     to phrase a short human-readable summary of the already-computed flags — it
 *     cannot change the verdict or invent a fact.
 *   - Money movement stays in the existing gated release path (money/approvals.ts:
 *     preparer≠approver, explicit human release). This module DETECTS and SURFACES;
 *     a 'block'/'review' verdict requires an explicit human override to proceed.
 *     `screenPayment` is a PURE-boundary function the release path COULD call before
 *     releasing — it does not wire itself into markReleased(). See the route + report.
 *   - Every screen writes a PROPOSED row to public.ai_decisions (feature
 *     'PAYMENT_FRAUD', dedup_key `payfraud:<billId>`) so it surfaces in /exceptions,
 *     and an AI-attributed core.action_log row (canon §3 / trust layer).
 *
 * Five deterministic screeners:
 *   (1) NEW_PAYEE               — vendor never paid before (or first-ever bank instr).
 *   (2) BANK_DETAIL_CHANGE      — vendor's ACH account/routing mask changed since the
 *                                 last payment (the classic BEC / vendor-impersonation
 *                                 vector). Always critical.
 *   (3) UNUSUAL_AMOUNT          — amount well outside the vendor's own payment-history
 *                                 distribution (z-score AND ratio-to-max).
 *   (4) DUPLICATE               — same vendor + same/near amount + near date, OR same
 *                                 invoice ref, vs recent payments/open bills (kin to
 *                                 lib/controls/duplicate-payments — reuses its helpers).
 *   (5) ROUND_DOLLAR_FIRST_LARGE — a large, perfectly-round first-time payment (a tell).
 *
 * All money is bigint cents.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { formatMoney } from '@meritbooks/shared';
import { logAction } from '@/lib/trust/action-log';
import {
  DUP_THRESHOLDS,
  normalizeInvoiceNumber,
  toConfidence,
} from '@/lib/controls/duplicate-payments';

export const PAYMENT_FRAUD_FEATURE = 'PAYMENT_FRAUD';
export const PAYMENT_FRAUD_MODEL = 'claude-sonnet-4-20250514';

/** A payment at/above this is "large" for first-time / round-dollar escalation.
 *  Mirrors the money Business Rule auto-approve ceiling ($10,000). */
export const LARGE_PAYMENT_CENTS = 1_000_000;

/** Amount-outlier tunables (single source of truth). */
export const FRAUD_THRESHOLDS = {
  /** need at least this many prior payments before a distribution is meaningful. */
  minAmountSample: 4,
  /** z-score at/above which an amount is "unusual"; and the critical cut-line. */
  outlierZ: 3,
  outlierZCritical: 5,
  /** ratio to the largest prior payment at/above which an amount is "unusual". */
  outlierRatio: 3,
  outlierRatioCritical: 5,
  /** duplicate window (days) — reuse the AP duplicate matcher's wide window. */
  dupNearDays: DUP_THRESHOLDS.dateTightDays,
  dupWideDays: DUP_THRESHOLDS.dateWideDays,
  /** round-dollar granularity: a whole multiple of $1,000 reads as "round". */
  roundDollarCents: 100_000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentToScreen {
  /** the bill (or disbursement) about to be paid — subject id, used for dedup_key. */
  paymentId: string;
  vendorId: string;
  vendorName: string;
  locationId: string | null;
  amountCents: number;
  paymentDate: string; // ISO date the disbursement is dated
  invoiceRef: string | null; // bill number / invoice reference
}

export interface VendorPaymentHistory {
  /** prior POSTED disbursement amounts to this vendor (cents), excluding the subject. */
  priorAmountsCents: number[];
  /** count of prior POSTED payments to this vendor. */
  priorPaymentCount: number;
  /** ISO date of the most recent prior payment, or null (never paid). */
  lastPaidDate: string | null;
}

export interface VendorBankDetail {
  /** most-recent active ACH authorization masks on file. */
  currentAccountMask: string | null;
  currentRoutingMask: string | null;
  /** the masks in effect at the last payment (the "known good" baseline). */
  priorAccountMask: string | null;
  priorRoutingMask: string | null;
  /** when the current authorization was signed (ISO), or null. */
  currentSignedAt: string | null;
  /** number of distinct active authorizations on file. */
  activeAuthCount: number;
}

export interface RecentPayment {
  id: string;
  amountCents: number;
  paymentDate: string; // ISO
  invoiceRef: string | null;
  /** 'payment' = already-disbursed cash; 'bill' = another open bill for this vendor. */
  kind: 'payment' | 'bill';
}

export type FraudFlagCode =
  | 'NEW_PAYEE'
  | 'BANK_DETAIL_CHANGE'
  | 'UNUSUAL_AMOUNT'
  | 'DUPLICATE'
  | 'ROUND_DOLLAR_FIRST_LARGE';

export type FraudSeverity = 'info' | 'warn' | 'critical';

export interface FraudFlag {
  code: FraudFlagCode;
  severity: FraudSeverity;
  message: string; // audit-ready, plain language
  detail: Record<string, unknown>;
}

export type RiskLevel = 'clear' | 'review' | 'block';

export interface RiskVerdict {
  level: RiskLevel;
  flags: FraudFlag[];
  /** deterministic, human-readable summary of the computed flags. */
  explanation: string;
  /** 0..1 advisory risk score (max flag weight + small per-extra-flag bump). */
  score: number;
}

// ── small local helpers (I/O-free) ───────────────────────────────────────────

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

interface AmountStats {
  n: number;
  mean: number;
  std: number;
  median: number;
  max: number;
}

export function amountStats(values: number[]): AmountStats {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, std: 0, median: 0, max: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const sorted = [...values].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return { n, mean, std, median, max: sorted[n - 1] };
}

const SEVERITY_WEIGHT: Record<FraudSeverity, number> = { info: 0.15, warn: 0.5, critical: 1 };

// ─────────────────────────────────────────────────────────────────────────────
// (1) NEW PAYEE. Pure.
// ─────────────────────────────────────────────────────────────────────────────
export function screenNewPayee(
  payment: PaymentToScreen,
  history: VendorPaymentHistory,
): FraudFlag | null {
  if (history.priorPaymentCount > 0) return null;
  const large = payment.amountCents >= LARGE_PAYMENT_CENTS;
  return {
    code: 'NEW_PAYEE',
    severity: large ? 'critical' : 'warn',
    message: `First-ever payment to ${payment.vendorName} — no prior disbursement history${
      large ? `, and it is large (${formatMoney(payment.amountCents)}). Verify the payee and banking details out-of-band before release.` : '. Confirm the vendor is legitimate.'
    }`,
    detail: { amount_cents: payment.amountCents, prior_payment_count: 0, large },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) BANK-DETAIL CHANGE (BEC vector). Pure.
// ─────────────────────────────────────────────────────────────────────────────
export function screenBankDetailChange(
  payment: PaymentToScreen,
  history: VendorPaymentHistory,
  bank: VendorBankDetail,
): FraudFlag | null {
  const acctChanged =
    !!bank.priorAccountMask && !!bank.currentAccountMask && bank.priorAccountMask !== bank.currentAccountMask;
  const routeChanged =
    !!bank.priorRoutingMask && !!bank.currentRoutingMask && bank.priorRoutingMask !== bank.currentRoutingMask;

  // A CHANGED account/routing since the known-good baseline is the classic BEC
  // vector — always critical, cash is about to route to a new destination.
  if (acctChanged || routeChanged) {
    const parts: string[] = [];
    if (acctChanged) parts.push(`account …${bank.priorAccountMask} → …${bank.currentAccountMask}`);
    if (routeChanged) parts.push(`routing …${bank.priorRoutingMask} → …${bank.currentRoutingMask}`);
    return {
      code: 'BANK_DETAIL_CHANGE',
      severity: 'critical',
      message: `${payment.vendorName}'s bank details CHANGED since the last payment (${parts.join('; ')}). This is the classic business-email-compromise pattern — re-verify the new instructions with a known vendor contact by phone before releasing.`,
      detail: {
        account_changed: acctChanged,
        routing_changed: routeChanged,
        current_account_mask: bank.currentAccountMask,
        prior_account_mask: bank.priorAccountMask,
        current_routing_mask: bank.currentRoutingMask,
        prior_routing_mask: bank.priorRoutingMask,
        current_signed_at: bank.currentSignedAt,
      },
    };
  }

  // New banking instructions for a vendor we have paid before (previously by
  // check/no ACH on file) — a softer but still notable change.
  const newInstructionsForPaidVendor =
    history.priorPaymentCount > 0 &&
    !bank.priorAccountMask &&
    !bank.priorRoutingMask &&
    (!!bank.currentAccountMask || !!bank.currentRoutingMask);
  if (newInstructionsForPaidVendor) {
    return {
      code: 'BANK_DETAIL_CHANGE',
      severity: 'warn',
      message: `New banking instructions on file for ${payment.vendorName}, an existing vendor with no prior ACH details. Confirm the account was added by an authorized change before releasing.`,
      detail: {
        current_account_mask: bank.currentAccountMask,
        current_routing_mask: bank.currentRoutingMask,
        current_signed_at: bank.currentSignedAt,
        prior_payment_count: history.priorPaymentCount,
      },
    };
  }

  // Multiple concurrently-active bank accounts for one vendor — worth a look.
  if (bank.activeAuthCount > 1) {
    return {
      code: 'BANK_DETAIL_CHANGE',
      severity: 'warn',
      message: `${payment.vendorName} has ${bank.activeAuthCount} active bank authorizations on file — confirm the disbursement is routing to the intended account.`,
      detail: { active_auth_count: bank.activeAuthCount, current_account_mask: bank.currentAccountMask },
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// (3) UNUSUAL AMOUNT. Pure.
// ─────────────────────────────────────────────────────────────────────────────
export function screenUnusualAmount(
  payment: PaymentToScreen,
  history: VendorPaymentHistory,
): FraudFlag | null {
  const T = FRAUD_THRESHOLDS;
  const amounts = history.priorAmountsCents.filter((n) => Number.isFinite(n) && n > 0);
  if (amounts.length < T.minAmountSample) return null; // not enough history to judge

  const s = amountStats(amounts);
  // Only larger-than-history matters for disbursement fraud/overpayment.
  if (payment.amountCents <= s.max) {
    // still catch a heavy z-score even if not the strict max (near-ties)
    if (s.std <= 0) return null;
  }
  const z = s.std > 0 ? (payment.amountCents - s.mean) / s.std : payment.amountCents > s.max ? Number.POSITIVE_INFINITY : 0;
  const ratioToMax = s.max > 0 ? payment.amountCents / s.max : Number.POSITIVE_INFINITY;

  const isOutlier = payment.amountCents > s.mean && (z >= T.outlierZ || ratioToMax >= T.outlierRatio);
  if (!isOutlier) return null;

  const critical = z >= T.outlierZCritical || ratioToMax >= T.outlierRatioCritical;
  return {
    code: 'UNUSUAL_AMOUNT',
    severity: critical ? 'critical' : 'warn',
    message: `${formatMoney(payment.amountCents)} is well above ${payment.vendorName}'s usual payments (median ${formatMoney(Math.round(s.median))}, largest prior ${formatMoney(Math.round(s.max))}${
      Number.isFinite(ratioToMax) ? `, ~${ratioToMax.toFixed(1)}× the largest` : ''
    }). Verify the invoice amount before release.`,
    detail: {
      amount_cents: payment.amountCents,
      mean_cents: Math.round(s.mean),
      median_cents: Math.round(s.median),
      max_cents: Math.round(s.max),
      z_score: Number.isFinite(z) ? Number(z.toFixed(2)) : null,
      ratio_to_max: Number.isFinite(ratioToMax) ? Number(ratioToMax.toFixed(2)) : null,
      sample: s.n,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (4) DUPLICATE — kin to lib/controls/duplicate-payments. Pure.
// ─────────────────────────────────────────────────────────────────────────────
export function screenDuplicate(
  payment: PaymentToScreen,
  recent: RecentPayment[],
): FraudFlag | null {
  const T = DUP_THRESHOLDS;
  const F = FRAUD_THRESHOLDS;
  const subjInv = normalizeInvoiceNumber(payment.invoiceRef);

  let best: { r: RecentPayment; confidence: number; reason: string } | null = null;

  for (const r of recent) {
    if (r.id === payment.paymentId) continue;
    const rel = relAmountDiff(payment.amountCents, r.amountCents);
    const amountExact = rel <= T.amountExactRel;
    const amountNear = rel <= T.amountNearRel;
    const dd = daysApart(payment.paymentDate, r.paymentDate);
    const rInv = normalizeInvoiceNumber(r.invoiceRef);
    const sameInvoice = subjInv.length >= T.minInvoiceLen && subjInv === rInv;

    let confidence = 0;
    let reason = '';
    if (sameInvoice && amountExact) {
      confidence = 0.98;
      reason = `same invoice #${subjInv} and the same amount (${formatMoney(payment.amountCents)})`;
    } else if (sameInvoice) {
      confidence = 0.9;
      reason = `same invoice #${subjInv} for this vendor`;
    } else if (amountExact && dd <= F.dupNearDays) {
      confidence = 0.92;
      reason = `identical amount (${formatMoney(payment.amountCents)}), ${Math.round(dd)} day(s) apart`;
    } else if (amountExact && dd <= F.dupWideDays) {
      confidence = 0.82;
      reason = `identical amount (${formatMoney(payment.amountCents)}), ${Math.round(dd)} day(s) apart`;
    } else if (amountNear && dd <= F.dupNearDays) {
      confidence = 0.75;
      reason = `near-identical amount (~${formatMoney(payment.amountCents)}), ${Math.round(dd)} day(s) apart`;
    }
    if (confidence >= T.minSurface && (!best || confidence > best.confidence)) {
      best = { r, confidence, reason };
    }
  }

  if (!best) return null;
  const alreadyOut = best.r.kind === 'payment';
  return {
    code: 'DUPLICATE',
    severity: 'critical',
    message: `Possible duplicate of a ${alreadyOut ? 'payment already disbursed' : 'bill already on file'} to ${payment.vendorName} — ${best.reason}. Paying this releases the same money twice.`,
    detail: {
      match_id: best.r.id,
      match_kind: best.r.kind,
      confidence: Number(best.confidence.toFixed(4)),
      amount_cents: payment.amountCents,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (5) ROUND-DOLLAR / FIRST-TIME-LARGE. Pure.
// ─────────────────────────────────────────────────────────────────────────────
export function screenRoundDollarFirstLarge(
  payment: PaymentToScreen,
  history: VendorPaymentHistory,
): FraudFlag | null {
  const T = FRAUD_THRESHOLDS;
  const isRound = payment.amountCents > 0 && payment.amountCents % T.roundDollarCents === 0;
  const large = payment.amountCents >= LARGE_PAYMENT_CENTS;
  const firstTime = history.priorPaymentCount === 0;
  if (!(isRound && large && firstTime)) return null;
  return {
    code: 'ROUND_DOLLAR_FIRST_LARGE',
    severity: 'info',
    message: `${formatMoney(payment.amountCents)} is a large, perfectly round first-time payment to ${payment.vendorName} — a common fraud tell. Sanity-check the invoice.`,
    detail: { amount_cents: payment.amountCents, round: true, first_time: true },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict aggregation. Pure.
// ─────────────────────────────────────────────────────────────────────────────
export function assessPaymentRisk(
  payment: PaymentToScreen,
  history: VendorPaymentHistory,
  bank: VendorBankDetail,
  recent: RecentPayment[],
): RiskVerdict {
  const flags: FraudFlag[] = [];
  const push = (f: FraudFlag | null) => {
    if (f) flags.push(f);
  };
  push(screenNewPayee(payment, history));
  push(screenBankDetailChange(payment, history, bank));
  push(screenUnusualAmount(payment, history));
  push(screenDuplicate(payment, recent));
  push(screenRoundDollarFirstLarge(payment, history));

  const hasCritical = flags.some((f) => f.severity === 'critical');
  const hasWarn = flags.some((f) => f.severity === 'warn');
  const level: RiskLevel = hasCritical ? 'block' : hasWarn ? 'review' : 'clear';

  const maxWeight = flags.reduce((m, f) => Math.max(m, SEVERITY_WEIGHT[f.severity]), 0);
  const score = Math.min(1, maxWeight + Math.max(0, flags.length - 1) * 0.05);

  const explanation =
    flags.length === 0
      ? `No fraud indicators found for the ${formatMoney(payment.amountCents)} payment to ${payment.vendorName}. Cleared for the normal approval path.`
      : `${level === 'block' ? 'BLOCK' : 'REVIEW'} — ${flags.length} indicator${flags.length === 1 ? '' : 's'} on the ${formatMoney(
          payment.amountCents,
        )} payment to ${payment.vendorName}: ${flags.map((f) => f.message).join(' ')}`;

  return { level, flags, explanation, score };
}

/** A block/review verdict requires an explicit human override before money moves. */
export function requiresOverride(verdict: RiskVerdict): boolean {
  return verdict.level !== 'clear';
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration (I/O). Loads history + bank detail + recent activity, assesses,
// optionally phrases an AI explanation, writes the PROPOSED exception + audit row.
// NEVER moves money. NEVER throws on a data/logging error — a screen must not break
// the flow it rides on; on a hard read error it returns a fail-safe 'review'.
// ─────────────────────────────────────────────────────────────────────────────

export interface ScreenOptions {
  /** override the amount screened (defaults to the bill's outstanding balance). */
  amountCentsOverride?: number;
  /** the acting user's Clerk id, for the audit trail (screening is a human action). */
  actorClerkUserId?: string | null;
  /** when true and a key is available, ask the gateway to phrase the flags. */
  useAiExplanation?: boolean;
  /** server-injected Anthropic key (from lib/ai/gateway getAnthropicApiKey). */
  anthropicApiKey?: string | null;
}

export interface ScreenResult {
  ok: boolean;
  paymentId: string;
  verdict: RiskVerdict;
  aiExplanation: string | null;
  decisionId: string | null;
  error?: string;
}

interface BillRow {
  id: string;
  vendor_id: string;
  location_id: string | null;
  bill_number: string | null;
  bill_date: string;
  total_cents: number | string;
  balance_cents: number | string;
  amount_paid_cents: number | string;
  status: string;
}

function failSafeReview(paymentId: string, amountCents: number, why: string): ScreenResult {
  return {
    ok: false,
    paymentId,
    verdict: {
      level: 'review',
      flags: [
        {
          code: 'NEW_PAYEE',
          severity: 'warn',
          message: `Fraud screen could not complete (${why}); routing to manual review as a fail-safe.`,
          detail: { fail_safe: true },
        },
      ],
      explanation: `Screen incomplete — manual review required before release. (${why})`,
      score: 0.5,
    },
    aiExplanation: null,
    decisionId: null,
    error: why,
  };
}

export async function screenPayment(
  supabase: SupabaseClient,
  orgId: string,
  billId: string,
  opts: ScreenOptions = {},
): Promise<ScreenResult> {
  // ── 1. Subject bill ─────────────────────────────────────────────────────────
  const { data: billRaw, error: billErr } = await supabase
    .from('bills')
    .select('id, vendor_id, location_id, bill_number, bill_date, total_cents, balance_cents, amount_paid_cents, status')
    .eq('id', billId)
    .maybeSingle();
  if (billErr) return failSafeReview(billId, 0, 'bill lookup failed');
  if (!billRaw) return failSafeReview(billId, 0, 'bill not found');
  const bill = billRaw as BillRow;
  const amountCents =
    opts.amountCentsOverride != null && opts.amountCentsOverride > 0
      ? opts.amountCentsOverride
      : Number(bill.balance_cents) || Number(bill.total_cents) || 0;

  // ── 2. Vendor display name ──────────────────────────────────────────────────
  let vendorName = 'this vendor';
  try {
    const { data: v } = await supabase
      .schema('core')
      .from('vendors')
      .select('name, display_name')
      .eq('id', bill.vendor_id)
      .maybeSingle();
    const vr = v as { name?: string; display_name?: string | null } | null;
    if (vr) vendorName = vr.display_name || vr.name || vendorName;
  } catch {
    /* non-fatal — keep the default label */
  }

  const payment: PaymentToScreen = {
    paymentId: bill.id,
    vendorId: bill.vendor_id,
    vendorName,
    locationId: bill.location_id,
    amountCents,
    paymentDate: bill.bill_date,
    invoiceRef: bill.bill_number,
  };

  // ── 3. Vendor payment history + recent activity for duplicate detection ──────
  const { data: vendorBillsRaw, error: vbErr } = await supabase
    .from('bills')
    .select('id, bill_number, bill_date, total_cents, status')
    .eq('vendor_id', bill.vendor_id)
    .neq('status', 'VOIDED')
    .limit(1000);
  if (vbErr) return failSafeReview(bill.id, amountCents, 'vendor bill history failed');
  const vendorBills = (vendorBillsRaw ?? []) as Array<{
    id: string;
    bill_number: string | null;
    bill_date: string;
    total_cents: number | string;
    status: string;
  }>;
  const billNumberById = new Map<string, string | null>();
  for (const b of vendorBills) billNumberById.set(b.id, b.bill_number);
  const vendorBillIds = vendorBills.map((b) => b.id);

  const priorAmountsCents: number[] = [];
  const recent: RecentPayment[] = [];
  let lastPaidDate: string | null = null;

  if (vendorBillIds.length > 0) {
    for (let i = 0; i < vendorBillIds.length; i += 500) {
      const slice = vendorBillIds.slice(i, i + 500);
      const { data: pays } = await supabase
        .from('bill_payments')
        .select('id, bill_id, amount_cents, payment_date, status')
        .in('bill_id', slice)
        .eq('status', 'POSTED');
      for (const p of (pays ?? []) as Array<{
        id: string;
        bill_id: string;
        amount_cents: number | string;
        payment_date: string;
      }>) {
        if (p.bill_id === bill.id) continue; // exclude the subject's own settlements
        const amt = Number(p.amount_cents) || 0;
        priorAmountsCents.push(amt);
        if (!lastPaidDate || p.payment_date > lastPaidDate) lastPaidDate = p.payment_date;
        recent.push({
          id: p.id,
          amountCents: amt,
          paymentDate: p.payment_date,
          invoiceRef: billNumberById.get(p.bill_id) ?? null,
          kind: 'payment',
        });
      }
    }
  }

  // Other OPEN bills for this vendor (a duplicate about to be entered/paid).
  for (const b of vendorBills) {
    if (b.id === bill.id) continue;
    if (b.status === 'PAID') continue;
    recent.push({
      id: b.id,
      amountCents: Number(b.total_cents) || 0,
      paymentDate: b.bill_date,
      invoiceRef: b.bill_number,
      kind: 'bill',
    });
  }

  const history: VendorPaymentHistory = {
    priorAmountsCents,
    priorPaymentCount: priorAmountsCents.length,
    lastPaidDate,
  };

  // ── 4. Vendor bank detail (ACH authorization masks) ─────────────────────────
  const bank = await loadVendorBankDetail(supabase, bill.vendor_id, lastPaidDate);

  // ── 5. Deterministic verdict ────────────────────────────────────────────────
  const verdict = assessPaymentRisk(payment, history, bank, recent);

  // ── 6. Optional AI phrasing of the ALREADY-COMPUTED flags (never decides) ────
  let aiExplanation: string | null = null;
  if (opts.useAiExplanation && verdict.flags.length > 0 && opts.anthropicApiKey) {
    aiExplanation = await explainFlagsViaGateway(supabase, orgId, opts, payment, verdict);
  }

  // ── 7. Surface as a PROPOSED exception (review/block only) + audit trail ─────
  let decisionId: string | null = null;
  if (verdict.level !== 'clear') {
    decisionId = await queueException(supabase, orgId, payment, verdict, aiExplanation);
    await logAction(supabase, {
      orgId,
      actorType: opts.actorClerkUserId ? 'HUMAN' : 'AI',
      actorUserId: null,
      action: 'controls.payment_fraud.screen',
      subjectTable: 'bills',
      subjectId: bill.id,
      summary: `Payment fraud screen: ${verdict.level.toUpperCase()} — ${payment.vendorName} · ${formatMoney(amountCents)}`,
      locationId: payment.locationId,
      confidence: toConfidence(verdict.score),
      tier: verdict.level === 'block' ? 'escalate' : 'review',
      metadata: {
        dedup_key: `payfraud:${bill.id}`,
        level: verdict.level,
        flags: verdict.flags.map((f) => f.code),
        amount_cents: amountCents,
      },
    });
  }

  return { ok: true, paymentId: bill.id, verdict, aiExplanation, decisionId };
}

// ── bank detail loader ───────────────────────────────────────────────────────
async function loadVendorBankDetail(
  supabase: SupabaseClient,
  vendorId: string,
  lastPaidDate: string | null,
): Promise<VendorBankDetail> {
  const empty: VendorBankDetail = {
    currentAccountMask: null,
    currentRoutingMask: null,
    priorAccountMask: null,
    priorRoutingMask: null,
    currentSignedAt: null,
    activeAuthCount: 0,
  };
  try {
    const { data, error } = await supabase
      .from('ach_authorizations')
      .select('account_mask, routing_mask, signed_at, revoked_at')
      .eq('vendor_id', vendorId)
      .order('signed_at', { ascending: true });
    if (error || !data || data.length === 0) return empty;
    const auths = data as Array<{
      account_mask: string | null;
      routing_mask: string | null;
      signed_at: string;
      revoked_at: string | null;
    }>;

    const active = auths.filter((a) => !a.revoked_at);
    const current = active.length > 0 ? active[active.length - 1] : auths[auths.length - 1];

    // "Known good" = the authorization in effect at/before the last payment.
    let prior: (typeof auths)[number] | null = null;
    if (lastPaidDate) {
      for (const a of auths) {
        if (a.signed_at <= lastPaidDate) prior = a;
      }
    }
    // Distinct active account masks (routing may repeat across a re-sign).
    const activeMasks = new Set(active.map((a) => `${a.account_mask ?? ''}|${a.routing_mask ?? ''}`));

    return {
      currentAccountMask: current?.account_mask ?? null,
      currentRoutingMask: current?.routing_mask ?? null,
      priorAccountMask: prior?.account_mask ?? null,
      priorRoutingMask: prior?.routing_mask ?? null,
      currentSignedAt: current?.signed_at ?? null,
      activeAuthCount: activeMasks.size,
    };
  } catch {
    return empty;
  }
}

// ── idempotent exception write (migration 070 open-dedup guard) ───────────────
async function queueException(
  supabase: SupabaseClient,
  orgId: string,
  payment: PaymentToScreen,
  verdict: RiskVerdict,
  aiExplanation: string | null,
): Promise<string | null> {
  const dedupKey = `payfraud:${payment.paymentId}`;
  try {
    // Skip if an OPEN exception already exists for this subject (app-level dedup;
    // migration 070's partial unique index is the DB guarantor on the race).
    const { data: existing } = await supabase
      .from('ai_decisions')
      .select('id')
      .eq('feature', PAYMENT_FRAUD_FEATURE)
      .eq('status', 'PROPOSED')
      .contains('proposed_output', { dedup_key: dedupKey })
      .maybeSingle();
    if (existing && (existing as { id: string }).id) return (existing as { id: string }).id;

    const critical = verdict.level === 'block';
    const { data, error } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        location_id: payment.locationId,
        feature: PAYMENT_FRAUD_FEATURE,
        input_summary:
          `Payment fraud ${critical ? 'BLOCK' : 'REVIEW'}: ${payment.vendorName} · ${formatMoney(payment.amountCents)} at risk`.slice(0, 2000),
        proposed_output: {
          control: 'PAYMENT_FRAUD',
          dedup_key: dedupKey,
          level: verdict.level,
          amount_at_risk_cents: payment.amountCents,
          score: verdict.score,
          flags: verdict.flags,
          requires_human_override: true,
          subjects: { bill_id: payment.paymentId, vendor_id: payment.vendorId },
          ai_explanation: aiExplanation,
        },
        confidence: toConfidence(verdict.score),
        reasoning: aiExplanation ?? verdict.explanation,
        clarifying_question:
          critical
            ? 'Release is blocked. Confirm the payee and banking details out-of-band, then explicitly override to proceed — or hold the payment.'
            : 'Review the flags and confirm this payment is legitimate before it is released.',
        status: 'PROPOSED',
        created_by_user: null,
      })
      .select('id')
      .single();
    if (error) {
      // A concurrent insert may have won the unique index — treat as deduped.
      console.warn('[controls/payment-fraud] queue exception failed:', error.message);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.warn('[controls/payment-fraud] queue exception threw:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ── AI phrasing (explanation only; cannot change the verdict) ─────────────────
function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

async function explainFlagsViaGateway(
  supabase: SupabaseClient,
  orgId: string,
  opts: ScreenOptions,
  payment: PaymentToScreen,
  verdict: RiskVerdict,
): Promise<string | null> {
  const flagLines = verdict.flags.map((f) => `- [${f.severity}] ${f.code}: ${f.message}`).join('\n');
  const prompt = `You are a payments-risk analyst. Deterministic controls have ALREADY decided the verdict below for an accounts-payable disbursement. Do NOT re-decide, do NOT invent facts, do NOT recommend releasing. In 2 sentences, plainly summarize WHY this payment was flagged so an approver understands the risk before they manually decide.

PAYMENT: ${payment.vendorName} — ${formatMoney(payment.amountCents)} (invoice ${payment.invoiceRef ?? 'n/a'})
VERDICT: ${verdict.level.toUpperCase()}
COMPUTED FLAGS:
${flagLines}

Respond with plain text only, 2 sentences max.`;
  try {
    const gw = await runAiGateway(
      { supabase, anthropicApiKey: opts.anthropicApiKey as string },
      {
        tenant_id: orgId,
        user_id: opts.actorClerkUserId ?? null,
        module: 'BOOKS',
        feature: PAYMENT_FRAUD_FEATURE,
        model: PAYMENT_FRAUD_MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: 200,
      },
    );
    if (gw.status === 'blocked' || gw.result == null) return null;
    const text = extractText(gw.result);
    return text ? text.trim() : null;
  } catch {
    return null; // explanation is best-effort; the deterministic verdict stands
  }
}
