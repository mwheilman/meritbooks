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
  const startDate = searchParams.get('start_date') ?? new Date().toISOString().slice(0, 8) + '01';
  const endDate = searchParams.get('end_date') ?? new Date().toISOString().slice(0, 10);
  const mode = searchParams.get('mode') ?? 'summary';

  // Get invoice lines with customer and account info
  let invQ = supabase
    .from('invoices')
    .select(`
      id, invoice_number, invoice_date, customer_id, status,
      customer:customers!invoices_customer_id_fkey(id, name),
      location:locations!invoices_location_id_fkey(name, short_code)
    `)
    .gte('invoice_date', startDate)
    .lte('invoice_date', endDate)
    .not('status', 'in', '("VOIDED","DRAFT")');
  if (locationId) invQ = invQ.eq('location_id', locationId);
  const { data: invoices } = await invQ;

  if (!invoices || invoices.length === 0) {
    return NextResponse.json({ period: { startDate, endDate }, mode, data: [], summary: { totalSalesCents: 0, customerCount: 0, lineItemCount: 0 } });
  }

  // Get lines for these invoices
  const invIds = invoices.map((i) => i.id);
  const { data: lines } = await supabase
    .from('invoice_lines')
    .select(`
      invoice_id, description, quantity, unit_price_cents, amount_cents,
      account:accounts!invoice_lines_account_id_fkey(account_number, name)
    `)
    .in('invoice_id', invIds);

  // Build invoice lookup
  const invLookup = new Map(invoices.map((i) => {
    const c = Array.isArray(i.customer) ? i.customer[0] : i.customer;
    const loc = Array.isArray(i.location) ? i.location[0] : i.location;
    return [i.id, { customerId: (c as { id: string })?.id ?? '', customerName: (c as { name: string })?.name ?? 'Unknown', invoiceNumber: i.invoice_number, date: i.invoice_date, locationCode: (loc as { short_code: string } | null)?.short_code ?? '' }];
  }));

  // Aggregate: customer → revenue accounts → line items
  const customerMap = new Map<string, {
    customerId: string;
    customerName: string;
    totalSalesCents: number;
    lineCount: number;
    byAccount: Map<string, { accountNumber: string; accountName: string; totalCents: number; qty: number }>;
    details: { invoiceNumber: string; date: string; description: string; qty: number; unitPriceCents: number; amountCents: number; accountName: string; locationCode: string }[];
  }>();

  for (const line of lines ?? []) {
    const inv = invLookup.get(line.invoice_id);
    if (!inv) continue;
    const acct = Array.isArray(line.account) ? line.account[0] : line.account;
    const acctNum = (acct as { account_number: string } | null)?.account_number ?? '';
    const acctName = (acct as { name: string } | null)?.name ?? 'Revenue';
    const amt = Number(line.amount_cents);

    const existing = customerMap.get(inv.customerId);
    if (existing) {
      existing.totalSalesCents += amt;
      existing.lineCount++;
      const ba = existing.byAccount.get(acctNum);
      if (ba) { ba.totalCents += amt; ba.qty += Number(line.quantity); }
      else { existing.byAccount.set(acctNum, { accountNumber: acctNum, accountName: acctName, totalCents: amt, qty: Number(line.quantity) }); }
      if (mode === 'detail') existing.details.push({ invoiceNumber: inv.invoiceNumber, date: inv.date, description: line.description, qty: Number(line.quantity), unitPriceCents: Number(line.unit_price_cents), amountCents: amt, accountName: acctName, locationCode: inv.locationCode });
    } else {
      const byAccount = new Map<string, { accountNumber: string; accountName: string; totalCents: number; qty: number }>();
      byAccount.set(acctNum, { accountNumber: acctNum, accountName: acctName, totalCents: amt, qty: Number(line.quantity) });
      customerMap.set(inv.customerId, {
        customerId: inv.customerId, customerName: inv.customerName, totalSalesCents: amt, lineCount: 1, byAccount,
        details: mode === 'detail' ? [{ invoiceNumber: inv.invoiceNumber, date: inv.date, description: line.description, qty: Number(line.quantity), unitPriceCents: Number(line.unit_price_cents), amountCents: amt, accountName: acctName, locationCode: inv.locationCode }] : [],
      });
    }
  }

  const customers = Array.from(customerMap.values())
    .map((c) => ({ ...c, byAccount: Array.from(c.byAccount.values()).sort((a, b) => b.totalCents - a.totalCents) }))
    .sort((a, b) => b.totalSalesCents - a.totalSalesCents);

  return NextResponse.json({
    period: { startDate, endDate },
    mode,
    data: customers,
    summary: {
      totalSalesCents: customers.reduce((s, c) => s + c.totalSalesCents, 0),
      customerCount: customers.length,
      lineItemCount: customers.reduce((s, c) => s + c.lineCount, 0),
    },
  });
}
