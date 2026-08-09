export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

/**
 * GET /api/customers/[id] — customer record for the detail drawer/peek:
 * identity + AR summary (open balance, overdue count) + recent invoices.
 * customers is in `core`; invoices is in `public` (filtered by customer_id).
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: c, error } = await supabase
    .schema('core').from('customers').select('*')
    .eq('org_id', orgId).eq('id', params.id).single();
  if (error || !c) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  const { data: invRows } = await supabase
    .from('invoices')
    .select('id, invoice_number, invoice_date, due_date, total_cents, balance_cents, status')
    .eq('org_id', orgId).eq('customer_id', params.id)
    .order('invoice_date', { ascending: false })
    .limit(50);

  const invoices = (invRows ?? []) as Array<Record<string, any>>;
  const recentInvoices = invoices.slice(0, 5).map((inv) => ({
    id: inv.id, invoiceNumber: inv.invoice_number, invoiceDate: inv.invoice_date,
    totalCents: Number(inv.total_cents ?? 0), balanceCents: Number(inv.balance_cents ?? 0), status: inv.status,
  }));

  // AR-at-a-glance figures — computed over the FULL set of open invoices (not the
  // 50-row recent slice) so the strip is exact even for high-volume customers.
  // `balance_cents` is a stored generated column, so it's filterable server-side.
  const todayStr = new Date().toISOString().slice(0, 10);
  const daysSince = (d: string | null): number | null => {
    if (!d) return null;
    const t = Date.parse(`${d}T00:00:00Z`);
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.floor((Date.parse(`${todayStr}T00:00:00Z`) - t) / 86_400_000));
  };

  const { data: openRows } = await supabase
    .from('invoices')
    .select('invoice_date, due_date, balance_cents')
    .eq('org_id', orgId).eq('customer_id', params.id)
    .gt('balance_cents', 0)
    .neq('status', 'VOIDED')
    .order('invoice_date', { ascending: true });
  const open = (openRows ?? []) as Array<Record<string, any>>;
  let totalOutstanding = 0;
  let overdueCount = 0;
  let overdueOutstanding = 0;
  for (const inv of open) {
    const bal = Number(inv.balance_cents ?? 0);
    totalOutstanding += bal;
    if (inv.due_date && inv.due_date < todayStr) {
      overdueCount += 1;
      overdueOutstanding += bal;
    }
  }
  const oldestOpenInvoiceDays = open.length ? daysSince(String(open[0].invoice_date ?? '')) : null;

  const { data: lastPay } = await supabase
    .from('customer_payments')
    .select('payment_date, amount_cents')
    .eq('org_id', orgId).eq('customer_id', params.id)
    .order('payment_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const lp = lastPay as Record<string, any> | null;

  const cust = c as Record<string, any>;
  return NextResponse.json({
    id: cust.id,
    name: cust.display_name || cust.name,
    legalName: cust.name,
    email: cust.email ?? null,
    phone: cust.phone ?? null,
    contactName: [cust.contact_first_name, cust.contact_last_name].filter(Boolean).join(' ') || null,
    addressLine: [cust.address_line1, cust.city, cust.state, cust.zip].filter(Boolean).join(', ') || null,
    website: cust.website ?? null,
    paymentTermsDays: cust.payment_terms_days ?? null,
    creditLimitCents: cust.credit_limit_cents ?? null,
    taxExempt: !!cust.tax_exempt,
    isPortfolioCompany: !!cust.is_portfolio_company,
    isActive: cust.is_active !== false,
    notes: cust.notes ?? null,
    ar: {
      totalOutstanding,
      overdueCount,
      overdueOutstanding,
      openInvoiceCount: open.length,
      oldestOpenInvoiceDays,
      lastPaymentDate: lp?.payment_date ?? null,
      lastPaymentCents: lp?.amount_cents != null ? Number(lp.amount_cents) : null,
    },
    recentInvoices,
  });
}
