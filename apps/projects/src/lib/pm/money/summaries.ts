/**
 * Roll-ups over the money rows, computed the way the SQL computes them. Pure (unit-tested).
 */
import { COUNTED_STATUSES } from './aia';
import type {
  BillingLineRow, BillingQueueRow, BillingRequestRow, BillingStatus, CommitmentRow, CommitmentStatusRow, EstimateLineRow, JobFinancialsRow,
} from './types';

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

export interface CommitmentTotals {
  /** Revised amount (original + approved commitment changes). */
  committed: number;
  original: number;
  changes: number;
  received: number;
  billed: number;
  /** APPROVED / EXECUTED: Σ max(amount − billed, 0). */
  open: number;
  overBilled: number;
  receivedNotBilled: number;
  lines: number;
  vendorName: string | null;
  holdEffective: boolean;
  complianceOk: boolean;
}

const EMPTY: CommitmentTotals = {
  committed: 0, original: 0, changes: 0, received: 0, billed: 0, open: 0, overBilled: 0, receivedNotBilled: 0, lines: 0,
  vendorName: null, holdEffective: false, complianceOk: true,
};

/** pm.v_commitment_status lines → totals per commitment id. */
export function commitmentTotals(rows: ReadonlyArray<CommitmentStatusRow>): Map<string, CommitmentTotals> {
  const out = new Map<string, CommitmentTotals>();
  for (const r of rows) {
    const t = { ...(out.get(r.commitment_id) ?? EMPTY) };
    t.committed += r.revised_amount_cents;
    t.original += r.original_amount_cents;
    t.changes += r.approved_change_cents;
    t.received += r.received_cents;
    t.billed += r.billed_cents;
    t.open += r.open_cents;
    t.overBilled += r.over_billed_cents;
    t.receivedNotBilled += r.received_not_billed_cents;
    t.lines += 1;
    t.vendorName = r.vendor_name;
    t.holdEffective = r.payment_hold_effective;
    t.complianceOk = r.compliance_ok;
    out.set(r.commitment_id, t);
  }
  return out;
}

export function totalsFor(map: ReadonlyMap<string, CommitmentTotals>, c: Pick<CommitmentRow, 'id' | 'payment_hold'>): CommitmentTotals {
  return map.get(c.id) ?? { ...EMPTY, holdEffective: c.payment_hold };
}

// ---------------------------------------------------------------------------
// Billing to date (the generators' "counted" rule)
// ---------------------------------------------------------------------------

/** Σ gross of counted requests (EMITTED | ISSUED | UNISSUED | REJECTED), excluding retainage releases. */
export function billedToDate(requests: ReadonlyArray<Pick<BillingRequestRow, 'status' | 'billing_subtype' | 'gross_earned_cents' | 'id'>>, exceptId?: string): number {
  let s = 0;
  for (const r of requests) {
    if (r.id === exceptId || !COUNTED_STATUSES.has(r.status) || r.billing_subtype === 'RETAINAGE_RELEASE') continue;
    s += r.gross_earned_cents;
  }
  return s;
}

/** Σ retainage held on STANDARD lines of counted requests (the progress generator's "held"). */
export function heldToDate(
  requests: ReadonlyArray<Pick<BillingRequestRow, 'id' | 'status'>>,
  lines: ReadonlyArray<Pick<BillingLineRow, 'billing_request_id' | 'line_type' | 'retainage_this_period_cents'>>,
): number {
  const counted = new Set(requests.filter((r) => COUNTED_STATUSES.has(r.status)).map((r) => r.id));
  let s = 0;
  for (const l of lines) if (l.line_type === 'STANDARD' && counted.has(l.billing_request_id)) s += l.retainage_this_period_cents;
  return s;
}

// ---------------------------------------------------------------------------
// Company billing bands (/billing)
// ---------------------------------------------------------------------------

export type BillingBand = 'draft' | 'ready' | 'sent' | 'issued' | 'rejected' | 'unissued';

export function billingBand(r: { status: BillingStatus; failing_preconditions?: ReadonlyArray<string> | null }): BillingBand | null {
  switch (r.status) {
    case 'DRAFT': return (r.failing_preconditions?.length ?? 0) > 0 ? 'draft' : 'ready';
    case 'EMITTED': return 'sent';
    case 'ISSUED': return 'issued';
    case 'REJECTED': return 'rejected';
    case 'UNISSUED': return 'unissued';
    default: return null;
  }
}

/** A queue row the caller may approve: a draft or a rejected request with nothing failing. */
export function canSend(r: Pick<BillingQueueRow, 'kind' | 'status' | 'failing_preconditions'>): boolean {
  return r.kind === 'BILLING' && (r.status === 'DRAFT' || r.status === 'REJECTED') && r.failing_preconditions.length === 0;
}

// ---------------------------------------------------------------------------
// Job cost
// ---------------------------------------------------------------------------

/** Original margin fraction: (original contract − original budget) ÷ original contract. */
export function originalMargin(f: Pick<JobFinancialsRow, 'original_contract_cents' | 'budget_original_cents'>): number | null {
  if (f.original_contract_cents <= 0 || f.budget_original_cents == null) return null;
  return (f.original_contract_cents - f.budget_original_cents) / f.original_contract_cents;
}

export function projectedMargin(f: Pick<JobFinancialsRow, 'revised_contract_cents' | 'projected_margin_cents'>): number | null {
  if (f.revised_contract_cents <= 0) return null;
  return f.projected_margin_cents / f.revised_contract_cents;
}

/** Margin fade in fraction points (positive = the job is fading from what it was sold at). Null without both margins. */
export function marginFade(f: Pick<JobFinancialsRow, 'original_contract_cents' | 'budget_original_cents' | 'revised_contract_cents' | 'projected_margin_cents'>): number | null {
  const o = originalMargin(f);
  const p = projectedMargin(f);
  if (o == null || p == null) return null;
  return o - p;
}

/** Worst fade first; jobs without a comparison last, by projected margin. */
export function byFade<T extends Pick<JobFinancialsRow, 'original_contract_cents' | 'budget_original_cents' | 'revised_contract_cents' | 'projected_margin_cents'>>(rows: ReadonlyArray<T>): T[] {
  return [...rows].sort((a, b) => {
    const fa = marginFade(a);
    const fb = marginFade(b);
    if (fa == null && fb == null) return a.projected_margin_cents - b.projected_margin_cents;
    if (fa == null) return 1;
    if (fb == null) return -1;
    return fb - fa;
  });
}

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

export interface EstimateTotals { sell: number; cost: number; margin: number; marginPct: number | null; allowances: number; uncoded: number }

export function estimateTotals(lines: ReadonlyArray<Pick<EstimateLineRow, 'amount_cents' | 'cost_cents' | 'is_allowance' | 'cost_code_id'>>): EstimateTotals {
  let sell = 0, cost = 0, allowances = 0, uncoded = 0;
  for (const l of lines) {
    sell += l.amount_cents;
    cost += l.cost_cents ?? 0;
    if (l.is_allowance) allowances += l.amount_cents;
    if ((l.cost_cents ?? 0) !== 0 && !l.cost_code_id) uncoded += 1;
  }
  return { sell, cost, margin: sell - cost, marginPct: sell > 0 ? (sell - cost) / sell : null, allowances, uncoded };
}
