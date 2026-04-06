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
        customer:customers!invoices_customer_id_fkey(name),
        location:locations!invoices_location_id_fkey(name)
      `)
      .not('status', 'in', '("PAID","VOIDED","DRAFT")');
    if (locationId) invQ = invQ.eq('location_id', locationId);
    const { data: invoices } = await invQ;

    for (const inv of invoices ?? []) {
      const cust = Array.isArray(inv.customer) ? inv.customer[0] : inv.customer;
      const loc = Array.isArray(inv.location) ? inv.location[0] : inv.location;
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
        vendor:vendors!bills_vendor_id_fkey(name),
        location:locations!bills_location_id_fkey(name)
      `)
      .not('status', 'in', '("PAID","VOIDED")');
    if (locationId) billQ = billQ.eq('location_id', locationId);
    const { data: bills } = await billQ;

    for (const bill of bills ?? []) {
      const vend = Array.isArray(bill.vendor) ? bill.vendor[0] : bill.vendor;
      const loc = Array.isArray(bill.location) ? bill.location[0] : bill.location;
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
