export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { remainingCents, type DepositRow } from '@/lib/customer-deposits/service';

/**
 * GET /api/customer-deposits/[id]
 * Deposit detail: the deposit row, its applications (with invoice numbers), and
 * the customer's OPEN invoices that a remaining balance could be applied to.
 * RLS-scoped user client → tenant isolation at the DB.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 403 });

  const { data: depRaw, error } = await supabase
    .from('customer_deposits')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  if (!depRaw) return NextResponse.json({ error: 'Deposit not found', code: 'NOT_FOUND' }, { status: 404 });

  const deposit = depRaw as unknown as DepositRow;
  const remaining = remainingCents({
    amount_cents: Number(deposit.amount_cents),
    applied_cents: Number(deposit.applied_cents),
    refunded_cents: Number(deposit.refunded_cents),
  });

  const [{ data: appsRaw }, { data: cust }, { data: loc }] = await Promise.all([
    supabase
      .from('customer_deposit_applications')
      .select('id, invoice_id, amount_cents, journal_entry_id, applied_by, applied_at')
      .eq('org_id', orgId)
      .eq('deposit_id', params.id)
      .order('applied_at', { ascending: false }),
    supabase.schema('core').from('customers').select('id, name, email').eq('id', deposit.customer_id).maybeSingle(),
    supabase.schema('core').from('locations').select('id, name, short_code').eq('id', deposit.location_id).maybeSingle(),
  ]);

  const apps = appsRaw ?? [];
  const invoiceIds = [...new Set(apps.map((a) => a.invoice_id as string))];

  // Applied-to invoice numbers.
  const appliedInvoices = invoiceIds.length
    ? (await supabase.from('invoices').select('id, invoice_number').in('id', invoiceIds)).data ?? []
    : [];
  const invNumById = new Map(appliedInvoices.map((i) => [i.id as string, i.invoice_number as string]));

  // Open invoices for this customer that could receive an application.
  const { data: openInvoices } = await supabase
    .from('invoices')
    .select('id, invoice_number, invoice_date, due_date, total_cents, balance_cents, status, currency')
    .eq('org_id', orgId)
    .eq('customer_id', deposit.customer_id)
    .gt('balance_cents', 0)
    .in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE'])
    .order('due_date', { ascending: true });

  return NextResponse.json({
    data: {
      deposit: { ...deposit, remainingCents: remaining },
      customer: cust ?? null,
      location: loc ?? null,
      applications: apps.map((a) => ({
        ...a,
        invoiceNumber: invNumById.get(a.invoice_id as string) ?? null,
      })),
      openInvoices: (openInvoices ?? []).map((i) => ({
        id: i.id,
        invoiceNumber: i.invoice_number,
        invoiceDate: i.invoice_date,
        dueDate: i.due_date,
        totalCents: Number(i.total_cents),
        balanceCents: Number(i.balance_cents),
        status: i.status,
        currency: i.currency ?? 'USD',
      })),
    },
  });
}
