export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * GET /api/customers/[id] — customer record for the detail drawer/peek:
 * identity + AR summary (open balance, overdue count) + recent invoices.
 * customers is in `core`; invoices is in `public` (filtered by customer_id).
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  const orgId = (org as { id: string } | null)?.id;
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
  const today = new Date();
  let totalOutstanding = 0;
  let overdueCount = 0;
  for (const inv of invoices) {
    const bal = Number(inv.balance_cents ?? 0);
    if (bal > 0) {
      totalOutstanding += bal;
      if (inv.due_date && new Date(inv.due_date) < today) overdueCount += 1;
    }
  }

  const recentInvoices = invoices.slice(0, 5).map((inv) => ({
    id: inv.id, invoiceNumber: inv.invoice_number, invoiceDate: inv.invoice_date,
    totalCents: Number(inv.total_cents ?? 0), balanceCents: Number(inv.balance_cents ?? 0), status: inv.status,
  }));

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
    ar: { totalOutstanding, overdueCount, openInvoiceCount: invoices.filter((i) => Number(i.balance_cents ?? 0) > 0).length },
    recentInvoices,
  });
}
