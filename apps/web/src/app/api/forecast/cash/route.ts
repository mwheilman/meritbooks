export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import {
  buildDriverForecast,
  type ForecastReceivable,
  type ForecastPayable,
  type RecurringFlow,
  type Cadence,
  type FlowCategory,
} from '@/lib/forecast/driver-forecast';

/**
 * GET /api/forecast/cash?location_id=&collection_lag_days=&payment_lag_days=&minimum_buffer_cents=&horizon_weeks=
 *
 * DEEPER, driver-based cash forecast (companion to the /api/forecast 13-week
 * direct model). Projects cash from the underlying drivers:
 *   • collections  — open AR shifted by a collection lag (DSO drift)
 *   • disbursements — open AP shifted by a payment lag, PLUS recurring
 *                     obligations (debt service + recurring JE templates:
 *                     payroll / leases / recurring bills) expanded by cadence
 *   • opening cash  — active operating bank balances
 *
 * Returns weekly opening→collections−disbursements→closing, a category
 * waterfall, the projected ending balance, low-water mark and shortfall flag.
 *
 * SECURITY: RLS-scoped + forecast:view permission gate. Read-only.
 */

const OPEN_INVOICE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'];
const OPEN_BILL_STATUSES = ['PENDING', 'APPROVED', 'PARTIALLY_PAID', 'ON_HOLD'];
const CASH_ACCOUNT_TYPES = ['CHECKING', 'SAVINGS'];
const MAX_ITEMS_PER_WEEK = 40;

const FREQ_TO_CADENCE: Record<string, Cadence> = {
  MONTHLY: 'MONTHLY',
  QUARTERLY: 'QUARTERLY',
  ANNUALLY: 'ANNUALLY',
};

interface BankAccountRow { current_balance_cents: number | string | null; location_id: string; account_type: string }
interface InvoiceRow { id: string; invoice_number: string | null; due_date: string; balance_cents: number | string | null; customer_id: string | null; location_id: string }
interface BillRow { id: string; bill_number: string | null; due_date: string; balance_cents: number | string | null; vendor_id: string | null; location_id: string }
interface NamedRow { id: string; name: string }
interface DebtRow { id: string; name: string; monthly_payment_cents: number | string | null; location_id: string }
interface TemplateRow { id: string; name: string; frequency: string; next_run_date: string | null; start_date: string; end_date: string | null; template_lines: unknown; location_id: string }

function intParam(v: string | null, fallback: number): number {
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveRoleId(supabase: any, orgId: string, role: AccountRoleKey): Promise<string | null> {
  try {
    return (await resolveRole(supabase, orgId, role)).id;
  } catch (e) {
    if (e instanceof PostingError) return null;
    throw e;
  }
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'forecast', 'view');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const locationId = url.searchParams.get('location_id');
  const collectionLagDays = Math.max(0, intParam(url.searchParams.get('collection_lag_days'), 0));
  const paymentLagDays = Math.max(0, intParam(url.searchParams.get('payment_lag_days'), 0));
  const minimumBufferCents = Math.max(0, intParam(url.searchParams.get('minimum_buffer_cents'), 0));
  const horizonWeeks = Math.min(52, Math.max(4, intParam(url.searchParams.get('horizon_weeks'), 13)));

  // 1. Opening cash — active operating bank balances.
  let baQuery = supabase
    .from('bank_accounts')
    .select('current_balance_cents, location_id, account_type')
    .eq('is_active', true)
    .in('account_type', CASH_ACCOUNT_TYPES);
  if (locationId) baQuery = baQuery.eq('location_id', locationId);
  const { data: accountsData, error: baErr } = await baQuery;
  if (baErr) return NextResponse.json({ error: baErr.message }, { status: 500 });
  const accounts = (accountsData ?? []) as BankAccountRow[];
  const openingCashCents = accounts.reduce((s, a) => s + Number(a.current_balance_cents ?? 0), 0);

  // 2. Open AR / AP.
  let invQuery = supabase
    .from('invoices')
    .select('id, invoice_number, due_date, balance_cents, customer_id, location_id')
    .in('status', OPEN_INVOICE_STATUSES)
    .gt('balance_cents', 0);
  if (locationId) invQuery = invQuery.eq('location_id', locationId);

  let billQuery = supabase
    .from('bills')
    .select('id, bill_number, due_date, balance_cents, vendor_id, location_id')
    .in('status', OPEN_BILL_STATUSES)
    .gt('balance_cents', 0);
  if (locationId) billQuery = billQuery.eq('location_id', locationId);

  // 3. Debt service (recurring monthly disbursements) + recurring JE templates.
  let debtQuery = supabase
    .from('debt_instruments')
    .select('id, name, monthly_payment_cents, location_id')
    .gt('monthly_payment_cents', 0);
  if (locationId) debtQuery = debtQuery.eq('location_id', locationId);

  let tplQuery = supabase
    .from('recurring_templates')
    .select('id, name, frequency, next_run_date, start_date, end_date, template_lines, location_id')
    .eq('is_active', true);
  if (locationId) tplQuery = tplQuery.eq('location_id', locationId);

  const [invRes, billRes, debtRes, tplRes] = await Promise.all([invQuery, billQuery, debtQuery, tplQuery]);
  if (invRes.error) return NextResponse.json({ error: invRes.error.message }, { status: 500 });
  if (billRes.error) return NextResponse.json({ error: billRes.error.message }, { status: 500 });

  const invoices = (invRes.data ?? []) as InvoiceRow[];
  const bills = (billRes.data ?? []) as BillRow[];
  const debts = (debtRes.data ?? []) as DebtRow[];
  const templates = (tplRes.data ?? []) as TemplateRow[];

  // 4. Counterparty names (core schema — stitched in JS).
  const customerIds = [...new Set(invoices.map((i) => i.customer_id).filter((v): v is string => !!v))];
  const vendorIds = [...new Set(bills.map((b) => b.vendor_id).filter((v): v is string => !!v))];
  const [custRes, vendRes] = await Promise.all([
    customerIds.length ? supabase.schema('core').from('customers').select('id, name').in('id', customerIds) : Promise.resolve({ data: [] as NamedRow[] }),
    vendorIds.length ? supabase.schema('core').from('vendors').select('id, name').in('id', vendorIds) : Promise.resolve({ data: [] as NamedRow[] }),
  ]);
  const custName = new Map(((custRes.data ?? []) as NamedRow[]).map((c) => [c.id, c.name]));
  const vendName = new Map(((vendRes.data ?? []) as NamedRow[]).map((v) => [v.id, v.name]));

  const receivables: ForecastReceivable[] = invoices.map((i) => ({
    id: i.id,
    label: i.invoice_number ?? 'Invoice',
    party: (i.customer_id && custName.get(i.customer_id)) || 'Customer',
    amountCents: Number(i.balance_cents ?? 0),
    dueDate: i.due_date,
  }));

  const payables: ForecastPayable[] = bills.map((b) => ({
    id: b.id,
    label: b.bill_number ?? 'Bill',
    party: (b.vendor_id && vendName.get(b.vendor_id)) || 'Vendor',
    amountCents: Number(b.balance_cents ?? 0),
    dueDate: b.due_date,
    category: 'AP' as FlowCategory,
  }));

  // 5. Recurring flows. Debt service → monthly outflow from today's anchor.
  const todayIso = new Date().toISOString().slice(0, 10);
  const recurring: RecurringFlow[] = [];
  for (const d of debts) {
    const pay = Number(d.monthly_payment_cents ?? 0);
    if (pay <= 0) continue;
    recurring.push({ id: `debt:${d.id}`, label: `${d.name} — debt service`, amountCents: -pay, cadence: 'MONTHLY', nextDate: todayIso, category: 'DEBT' });
  }

  // Recurring JE templates → net cash effect (Σ debit−credit on cash accounts).
  // Cash-account ids resolved BY ROLE / bank flag (never by number).
  if (templates.length > 0) {
    const { data: accts } = await supabase.from('accounts').select('id, is_bank_account');
    const cashIds = new Set<string>();
    for (const a of accts ?? []) if (a.is_bank_account) cashIds.add(a.id as string);
    for (const role of ['CASH_ON_HAND', 'UNDEPOSITED_FUNDS', 'OPERATING_BANK'] as AccountRoleKey[]) {
      const id = await resolveRoleId(supabase, orgId, role);
      if (id) cashIds.add(id);
    }
    for (const t of templates) {
      const cadence = FREQ_TO_CADENCE[t.frequency];
      if (!cadence) continue;
      const lines = Array.isArray(t.template_lines) ? (t.template_lines as Array<Record<string, unknown>>) : [];
      let cashDelta = 0;
      for (const ln of lines) {
        const acctId = ln.account_id as string | undefined;
        if (!acctId || !cashIds.has(acctId)) continue;
        cashDelta += Number(ln.debit_cents ?? 0) - Number(ln.credit_cents ?? 0);
      }
      if (cashDelta === 0) continue; // template doesn't move cash
      recurring.push({
        id: `tpl:${t.id}`,
        label: t.name,
        amountCents: cashDelta, // signed: + inflow, − outflow
        cadence,
        nextDate: t.next_run_date ?? t.start_date ?? todayIso,
        category: 'RECURRING',
        endDate: t.end_date ?? undefined,
      });
    }
  }

  const forecast = buildDriverForecast({
    openingCashCents,
    receivables,
    payables,
    recurring,
    collectionLagDays,
    paymentLagDays,
    minimumBufferCents,
    horizonWeeks,
  });

  // Cap drill-down arrays (totals already aggregated).
  const weeks = forecast.weeks.map((w) => ({
    ...w,
    collectionItems: w.collectionItems.slice(0, MAX_ITEMS_PER_WEEK),
    disbursementItems: w.disbursementItems.slice(0, MAX_ITEMS_PER_WEEK),
    collectionItemCount: w.collectionItems.length,
    disbursementItemCount: w.disbursementItems.length,
  }));

  return NextResponse.json({
    ...forecast,
    weeks,
    drivers: {
      collectionLagDays,
      paymentLagDays,
      minimumBufferCents,
      horizonWeeks,
      openInvoiceCount: invoices.length,
      openBillCount: bills.length,
      recurringFlowCount: recurring.length,
      debtServiceCount: debts.length,
    },
    meta: {
      locationId: locationId ?? null,
      consolidated: !locationId,
      bankAccountCount: accounts.length,
      generatedAt: new Date().toISOString(),
    },
  });
}
