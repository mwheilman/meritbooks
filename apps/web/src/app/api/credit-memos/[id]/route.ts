export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * GET /api/credit-memos/[id] — a single credit memo with its lines, stitched
 * customer/location from `core`, and (when linked) the target invoice's current
 * open balance so the drawer can offer a correct one-click apply. RLS-scoped.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: m, error } = await supabase
    .from('credit_memos')
    .select(`
      id, credit_number, credit_date, status, memo, reason,
      subtotal_cents, tax_cents, total_cents, applied_amount_cents,
      customer_id, location_id, invoice_id, gl_entry_id, created_at
    `)
    .eq('org_id', orgId)
    .eq('id', params.id)
    .single();

  if (error || !m) return NextResponse.json({ error: 'Credit memo not found' }, { status: 404 });

  // credit_memo_lines.account_id has no FK in migration 071, so PostgREST cannot
  // embed accounts here — fetch the referenced accounts separately and stitch.
  const { data: lineRows } = await supabase
    .from('credit_memo_lines')
    .select('id, description, amount_cents, account_id')
    .eq('credit_memo_id', params.id)
    .order('created_at', { ascending: true });

  const acctIds = [...new Set((lineRows ?? []).map((l) => l.account_id).filter(Boolean))] as string[];
  const { data: acctRows } = acctIds.length
    ? await supabase.from('accounts').select('id, account_number, name').eq('org_id', orgId).in('id', acctIds)
    : { data: [] as { id: string; account_number: string; name: string }[] };
  const acctById = new Map((acctRows ?? []).map((a) => [a.id as string, a]));

  const custMap = await fetchCoreMap<{ id: string; name: string; email: string | null }>(
    supabase, 'customers', 'id, name, email', [m.customer_id]);
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', [m.location_id]);
  const cust = m.customer_id ? custMap.get(m.customer_id) ?? null : null;
  const loc = m.location_id ? locMap.get(m.location_id) ?? null : null;

  // Linked-invoice snapshot for apply UX (number + live open balance).
  let linkedInvoice: { id: string; invoiceNumber: string; balanceCents: number; status: string } | null = null;
  if (m.invoice_id) {
    const { data: inv } = await supabase
      .from('invoices')
      .select('id, invoice_number, balance_cents, status')
      .eq('org_id', orgId).eq('id', m.invoice_id).maybeSingle();
    if (inv) {
      linkedInvoice = {
        id: inv.id as string,
        invoiceNumber: inv.invoice_number as string,
        balanceCents: Number(inv.balance_cents ?? 0),
        status: inv.status as string,
      };
    }
  }

  const lines = (lineRows ?? []).map((l) => {
    const acct = l.account_id ? acctById.get(l.account_id as string) ?? null : null;
    return {
      id: l.id,
      description: l.description,
      amountCents: Number(l.amount_cents ?? 0),
      accountNumber: acct?.account_number ?? '',
      accountName: acct?.name ?? '',
    };
  });

  const total = Number(m.total_cents ?? 0);
  const applied = Number(m.applied_amount_cents ?? 0);

  return NextResponse.json({
    id: m.id,
    creditNumber: m.credit_number,
    creditDate: m.credit_date,
    status: m.status,
    memo: m.memo,
    reason: m.reason,
    subtotalCents: Number(m.subtotal_cents ?? 0),
    taxCents: Number(m.tax_cents ?? 0),
    totalCents: total,
    appliedCents: applied,
    unappliedCents: Math.max(0, total - applied),
    glEntryId: m.gl_entry_id,
    invoiceId: m.invoice_id,
    customerId: m.customer_id,
    customerName: cust?.name ?? '',
    customerEmail: cust?.email ?? null,
    locationName: loc?.name ?? '',
    locationCode: loc?.short_code ?? '',
    linkedInvoice,
    lines,
  });
}
