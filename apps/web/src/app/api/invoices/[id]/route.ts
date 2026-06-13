export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * GET /api/invoices/[id]
 * Full invoice for the detail drawer: header + line items (account is public,
 * embed OK) with customer / location / job stitched from `core`.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  const orgId = (org as { id: string } | null)?.id;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: inv, error } = await supabase
    .from('invoices')
    .select(`
      id, invoice_number, invoice_date, due_date, status, memo,
      subtotal_cents, tax_cents, total_cents, amount_paid_cents, balance_cents,
      is_progress_bill, customer_id, location_id, job_id, gl_entry_id, created_at
    `)
    .eq('org_id', orgId)
    .eq('id', params.id)
    .single();

  if (error || !inv) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const { data: lineRows } = await supabase
    .from('invoice_lines')
    .select(`
      id, line_number, description, quantity, unit_price_cents, amount_cents,
      account:accounts!invoice_lines_account_id_fkey(account_number, name)
    `)
    .eq('invoice_id', params.id)
    .order('line_number', { ascending: true });

  const custMap = await fetchCoreMap<{ id: string; name: string; email: string | null }>(
    supabase, 'customers', 'id, name, email', [inv.customer_id]);
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', [inv.location_id]);
  const jobMap = await fetchCoreMap<{ id: string; job_number: string; name: string }>(
    supabase, 'jobs', 'id, job_number, name', [inv.job_id]);

  const cust = inv.customer_id ? custMap.get(inv.customer_id) ?? null : null;
  const loc = inv.location_id ? locMap.get(inv.location_id) ?? null : null;
  const job = inv.job_id ? jobMap.get(inv.job_id) ?? null : null;

  const lines = (lineRows ?? []).map((l: Record<string, any>) => {
    const acct = Array.isArray(l.account) ? l.account[0] : l.account;
    return {
      id: l.id,
      lineNumber: l.line_number,
      description: l.description,
      quantity: Number(l.quantity ?? 0),
      unitPriceCents: Number(l.unit_price_cents ?? 0),
      amountCents: Number(l.amount_cents ?? 0),
      accountNumber: (acct as { account_number?: string } | null)?.account_number ?? '',
      accountName: (acct as { name?: string } | null)?.name ?? '',
    };
  });

  return NextResponse.json({
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    invoiceDate: inv.invoice_date,
    dueDate: inv.due_date,
    status: inv.status,
    memo: inv.memo,
    isProgressBill: inv.is_progress_bill,
    subtotalCents: Number(inv.subtotal_cents ?? 0),
    taxCents: Number(inv.tax_cents ?? 0),
    totalCents: Number(inv.total_cents ?? 0),
    amountPaidCents: Number(inv.amount_paid_cents ?? 0),
    balanceCents: Number(inv.balance_cents ?? 0),
    customerName: cust?.name ?? '',
    customerEmail: cust?.email ?? null,
    locationName: loc?.name ?? '',
    locationCode: loc?.short_code ?? '',
    jobLabel: job ? `${job.job_number} · ${job.name}` : null,
    lines,
  });
}
