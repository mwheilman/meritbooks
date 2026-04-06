export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');
  const locationId = searchParams.get('location_id');
  const locFilter = locationIds ? locationIds.split(',').filter(Boolean) : (locationId && locationId !== 'all' ? [locationId] : []);

  let query = supabase
    .from('invoices')
    .select(`
      id, customer_id, total_cents, amount_paid_cents, balance_cents, status, due_date,
      customer:customers!invoices_customer_id_fkey(id, name, email, payment_terms_days)
    `)
    .not('status', 'in', '("VOIDED","DRAFT")');

  if (locFilter.length === 1) query = query.eq('location_id', locFilter[0]);
  else if (locFilter.length > 1) query = query.in('location_id', locFilter);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const customerMap = new Map<string, {
    customerId: string; customerName: string; email: string | null; termsDays: number;
    totalInvoicedCents: number; totalPaidCents: number; openBalanceCents: number;
    invoiceCount: number; openInvoiceCount: number;
    aging: Record<string, number>;
  }>();

  const now = new Date();
  for (const inv of data ?? []) {
    const c = Array.isArray(inv.customer) ? inv.customer[0] : inv.customer;
    if (!c) continue;
    const key = c.id;
    const balance = Number(inv.balance_cents ?? 0);
    const daysOver = inv.due_date ? Math.max(0, Math.floor((now.getTime() - new Date(inv.due_date).getTime()) / 86400000)) : 0;
    const bucket = balance <= 0 ? 'PAID' : daysOver <= 0 ? 'CURRENT' : daysOver <= 30 ? '1-30' : daysOver <= 60 ? '31-60' : daysOver <= 90 ? '61-90' : '90+';

    const existing = customerMap.get(key);
    if (existing) {
      existing.totalInvoicedCents += Number(inv.total_cents);
      existing.totalPaidCents += Number(inv.amount_paid_cents);
      existing.openBalanceCents += balance > 0 ? balance : 0;
      existing.invoiceCount++;
      if (balance > 0) existing.openInvoiceCount++;
      if (bucket !== 'PAID') existing.aging[bucket] = (existing.aging[bucket] ?? 0) + balance;
    } else {
      const aging: Record<string, number> = {};
      if (bucket !== 'PAID') aging[bucket] = balance;
      customerMap.set(key, {
        customerId: c.id, customerName: c.name, email: c.email, termsDays: c.payment_terms_days,
        totalInvoicedCents: Number(inv.total_cents), totalPaidCents: Number(inv.amount_paid_cents),
        openBalanceCents: balance > 0 ? balance : 0, invoiceCount: 1, openInvoiceCount: balance > 0 ? 1 : 0, aging,
      });
    }
  }

  const customers = Array.from(customerMap.values()).sort((a, b) => b.openBalanceCents - a.openBalanceCents);

  return NextResponse.json({
    data: customers,
    summary: {
      totalCustomers: customers.length,
      totalOpenCents: customers.reduce((s, c) => s + c.openBalanceCents, 0),
      customersWithBalance: customers.filter((c) => c.openBalanceCents > 0).length,
    },
  });
}
