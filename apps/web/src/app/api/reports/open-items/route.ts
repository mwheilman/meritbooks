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
  const type = searchParams.get('type'); // 'ar', 'ap', or null for both

  const items: {
    id: string; type: 'invoice' | 'bill'; number: string; counterpartyName: string;
    date: string; dueDate: string; totalCents: number; paidCents: number; balanceCents: number;
    daysOverdue: number; locationName: string; status: string;
  }[] = [];

  const now = new Date();

  // Open invoices (AR)
  if (!type || type === 'ar') {
    let invQ = supabase
      .from('invoices')
      .select(`
        id, invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, balance_cents, status,
        customer_id, location_id
      `)
      .not('status', 'in', '("PAID","VOIDED","DRAFT")');
    if (locationId) invQ = invQ.eq('location_id', locationId);
    const { data: invoicesRaw } = await invQ;
    const invoices = (invoicesRaw ?? []) as Array<Record<string, any>>;
    const cMap = await fetchCoreMap<{ id: string; name: string }>(supabase, 'customers', 'id, name', invoices.map((i) => i.customer_id));
    const lMap = await fetchCoreMap<{ id: string; name: string }>(supabase, 'locations', 'id, name', invoices.map((i) => i.location_id));

    for (const inv of invoices) {
      const cust = inv.customer_id ? cMap.get(inv.customer_id) ?? null : null;
      const loc = inv.location_id ? lMap.get(inv.location_id) ?? null : null;
      const daysOver = Math.max(0, Math.floor((now.getTime() - new Date(inv.due_date).getTime()) / 86400000));
      items.push({
        id: inv.id, type: 'invoice', number: inv.invoice_number,
        counterpartyName: (cust as { name: string } | null)?.name ?? 'Unknown',
        date: inv.invoice_date, dueDate: inv.due_date,
        totalCents: Number(inv.total_cents), paidCents: Number(inv.amount_paid_cents),
        balanceCents: Number(inv.balance_cents), daysOverdue: daysOver,
        locationName: (loc as { name: string } | null)?.name ?? '', status: inv.status,
      });
    }
  }

  // Open bills (AP)
  if (!type || type === 'ap') {
    let billQ = supabase
      .from('bills')
      .select(`
        id, bill_number, bill_date, due_date, total_cents, amount_paid_cents, balance_cents, status,
        vendor_id, location_id
      `)
      .not('status', 'in', '("PAID","VOIDED")');
    if (locationId) billQ = billQ.eq('location_id', locationId);
    const { data: billsRaw } = await billQ;
    const bills = (billsRaw ?? []) as Array<Record<string, any>>;
    const vMap = await fetchCoreMap<{ id: string; name: string }>(supabase, 'vendors', 'id, name', bills.map((b) => b.vendor_id));
    const blMap = await fetchCoreMap<{ id: string; name: string }>(supabase, 'locations', 'id, name', bills.map((b) => b.location_id));

    for (const bill of bills) {
      const vend = bill.vendor_id ? vMap.get(bill.vendor_id) ?? null : null;
      const loc = bill.location_id ? blMap.get(bill.location_id) ?? null : null;
      const daysOver = Math.max(0, Math.floor((now.getTime() - new Date(bill.due_date).getTime()) / 86400000));
      items.push({
        id: bill.id, type: 'bill', number: bill.bill_number ?? 'No #',
        counterpartyName: (vend as { name: string } | null)?.name ?? 'Unknown',
        date: bill.bill_date, dueDate: bill.due_date,
        totalCents: Number(bill.total_cents), paidCents: Number(bill.amount_paid_cents),
        balanceCents: Number(bill.balance_cents), daysOverdue: daysOver,
        locationName: (loc as { name: string } | null)?.name ?? '', status: bill.status,
      });
    }
  }

  // Sort by due date
  items.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  const totalAR = items.filter((i) => i.type === 'invoice').reduce((s, i) => s + i.balanceCents, 0);
  const totalAP = items.filter((i) => i.type === 'bill').reduce((s, i) => s + i.balanceCents, 0);

  return NextResponse.json({
    data: items,
    summary: {
      openInvoices: items.filter((i) => i.type === 'invoice').length,
      openBills: items.filter((i) => i.type === 'bill').length,
      totalARCents: totalAR,
      totalAPCents: totalAP,
      netCents: totalAR - totalAP,
    },
  });
}
