export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const startDate = searchParams.get('start_date') ?? new Date().toISOString().slice(0, 8) + '01';
  const endDate = searchParams.get('end_date') ?? new Date().toISOString().slice(0, 10);
  const mode = searchParams.get('mode') ?? 'summary';

  // Get invoices in period with customer info
  let invQ = supabase
    .from('invoices')
    .select(`
      id, invoice_number, invoice_date, total_cents, amount_paid_cents, balance_cents, status,
      customer:customers!invoices_customer_id_fkey(id, name, email, payment_terms_days),
      location:locations!invoices_location_id_fkey(name, short_code),
      job:jobs!invoices_job_id_fkey(job_number, name)
    `)
    .gte('invoice_date', startDate)
    .lte('invoice_date', endDate)
    .not('status', 'in', '("VOIDED","DRAFT")');
  if (locationId) invQ = invQ.eq('location_id', locationId);
  const { data: invoices } = await invQ;

  // Aggregate by customer
  const customerMap = new Map<string, {
    customerId: string;
    customerName: string;
    email: string | null;
    totalRevenueCents: number;
    totalPaidCents: number;
    totalBalanceCents: number;
    invoiceCount: number;
    invoices: { invoiceNumber: string; date: string; totalCents: number; paidCents: number; balanceCents: number; status: string; jobNumber: string | null; locationCode: string }[];
  }>();

  for (const inv of invoices ?? []) {
    const c = Array.isArray(inv.customer) ? inv.customer[0] : inv.customer;
    const loc = Array.isArray(inv.location) ? inv.location[0] : inv.location;
    const job = Array.isArray(inv.job) ? inv.job[0] : inv.job;
    if (!c) continue;

    const existing = customerMap.get(c.id);
    const invDetail = {
      invoiceNumber: inv.invoice_number,
      date: inv.invoice_date,
      totalCents: Number(inv.total_cents),
      paidCents: Number(inv.amount_paid_cents),
      balanceCents: Number(inv.balance_cents),
      status: inv.status,
      jobNumber: (job as { job_number: string } | null)?.job_number ?? null,
      locationCode: (loc as { short_code: string } | null)?.short_code ?? '',
    };

    if (existing) {
      existing.totalRevenueCents += Number(inv.total_cents);
      existing.totalPaidCents += Number(inv.amount_paid_cents);
      existing.totalBalanceCents += Number(inv.balance_cents);
      existing.invoiceCount++;
      if (mode === 'detail') existing.invoices.push(invDetail);
    } else {
      customerMap.set(c.id, {
        customerId: c.id,
        customerName: c.name,
        email: c.email,
        totalRevenueCents: Number(inv.total_cents),
        totalPaidCents: Number(inv.amount_paid_cents),
        totalBalanceCents: Number(inv.balance_cents),
        invoiceCount: 1,
        invoices: mode === 'detail' ? [invDetail] : [],
      });
    }
  }

  const customers = Array.from(customerMap.values()).sort((a, b) => b.totalRevenueCents - a.totalRevenueCents);
  const totalRevenue = customers.reduce((s, c) => s + c.totalRevenueCents, 0);
  const totalCollected = customers.reduce((s, c) => s + c.totalPaidCents, 0);

  return NextResponse.json({
    period: { startDate, endDate },
    mode,
    data: customers,
    summary: {
      totalRevenueCents: totalRevenue,
      totalCollectedCents: totalCollected,
      totalOutstandingCents: totalRevenue - totalCollected,
      customerCount: customers.length,
      invoiceCount: customers.reduce((s, c) => s + c.invoiceCount, 0),
    },
  });
}
