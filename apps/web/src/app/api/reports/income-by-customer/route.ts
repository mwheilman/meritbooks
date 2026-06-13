export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { fetchCoreMap } from '@/lib/stitch-core';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');
  const locationId = searchParams.get('location_id');
  const locFilter = locationIds ? locationIds.split(',').filter(Boolean) : (locationId && locationId !== 'all' ? [locationId] : []);
  const startDate = searchParams.get('start_date') ?? new Date().toISOString().slice(0, 8) + '01';
  const endDate = searchParams.get('end_date') ?? new Date().toISOString().slice(0, 10);
  const mode = searchParams.get('mode') ?? 'summary';

  // Get invoices in period with customer info
  let invQ = supabase
    .from('invoices')
    .select(`
      id, invoice_number, invoice_date, total_cents, amount_paid_cents, balance_cents, status,
      customer_id, location_id, job_id
    `)
    .gte('invoice_date', startDate)
    .lte('invoice_date', endDate)
    .not('status', 'in', '("VOIDED","DRAFT")');
  if (locationId) invQ = invQ.eq('location_id', locationId);
  const { data: invoices } = await invQ;
  const invRows = (invoices ?? []) as Array<Record<string, any>>;
  const custMap = await fetchCoreMap<{ id: string; name: string; email: string | null; payment_terms_days: number }>(
    supabase, 'customers', 'id, name, email, payment_terms_days', invRows.map((i) => i.customer_id));
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', invRows.map((i) => i.location_id));
  const jobMap = await fetchCoreMap<{ id: string; job_number: string; name: string }>(
    supabase, 'jobs', 'id, job_number, name', invRows.map((i) => i.job_id));
  for (const i of invRows) {
    i.customer = i.customer_id ? custMap.get(i.customer_id) ?? null : null;
    i.location = i.location_id ? locMap.get(i.location_id) ?? null : null;
    i.job = i.job_id ? jobMap.get(i.job_id) ?? null : null;
  }

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

  for (const inv of invRows) {
    const c = inv.customer;
    const loc = inv.location;
    const job = inv.job;
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
