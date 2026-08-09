/**
 * Close open-items detector — the deterministic (AI-off) scan for the four
 * open-item classes the close-readiness gate adds on top of the reconciliation /
 * subledger / leakage checks already in the task graph:
 *
 *   • unposted (draft) journal entries dated in the period        → BLOCKING
 *   • vendor bills sitting ON_HOLD as of period end               → warning
 *   • customer payments with cash still unapplied to an invoice   → warning
 *   • period-relevant bills/JEs still awaiting an approval chain   → BLOCKING
 *
 * These feed `CloseSignals` (see `./orchestration.ts`), so the SAME numbers drive
 * the per-entity board, the on-transition hard-close gate, and the close-package
 * open-items summary — one source of truth.
 *
 * Everything is scoped precisely:
 *   - drafts / pending-approval JEs .. by `gl_entries.fiscal_period_id` (exact period)
 *   - bills / pending-approval bills . by `bills.location_id` + `bill_date <= period end`
 *   - unapplied payments ............. current-state cash, attributed to a location
 *                                       via the receiving bank account
 *
 * The scan is BATCHED (org-wide reads tallied per location) so it serves both the
 * whole-portfolio board and a single-entity gate from one code path. Every read runs
 * through the RLS-scoped client, so tenant isolation is enforced by the database.
 * All money is bigint cents; nothing is written.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const ROW_CAP = 5000;

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The open-item counts for one entity, as of the period being closed. */
export interface OpenItemsCounts {
  unpostedDraftCount: number;
  billsOnHoldCount: number;
  unappliedPaymentCount: number;
  unappliedPaymentCents: number;
  pendingApprovalCount: number;
}

export function emptyOpenItems(): OpenItemsCounts {
  return {
    unpostedDraftCount: 0,
    billsOnHoldCount: 0,
    unappliedPaymentCount: 0,
    unappliedPaymentCents: 0,
    pendingApprovalCount: 0,
  };
}

/** One entity's close context: which period is being closed and when it ends. */
export interface LocationCloseContext {
  locationId: string;
  /** The fiscal_periods.id for the month being closed (null ⇒ no period). */
  periodId: string | null;
  /** fiscal_periods.end_date (ISO date) — bounds bill-date scoping. */
  periodEndISO: string | null;
}

// Row shapes (only the columns selected).
interface DraftRow { fiscal_period_id: string | null }
interface BillRow { id: string; location_id: string | null; bill_date: string | null }
interface BankAcctRow { id: string; location_id: string | null }
interface PaymentRow { id: string; amount_cents: number | string | null; bank_account_id: string | null }
interface ApplicationRow { payment_id: string; amount_cents: number | string | null }
interface ApprovalRow { doc_type: string; doc_id: string }
interface GlLocRow { id: string; location_id: string | null; fiscal_period_id: string | null }

/**
 * Batched open-items scan across a set of entities. Returns a Map keyed by
 * location_id; entities with no open items still get a zeroed entry so callers can
 * read every location deterministically.
 */
export async function gatherOpenItemsByLocation(
  supabase: SupabaseClient,
  contexts: LocationCloseContext[],
): Promise<Map<string, OpenItemsCounts>> {
  const out = new Map<string, OpenItemsCounts>();
  for (const c of contexts) out.set(c.locationId, emptyOpenItems());
  if (contexts.length === 0) return out;

  const locationIds = contexts.map((c) => c.locationId);
  const periodIds = contexts.map((c) => c.periodId).filter((p): p is string => !!p);
  const locByPeriod = new Map<string, string>();
  const endByLoc = new Map<string, string | null>();
  for (const c of contexts) {
    if (c.periodId) locByPeriod.set(c.periodId, c.locationId);
    endByLoc.set(c.locationId, c.periodEndISO);
  }
  const inSet = (locationId: string | null): boolean => !!locationId && out.has(locationId);
  const beforeEnd = (locationId: string, dateISO: string | null): boolean => {
    const end = endByLoc.get(locationId) ?? null;
    if (!end) return true; // no period bound ⇒ count it
    if (!dateISO) return true;
    return dateISO <= end;
  };

  // ── (1) Unposted draft journal entries, by period ──────────────────────────
  // A draft = a gl_entries header not yet POSTED and not VOIDED, dated in the period.
  if (periodIds.length > 0) {
    const { data } = await supabase
      .from('gl_entries')
      .select('fiscal_period_id')
      .in('fiscal_period_id', periodIds)
      .neq('status', 'POSTED')
      .neq('status', 'VOIDED')
      .limit(ROW_CAP);
    for (const r of (data ?? []) as DraftRow[]) {
      const loc = r.fiscal_period_id ? locByPeriod.get(r.fiscal_period_id) : undefined;
      if (!loc) continue;
      const c = out.get(loc)!;
      c.unpostedDraftCount += 1;
    }
  }

  // ── (2) Bills on hold, by location, dated on/before period end ─────────────
  {
    const { data } = await supabase
      .from('bills')
      .select('id, location_id, bill_date')
      .eq('status', 'ON_HOLD')
      .in('location_id', locationIds)
      .limit(ROW_CAP);
    for (const r of (data ?? []) as BillRow[]) {
      if (!inSet(r.location_id)) continue;
      if (!beforeEnd(r.location_id as string, r.bill_date)) continue;
      out.get(r.location_id as string)!.billsOnHoldCount += 1;
    }
  }

  // ── (3) Unapplied customer payments, attributed via the receiving bank account ─
  // customer_payments carry no location; attribute by bank_account_id → location.
  // Unapplied = amount − Σ(payment_applications). Current-state cash (not period-bound).
  {
    const { data: acctData } = await supabase
      .from('bank_accounts')
      .select('id, location_id')
      .in('location_id', locationIds)
      .limit(ROW_CAP);
    const acctToLoc = new Map<string, string>();
    for (const a of (acctData ?? []) as BankAcctRow[]) {
      if (a.location_id && inSet(a.location_id)) acctToLoc.set(a.id, a.location_id);
    }
    const acctIds = [...acctToLoc.keys()];
    if (acctIds.length > 0) {
      const { data: payData } = await supabase
        .from('customer_payments')
        .select('id, amount_cents, bank_account_id')
        .in('bank_account_id', acctIds)
        .limit(ROW_CAP);
      const payments = (payData ?? []) as PaymentRow[];
      const paymentIds = payments.map((p) => p.id);
      const appliedByPayment = new Map<string, number>();
      if (paymentIds.length > 0) {
        const { data: appData } = await supabase
          .from('payment_applications')
          .select('payment_id, amount_cents')
          .in('payment_id', paymentIds)
          .limit(ROW_CAP);
        for (const a of (appData ?? []) as ApplicationRow[]) {
          appliedByPayment.set(a.payment_id, (appliedByPayment.get(a.payment_id) ?? 0) + num(a.amount_cents));
        }
      }
      for (const p of payments) {
        const loc = p.bank_account_id ? acctToLoc.get(p.bank_account_id) : undefined;
        if (!loc) continue;
        const unapplied = num(p.amount_cents) - (appliedByPayment.get(p.id) ?? 0);
        if (unapplied > 0) {
          const c = out.get(loc)!;
          c.unappliedPaymentCount += 1;
          c.unappliedPaymentCents += unapplied;
        }
      }
    }
  }

  // ── (4) Pending approval requests, attributed to a location + period ───────
  // Only the doc types that post to the ledger for a period are gated here:
  // JOURNAL_ENTRY (by gl_entries.fiscal_period_id) and BILL (by bills.location_id
  // + bill_date <= period end). PAYMENT/EXPENSE/PAYROLL lack a clean period tie and
  // are intentionally not treated as per-period close blockers.
  {
    const { data } = await supabase
      .from('approval_requests')
      .select('doc_type, doc_id')
      .eq('status', 'PENDING')
      .in('doc_type', ['JOURNAL_ENTRY', 'BILL'])
      .limit(ROW_CAP);
    const rows = (data ?? []) as ApprovalRow[];
    const jeIds = rows.filter((r) => r.doc_type === 'JOURNAL_ENTRY').map((r) => r.doc_id);
    const billIds = rows.filter((r) => r.doc_type === 'BILL').map((r) => r.doc_id);

    if (jeIds.length > 0 && periodIds.length > 0) {
      const { data: jeData } = await supabase
        .from('gl_entries')
        .select('id, location_id, fiscal_period_id')
        .in('id', jeIds)
        .in('fiscal_period_id', periodIds)
        .limit(ROW_CAP);
      for (const r of (jeData ?? []) as GlLocRow[]) {
        const loc = r.fiscal_period_id ? locByPeriod.get(r.fiscal_period_id) : undefined;
        if (!loc) continue;
        out.get(loc)!.pendingApprovalCount += 1;
      }
    }
    if (billIds.length > 0) {
      const { data: billData } = await supabase
        .from('bills')
        .select('id, location_id, bill_date')
        .in('id', billIds)
        .in('location_id', locationIds)
        .limit(ROW_CAP);
      for (const r of (billData ?? []) as BillRow[]) {
        if (!inSet(r.location_id)) continue;
        if (!beforeEnd(r.location_id as string, r.bill_date)) continue;
        out.get(r.location_id as string)!.pendingApprovalCount += 1;
      }
    }
  }

  return out;
}

/** Single-entity convenience wrapper over the batched scan. */
export async function gatherEntityOpenItems(
  supabase: SupabaseClient,
  ctx: LocationCloseContext,
): Promise<OpenItemsCounts> {
  const map = await gatherOpenItemsByLocation(supabase, [ctx]);
  return map.get(ctx.locationId) ?? emptyOpenItems();
}
