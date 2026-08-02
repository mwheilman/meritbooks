export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { pairsForVendor, type VendorDupInput } from '@/lib/vendors/dedupe';

/**
 * GET /api/vendors/[id] — vendor detail + ledger rollup for the detail drawer/peek.
 *
 * Returns identity + compliance (W-9 / GL COI / WC COI + payment-hold state),
 * the open-bills list, payment history (POSTED bill_payments), an A/P summary,
 * YTD + trailing-12-month spend, and the raw compliance docs.
 *
 * Schema notes (Rule 11):
 *  - vendors live in `core`; bills / bill_payments / vendor_compliance_docs /
 *    vendor_payment_holds live in `public`. PostgREST cannot embed core↔public,
 *    so every child set is fetched separately and stitched in JS.
 *  - money is bigint cents everywhere; balance_cents is a generated column
 *    (total_cents - amount_paid_cents).
 *  - bill.status ∈ PENDING|APPROVED|PARTIALLY_PAID|PAID|VOIDED|ON_HOLD.
 *  - bill_payments.status ∈ POSTED|VOIDED; only POSTED count as real cash out.
 *  - vendor_compliance_docs.status ∈ MISSING|PENDING|VALID|EXPIRED;
 *    doc_type ∈ W9|GL_COI|WC_COI|WC_EXEMPTION.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: v, error } = await supabase
    .schema('core').from('vendors').select('*')
    .eq('org_id', orgId).eq('id', params.id).single();
  if (error || !v) return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });

  // ---- Bills (public), all of this vendor's — bounded, newest first. Used for
  // the open-bills list, A/P summary, spend rollups, and the payment-number map.
  const { data: billRows } = await supabase
    .from('bills')
    .select('id, bill_number, bill_date, due_date, total_cents, balance_cents, amount_paid_cents, status')
    .eq('org_id', orgId).eq('vendor_id', params.id)
    .order('bill_date', { ascending: false })
    .limit(500);
  const bills = (billRows ?? []) as Array<Record<string, any>>;
  const billIds = bills.map((b) => b.id as string);

  // ---- Payment history (public.bill_payments, POSTED), joined to bill # in JS.
  let paymentRows: Array<Record<string, any>> = [];
  if (billIds.length > 0) {
    const { data: pays } = await supabase
      .from('bill_payments')
      .select('id, bill_id, amount_cents, payment_date, method, rail, status')
      .eq('org_id', orgId).in('bill_id', billIds)
      .eq('status', 'POSTED')
      .order('payment_date', { ascending: false })
      .limit(100);
    paymentRows = (pays ?? []) as Array<Record<string, any>>;
  }

  // ---- Compliance docs (public) + payment holds (public).
  const [{ data: docRows }, { data: holdRows }] = await Promise.all([
    supabase
      .from('vendor_compliance_docs')
      .select('id, doc_type, status, issued_date, expiration_date, coverage_amount_cents, file_url')
      .eq('org_id', orgId).eq('vendor_id', params.id),
    supabase
      .from('vendor_payment_holds')
      .select('id, hold_type, reason, start_date, end_date, released_at')
      .eq('org_id', orgId).eq('vendor_id', params.id),
  ]);
  const docs = (docRows ?? []) as Array<Record<string, any>>;
  const holds = (holdRows ?? []) as Array<Record<string, any>>;

  const now = new Date();
  const today = now;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // A hold is in effect if its window covers today and it hasn't been released.
  const holdInEffect = (h: Record<string, any>) => {
    if (h.released_at) return false;
    if (h.start_date && new Date(h.start_date) > now) return false;
    if (h.end_date && new Date(h.end_date) < now) return false;
    return true;
  };
  const activeHold = holds.find(holdInEffect) ?? null;
  const hasPaymentHold = !!activeHold;

  // ---- Compliance status per doc-type (mirrors the list route's logic).
  const docStatus = (docType: string): 'valid' | 'expired' | 'pending' | 'missing' => {
    const d = docs.find((x) => x.doc_type === docType);
    if (!d) return 'missing';
    if (d.status === 'PENDING') return 'pending';
    if (d.status !== 'VALID') return 'expired';
    if (d.expiration_date && new Date(d.expiration_date) < now) return 'expired';
    return 'valid';
  };

  // ---- A/P summary + open bills.
  let openBalance = 0;
  let overdueCount = 0;
  const openBills = bills
    .filter((b) => Number(b.balance_cents ?? 0) > 0 && b.status !== 'VOIDED')
    .map((b) => {
      const balance = Number(b.balance_cents ?? 0);
      openBalance += balance;
      const due = b.due_date ? startOfDay(new Date(b.due_date)) : null;
      const overdue = due != null && due < startOfDay(today);
      if (overdue) overdueCount += 1;
      const daysOverdue = overdue && due ? Math.floor((startOfDay(today).getTime() - due.getTime()) / 86_400_000) : 0;
      return {
        id: b.id, billNumber: b.bill_number, billDate: b.bill_date, dueDate: b.due_date,
        totalCents: Number(b.total_cents ?? 0), balanceCents: balance, status: b.status, daysOverdue,
      };
    });

  // ---- Spend rollups (from bills posted, excluding voided). YTD = since Jan 1
  // of the current year; TTM = trailing 12 months by bill_date.
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const ttmStart = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  let ytdCents = 0;
  let ttmCents = 0;
  let lifetimeBilledCents = 0;
  for (const b of bills) {
    if (b.status === 'VOIDED') continue;
    const amt = Number(b.total_cents ?? 0);
    lifetimeBilledCents += amt;
    const bd = b.bill_date ? new Date(b.bill_date) : null;
    if (!bd) continue;
    if (bd >= yearStart) ytdCents += amt;
    if (bd >= ttmStart) ttmCents += amt;
  }

  // ---- Payment history with bill-number stitched in.
  const billNumberById = new Map(bills.map((b) => [b.id as string, b.bill_number as string | null]));
  const payments = paymentRows.map((p) => ({
    id: p.id,
    billId: p.bill_id,
    billNumber: billNumberById.get(p.bill_id as string) ?? null,
    paymentDate: p.payment_date,
    amountCents: Number(p.amount_cents ?? 0),
    method: p.method ?? p.rail ?? null,
  }));
  const paidYtdCents = payments
    .filter((p) => p.paymentDate && new Date(p.paymentDate) >= yearStart)
    .reduce((s, p) => s + p.amountCents, 0);

  const recentBills = bills.slice(0, 8).map((b) => ({
    id: b.id, billNumber: b.bill_number, billDate: b.bill_date,
    totalCents: Number(b.total_cents ?? 0), balanceCents: Number(b.balance_cents ?? 0), status: b.status,
  }));

  // ---- Live "possible duplicates" surface (read-only; never auto-merges).
  const possibleDuplicates = await computePossibleDuplicates(supabase, orgId, params.id);

  const ven = v as Record<string, any>;
  return NextResponse.json({
    id: ven.id,
    name: ven.display_name || ven.name,
    legalName: ven.name,
    email: ven.email ?? null,
    phone: ven.phone ?? null,
    website: ven.website ?? null,
    addressLine: [ven.address_line1, ven.city, ven.state, ven.zip].filter(Boolean).join(', ') || null,
    paymentTermsDays: ven.payment_terms_days ?? null,
    is1099: !!ven.is_1099_eligible,
    autoApprove: !!ven.auto_approve,
    taxId: null, // no plaintext TIN column on core.vendors (tin_encrypted not surfaced)
    isActive: ven.is_active !== false,
    w9Status: ven.w9_status ?? null,

    compliance: {
      w9: docStatus('W9'),
      glCoi: docStatus('GL_COI'),
      wcCoi: docStatus('WC_COI'),
      hasPaymentHold,
      hold: activeHold
        ? { type: activeHold.hold_type, reason: activeHold.reason, endDate: activeHold.end_date ?? null }
        : null,
    },
    complianceDocs: docs.map((d) => ({
      id: d.id,
      docType: d.doc_type,
      status: d.status,
      issuedDate: d.issued_date ?? null,
      expirationDate: d.expiration_date ?? null,
      coverageAmountCents: d.coverage_amount_cents != null ? Number(d.coverage_amount_cents) : null,
      hasFile: !!d.file_url,
    })),

    ap: {
      openBalance,
      overdueCount,
      openBillCount: openBills.length,
    },
    spend: {
      ytdCents,
      ttmCents,
      lifetimeBilledCents,
      paidYtdCents,
    },

    openBills,
    payments,
    recentBills,
    possibleDuplicates,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Live read-only duplicate-vendor surface for the detail drawer. Loads the org's
 * active vendors, quantifies each one's open A/P (sum of positive bill balances,
 * excluding voided), scores them against this vendor with the shared vendor
 * dedupe scorer, and returns up to the 5 strongest candidates. Pure detection —
 * there is deliberately no vendor merge action (canon §3).
 */
async function computePossibleDuplicates(
  supabase: SupabaseClient,
  orgId: string,
  targetId: string,
): Promise<Array<{
  id: string;
  name: string;
  confidence: number;
  matchedFields: string[];
  reason: string;
  amountAtRiskCents: number;
}>> {
  const { data: rows } = await supabase
    .schema('core')
    .from('vendors')
    .select('id, name, display_name, email, phone, address_line1, zip')
    .eq('org_id', orgId)
    .is('deleted_at', null)
    .limit(5000);
  const venRows = (rows ?? []) as Array<{
    id: string;
    name: string;
    display_name: string | null;
    email: string | null;
    phone: string | null;
    address_line1: string | null;
    zip: string | null;
  }>;
  if (venRows.length < 2) return [];

  // open A/P per vendor (best-effort) to quantify the at-risk figure.
  const openApByVendor = new Map<string, number>();
  const ids = venRows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const { data: billBals } = await supabase
      .from('bills')
      .select('vendor_id, balance_cents, status')
      .eq('org_id', orgId)
      .in('vendor_id', slice)
      .gt('balance_cents', 0)
      .neq('status', 'VOIDED');
    for (const b of (billBals ?? []) as Array<{ vendor_id: string; balance_cents: number | string }>) {
      const cur = openApByVendor.get(b.vendor_id) ?? 0;
      openApByVendor.set(b.vendor_id, cur + (Number(b.balance_cents) || 0));
    }
  }

  const toInput = (r: (typeof venRows)[number]): VendorDupInput => ({
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    email: r.email,
    phone: r.phone,
    addressLine1: r.address_line1,
    zip: r.zip,
    openApCents: openApByVendor.get(r.id) ?? 0,
  });

  const target = venRows.find((r) => r.id === targetId);
  if (!target) return [];
  const others = venRows.filter((r) => r.id !== targetId).map(toInput);
  const pairs = pairsForVendor(toInput(target), others);
  return pairs.slice(0, 5).map((p) => ({
    id: p.b.id,
    name: p.b.displayName || p.b.name,
    confidence: p.signal.confidence,
    matchedFields: p.signal.matchedFields,
    reason: p.signal.reason,
    amountAtRiskCents: p.amountAtRiskCents,
  }));
}
