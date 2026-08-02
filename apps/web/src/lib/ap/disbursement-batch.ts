/**
 * AP disbursement BATCH builder (money-out MVP, task #109) — PURE, DB-free.
 *
 * Assembles a set of APPROVED AP disbursement approvals into a payable BATCH:
 * grouped by vendor, with per-vendor + grand-total controls, per-method totals,
 * and an intra-batch DUPLICATE-PAYMENT guard so the same money is never released
 * twice in one run.
 *
 * SAFETY / CANON §3: this module NEVER moves money, NEVER posts to the GL, and
 * NEVER contacts a bank or payment API. It only shapes data + computes controls.
 * Releasing (the DR A/P / CR Cash post) happens elsewhere, only on an explicit
 * human RELEASE through the existing gated payment path (see the release route).
 *
 * The duplicate guard reuses the EC-1 duplicate-payment detector's thresholds and
 * invoice-number normalization (lib/controls/duplicate-payments) so this control
 * can't drift from the standalone one. All money is bigint cents.
 */

import { formatMoney } from '@meritbooks/shared';
import { DUP_THRESHOLDS, normalizeInvoiceNumber } from '@/lib/controls/duplicate-payments';

export type DisbursementMethod = 'ACH' | 'CHECK';

/** One payable line fed into the batch — one APPROVED disbursement approval. */
export interface DisbursementItemInput {
  /** the approvals.id (AP_DISBURSEMENT) that authorizes this line. */
  approvalId: string;
  billId: string;
  vendorId: string;
  vendorName: string;
  /** bill number / invoice reference (the duplicate key). */
  invoiceRef: string | null;
  amountCents: number;
  /** ISO date the disbursement is dated (bill due date, or the run date). */
  paymentDate: string;
  method: DisbursementMethod;
  locationId: string | null;
  /** clerk id of the preparer — used downstream to enforce releaser != preparer. */
  preparedBy: string;
}

export interface DisbursementItem extends DisbursementItemInput {
  /** approvalIds of other items in THIS batch this line may duplicate. */
  duplicateOf: string[];
}

export interface VendorGroup {
  vendorId: string;
  vendorName: string;
  itemCount: number;
  subtotalCents: number;
  items: DisbursementItem[];
}

export type DuplicateSeverity = 'warn' | 'critical';

export interface DuplicateWarning {
  aApprovalId: string;
  bApprovalId: string;
  vendorId: string;
  vendorName: string;
  /** 0..1 confidence the two lines are the same payment. */
  confidence: number;
  severity: DuplicateSeverity;
  reason: string;
}

export interface MethodTotals {
  count: number;
  totalCents: number;
}

export interface BatchControls {
  itemCount: number;
  vendorCount: number;
  totalCents: number;
  byMethod: Record<DisbursementMethod, MethodTotals>;
  /** true when any duplicate warning is `critical` — the release path must block
   *  unless a human explicitly overrides. */
  hasBlockingDuplicates: boolean;
}

export interface DisbursementBatch {
  groups: VendorGroup[];
  controls: BatchControls;
  duplicateWarnings: DuplicateWarning[];
}

// ── local, I/O-free helpers (mirror the private ones in duplicate-payments) ──

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

/**
 * Score two SAME-VENDOR lines in the same batch as duplicates of one another.
 * Returns null below the surfacing floor. Confidence curve mirrors the EC-1
 * detector / payment-fraud DUPLICATE screener so the controls agree.
 */
export function scoreIntraBatchDuplicate(
  a: DisbursementItemInput,
  b: DisbursementItemInput,
): { confidence: number; reason: string } | null {
  if (a.approvalId === b.approvalId || a.vendorId !== b.vendorId) return null;
  const T = DUP_THRESHOLDS;

  const invA = normalizeInvoiceNumber(a.invoiceRef);
  const invB = normalizeInvoiceNumber(b.invoiceRef);
  const sameInvoice = invA.length >= T.minInvoiceLen && invA === invB;

  const rel = relAmountDiff(a.amountCents, b.amountCents);
  const amountExact = rel <= T.amountExactRel;
  const amountNear = rel <= T.amountNearRel;
  const dd = daysApart(a.paymentDate, b.paymentDate);
  const amt = formatMoney(Math.min(a.amountCents, b.amountCents));

  if (sameInvoice && amountExact) {
    return { confidence: 0.98, reason: `Same invoice #${invA} and the same amount (${amt}) queued twice for ${a.vendorName}.` };
  }
  if (sameInvoice) {
    return { confidence: 0.9, reason: `Same invoice #${invA} queued twice for ${a.vendorName} (amounts differ).` };
  }
  if (amountExact && dd <= T.dateTightDays) {
    return { confidence: 0.92, reason: `Two lines for ${a.vendorName} at the identical amount (${amt}), ${Math.round(dd)} day(s) apart.` };
  }
  if (amountExact && dd <= T.dateWideDays) {
    return { confidence: 0.82, reason: `Two lines for ${a.vendorName} at the identical amount (${amt}), ${Math.round(dd)} day(s) apart.` };
  }
  if (amountNear && dd <= T.dateTightDays) {
    return { confidence: 0.75, reason: `Two lines for ${a.vendorName} at near-identical amounts (~${amt}), ${Math.round(dd)} day(s) apart.` };
  }
  return null;
}

/** A warning at/above this confidence blocks the release unless overridden. */
export const DUP_BLOCK_CONFIDENCE = 0.9;

const EMPTY_METHOD_TOTALS = (): Record<DisbursementMethod, MethodTotals> => ({
  ACH: { count: 0, totalCents: 0 },
  CHECK: { count: 0, totalCents: 0 },
});

/**
 * Build a disbursement batch from approved payable lines. Throws on a
 * non-positive amount (a money invariant — callers must pass real balances).
 */
export function buildDisbursementBatch(inputs: DisbursementItemInput[]): DisbursementBatch {
  for (const i of inputs) {
    if (!Number.isFinite(i.amountCents) || i.amountCents <= 0) {
      throw new Error(`Disbursement line ${i.approvalId} has a non-positive amount (${i.amountCents})`);
    }
  }

  // ── Duplicate detection (per vendor, O(n²) within a vendor) ──
  const warnings: DuplicateWarning[] = [];
  const dupIdsByApproval = new Map<string, Set<string>>();
  const byVendor = new Map<string, DisbursementItemInput[]>();
  for (const i of inputs) {
    const arr = byVendor.get(i.vendorId) ?? [];
    arr.push(i);
    byVendor.set(i.vendorId, arr);
  }
  for (const group of byVendor.values()) {
    for (let x = 0; x < group.length; x++) {
      for (let y = x + 1; y < group.length; y++) {
        const a = group[x];
        const b = group[y];
        const sig = scoreIntraBatchDuplicate(a, b);
        if (!sig || sig.confidence < DUP_THRESHOLDS.minSurface) continue;
        const severity: DuplicateSeverity = sig.confidence >= DUP_BLOCK_CONFIDENCE ? 'critical' : 'warn';
        warnings.push({
          aApprovalId: a.approvalId,
          bApprovalId: b.approvalId,
          vendorId: a.vendorId,
          vendorName: a.vendorName,
          confidence: Number(sig.confidence.toFixed(4)),
          severity,
          reason: sig.reason,
        });
        for (const [p, q] of [[a.approvalId, b.approvalId], [b.approvalId, a.approvalId]] as const) {
          const set = dupIdsByApproval.get(p) ?? new Set<string>();
          set.add(q);
          dupIdsByApproval.set(p, set);
        }
      }
    }
  }

  // ── Group + totals ──
  const groups: VendorGroup[] = [];
  const byMethod = EMPTY_METHOD_TOTALS();
  let totalCents = 0;

  const sortedVendorIds = Array.from(byVendor.keys()).sort((p, q) => {
    const np = byVendor.get(p)![0].vendorName;
    const nq = byVendor.get(q)![0].vendorName;
    return np.localeCompare(nq);
  });

  for (const vendorId of sortedVendorIds) {
    const raw = byVendor.get(vendorId)!;
    const items: DisbursementItem[] = raw
      .slice()
      .sort((p, q) => p.paymentDate.localeCompare(q.paymentDate))
      .map((i) => ({ ...i, duplicateOf: Array.from(dupIdsByApproval.get(i.approvalId) ?? []) }));
    let subtotalCents = 0;
    for (const i of items) {
      subtotalCents += i.amountCents;
      totalCents += i.amountCents;
      byMethod[i.method].count += 1;
      byMethod[i.method].totalCents += i.amountCents;
    }
    groups.push({
      vendorId,
      vendorName: items[0].vendorName,
      itemCount: items.length,
      subtotalCents,
      items,
    });
  }

  const hasBlockingDuplicates = warnings.some((w) => w.severity === 'critical');

  return {
    groups,
    duplicateWarnings: warnings,
    controls: {
      itemCount: inputs.length,
      vendorCount: byVendor.size,
      totalCents,
      byMethod,
      hasBlockingDuplicates,
    },
  };
}
