export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { buildForecast, type ForecastCashflowItem } from '@/lib/cash/forecast';

/**
 * GET /api/forecast?location_id=<uuid>
 *
 * 13-week direct cash forecast. Starting cash = active CHECKING/SAVINGS bank
 * balances. Inflows = open AR (invoice balances) bucketed by due date. Outflows
 * = open AP (bill balances) bucketed by due date. Omit `location_id` for a
 * consolidated (all-company) projection.
 *
 * RLS-scoped: runs as the user, so tenant isolation is enforced by the database.
 */

// Open receivables that still represent expected cash in.
const OPEN_INVOICE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'];
// Open payables that still represent expected cash out.
const OPEN_BILL_STATUSES = ['PENDING', 'APPROVED', 'PARTIALLY_PAID', 'ON_HOLD'];
// Only spendable operating cash counts toward the starting balance.
const CASH_ACCOUNT_TYPES = ['CHECKING', 'SAVINGS'];

// Bound the per-week drill-down payload.
const MAX_ITEMS_PER_WEEK = 50;

interface BankAccountRow {
  current_balance_cents: number | string | null;
  location_id: string;
  account_type: string;
}
interface InvoiceRow {
  id: string;
  invoice_number: string | null;
  due_date: string;
  balance_cents: number | string | null;
  status: string;
  customer_id: string | null;
  location_id: string;
}
interface BillRow {
  id: string;
  bill_number: string | null;
  due_date: string;
  balance_cents: number | string | null;
  status: string;
  vendor_id: string | null;
  location_id: string;
}
interface NamedRow {
  id: string;
  name: string;
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const locationId = new URL(request.url).searchParams.get('location_id');

  // 1. Starting cash — active operating bank balances.
  let baQuery = supabase
    .from('bank_accounts')
    .select('current_balance_cents, location_id, account_type')
    .eq('is_active', true)
    .in('account_type', CASH_ACCOUNT_TYPES);
  if (locationId) baQuery = baQuery.eq('location_id', locationId);
  const { data: accountsData, error: baErr } = await baQuery;
  if (baErr) return NextResponse.json({ error: baErr.message }, { status: 500 });
  const accounts = (accountsData ?? []) as BankAccountRow[];
  const startingCashCents = accounts.reduce((s, a) => s + Number(a.current_balance_cents ?? 0), 0);

  // 2. Open AR (inflows).
  let invQuery = supabase
    .from('invoices')
    .select('id, invoice_number, due_date, balance_cents, status, customer_id, location_id')
    .in('status', OPEN_INVOICE_STATUSES)
    .gt('balance_cents', 0);
  if (locationId) invQuery = invQuery.eq('location_id', locationId);
  const { data: invData, error: invErr } = await invQuery;
  if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });
  const invoices = (invData ?? []) as InvoiceRow[];

  // 3. Open AP (outflows).
  let billQuery = supabase
    .from('bills')
    .select('id, bill_number, due_date, balance_cents, status, vendor_id, location_id')
    .in('status', OPEN_BILL_STATUSES)
    .gt('balance_cents', 0);
  if (locationId) billQuery = billQuery.eq('location_id', locationId);
  const { data: billData, error: billErr } = await billQuery;
  if (billErr) return NextResponse.json({ error: billErr.message }, { status: 500 });
  const bills = (billData ?? []) as BillRow[];

  // 4. Resolve counterparty names (customers/vendors live in `core`).
  const customerIds = [...new Set(invoices.map((i) => i.customer_id).filter((v): v is string => !!v))];
  const vendorIds = [...new Set(bills.map((b) => b.vendor_id).filter((v): v is string => !!v))];

  const [custRes, vendRes] = await Promise.all([
    customerIds.length
      ? supabase.schema('core').from('customers').select('id, name').in('id', customerIds)
      : Promise.resolve({ data: [] as NamedRow[], error: null }),
    vendorIds.length
      ? supabase.schema('core').from('vendors').select('id, name').in('id', vendorIds)
      : Promise.resolve({ data: [] as NamedRow[], error: null }),
  ]);
  const custName = new Map(((custRes.data ?? []) as NamedRow[]).map((c) => [c.id, c.name]));
  const vendName = new Map(((vendRes.data ?? []) as NamedRow[]).map((v) => [v.id, v.name]));

  // 5. Build cashflow items. `overdue` is relative to today (for the UI badge);
  //    the engine still buckets past-due items into week 1.
  const todayMs = Date.now();
  const isOverdue = (due: string) => new Date(due.slice(0, 10) + 'T00:00:00Z').getTime() < todayMs;

  const inflows: ForecastCashflowItem[] = invoices.map((i) => ({
    id: i.id,
    dueDate: i.due_date,
    amountCents: Number(i.balance_cents ?? 0),
    label: i.invoice_number ?? 'Invoice',
    party: (i.customer_id && custName.get(i.customer_id)) || 'Customer',
    status: i.status,
    overdue: isOverdue(i.due_date),
  }));

  const outflows: ForecastCashflowItem[] = bills.map((b) => ({
    id: b.id,
    dueDate: b.due_date,
    amountCents: Number(b.balance_cents ?? 0),
    label: b.bill_number ?? 'Bill',
    party: (b.vendor_id && vendName.get(b.vendor_id)) || 'Vendor',
    status: b.status,
    overdue: isOverdue(b.due_date),
  }));

  const forecast = buildForecast({ startingCashCents, inflows, outflows });

  // Cap drill-down arrays for payload size (totals are already aggregated).
  const weeks = forecast.weeks.map((w) => ({
    ...w,
    inflowItems: w.inflowItems.slice(0, MAX_ITEMS_PER_WEEK),
    outflowItems: w.outflowItems.slice(0, MAX_ITEMS_PER_WEEK),
    inflowItemCount: w.inflowItems.length,
    outflowItemCount: w.outflowItems.length,
  }));

  return NextResponse.json({
    ...forecast,
    weeks,
    meta: {
      locationId: locationId ?? null,
      consolidated: !locationId,
      bankAccountCount: accounts.length,
      openInvoiceCount: invoices.length,
      openBillCount: bills.length,
      generatedAt: new Date().toISOString(),
    },
  });
}
