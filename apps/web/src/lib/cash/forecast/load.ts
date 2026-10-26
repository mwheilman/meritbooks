/**
 * Cash forecast loader — every read for one scope, through the CALLER'S client (RLS + client scope;
 * the scheduler passes its system tenant client). SERVER ONLY. Pure decisions live in ./assemble.ts.
 *
 * Schema ground truth (Rule 11): invoices / bills (008, 022, 184), payment_applications +
 * customer_payments (008), recurring_invoice_templates (073), pay_schedules / payroll_runs (069),
 * debt_instruments (008, 083) + debt_schedule_lines (083), leases + lease_schedule_lines (082),
 * subscriptions (085), sales_tax_filings (105), budgets (013, 189), accounts / account_groups /
 * account_roles, agent_runs (PAY_RUN proposals), bank_accounts / bank_transactions (005, 046),
 * core.customers (related_location_id), core.vendors, core.locations, and the 192 tables.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { resolveCashAccountIds } from '@/lib/cash/book-cash';
import { budgetMonth } from '@/lib/metrics/fold';
import { addDays, addMonths, endOfMonth, startOfMonth, type PayFrequency, type RecurringFrequency } from './dates';
import { DEFAULT_SETTINGS, emptyInputs, type CompanyInput, type CompanySettings, type ForecastInputs, type RunRateBasis } from './assemble';
import { classifyFamily, horizonMonths, type AccountFamily, type MonthlyBasisRow } from './runrate';
import type { ActualCashLine } from './accuracy';
import type { LiquidityLineRow, LocBankAccount, LocInstrument } from './liquidity';
import type { ScenarioAdjustment, AdjustmentKind } from './scenario';
import type { ManualItemRow } from './sources';
import { isCategory } from './types';

type Row = Record<string, unknown>;

const OPEN_INVOICE = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'];
const OPEN_BILL = ['PENDING', 'APPROVED', 'SCHEDULED', 'PARTIALLY_PAID', 'ON_HOLD'];
const HISTORY_MONTHS = 24;

const n = (v: unknown): number => {
  const x = Math.round(Number(v ?? 0));
  return Number.isFinite(x) ? x : 0;
};
const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const d = (v: unknown): string | null => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null);

function must<T>(res: { data: T | null; error: { message: string } | null }, label: string): T {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  return (res.data ?? ([] as unknown)) as T;
}

/** Fetch rows `in` a (possibly long) id list, in chunks. */
async function inChunks(ids: readonly string[], run: (chunk: string[]) => Promise<Row[]>): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 200) out.push(...(await run(ids.slice(i, i + 200))));
  return out;
}

// ── companies, settings ────────────────────────────────────────────────────────

export interface CompanyRow {
  id: string;
  name: string;
  minimumCashCents: number;
}

/** Active companies the caller's RLS shows (the route narrows to client scope / the requested one). */
export async function loadCompanies(db: SupabaseClient, orgId: string): Promise<CompanyRow[]> {
  const rows = must(await db.schema('core').from('locations').select('id, name, minimum_cash_cents, is_active').eq('org_id', orgId).order('name'), 'companies') as Row[];
  return rows.filter((r) => r.is_active !== false).map((r) => ({ id: String(r.id), name: String(r.name ?? 'Company'), minimumCashCents: n(r.minimum_cash_cents) }));
}

export interface SettingsRow extends CompanySettings {
  companyId: string;
}

export async function loadSettings(db: SupabaseClient, companyIds: readonly string[]): Promise<Map<string, CompanySettings>> {
  const out = new Map<string, CompanySettings>();
  if (!companyIds.length) return out;
  const rows = must(await db.from('cash_settings').select('location_id, minimum_cash_cents, alerts_enabled, employer_tax_bps, estimated_tax_quarterly_cents, runrate_basis, include_unapproved_bills').in('location_id', [...companyIds]), 'cash_settings') as Row[];
  for (const r of rows) {
    out.set(String(r.location_id), {
      minimumCashCents: r.minimum_cash_cents === null || r.minimum_cash_cents === undefined ? -1 : n(r.minimum_cash_cents),
      alertsEnabled: r.alerts_enabled !== false,
      employerTaxBps: r.employer_tax_bps === null || r.employer_tax_bps === undefined ? null : n(r.employer_tax_bps),
      estimatedTaxQuarterlyCents: r.estimated_tax_quarterly_cents === null || r.estimated_tax_quarterly_cents === undefined ? null : n(r.estimated_tax_quarterly_cents),
      runrateBasis: (['BUDGET', 'TRAILING_3M', 'OFF'].includes(String(r.runrate_basis)) ? r.runrate_basis : 'BUDGET') as RunRateBasis,
      includeUnapprovedBills: r.include_unapproved_bills !== false,
      configured: true,
    });
  }
  return out;
}

/** Company inputs: settings row (minimum NULL → core.locations.minimum_cash_cents), else defaults. */
export function companyInputs(companies: readonly CompanyRow[], settings: ReadonlyMap<string, CompanySettings>): CompanyInput[] {
  return companies.map((c) => {
    const st = settings.get(c.id);
    const merged: CompanySettings = st ? { ...st, minimumCashCents: st.minimumCashCents >= 0 ? st.minimumCashCents : c.minimumCashCents } : { ...DEFAULT_SETTINGS, minimumCashCents: c.minimumCashCents };
    return { id: c.id, name: c.name, settings: merged };
  });
}

// ── cash lines (book cash, history, actuals) ────────────────────────────────────

export interface DetailedCashLines {
  cashIds: Set<string>;
  lines: Array<ActualCashLine & { accountId: string; locationId: string | null }>;
}

/** Every POSTED cash line through `asOf` for the companies, with entry id + source (one read serves opening, history, burn and accuracy). */
export async function loadCashLinesDetailed(db: SupabaseClient, orgId: string, companyIds: readonly string[], asOf: string): Promise<DetailedCashLines> {
  const cashIds = await resolveCashAccountIds(db, orgId);
  if (cashIds.size === 0 || companyIds.length === 0) return { cashIds, lines: [] };
  const ids = Array.from(cashIds);
  const { data, error } = await fetchAll(
    () =>
      db
        .from('gl_entry_lines')
        .select('id, account_id, location_id, debit_cents, credit_cents, gl_entries!inner(id, entry_date, status, source_module)')
        .eq('gl_entries.status', 'POSTED')
        .lte('gl_entries.entry_date', asOf)
        .in('account_id', ids)
        .in('location_id', [...companyIds]),
    { label: 'cash-forecast cash lines' },
  );
  if (error) throw new Error(error.message);
  const lines = ((data ?? []) as Row[]).map((r) => {
    const e = (r.gl_entries ?? {}) as Row;
    return {
      accountId: String(r.account_id),
      locationId: s(r.location_id),
      companyId: s(r.location_id),
      entryId: String(e.id ?? r.id),
      entryDate: d(e.entry_date) ?? '9999-12-31',
      sourceModule: s(e.source_module),
      debitCents: n(r.debit_cents),
      creditCents: n(r.credit_cents),
    };
  });
  return { cashIds, lines };
}

export interface BankAccountRow {
  id: string;
  companyId: string;
  name: string;
  institution: string | null;
  mask: string | null;
  type: string;
  currentCents: number | null;
  availableCents: number | null;
  updatedAt: string | null;
}

export async function loadBankAccounts(db: SupabaseClient, companyIds: readonly string[]): Promise<BankAccountRow[]> {
  if (!companyIds.length) return [];
  const rows = must(
    await db
      .from('bank_accounts')
      .select('id, location_id, institution_name, account_name, account_mask, account_type, current_balance_cents, available_balance_cents, balance_updated_at')
      .eq('is_active', true)
      .in('location_id', [...companyIds]),
    'bank_accounts',
  ) as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    companyId: String(r.location_id),
    name: String(r.account_name ?? r.institution_name ?? 'Account'),
    institution: s(r.institution_name),
    mask: s(r.account_mask),
    type: String(r.account_type ?? 'CHECKING'),
    currentCents: r.current_balance_cents === null || r.current_balance_cents === undefined ? null : n(r.current_balance_cents),
    availableCents: r.available_balance_cents === null || r.available_balance_cents === undefined ? null : n(r.available_balance_cents),
    updatedAt: s(r.balance_updated_at),
  }));
}

export async function loadBankTxns(db: SupabaseClient, accountIds: readonly string[], since: string): Promise<Array<{ accountId: string; date: string; amountCents: number }>> {
  if (!accountIds.length) return [];
  const { data, error } = await fetchAll(
    () => db.from('bank_transactions').select('id, bank_account_id, transaction_date, amount_cents').in('bank_account_id', [...accountIds]).gte('transaction_date', since),
    { label: 'cash-forecast bank txns' },
  );
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).map((r) => ({ accountId: String(r.bank_account_id), date: d(r.transaction_date) ?? since, amountCents: n(r.amount_cents) }));
}

// ── scenarios, items, lines ─────────────────────────────────────────────────────

export interface ScenarioRow {
  id: string;
  companyId: string | null;
  name: string;
  kind: 'BASE' | 'DOWNSIDE' | 'UPSIDE' | 'CUSTOM';
  description: string | null;
  isArchived: boolean;
  updatedAt: string | null;
  adjustments: Array<ScenarioAdjustment & { note: string | null }>;
}

export async function loadScenarios(db: SupabaseClient, orgId: string, opts: { includeArchived?: boolean } = {}): Promise<ScenarioRow[]> {
  let q = db.from('cash_forecast_scenarios').select('id, location_id, name, kind, description, is_archived, updated_at').eq('org_id', orgId).order('created_at');
  if (!opts.includeArchived) q = q.eq('is_archived', false);
  const rows = must(await q, 'cash_forecast_scenarios') as Row[];
  const ids = rows.map((r) => String(r.id));
  const adj = ids.length
    ? (must(
        await db
          .from('cash_forecast_adjustments')
          .select('id, scenario_id, location_id, kind, customer_id, vendor_id, instrument_id, item_key, days, bps, amount_cents, effective_date, label, note')
          .in('scenario_id', ids)
          .order('created_at'),
        'cash_forecast_adjustments',
      ) as Row[])
    : [];
  return rows.map((r) => ({
    id: String(r.id),
    companyId: s(r.location_id),
    name: String(r.name),
    kind: String(r.kind) as ScenarioRow['kind'],
    description: s(r.description),
    isArchived: r.is_archived === true,
    updatedAt: s(r.updated_at),
    adjustments: adj
      .filter((a) => a.scenario_id === r.id)
      .map((a) => ({
        id: String(a.id),
        kind: String(a.kind) as AdjustmentKind,
        companyId: s(a.location_id),
        customerId: s(a.customer_id),
        vendorId: s(a.vendor_id),
        instrumentId: s(a.instrument_id),
        itemKey: s(a.item_key),
        days: a.days === null || a.days === undefined ? null : n(a.days),
        bps: a.bps === null || a.bps === undefined ? null : n(a.bps),
        amountCents: a.amount_cents === null || a.amount_cents === undefined ? null : n(a.amount_cents),
        effectiveDate: d(a.effective_date),
        label: s(a.label),
        note: s(a.note),
      })),
  }));
}

export async function loadManualItems(db: SupabaseClient, companyIds: readonly string[]): Promise<Array<ManualItemRow & { isActive: boolean; updatedAt: string | null }>> {
  if (!companyIds.length) return [];
  const rows = must(
    await db
      .from('cash_forecast_items')
      .select('id, location_id, scenario_id, direction, category, label, expected_date, amount_cents, probability_bps, recurrence, recurrence_end, counterparty_location_id, account_id, note, is_active, updated_at')
      .in('location_id', [...companyIds])
      .order('expected_date'),
    'cash_forecast_items',
  ) as Row[];
  return rows
    .filter((r) => isCategory(r.category))
    .map((r) => ({
      id: String(r.id),
      companyId: String(r.location_id),
      scenarioId: s(r.scenario_id),
      direction: r.direction === 'IN' ? 'IN' : 'OUT',
      category: r.category as ManualItemRow['category'],
      label: String(r.label),
      expectedDate: d(r.expected_date) ?? '1970-01-01',
      amountCents: n(r.amount_cents),
      probabilityBps: n(r.probability_bps) || 10_000,
      recurrence: (['NONE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY'].includes(String(r.recurrence)) ? r.recurrence : 'NONE') as ManualItemRow['recurrence'],
      recurrenceEnd: d(r.recurrence_end),
      counterpartyCompanyId: s(r.counterparty_location_id),
      accountId: s(r.account_id),
      note: s(r.note),
      isActive: r.is_active !== false,
      updatedAt: s(r.updated_at),
    }));
}

export async function loadLiquidity(db: SupabaseClient, companyIds: readonly string[], banks: readonly BankAccountRow[]): Promise<{ rows: LiquidityLineRow[]; banks: LocBankAccount[]; instruments: LocInstrument[] }> {
  if (!companyIds.length) return { rows: [], banks: [], instruments: [] };
  const [lines, insts] = await Promise.all([
    db.from('cash_liquidity_lines').select('id, location_id, instrument_id, name, commitment_cents, borrowing_base_cents, drawn_cents, as_of_date').eq('is_active', true).in('location_id', [...companyIds]),
    db.from('debt_instruments').select('id, location_id, name, instrument_type, original_amount_cents, current_balance_cents, status').eq('instrument_type', 'LINE_OF_CREDIT').eq('status', 'ACTIVE').in('location_id', [...companyIds]),
  ]);
  const rows = (must(lines, 'cash_liquidity_lines') as Row[]).map((r) => ({
    id: String(r.id),
    companyId: String(r.location_id),
    name: String(r.name),
    commitmentCents: n(r.commitment_cents),
    borrowingBaseCents: r.borrowing_base_cents === null || r.borrowing_base_cents === undefined ? null : n(r.borrowing_base_cents),
    drawnCents: r.drawn_cents === null || r.drawn_cents === undefined ? null : n(r.drawn_cents),
    instrumentId: s(r.instrument_id),
    asOfDate: d(r.as_of_date),
  }));
  const instruments = (must(insts, 'debt_instruments') as Row[]).map((r) => ({
    id: String(r.id),
    companyId: s(r.location_id),
    name: String(r.name),
    originalCents: n(r.original_amount_cents),
    currentBalanceCents: n(r.current_balance_cents),
  }));
  const locBanks = banks
    .filter((b) => b.type === 'LINE_OF_CREDIT')
    .map((b) => ({ id: b.id, companyId: b.companyId, name: b.name, availableCents: b.availableCents, currentCents: b.currentCents }));
  return { rows, banks: locBanks, instruments };
}

// ── forecast sources ────────────────────────────────────────────────────────────

export interface LoadSourcesOptions {
  orgId: string;
  companies: CompanyInput[];
  today: string;
  horizonEnd: string;
}

export async function loadForecastInputs(db: SupabaseClient, opts: LoadSourcesOptions): Promise<ForecastInputs> {
  const inp = emptyInputs(opts.companies);
  const ids = opts.companies.map((c) => c.id);
  if (!ids.length) return inp;
  const idSet = new Set(ids);
  const historyFrom = addMonths(opts.today, -HISTORY_MONTHS);

  // AR — open invoices + customers.
  const invRows = (await fetchAll(
    () => db.from('invoices').select('id, location_id, invoice_number, customer_id, due_date, balance_cents, status, disputed_at').in('status', OPEN_INVOICE).gt('balance_cents', 0).in('location_id', ids),
    { label: 'cash-forecast invoices' },
  )).data as Row[] | null;
  const customerIds = new Set<string>();
  for (const r of invRows ?? []) if (r.customer_id) customerIds.add(String(r.customer_id));

  // Recurring billing.
  const tplRows = must(
    await db.from('recurring_invoice_templates').select('id, location_id, customer_id, name, frequency, interval_count, next_run_date, end_date, occurrences_remaining, is_active, template_data').eq('is_active', true).in('location_id', ids),
    'recurring_invoice_templates',
  ) as Row[];
  for (const r of tplRows) if (r.customer_id) customerIds.add(String(r.customer_id));

  // Paid history (24 months): applications × invoice due date × payment date.
  const histRes = await fetchAll(
    () =>
      db
        .from('payment_applications')
        .select('id, amount_cents, invoices!inner(due_date, customer_id, location_id), customer_payments!inner(payment_date)')
        .gte('customer_payments.payment_date', historyFrom)
        .in('invoices.location_id', ids),
    { label: 'cash-forecast pay history' },
  );
  if (histRes.error) throw new Error(histRes.error.message);
  inp.paidHistory = ((histRes.data ?? []) as Row[]).map((r) => {
    const inv = (r.invoices ?? {}) as Row;
    const pay = (r.customer_payments ?? {}) as Row;
    return { customerId: s(inv.customer_id), dueDate: d(inv.due_date) ?? '', paidDate: d(pay.payment_date) ?? '', amountCents: n(r.amount_cents) };
  });
  const outRes = await fetchAll(
    () => db.from('invoices').select('id, customer_id, status, total_cents, amount_paid_cents').in('status', ['PAID', 'WRITTEN_OFF']).gte('invoice_date', historyFrom).in('location_id', ids),
    { label: 'cash-forecast outcomes' },
  );
  if (outRes.error) throw new Error(outRes.error.message);
  inp.outcomes = ((outRes.data ?? []) as Row[]).map((r) => ({
    customerId: s(r.customer_id),
    outcome: r.status === 'WRITTEN_OFF' ? 'WRITTEN_OFF' : 'PAID',
    cents: r.status === 'WRITTEN_OFF' ? Math.max(0, n(r.total_cents) - n(r.amount_paid_cents)) : n(r.total_cents),
  }));

  const customers = new Map<string, { name: string; related: string | null; terms: number | null }>();
  const custRows = await inChunks(Array.from(customerIds), async (chunk) =>
    must(await db.schema('core').from('customers').select('id, name, display_name, related_location_id, payment_terms_days').in('id', chunk), 'customers') as Row[],
  );
  for (const c of custRows) customers.set(String(c.id), { name: String(c.display_name ?? c.name ?? 'Customer'), related: s(c.related_location_id), terms: c.payment_terms_days === null ? null : n(c.payment_terms_days) });
  const icOf = (custId: string | null, companyId: string) => {
    const rel = custId ? customers.get(custId)?.related ?? null : null;
    return rel && rel !== companyId && idSet.has(rel) ? rel : null;
  };

  inp.invoices = (invRows ?? []).map((r) => ({
    id: String(r.id),
    companyId: String(r.location_id),
    number: s(r.invoice_number),
    customerId: s(r.customer_id),
    customerName: r.customer_id ? customers.get(String(r.customer_id))?.name ?? 'Customer' : 'Customer',
    dueDate: d(r.due_date) ?? opts.today,
    balanceCents: n(r.balance_cents),
    status: String(r.status),
    disputed: !!r.disputed_at,
    counterpartyCompanyId: icOf(s(r.customer_id), String(r.location_id)),
  }));

  // Recurring: runs already invoiced (source_ref 'recurring:<template>:<run>').
  const tplIds = tplRows.map((r) => String(r.id));
  const generated = new Map<string, Set<string>>();
  if (tplIds.length) {
    const refs = await fetchAll(
      () => db.from('invoices').select('id, source_ref').like('source_ref', 'recurring:%').gte('invoice_date', addDays(opts.today, -60)).in('location_id', ids),
      { label: 'cash-forecast recurring refs' },
    );
    for (const r of (refs.data ?? []) as Row[]) {
      const m = /^recurring:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})/.exec(String(r.source_ref ?? ''));
      if (!m) continue;
      const set = generated.get(m[1]) ?? new Set<string>();
      set.add(m[2]);
      generated.set(m[1], set);
    }
  }
  inp.recurring = tplRows.map((r) => {
    const data = (r.template_data ?? {}) as { lines?: Array<{ quantity?: number; unit_price_cents?: number }>; tax_cents?: number; terms?: number };
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const amount = lines.reduce((a, l) => a + Math.round((Number(l.quantity ?? 1) || 1) * Number(l.unit_price_cents ?? 0)), 0) + Math.max(0, Math.round(Number(data.tax_cents ?? 0)));
    const cust = r.customer_id ? customers.get(String(r.customer_id)) : undefined;
    return {
      id: String(r.id),
      companyId: s(r.location_id),
      name: String(r.name),
      customerId: s(r.customer_id),
      customerName: cust?.name ?? null,
      frequency: String(r.frequency) as RecurringFrequency,
      intervalCount: n(r.interval_count) || 1,
      nextRunDate: d(r.next_run_date),
      endDate: d(r.end_date),
      occurrencesRemaining: r.occurrences_remaining === null || r.occurrences_remaining === undefined ? null : n(r.occurrences_remaining),
      runAmountCents: amount,
      termsDays: Number.isFinite(Number(data.terms)) && data.terms !== undefined ? Math.max(0, Math.round(Number(data.terms))) : (cust?.terms ?? 30),
      counterpartyCompanyId: r.location_id ? icOf(s(r.customer_id), String(r.location_id)) : null,
      generatedRunDates: generated.get(String(r.id)),
    };
  });

  // AP — open bills, their lines, vendors, and pay-run proposals waiting at the gate.
  const billRes = await fetchAll(
    () => db.from('bills').select('id, location_id, bill_number, vendor_id, due_date, balance_cents, status, scheduled_payment_date, early_pay_discount_date').in('status', OPEN_BILL).gt('balance_cents', 0).in('location_id', ids),
    { label: 'cash-forecast bills' },
  );
  if (billRes.error) throw new Error(billRes.error.message);
  const billRows = (billRes.data ?? []) as Row[];
  const billIds = billRows.map((b) => String(b.id));
  const lineRows = await inChunks(billIds, async (chunk) => must(await db.from('bill_lines').select('bill_id, account_id, amount_cents').in('bill_id', chunk), 'bill_lines') as Row[]);
  const vendorIds = Array.from(new Set(billRows.map((b) => s(b.vendor_id)).filter((v): v is string => !!v)));
  const vendRows = await inChunks(vendorIds, async (chunk) => must(await db.schema('core').from('vendors').select('id, name, display_name').in('id', chunk), 'vendors') as Row[]);
  const vendorName = new Map(vendRows.map((v) => [String(v.id), String(v.display_name ?? v.name ?? 'Vendor')]));
  const payRun = new Set<string>();
  const runRes = await db.from('agent_runs').select('id, context, status').eq('recipe', 'PAY_RUN').eq('status', 'PAUSED').limit(20);
  if (!runRes.error) {
    for (const r of (runRes.data ?? []) as Row[]) {
      const ctx = (r.context ?? {}) as Row;
      const state = ((ctx.state ?? ctx) as Row) ?? {};
      const list = Array.isArray(state.proposedBillIds) ? state.proposedBillIds : [];
      for (const id of list) if (typeof id === 'string') payRun.add(id);
    }
  }
  inp.bills = billRows.map((b) => {
    const due = d(b.due_date);
    const disc = d(b.early_pay_discount_date);
    const onRun = payRun.has(String(b.id));
    return {
      id: String(b.id),
      companyId: String(b.location_id),
      number: s(b.bill_number),
      vendorId: s(b.vendor_id),
      vendorName: b.vendor_id ? vendorName.get(String(b.vendor_id)) ?? 'Vendor' : 'Vendor',
      dueDate: due,
      balanceCents: n(b.balance_cents),
      status: String(b.status),
      scheduledPaymentDate: d(b.scheduled_payment_date),
      payRunDate: onRun ? (disc && due && disc < due ? disc : due) : null,
      lines: lineRows.filter((l) => l.bill_id === b.id).map((l) => ({ accountId: s(l.account_id), amountCents: n(l.amount_cents) })),
    };
  });

  // Payroll.
  const [schedRes, runsRes] = await Promise.all([
    db.from('pay_schedules').select('id, location_id, name, frequency, anchor_date, is_active').eq('is_active', true),
    db.from('payroll_runs').select('id, pay_schedule_id, location_id, pay_date, status, gross_cents, net_cents, employer_tax_cents, employee_tax_cents').gte('pay_date', addDays(opts.today, -120)).lte('pay_date', opts.horizonEnd),
  ]);
  const runs = (must(runsRes, 'payroll_runs') as Row[]).map((r) => ({
    id: String(r.id),
    scheduleId: s(r.pay_schedule_id),
    companyId: s(r.location_id),
    payDate: d(r.pay_date) ?? opts.today,
    status: String(r.status),
    grossCents: n(r.gross_cents),
    netCents: n(r.net_cents),
    employerTaxCents: n(r.employer_tax_cents),
    employeeTaxCents: n(r.employee_tax_cents),
  }));
  const schedules = (must(schedRes, 'pay_schedules') as Row[]).map((r) => ({
    id: String(r.id),
    companyId: s(r.location_id),
    name: String(r.name),
    frequency: String(r.frequency) as PayFrequency,
    anchorDate: d(r.anchor_date),
  }));
  // A schedule without a company takes its runs' company; keep only schedules / runs in scope.
  inp.schedules = schedules
    .map((sc) => ({ ...sc, companyId: sc.companyId ?? runs.find((r) => r.scheduleId === sc.id && r.companyId)?.companyId ?? null }))
    .filter((sc) => sc.companyId && idSet.has(sc.companyId));
  inp.runs = runs.filter((r) => r.companyId && idSet.has(r.companyId));

  // Debt service (ACTIVE instruments, unposted lines from 30 days back).
  const instRows = must(await db.from('debt_instruments').select('id, name, lender, location_id, status').eq('status', 'ACTIVE').in('location_id', ids), 'debt_instruments') as Row[];
  if (instRows.length) {
    const byId = new Map(instRows.map((i) => [String(i.id), i]));
    const lines = must(
      await db
        .from('debt_schedule_lines')
        .select('instrument_id, period, period_date, payment_cents, interest_cents, principal_cents')
        .in('instrument_id', Array.from(byId.keys()))
        .gte('period_date', addDays(opts.today, -30))
        .lte('period_date', opts.horizonEnd),
      'debt_schedule_lines',
    ) as Row[];
    inp.debtLines = lines
      .filter((l) => d(l.period_date))
      .map((l) => {
        const i = byId.get(String(l.instrument_id))!;
        return {
          instrumentId: String(l.instrument_id),
          instrumentName: String(i.name ?? 'Loan'),
          lender: s(i.lender),
          companyId: s(i.location_id),
          period: n(l.period),
          date: d(l.period_date)!,
          paymentCents: n(l.payment_cents),
          interestCents: n(l.interest_cents),
          principalCents: n(l.principal_cents),
        };
      });
    const posted = await fetchAll(
      () => db.from('gl_entries').select('id, source_ref').eq('source_module', 'DEBT').neq('status', 'VOIDED').like('source_ref', 'debt:payment:%'),
      { label: 'cash-forecast debt refs' },
    );
    for (const e of (posted.data ?? []) as Row[]) if (e.source_ref) inp.paidDebtRefs.add(String(e.source_ref));
  }

  // Leases.
  const leaseRows = must(await db.from('leases').select('id, location_id, lessor, description, payment_frequency, payment_timing, status').eq('status', 'ACTIVE').in('location_id', ids), 'leases') as Row[];
  if (leaseRows.length) {
    const byId = new Map(leaseRows.map((l) => [String(l.id), l]));
    const ll = must(
      await db
        .from('lease_schedule_lines')
        .select('lease_id, period, period_date, payment_cents')
        .in('lease_id', Array.from(byId.keys()))
        .gte('period_date', opts.today)
        .lte('period_date', addMonths(opts.horizonEnd, 12)),
      'lease_schedule_lines',
    ) as Row[];
    inp.leaseLines = ll.map((l) => {
      const lease = byId.get(String(l.lease_id))!;
      return {
        leaseId: String(l.lease_id),
        lessor: String(lease.lessor ?? 'Lessor'),
        description: s(lease.description),
        companyId: String(lease.location_id),
        period: n(l.period),
        periodDate: d(l.period_date)!,
        paymentCents: n(l.payment_cents),
        frequency: (['MONTHLY', 'QUARTERLY', 'ANNUAL'].includes(String(lease.payment_frequency)) ? lease.payment_frequency : 'MONTHLY') as 'MONTHLY' | 'QUARTERLY' | 'ANNUAL',
        timing: lease.payment_timing === 'ADVANCE' ? 'ADVANCE' : 'ARREARS',
      };
    });
  }

  // Subscriptions.
  const subRows = must(
    await db.from('subscriptions').select('id, location_id, vendor_id, vendor_name, product, amount_cents, billing_cadence, next_renewal_date, last_charged_date, status').in('status', ['ACTIVE', 'KEPT', 'UNDER_REVIEW', 'DETECTED']).in('location_id', ids),
    'subscriptions',
  ) as Row[];
  inp.subscriptions = subRows.map((r) => ({
    id: String(r.id),
    companyId: s(r.location_id),
    vendorId: s(r.vendor_id),
    vendorName: String(r.vendor_name ?? 'Subscription'),
    product: s(r.product),
    amountCents: n(r.amount_cents),
    cadence: String(r.billing_cadence ?? 'MONTHLY'),
    nextRenewalDate: d(r.next_renewal_date),
    lastChargedDate: d(r.last_charged_date),
    status: String(r.status),
  }));

  // Sales tax filing calendar (org-level).
  const taxRes = await db.from('sales_tax_filings').select('jurisdiction, frequency, period_end, due_date, remitted_cents').eq('org_id', opts.orgId).order('period_end', { ascending: false }).limit(200);
  if (!taxRes.error) {
    inp.salesTax = ((taxRes.data ?? []) as Row[]).map((r) => ({
      jurisdiction: String(r.jurisdiction),
      frequency: (['monthly', 'quarterly', 'annual'].includes(String(r.frequency)) ? r.frequency : 'quarterly') as 'monthly' | 'quarterly' | 'annual',
      periodEnd: d(r.period_end)!,
      dueDate: d(r.due_date)!,
      remittedCents: n(r.remitted_cents),
    }));
  }

  // Manual items (base + scenario-specific; the assembler picks).
  inp.manual = (await loadManualItems(db, ids)).filter((m) => m.isActive);

  // Run-rate basis + account families.
  await loadRunRate(db, opts, inp);
  return inp;
}

async function loadRunRate(db: SupabaseClient, opts: LoadSourcesOptions, inp: ForecastInputs): Promise<void> {
  const wantBudget = opts.companies.filter((c) => c.settings.runrateBasis === 'BUDGET').map((c) => c.id);
  const wantTrailing = opts.companies.filter((c) => c.settings.runrateBasis === 'TRAILING_3M').map((c) => c.id);
  if (!wantBudget.length && !wantTrailing.length) return;

  const accts = must(await db.from('accounts').select('id, name, account_type, account_group_id').in('account_type', ['OPEX', 'COGS']), 'accounts') as Row[];
  if (!accts.length) return;
  const groupIds = Array.from(new Set(accts.map((a) => s(a.account_group_id)).filter((g): g is string => !!g)));
  const groups = new Map<string, string>();
  if (groupIds.length) {
    const g = await db.from('account_groups').select('id, name').in('id', groupIds);
    for (const r of (g.data ?? []) as Row[]) groups.set(String(r.id), String(r.name ?? ''));
  }
  const roles = new Map<string, string[]>();
  const rr = await db.from('account_roles').select('role_key, account_id');
  for (const r of (rr.data ?? []) as Row[]) {
    const list = roles.get(String(r.account_id)) ?? [];
    list.push(String(r.role_key));
    roles.set(String(r.account_id), list);
  }
  const families = new Map<string, AccountFamily>();
  for (const a of accts) {
    const id = String(a.id);
    inp.accountNames.set(id, String(a.name ?? 'Account'));
    families.set(id, classifyFamily({ name: String(a.name ?? ''), groupName: a.account_group_id ? groups.get(String(a.account_group_id)) : null, roleKeys: roles.get(id) }));
  }
  inp.accountFamilies = families;
  const acctIds = new Set(families.keys());
  const months = horizonMonths(opts.today, opts.horizonEnd);
  const basis: MonthlyBasisRow[] = [];

  if (wantBudget.length) {
    const org = await db.schema('core').from('organizations').select('fiscal_year_start_month').eq('id', opts.orgId).maybeSingle();
    const fy = Number((org.data as { fiscal_year_start_month?: number } | null)?.fiscal_year_start_month ?? 1) || 1;
    const years = Array.from(new Set(months.flatMap((m) => [Number(m.slice(0, 4)), Number(m.slice(0, 4)) + 1])));
    const res = await fetchAll(
      () => db.from('budgets').select('id, location_id, account_id, fiscal_year, period_number, amount_cents').in('location_id', wantBudget).in('fiscal_year', years),
      { label: 'cash-forecast budgets' },
    );
    if (res.error) throw new Error(res.error.message);
    const want = new Set(months);
    for (const r of (res.data ?? []) as Row[]) {
      const acct = String(r.account_id);
      if (!acctIds.has(acct)) continue;
      const m = budgetMonth(n(r.fiscal_year), n(r.period_number), fy);
      if (!want.has(m)) continue;
      basis.push({ companyId: String(r.location_id), accountId: acct, month: m, cents: n(r.amount_cents) });
    }
  }

  if (wantTrailing.length) {
    const from = startOfMonth(addMonths(startOfMonth(opts.today), -3));
    const to = endOfMonth(addMonths(startOfMonth(opts.today), -1));
    const res = await fetchAll(
      () =>
        db
          .from('gl_entry_lines')
          .select('id, account_id, location_id, debit_cents, credit_cents, gl_entries!inner(entry_date, status)')
          .eq('gl_entries.status', 'POSTED')
          .gte('gl_entries.entry_date', from)
          .lte('gl_entries.entry_date', to)
          .in('account_id', Array.from(acctIds))
          .in('location_id', wantTrailing),
      { label: 'cash-forecast trailing opex' },
    );
    if (res.error) throw new Error(res.error.message);
    const sum = new Map<string, number>();
    for (const r of (res.data ?? []) as Row[]) {
      const k = `${r.location_id}|${r.account_id}`;
      sum.set(k, (sum.get(k) ?? 0) + n(r.debit_cents) - n(r.credit_cents));
    }
    for (const [k, v] of sum) {
      const [companyId, accountId] = k.split('|');
      const monthly = Math.round(v / 3);
      if (monthly <= 0) continue;
      for (const m of months) basis.push({ companyId, accountId, month: m, cents: monthly });
    }
  }
  inp.runRateBasis = basis;
}

// ── snapshots ───────────────────────────────────────────────────────────────────

export async function loadSnapshots(db: SupabaseClient, orgId: string, since: string): Promise<Array<{ anchorDate: string; companyId: string | null; openingCents: number; closingCents: number; weeks: unknown; createdAt: string | null; source: string }>> {
  const rows = must(
    await db.from('cash_forecast_snapshots').select('anchor_date, location_id, opening_cents, closing_cents, weeks, created_at, source').eq('org_id', orgId).gte('anchor_date', since).order('anchor_date'),
    'cash_forecast_snapshots',
  ) as Row[];
  return rows.map((r) => ({
    anchorDate: d(r.anchor_date)!,
    companyId: s(r.location_id),
    openingCents: n(r.opening_cents),
    closingCents: n(r.closing_cents),
    weeks: r.weeks,
    createdAt: s(r.created_at),
    source: String(r.source ?? 'SCHEDULED'),
  }));
}
