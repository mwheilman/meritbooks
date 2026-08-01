export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

/**
 * GET /api/vendors/[id] — vendor record for the detail drawer/peek:
 * identity + compliance + AP summary (open balance, overdue) + recent bills.
 * vendors is in `core`; bills is in `public` (filtered by vendor_id).
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

  const { data: billRows } = await supabase
    .from('bills')
    .select('id, bill_number, bill_date, due_date, total_cents, balance_cents, status')
    .eq('org_id', orgId).eq('vendor_id', params.id)
    .order('bill_date', { ascending: false })
    .limit(50);

  // Payment-hold state lives in public.vendor_payment_holds (not a column on
  // core.vendors). A hold is active if its window covers today.
  const { data: holdRows } = await supabase
    .from('vendor_payment_holds')
    .select('start_date, end_date')
    .eq('org_id', orgId).eq('vendor_id', params.id);
  const now = new Date();
  const hasPaymentHold = (holdRows ?? []).some((h: { start_date: string | null; end_date: string | null }) => {
    if (h.start_date && new Date(h.start_date) > now) return false;
    if (h.end_date && new Date(h.end_date) < now) return false;
    return true;
  });

  const bills = (billRows ?? []) as Array<Record<string, any>>;
  const today = new Date();
  let openBalance = 0;
  let overdueCount = 0;
  for (const b of bills) {
    const bal = Number(b.balance_cents ?? 0);
    if (bal > 0) {
      openBalance += bal;
      if (b.due_date && new Date(b.due_date) < today) overdueCount += 1;
    }
  }
  const recentBills = bills.slice(0, 5).map((b) => ({
    id: b.id, billNumber: b.bill_number, billDate: b.bill_date,
    totalCents: Number(b.total_cents ?? 0), balanceCents: Number(b.balance_cents ?? 0), status: b.status,
  }));

  const ven = v as Record<string, any>;
  return NextResponse.json({
    id: ven.id,
    name: ven.display_name || ven.name,
    legalName: ven.name,
    email: ven.email ?? null,
    phone: ven.phone ?? null,
    addressLine: [ven.address_line1, ven.city, ven.state, ven.zip].filter(Boolean).join(', ') || null,
    paymentTermsDays: ven.payment_terms_days ?? null,
    is1099: !!ven.is_1099_eligible,
    autoApprove: !!ven.auto_approve,
    taxId: null, // no plaintext TIN column on core.vendors (tin_encrypted is not surfaced)
    isActive: ven.is_active !== false,
    compliance: {
      w9: ven.w9_status ?? null,
      hasPaymentHold,
    },
    ap: { openBalance, overdueCount, openBillCount: bills.filter((b) => Number(b.balance_cents ?? 0) > 0).length },
    recentBills,
  });
}
