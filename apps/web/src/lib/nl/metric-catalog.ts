/**
 * NL → Ledger-Query — the ANALYTICAL / FP&A lane's safety kernel.
 *
 * Per docs/FPB-nl-copilot.md (Dimension 5, AC5.1–5.4): the analytical lane is
 * "injection-safe by construction" because **the model never authors SQL**. Its
 * only job is to pick a NAMED metric from this allowlist and fill TYPED,
 * VALIDATED parameters. Everything else — the query, the RLS wall, the math, the
 * citations — is deterministic code in this file.
 *
 * Guarantees enforced here:
 *  - No model-authored SQL. The model returns `{ metric, params }` as JSON; the
 *    metric id must be a key of METRIC_CATALOG and the params must pass the
 *    entry's Zod schema. Anything else → `resolveMetric` returns `abstain`.
 *  - The model never sees or emits table names, `org_id`, or raw SQL. Executors
 *    run pre-written queries against RLS-scoped views (`org_id = get_org_id()`),
 *    so a red-team prompt ("show all orgs' revenue", "'; drop table") cannot
 *    reach data — it either maps to an allowlisted metric (still RLS-walled) or
 *    abstains.
 *  - Every figure carries a drill-down citation into the matching report page.
 *  - All money stays bigint cents; formatting via `formatMoney`.
 *  - Read-only end to end: executors only SELECT.
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export interface NlCitation {
  label: string;
  href: string;
}

/** The deterministic result an executor returns (the route re-shapes it). */
export interface NlResult {
  answer: string;
  rows: unknown[];
  citations: NlCitation[];
  drilldownHref?: string;
}

/** Execution context — an RLS-scoped Supabase client + the caller's org. */
export interface NlExecContext {
  supabase: SupabaseClient;
  orgId: string;
}

interface MetricEntry {
  id: string;
  title: string;
  description: string;
  /** Human-readable param hint injected into the classifier prompt. */
  paramHint: string;
  paramsSchema: z.ZodTypeAny;
  execute: (ctx: NlExecContext, params: unknown) => Promise<NlResult>;
}

/**
 * Typed metric factory. Executors receive params already narrowed to the
 * schema's inferred type — so no `any` leaks into an executor body. The single
 * cast to `MetricEntry` is contained here.
 */
function defineMetric<S extends z.ZodTypeAny>(m: {
  id: string;
  title: string;
  description: string;
  paramHint: string;
  paramsSchema: S;
  execute: (ctx: NlExecContext, params: z.infer<S>) => Promise<NlResult>;
}): MetricEntry {
  return m as unknown as MetricEntry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared param primitives & helpers
// ─────────────────────────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const locationId = z.string().uuid().optional();

function firstOfMonth(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function today(): string {
  return new Date().toISOString().split('T')[0];
}

/** Build a stable /reports drill-down href from a report slug + query params. */
function reportHref(slug: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams({ report: slug });
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  return `/reports?${qs.toString()}`;
}

/** Normal-balance-aware net for an account type bucket. */
function netFor(normalBalance: string, debits: number, credits: number): number {
  return normalBalance === 'DEBIT' ? debits - credits : credits - debits;
}

/**
 * Aggregate POSTED gl_entry_lines into per-account-type net cents over a date
 * window (income-statement types) or as-of a date (balance-sheet types). This
 * mirrors the RLS-scoped queries in /api/reports/income-statement and
 * /api/reports/balance-sheet so a copilot figure equals the report figure.
 */
async function aggregateByType(
  supabase: SupabaseClient,
  opts: {
    accountTypes: string[];
    startDate?: string;
    endDate: string;
    locationId?: string;
  },
): Promise<Map<string, number>> {
  let query = supabase
    .from('gl_entry_lines')
    .select(
      `
      debit_cents,
      credit_cents,
      location_id,
      accounts!inner(
        account_type,
        account_groups!inner(
          account_sub_types!inner(
            account_types!inner( normal_balance )
          )
        )
      ),
      gl_entries!inner( entry_date, status )
    `,
    )
    .eq('gl_entries.status', 'POSTED')
    .lte('gl_entries.entry_date', opts.endDate)
    .in('accounts.account_type', opts.accountTypes);

  if (opts.startDate) query = query.gte('gl_entries.entry_date', opts.startDate);
  if (opts.locationId) query = query.eq('location_id', opts.locationId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  // net cents per account_type
  const totals = new Map<string, number>();
  for (const raw of data ?? []) {
    const line = raw as Record<string, unknown>;
    const acct = line.accounts as unknown as Record<string, unknown>;
    const accountType = String(acct.account_type);
    const group = acct.account_groups as Record<string, unknown>;
    const subType = group?.account_sub_types as Record<string, unknown>;
    const acctType = subType?.account_types as Record<string, unknown>;
    const normalBalance = String(acctType?.normal_balance ?? 'DEBIT');

    const debit = Number(line.debit_cents ?? 0);
    const credit = Number(line.credit_cents ?? 0);
    const signed = netFor(normalBalance, debit, credit);
    totals.set(accountType, (totals.get(accountType) ?? 0) + signed);
  }
  return totals;
}

/**
 * Static normal-balance map by account SUB-TYPE. The sub-type enum
 * (migration 001) is fixed, so the debit/credit normal side is deterministic —
 * this lets a balance-sheet sub-type aggregation (current ratio / working
 * capital) run WITHOUT the deep join to account_types just to read
 * `normal_balance`. Any sub-type not listed defaults to DEBIT (asset-like).
 */
const SUBTYPE_NORMAL_BALANCE: Record<string, 'DEBIT' | 'CREDIT'> = {
  CURRENT_ASSET: 'DEBIT',
  FIXED_ASSET: 'DEBIT',
  OTHER_ASSET: 'DEBIT',
  CURRENT_LIABILITY: 'CREDIT',
  LONG_TERM_LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
};

/**
 * Aggregate POSTED gl_entry_lines into per-account-SUB-TYPE net cents as-of a
 * date. Mirrors aggregateByType but keys on `accounts.account_sub_type` (a
 * direct column on `accounts`), applying the static normal-balance map above.
 * Used for liquidity metrics that need the CURRENT_ASSET / CURRENT_LIABILITY cut.
 */
async function aggregateBySubType(
  supabase: SupabaseClient,
  opts: { subTypes: string[]; endDate: string; locationId?: string },
): Promise<Map<string, number>> {
  let query = supabase
    .from('gl_entry_lines')
    .select('debit_cents, credit_cents, location_id, accounts!inner( account_sub_type ), gl_entries!inner( entry_date, status )')
    .eq('gl_entries.status', 'POSTED')
    .lte('gl_entries.entry_date', opts.endDate)
    .in('accounts.account_sub_type', opts.subTypes);
  if (opts.locationId) query = query.eq('location_id', opts.locationId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const totals = new Map<string, number>();
  for (const raw of data ?? []) {
    const line = raw as Record<string, unknown>;
    const acct = line.accounts as unknown as Record<string, unknown>;
    const subType = String(acct.account_sub_type);
    const nb = SUBTYPE_NORMAL_BALANCE[subType] ?? 'DEBIT';
    const debit = Number(line.debit_cents ?? 0);
    const credit = Number(line.credit_cents ?? 0);
    totals.set(subType, (totals.get(subType) ?? 0) + netFor(nb, debit, credit));
  }
  return totals;
}

/**
 * Resolve cash on hand BY ROLE (OPERATING_BANK + CASH_ON_HAND) and sum the
 * net balances from v_trial_balance. Shared by the cash-position and
 * cash-runway metrics. `mapped:false` means no cash role is seeded for the entity.
 */
async function resolveCashCents(
  ctx: NlExecContext,
  locationId?: string,
): Promise<{ rows: Array<{ accountNumber: string; accountName: string; balanceCents: number }>; totalCents: number; mapped: boolean }> {
  const roleKeys = ['OPERATING_BANK', 'CASH_ON_HAND'] as const;
  const accountIds: string[] = [];
  for (const role of roleKeys) {
    try {
      const ref = await resolveRole(ctx.supabase, ctx.orgId, role, locationId);
      if (ref?.id) accountIds.push(ref.id);
    } catch (e) {
      if (!(e instanceof PostingError)) throw e;
    }
  }
  if (accountIds.length === 0) return { rows: [], totalCents: 0, mapped: false };

  let query = ctx.supabase
    .from('v_trial_balance')
    .select('account_number, account_name, net_balance, account_id')
    .in('account_id', accountIds);
  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      accountNumber: String(row.account_number ?? ''),
      accountName: String(row.account_name ?? ''),
      balanceCents: Number(row.net_balance ?? 0),
    };
  });
  return { rows, totalCents: rows.reduce((s, r) => s + r.balanceCents, 0), mapped: true };
}

/** Sum open (balance > 0) rows of an aging view into total + overdue (non-CURRENT) cents. */
async function sumAgingTotals(
  supabase: SupabaseClient,
  view: 'v_ap_aging' | 'v_ar_aging',
  locationId?: string,
): Promise<{ total: number; overdue: number }> {
  let q = supabase.from(view).select('aging_bucket, balance_cents').gt('balance_cents', 0);
  if (locationId) q = q.eq('location_id', locationId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let total = 0;
  let overdue = 0;
  for (const raw of data ?? []) {
    const row = raw as Record<string, unknown>;
    const bal = Number(row.balance_cents ?? 0);
    total += bal;
    if (String(row.aging_bucket ?? '') !== 'CURRENT') overdue += bal;
  }
  return { total, overdue };
}

/** Rank the parties in an aging view by outstanding balance (top N). */
async function topByParty(
  supabase: SupabaseClient,
  opts: { view: 'v_ap_aging' | 'v_ar_aging'; nameCol: 'vendor_name' | 'customer_name'; locationId?: string; limit: number },
): Promise<Array<{ name: string; balanceCents: number; openItems: number }>> {
  let q = supabase.from(opts.view).select(`${opts.nameCol}, balance_cents`).gt('balance_cents', 0);
  if (opts.locationId) q = q.eq('location_id', opts.locationId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const m = new Map<string, { balanceCents: number; openItems: number }>();
  for (const raw of data ?? []) {
    const row = raw as Record<string, unknown>;
    const name = String(row[opts.nameCol] ?? 'Unknown');
    const bal = Number(row.balance_cents ?? 0);
    const e = m.get(name) ?? { balanceCents: 0, openItems: 0 };
    e.balanceCents += bal;
    e.openItems += 1;
    m.set(name, e);
  }
  return [...m.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.balanceCents - a.balanceCents)
    .slice(0, opts.limit);
}

/**
 * Net POSTED amount by DEPARTMENT over a window, read from the RLS-scoped
 * v_gl_detail view (which exposes department_name + debit/credit per line).
 * direction REVENUE → credit−debit; EXPENSE → debit−credit.
 */
async function sumByDepartment(
  supabase: SupabaseClient,
  opts: { accountTypes: string[]; startDate: string; endDate: string; direction: 'REVENUE' | 'EXPENSE' },
): Promise<Array<{ department: string; amountCents: number }>> {
  const { data, error } = await supabase
    .from('v_gl_detail')
    .select('account_type, debit_cents, credit_cents, department_name, entry_date, entry_status')
    .eq('entry_status', 'POSTED')
    .gte('entry_date', opts.startDate)
    .lte('entry_date', opts.endDate)
    .in('account_type', opts.accountTypes);
  if (error) throw new Error(error.message);
  const m = new Map<string, number>();
  for (const raw of data ?? []) {
    const row = raw as Record<string, unknown>;
    const dept = String(row.department_name ?? 'Unassigned');
    const d = Number(row.debit_cents ?? 0);
    const c = Number(row.credit_cents ?? 0);
    const amt = opts.direction === 'REVENUE' ? c - d : d - c;
    m.set(dept, (m.get(dept) ?? 0) + amt);
  }
  return [...m.entries()]
    .map(([department, amountCents]) => ({ department, amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

/**
 * Monthly series of the (already normal-balance-normalized) income-statement
 * amounts over a window, from v_income_statement. Summing REVENUE gives revenue;
 * summing COGS+OPEX+OTHER gives total expense (the view pre-signs each type).
 */
async function monthlyTrend(
  supabase: SupabaseClient,
  opts: { accountTypes: string[]; startDate: string; endDate: string; locationId?: string },
): Promise<Array<{ period: string; amountCents: number }>> {
  let q = supabase
    .from('v_income_statement')
    .select('fiscal_year, fiscal_month, amount_cents, account_type, entry_date, location_id')
    .gte('entry_date', opts.startDate)
    .lte('entry_date', opts.endDate)
    .in('account_type', opts.accountTypes);
  if (opts.locationId) q = q.eq('location_id', opts.locationId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const m = new Map<string, number>();
  for (const raw of data ?? []) {
    const row = raw as Record<string, unknown>;
    const y = Number(row.fiscal_year ?? 0);
    const mo = Number(row.fiscal_month ?? 0);
    const key = `${y}-${String(mo).padStart(2, '0')}`;
    m.set(key, (m.get(key) ?? 0) + Number(row.amount_cents ?? 0));
  }
  return [...m.entries()]
    .map(([period, amountCents]) => ({ period, amountCents }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure, deterministic ratio math (exported for unit tests — no DB, no model).
// Every derived KPI below is arithmetic over engine-computed cents; the AI never
// computes a number, it only names the metric and fills params.
// ─────────────────────────────────────────────────────────────────────────────

/** Gross margin % = (revenue − COGS) / revenue × 100. null when revenue ≤ 0. */
export function grossMarginPct(revenueCents: number, cogsCents: number): number | null {
  if (revenueCents <= 0) return null;
  return ((revenueCents - cogsCents) / revenueCents) * 100;
}

/** Net margin % = net income / revenue × 100. null when revenue ≤ 0. */
export function netMarginPct(netIncomeCents: number, revenueCents: number): number | null {
  if (revenueCents <= 0) return null;
  return (netIncomeCents / revenueCents) * 100;
}

/** A ratio (e.g. current ratio). null when the denominator ≤ 0. */
export function ratioOf(numeratorCents: number, denominatorCents: number): number | null {
  if (denominatorCents <= 0) return null;
  return numeratorCents / denominatorCents;
}

/** Days outstanding = balance × days / flow (DSO/DPO). null when flow ≤ 0. */
export function daysOutstanding(balanceCents: number, flowCents: number, days: number): number | null {
  if (flowCents <= 0 || days <= 0) return null;
  return (balanceCents * days) / flowCents;
}

/** Runway in months = cash / monthly burn. null when not burning (≤ 0). */
export function runwayMonths(cashCents: number, monthlyBurnCents: number): number | null {
  if (monthlyBurnCents <= 0) return null;
  return cashCents / monthlyBurnCents;
}

function formatPct(v: number | null, digits = 1): string {
  return v == null ? 'n/a' : `${v.toFixed(digits)}%`;
}
function formatRatio(v: number | null, digits = 2): string {
  return v == null ? 'n/a' : `${v.toFixed(digits)}×`;
}

/** ISO date `n` days before today (trailing-window helper). */
function isoNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
/** First day of the month `n` months back (trend-window helper). */
function firstOfMonthNBack(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

const periodDays = z.coerce.number().int().min(1).max(3650).optional();
const topLimit = z.coerce.number().int().min(1).max(50).optional();

// ─────────────────────────────────────────────────────────────────────────────
// The allowlist catalog
// ─────────────────────────────────────────────────────────────────────────────

const pnlSummary = defineMetric({
  id: 'pnl_summary',
  title: 'Profit & Loss summary',
  description:
    'Income statement summary for a period: revenue, COGS, gross profit, operating expenses, and net income.',
  paramHint: 'start_date? (YYYY-MM-DD), end_date? (YYYY-MM-DD), location_id? (uuid)',
  paramsSchema: z.object({
    start_date: isoDate.optional(),
    end_date: isoDate.optional(),
    location_id: locationId,
  }),
  async execute(ctx, params) {
    const startDate = params.start_date ?? firstOfMonth();
    const endDate = params.end_date ?? today();
    const totals = await aggregateByType(ctx.supabase, {
      accountTypes: ['REVENUE', 'COGS', 'OPEX', 'OTHER'],
      startDate,
      endDate,
      locationId: params.location_id,
    });
    const revenue = totals.get('REVENUE') ?? 0;
    const cogs = totals.get('COGS') ?? 0;
    const opex = totals.get('OPEX') ?? 0;
    const other = totals.get('OTHER') ?? 0;
    const grossProfit = revenue - cogs;
    const netIncome = grossProfit - opex - other;

    const rows = [
      { label: 'Revenue', amountCents: revenue },
      { label: 'Cost of goods sold', amountCents: cogs },
      { label: 'Gross profit', amountCents: grossProfit },
      { label: 'Operating expenses', amountCents: opex },
      { label: 'Other income / expense', amountCents: other },
      { label: 'Net income', amountCents: netIncome },
    ];
    const href = reportHref('income-statement', {
      start_date: startDate,
      end_date: endDate,
      location_id: params.location_id,
    });
    const answer =
      `For ${startDate} to ${endDate}, revenue was ${formatMoney(revenue)}, ` +
      `gross profit ${formatMoney(grossProfit)}, operating expenses ${formatMoney(opex)}, ` +
      `and net income ${formatMoney(netIncome)}.`;
    return {
      answer,
      rows,
      citations: [{ label: 'Income Statement', href }],
      drilldownHref: href,
    };
  },
});

const balanceSheetSummary = defineMetric({
  id: 'balance_sheet_summary',
  title: 'Balance sheet summary',
  description:
    'Balance sheet totals as of a date: total assets, total liabilities, total equity, and whether it balances.',
  paramHint: 'as_of_date? (YYYY-MM-DD), location_id? (uuid)',
  paramsSchema: z.object({
    as_of_date: isoDate.optional(),
    location_id: locationId,
  }),
  async execute(ctx, params) {
    const asOf = params.as_of_date ?? today();
    const totals = await aggregateByType(ctx.supabase, {
      accountTypes: ['ASSET', 'LIABILITY', 'EQUITY'],
      endDate: asOf,
      locationId: params.location_id,
    });
    const assets = totals.get('ASSET') ?? 0;
    const liabilities = totals.get('LIABILITY') ?? 0;
    const equity = totals.get('EQUITY') ?? 0;
    const balanced = assets === liabilities + equity;

    const rows = [
      { label: 'Total assets', amountCents: assets },
      { label: 'Total liabilities', amountCents: liabilities },
      { label: 'Total equity', amountCents: equity },
    ];
    const href = reportHref('balance-sheet', {
      as_of_date: asOf,
      location_id: params.location_id,
    });
    const answer =
      `As of ${asOf}, total assets were ${formatMoney(assets)}, liabilities ${formatMoney(liabilities)}, ` +
      `and equity ${formatMoney(equity)}. The balance sheet ${balanced ? 'is in balance' : 'does NOT balance — review'}.`;
    return {
      answer,
      rows,
      citations: [{ label: 'Balance Sheet', href }],
      drilldownHref: href,
    };
  },
});

const trialBalance = defineMetric({
  id: 'trial_balance',
  title: 'Trial balance',
  description:
    'Trial balance: every account with its total debits, total credits, and net balance; confirms debits equal credits.',
  paramHint: 'location_id? (uuid)',
  paramsSchema: z.object({ location_id: locationId }),
  async execute(ctx, params) {
    let query = ctx.supabase
      .from('v_trial_balance')
      .select('account_number, account_name, account_type, total_debits, total_credits, net_balance');
    if (params.location_id) query = query.eq('location_id', params.location_id);

    const { data, error } = await query
      .order('type_order')
      .order('sub_type_order')
      .order('group_order')
      .order('account_order');
    if (error) throw new Error(error.message);

    const rows = (data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        accountNumber: String(row.account_number ?? ''),
        accountName: String(row.account_name ?? ''),
        accountType: String(row.account_type ?? ''),
        debitCents: Number(row.total_debits ?? 0),
        creditCents: Number(row.total_credits ?? 0),
        netBalanceCents: Number(row.net_balance ?? 0),
      };
    });
    const totalDebits = rows.reduce((s, r) => s + r.debitCents, 0);
    const totalCredits = rows.reduce((s, r) => s + r.creditCents, 0);
    const balanced = totalDebits === totalCredits;
    const href = reportHref('trial-balance', { location_id: params.location_id });
    const answer =
      `The trial balance across ${rows.length} account${rows.length === 1 ? '' : 's'} totals ` +
      `${formatMoney(totalDebits)} in debits and ${formatMoney(totalCredits)} in credits — ` +
      `${balanced ? 'in balance' : 'OUT OF BALANCE, investigate'}.`;
    return {
      answer,
      rows,
      citations: [{ label: 'Trial Balance', href }],
      drilldownHref: href,
    };
  },
});

/** Shared executor for the AP/AR aging views (identical shape). */
async function agingExecutor(
  ctx: NlExecContext,
  opts: { view: 'v_ap_aging' | 'v_ar_aging'; slug: string; label: string; party: 'owe' | 'owed'; locationId?: string },
): Promise<NlResult> {
  // `> 0` defensively excludes WRITTEN_OFF/settled (balance 0) rows from aging
  // before the v_ar_aging view is re-created to drop WRITTEN_OFF.
  let query = ctx.supabase.from(opts.view).select('aging_bucket, balance_cents').gt('balance_cents', 0);
  if (opts.locationId) query = query.eq('location_id', opts.locationId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const bucketOrder = ['CURRENT', '1-30', '31-60', '61-90', '90+'];
  const buckets = new Map<string, { count: number; totalCents: number }>();
  for (const b of bucketOrder) buckets.set(b, { count: 0, totalCents: 0 });
  for (const raw of data ?? []) {
    const row = raw as Record<string, unknown>;
    const bucket = String(row.aging_bucket ?? '');
    const entry = buckets.get(bucket);
    if (entry) {
      entry.count += 1;
      entry.totalCents += Number(row.balance_cents ?? 0);
    }
  }
  const rows = bucketOrder.map((b) => ({
    bucket: b,
    count: buckets.get(b)!.count,
    totalCents: buckets.get(b)!.totalCents,
  }));
  const totalOutstanding = rows.reduce((s, r) => s + r.totalCents, 0);
  const overdue = rows.filter((r) => r.bucket !== 'CURRENT').reduce((s, r) => s + r.totalCents, 0);
  const href = reportHref(opts.slug, { location_id: opts.locationId });
  const verb = opts.party === 'owe' ? 'owe vendors' : 'are owed by customers';
  const answer =
    `You ${verb} ${formatMoney(totalOutstanding)} in total, of which ${formatMoney(overdue)} is past due ` +
    `(beyond the current bucket).`;
  return {
    answer,
    rows,
    citations: [{ label: opts.label, href }],
    drilldownHref: href,
  };
}

const apAging = defineMetric({
  id: 'ap_aging',
  title: 'Accounts payable aging',
  description: 'How much you owe vendors, bucketed by how overdue it is (current, 1-30, 31-60, 61-90, 90+).',
  paramHint: 'location_id? (uuid)',
  paramsSchema: z.object({ location_id: locationId }),
  async execute(ctx, params) {
    return agingExecutor(ctx, {
      view: 'v_ap_aging',
      slug: 'ap-aging',
      label: 'AP Aging',
      party: 'owe',
      locationId: params.location_id,
    });
  },
});

const arAging = defineMetric({
  id: 'ar_aging',
  title: 'Accounts receivable aging',
  description: 'How much customers owe you, bucketed by how overdue it is (current, 1-30, 31-60, 61-90, 90+).',
  paramHint: 'location_id? (uuid)',
  paramsSchema: z.object({ location_id: locationId }),
  async execute(ctx, params) {
    return agingExecutor(ctx, {
      view: 'v_ar_aging',
      slug: 'ar-aging',
      label: 'AR Aging',
      party: 'owed',
      locationId: params.location_id,
    });
  },
});

const cashPosition = defineMetric({
  id: 'cash_position',
  title: 'Cash position',
  description:
    'Current cash on hand: the net balance of the operating-bank and cash-on-hand accounts (resolved by role, not number).',
  paramHint: 'location_id? (uuid)',
  paramsSchema: z.object({ location_id: locationId }),
  async execute(ctx, params) {
    // Resolve cash/bank accounts BY ROLE (canon: never by hard-coded number).
    const cash = await resolveCashCents(ctx, params.location_id);
    const href = reportHref('cash-flow', { location_id: params.location_id });
    if (!cash.mapped) {
      return {
        answer:
          'No operating-bank or cash-on-hand account is mapped for this entity, so a cash position ' +
          'cannot be computed. Map the cash roles on the Account Roles screen.',
        rows: [],
        citations: [{ label: 'Cash Flow', href }],
        drilldownHref: href,
      };
    }
    const answer = `Current cash on hand is ${formatMoney(cash.totalCents)} across ${cash.rows.length} cash/bank account${
      cash.rows.length === 1 ? '' : 's'
    }.`;
    return {
      answer,
      rows: cash.rows,
      citations: [{ label: 'Cash Flow', href }],
      drilldownHref: href,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Expanded catalog — profitability, liquidity, efficiency, mix & trends.
// Each metric is a hand-written, RLS-scoped, read-only query; every derived KPI
// is arithmetic over engine-computed cents (the pure helpers above). Accounts
// that must be resolved (cash) go BY ROLE, never by number.
// ─────────────────────────────────────────────────────────────────────────────

const grossMargin = defineMetric({
  id: 'gross_margin',
  title: 'Gross margin %',
  description:
    'Gross margin: revenue minus cost of goods sold, and the gross margin percentage, for a period.',
  paramHint: 'start_date? (YYYY-MM-DD, default 90 days ago), end_date? (YYYY-MM-DD), location_id? (uuid)',
  paramsSchema: z.object({ start_date: isoDate.optional(), end_date: isoDate.optional(), location_id: locationId }),
  async execute(ctx, params) {
    const startDate = params.start_date ?? isoNDaysAgo(90);
    const endDate = params.end_date ?? today();
    const totals = await aggregateByType(ctx.supabase, {
      accountTypes: ['REVENUE', 'COGS'],
      startDate,
      endDate,
      locationId: params.location_id,
    });
    const revenue = totals.get('REVENUE') ?? 0;
    const cogs = totals.get('COGS') ?? 0;
    const grossProfit = revenue - cogs;
    const gm = grossMarginPct(revenue, cogs);
    const href = reportHref('income-statement', { start_date: startDate, end_date: endDate, location_id: params.location_id });
    return {
      answer:
        `From ${startDate} to ${endDate}, gross margin was ${formatPct(gm)} — ` +
        `${formatMoney(grossProfit)} of gross profit on ${formatMoney(revenue)} of revenue ` +
        `(COGS ${formatMoney(cogs)}).`,
      rows: [
        { label: 'Revenue', amountCents: revenue },
        { label: 'Cost of goods sold', amountCents: cogs },
        { label: 'Gross profit', amountCents: grossProfit },
        { label: 'Gross margin %', value: formatPct(gm) },
      ],
      citations: [{ label: 'Income Statement', href }],
      drilldownHref: href,
    };
  },
});

const netMargin = defineMetric({
  id: 'net_margin',
  title: 'Net profit margin %',
  description: 'Net profit margin: net income as a percentage of revenue, for a period.',
  paramHint: 'start_date? (YYYY-MM-DD, default 90 days ago), end_date? (YYYY-MM-DD), location_id? (uuid)',
  paramsSchema: z.object({ start_date: isoDate.optional(), end_date: isoDate.optional(), location_id: locationId }),
  async execute(ctx, params) {
    const startDate = params.start_date ?? isoNDaysAgo(90);
    const endDate = params.end_date ?? today();
    const totals = await aggregateByType(ctx.supabase, {
      accountTypes: ['REVENUE', 'COGS', 'OPEX', 'OTHER'],
      startDate,
      endDate,
      locationId: params.location_id,
    });
    const revenue = totals.get('REVENUE') ?? 0;
    const cogs = totals.get('COGS') ?? 0;
    const opex = totals.get('OPEX') ?? 0;
    const other = totals.get('OTHER') ?? 0;
    const netIncome = revenue - cogs - opex - other;
    const nm = netMarginPct(netIncome, revenue);
    const href = reportHref('income-statement', { start_date: startDate, end_date: endDate, location_id: params.location_id });
    return {
      answer:
        `From ${startDate} to ${endDate}, net profit margin was ${formatPct(nm)} — ` +
        `${formatMoney(netIncome)} of net income on ${formatMoney(revenue)} of revenue.`,
      rows: [
        { label: 'Revenue', amountCents: revenue },
        { label: 'Net income', amountCents: netIncome },
        { label: 'Net margin %', value: formatPct(nm) },
      ],
      citations: [{ label: 'Income Statement', href }],
      drilldownHref: href,
    };
  },
});

const currentRatio = defineMetric({
  id: 'current_ratio',
  title: 'Current ratio & working capital',
  description:
    'Liquidity: current assets divided by current liabilities (the current ratio) and working capital, as of a date.',
  paramHint: 'as_of_date? (YYYY-MM-DD), location_id? (uuid)',
  paramsSchema: z.object({ as_of_date: isoDate.optional(), location_id: locationId }),
  async execute(ctx, params) {
    const asOf = params.as_of_date ?? today();
    const totals = await aggregateBySubType(ctx.supabase, {
      subTypes: ['CURRENT_ASSET', 'CURRENT_LIABILITY'],
      endDate: asOf,
      locationId: params.location_id,
    });
    const currentAssets = totals.get('CURRENT_ASSET') ?? 0;
    const currentLiabilities = totals.get('CURRENT_LIABILITY') ?? 0;
    const ratio = ratioOf(currentAssets, currentLiabilities);
    const workingCapital = currentAssets - currentLiabilities;
    const href = reportHref('balance-sheet', { as_of_date: asOf, location_id: params.location_id });
    return {
      answer:
        `As of ${asOf}, the current ratio is ${formatRatio(ratio)} ` +
        `(${formatMoney(currentAssets)} current assets vs ${formatMoney(currentLiabilities)} current liabilities), ` +
        `for ${formatMoney(workingCapital)} of working capital.`,
      rows: [
        { label: 'Current assets', amountCents: currentAssets },
        { label: 'Current liabilities', amountCents: currentLiabilities },
        { label: 'Working capital', amountCents: workingCapital },
        { label: 'Current ratio', value: formatRatio(ratio) },
      ],
      citations: [{ label: 'Balance Sheet', href }],
      drilldownHref: href,
    };
  },
});

const daysSalesOutstanding = defineMetric({
  id: 'days_sales_outstanding',
  title: 'Days sales outstanding (DSO)',
  description:
    'DSO: average days to collect receivables — open AR divided by average daily revenue over a trailing window.',
  paramHint: 'period_days? (integer, default 90), location_id? (uuid)',
  paramsSchema: z.object({ period_days: periodDays, location_id: locationId }),
  async execute(ctx, params) {
    const days = params.period_days ?? 90;
    const startDate = isoNDaysAgo(days);
    const endDate = today();
    const ar = await sumAgingTotals(ctx.supabase, 'v_ar_aging', params.location_id);
    const totals = await aggregateByType(ctx.supabase, { accountTypes: ['REVENUE'], startDate, endDate, locationId: params.location_id });
    const revenue = totals.get('REVENUE') ?? 0;
    const dso = daysOutstanding(ar.total, revenue, days);
    const href = reportHref('ar-aging', { location_id: params.location_id });
    return {
      answer:
        dso == null
          ? `DSO can't be computed — there was no revenue in the trailing ${days} days to annualize against ${formatMoney(ar.total)} of open receivables.`
          : `Days sales outstanding is ${dso.toFixed(1)} days: ${formatMoney(ar.total)} of open receivables against ${formatMoney(revenue)} of revenue over the trailing ${days} days.`,
      rows: [
        { label: 'Open receivables', amountCents: ar.total },
        { label: `Revenue (trailing ${days}d)`, amountCents: revenue },
        { label: 'DSO (days)', value: dso == null ? 'n/a' : dso.toFixed(1) },
      ],
      citations: [{ label: 'AR Aging', href }],
      drilldownHref: href,
    };
  },
});

const daysPayableOutstanding = defineMetric({
  id: 'days_payable_outstanding',
  title: 'Days payable outstanding (DPO)',
  description:
    'DPO: average days you take to pay vendors — open AP divided by average daily cost of goods sold over a trailing window.',
  paramHint: 'period_days? (integer, default 90), location_id? (uuid)',
  paramsSchema: z.object({ period_days: periodDays, location_id: locationId }),
  async execute(ctx, params) {
    const days = params.period_days ?? 90;
    const startDate = isoNDaysAgo(days);
    const endDate = today();
    const ap = await sumAgingTotals(ctx.supabase, 'v_ap_aging', params.location_id);
    const totals = await aggregateByType(ctx.supabase, { accountTypes: ['COGS'], startDate, endDate, locationId: params.location_id });
    const cogs = totals.get('COGS') ?? 0;
    const dpo = daysOutstanding(ap.total, cogs, days);
    const href = reportHref('ap-aging', { location_id: params.location_id });
    return {
      answer:
        dpo == null
          ? `DPO can't be computed — there was no cost of goods sold in the trailing ${days} days to annualize against ${formatMoney(ap.total)} of open payables.`
          : `Days payable outstanding is ${dpo.toFixed(1)} days: ${formatMoney(ap.total)} of open payables against ${formatMoney(cogs)} of COGS over the trailing ${days} days.`,
      rows: [
        { label: 'Open payables', amountCents: ap.total },
        { label: `COGS (trailing ${days}d)`, amountCents: cogs },
        { label: 'DPO (days)', value: dpo == null ? 'n/a' : dpo.toFixed(1) },
      ],
      citations: [{ label: 'AP Aging', href }],
      drilldownHref: href,
    };
  },
});

const cashRunway = defineMetric({
  id: 'cash_runway',
  title: 'Cash runway',
  description:
    'Cash runway: how many months current cash lasts at the recent net burn rate (trailing 90 days). If profitable, there is no burn.',
  paramHint: 'location_id? (uuid)',
  paramsSchema: z.object({ location_id: locationId }),
  async execute(ctx, params) {
    const cash = await resolveCashCents(ctx, params.location_id);
    const href = reportHref('cash-flow', { location_id: params.location_id });
    if (!cash.mapped) {
      return {
        answer:
          'No operating-bank or cash-on-hand account is mapped for this entity, so runway cannot be computed. ' +
          'Map the cash roles on the Account Roles screen.',
        rows: [],
        citations: [{ label: 'Cash Flow', href }],
        drilldownHref: href,
      };
    }
    const startDate = isoNDaysAgo(90);
    const endDate = today();
    const totals = await aggregateByType(ctx.supabase, {
      accountTypes: ['REVENUE', 'COGS', 'OPEX', 'OTHER'],
      startDate,
      endDate,
      locationId: params.location_id,
    });
    const revenue = totals.get('REVENUE') ?? 0;
    const cogs = totals.get('COGS') ?? 0;
    const opex = totals.get('OPEX') ?? 0;
    const other = totals.get('OTHER') ?? 0;
    const netIncome = revenue - cogs - opex - other; // 90-day net
    const monthlyBurn = netIncome >= 0 ? 0 : Math.round(-netIncome / 3); // ~3 months
    const months = runwayMonths(cash.totalCents, monthlyBurn);
    const answer =
      monthlyBurn <= 0
        ? `Over the last 90 days the entity was cash-flow positive (net ${formatMoney(netIncome)}), so there is no burn to deplete the ${formatMoney(cash.totalCents)} on hand — runway is effectively unlimited at the current rate.`
        : `At the recent burn of ${formatMoney(monthlyBurn)}/month, the ${formatMoney(cash.totalCents)} on hand is about ${months == null ? 'n/a' : months.toFixed(1)} months of runway.`;
    return {
      answer,
      rows: [
        { label: 'Cash on hand', amountCents: cash.totalCents },
        { label: 'Net income (trailing 90d)', amountCents: netIncome },
        { label: 'Monthly burn', amountCents: monthlyBurn },
        { label: 'Runway (months)', value: months == null ? 'unlimited' : months.toFixed(1) },
      ],
      citations: [{ label: 'Cash Flow', href }],
      drilldownHref: href,
    };
  },
});

const revenueByDepartment = defineMetric({
  id: 'revenue_by_department',
  title: 'Revenue by department',
  description: 'Revenue broken down by department for a period (which departments are bringing in the money).',
  paramHint: 'start_date? (YYYY-MM-DD, default 90 days ago), end_date? (YYYY-MM-DD)',
  paramsSchema: z.object({ start_date: isoDate.optional(), end_date: isoDate.optional() }),
  async execute(ctx, params) {
    const startDate = params.start_date ?? isoNDaysAgo(90);
    const endDate = params.end_date ?? today();
    const rows = await sumByDepartment(ctx.supabase, { accountTypes: ['REVENUE'], startDate, endDate, direction: 'REVENUE' });
    const total = rows.reduce((s, r) => s + r.amountCents, 0);
    const href = reportHref('income-statement', { start_date: startDate, end_date: endDate });
    const top = rows[0];
    return {
      answer:
        rows.length === 0
          ? `No departmental revenue was posted between ${startDate} and ${endDate}.`
          : `From ${startDate} to ${endDate}, revenue totaled ${formatMoney(total)} across ${rows.length} department${rows.length === 1 ? '' : 's'}` +
            (top ? `, led by ${top.department} at ${formatMoney(top.amountCents)}.` : '.'),
      rows: rows.map((r) => ({ department: r.department, amountCents: r.amountCents })),
      citations: [{ label: 'Income Statement', href }],
      drilldownHref: href,
    };
  },
});

const expenseByDepartment = defineMetric({
  id: 'expense_by_department',
  title: 'Expenses by department',
  description: 'Expenses (COGS + operating + other) broken down by department for a period.',
  paramHint: 'start_date? (YYYY-MM-DD, default 90 days ago), end_date? (YYYY-MM-DD)',
  paramsSchema: z.object({ start_date: isoDate.optional(), end_date: isoDate.optional() }),
  async execute(ctx, params) {
    const startDate = params.start_date ?? isoNDaysAgo(90);
    const endDate = params.end_date ?? today();
    const rows = await sumByDepartment(ctx.supabase, {
      accountTypes: ['COGS', 'OPEX', 'OTHER'],
      startDate,
      endDate,
      direction: 'EXPENSE',
    });
    const total = rows.reduce((s, r) => s + r.amountCents, 0);
    const href = reportHref('income-statement', { start_date: startDate, end_date: endDate });
    const top = rows[0];
    return {
      answer:
        rows.length === 0
          ? `No departmental expense was posted between ${startDate} and ${endDate}.`
          : `From ${startDate} to ${endDate}, expenses totaled ${formatMoney(total)} across ${rows.length} department${rows.length === 1 ? '' : 's'}` +
            (top ? `, led by ${top.department} at ${formatMoney(top.amountCents)}.` : '.'),
      rows: rows.map((r) => ({ department: r.department, amountCents: r.amountCents })),
      citations: [{ label: 'Income Statement', href }],
      drilldownHref: href,
    };
  },
});

const topCustomersByReceivable = defineMetric({
  id: 'top_customers_by_receivable',
  title: 'Top customers by open receivable',
  description: 'Which customers owe you the most right now, ranked by total outstanding (open) receivable balance.',
  paramHint: 'limit? (integer 1-50, default 5), location_id? (uuid)',
  paramsSchema: z.object({ limit: topLimit, location_id: locationId }),
  async execute(ctx, params) {
    const limit = params.limit ?? 5;
    const rows = await topByParty(ctx.supabase, { view: 'v_ar_aging', nameCol: 'customer_name', locationId: params.location_id, limit });
    const href = reportHref('ar-aging', { location_id: params.location_id });
    const top = rows[0];
    return {
      answer:
        rows.length === 0
          ? 'No customers currently have an open receivable balance.'
          : `Top ${rows.length} customer${rows.length === 1 ? '' : 's'} by open receivable` +
            (top ? `: ${top.name} at ${formatMoney(top.balanceCents)}.` : '.'),
      rows: rows.map((r) => ({ customer: r.name, openItems: r.openItems, balanceCents: r.balanceCents })),
      citations: [{ label: 'AR Aging', href }],
      drilldownHref: href,
    };
  },
});

const topVendorsByPayable = defineMetric({
  id: 'top_vendors_by_payable',
  title: 'Top vendors by open payable',
  description: 'Which vendors you owe the most right now, ranked by total outstanding (open) payable balance.',
  paramHint: 'limit? (integer 1-50, default 5), location_id? (uuid)',
  paramsSchema: z.object({ limit: topLimit, location_id: locationId }),
  async execute(ctx, params) {
    const limit = params.limit ?? 5;
    const rows = await topByParty(ctx.supabase, { view: 'v_ap_aging', nameCol: 'vendor_name', locationId: params.location_id, limit });
    const href = reportHref('ap-aging', { location_id: params.location_id });
    const top = rows[0];
    return {
      answer:
        rows.length === 0
          ? 'No vendors currently have an open payable balance.'
          : `Top ${rows.length} vendor${rows.length === 1 ? '' : 's'} by open payable` +
            (top ? `: ${top.name} at ${formatMoney(top.balanceCents)}.` : '.'),
      rows: rows.map((r) => ({ vendor: r.name, openItems: r.openItems, balanceCents: r.balanceCents })),
      citations: [{ label: 'AP Aging', href }],
      drilldownHref: href,
    };
  },
});

const revenueTrend = defineMetric({
  id: 'revenue_trend',
  title: 'Revenue trend by month',
  description: 'Monthly revenue over a date range (default the last 6 months) to see the trend.',
  paramHint: 'start_date? (YYYY-MM-DD, default 6 months ago), end_date? (YYYY-MM-DD), location_id? (uuid)',
  paramsSchema: z.object({ start_date: isoDate.optional(), end_date: isoDate.optional(), location_id: locationId }),
  async execute(ctx, params) {
    const startDate = params.start_date ?? firstOfMonthNBack(5);
    const endDate = params.end_date ?? today();
    const rows = await monthlyTrend(ctx.supabase, { accountTypes: ['REVENUE'], startDate, endDate, locationId: params.location_id });
    const total = rows.reduce((s, r) => s + r.amountCents, 0);
    const href = reportHref('income-statement', { start_date: startDate, end_date: endDate, location_id: params.location_id });
    const first = rows[0];
    const last = rows[rows.length - 1];
    const trend = first && last && rows.length > 1 ? (last.amountCents >= first.amountCents ? 'up' : 'down') : 'flat';
    return {
      answer:
        rows.length === 0
          ? `No revenue was posted between ${startDate} and ${endDate}.`
          : `Revenue totaled ${formatMoney(total)} across ${rows.length} month${rows.length === 1 ? '' : 's'} (${startDate} to ${endDate}), trending ${trend}` +
            (last ? ` — most recent month (${last.period}) was ${formatMoney(last.amountCents)}.` : '.'),
      rows: rows.map((r) => ({ period: r.period, amountCents: r.amountCents })),
      citations: [{ label: 'Income Statement', href }],
      drilldownHref: href,
    };
  },
});

const expenseTrend = defineMetric({
  id: 'expense_trend',
  title: 'Expense trend by month',
  description: 'Monthly total expenses (COGS + operating + other) over a date range (default the last 6 months).',
  paramHint: 'start_date? (YYYY-MM-DD, default 6 months ago), end_date? (YYYY-MM-DD), location_id? (uuid)',
  paramsSchema: z.object({ start_date: isoDate.optional(), end_date: isoDate.optional(), location_id: locationId }),
  async execute(ctx, params) {
    const startDate = params.start_date ?? firstOfMonthNBack(5);
    const endDate = params.end_date ?? today();
    const rows = await monthlyTrend(ctx.supabase, { accountTypes: ['COGS', 'OPEX', 'OTHER'], startDate, endDate, locationId: params.location_id });
    const total = rows.reduce((s, r) => s + r.amountCents, 0);
    const href = reportHref('income-statement', { start_date: startDate, end_date: endDate, location_id: params.location_id });
    const last = rows[rows.length - 1];
    return {
      answer:
        rows.length === 0
          ? `No expenses were posted between ${startDate} and ${endDate}.`
          : `Expenses totaled ${formatMoney(total)} across ${rows.length} month${rows.length === 1 ? '' : 's'} (${startDate} to ${endDate})` +
            (last ? ` — most recent month (${last.period}) was ${formatMoney(last.amountCents)}.` : '.'),
      rows: rows.map((r) => ({ period: r.period, amountCents: r.amountCents })),
      citations: [{ label: 'Income Statement', href }],
      drilldownHref: href,
    };
  },
});

const overdueReceivables = defineMetric({
  id: 'overdue_receivables',
  title: 'Overdue receivables',
  description: 'Total past-due accounts receivable — how much customers owe you that is beyond its due date.',
  paramHint: 'location_id? (uuid)',
  paramsSchema: z.object({ location_id: locationId }),
  async execute(ctx, params) {
    const ar = await sumAgingTotals(ctx.supabase, 'v_ar_aging', params.location_id);
    const href = reportHref('ar-aging', { location_id: params.location_id });
    const pct = ar.total > 0 ? (ar.overdue / ar.total) * 100 : 0;
    return {
      answer:
        `${formatMoney(ar.overdue)} of receivables is past due, out of ${formatMoney(ar.total)} total outstanding ` +
        `(${pct.toFixed(0)}% overdue).`,
      rows: [
        { label: 'Total outstanding', amountCents: ar.total },
        { label: 'Overdue (past due)', amountCents: ar.overdue },
      ],
      citations: [{ label: 'AR Aging', href }],
      drilldownHref: href,
    };
  },
});

const overduePayables = defineMetric({
  id: 'overdue_payables',
  title: 'Overdue payables',
  description: 'Total past-due accounts payable — how much you owe vendors that is beyond its due date.',
  paramHint: 'location_id? (uuid)',
  paramsSchema: z.object({ location_id: locationId }),
  async execute(ctx, params) {
    const ap = await sumAgingTotals(ctx.supabase, 'v_ap_aging', params.location_id);
    const href = reportHref('ap-aging', { location_id: params.location_id });
    const pct = ap.total > 0 ? (ap.overdue / ap.total) * 100 : 0;
    return {
      answer:
        `${formatMoney(ap.overdue)} of payables is past due, out of ${formatMoney(ap.total)} total outstanding ` +
        `(${pct.toFixed(0)}% overdue).`,
      rows: [
        { label: 'Total outstanding', amountCents: ap.total },
        { label: 'Overdue (past due)', amountCents: ap.overdue },
      ],
      citations: [{ label: 'AP Aging', href }],
      drilldownHref: href,
    };
  },
});

/** The allowlist. The model may ONLY select one of these ids. */
export const METRIC_CATALOG: Record<string, MetricEntry> = {
  [pnlSummary.id]: pnlSummary,
  [balanceSheetSummary.id]: balanceSheetSummary,
  [trialBalance.id]: trialBalance,
  [apAging.id]: apAging,
  [arAging.id]: arAging,
  [cashPosition.id]: cashPosition,
  // Expanded catalog — profitability, liquidity, efficiency, mix & trends.
  [grossMargin.id]: grossMargin,
  [netMargin.id]: netMargin,
  [currentRatio.id]: currentRatio,
  [daysSalesOutstanding.id]: daysSalesOutstanding,
  [daysPayableOutstanding.id]: daysPayableOutstanding,
  [cashRunway.id]: cashRunway,
  [revenueByDepartment.id]: revenueByDepartment,
  [expenseByDepartment.id]: expenseByDepartment,
  [topCustomersByReceivable.id]: topCustomersByReceivable,
  [topVendorsByPayable.id]: topVendorsByPayable,
  [revenueTrend.id]: revenueTrend,
  [expenseTrend.id]: expenseTrend,
  [overdueReceivables.id]: overdueReceivables,
  [overduePayables.id]: overduePayables,
};

export const METRIC_IDS = Object.keys(METRIC_CATALOG);

// ─────────────────────────────────────────────────────────────────────────────
// Classification: NL prompt → { metric, params } (validated) — no model SQL.
// ─────────────────────────────────────────────────────────────────────────────

/** Build the classifier prompt that constrains the model to the allowlist. */
export function buildClassifierPrompt(prompt: string): string {
  const menu = Object.values(METRIC_CATALOG)
    .map((m) => `- "${m.id}": ${m.description}\n    params: ${m.paramHint}`)
    .join('\n');

  return `You route a finance question to exactly ONE named metric from the allowlist below, or abstain.
You do NOT write SQL, table names, or code. You ONLY choose a metric id and fill its typed params.

ALLOWLISTED METRICS:
${menu}

USER QUESTION:
"""${prompt}"""

RULES:
- Choose the single best-fitting metric id from the list above.
- If the question does not clearly map to one of these metrics, or asks for data
  outside them (another company's data, arbitrary SQL, actions, anything not listed),
  set "metric" to "none".
- Fill only params that the user actually specified; omit the rest (defaults apply).
- Dates must be YYYY-MM-DD. location_id must be a UUID the user referenced; otherwise omit it.
- Never invent an org id, account number, table name, or SQL.

Respond with ONLY a JSON object, no markdown, no prose:
{ "metric": "<one of the ids above, or none>", "params": { }, "reasoning": "one short sentence" }`;
}

/** Parse the classifier's JSON text into a raw choice, tolerant of code fences. */
export function parseClassifierOutput(
  text: string,
): { metric: string; params: Record<string, unknown> } | null {
  const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  const metric = typeof parsed.metric === 'string' ? parsed.metric : '';
  const params =
    parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params)
      ? (parsed.params as Record<string, unknown>)
      : {};
  if (!metric) return null;
  return { metric, params };
}

export type ResolveMetricResult =
  | { ok: true; entry: MetricEntry; params: unknown }
  | { ok: false; reason: string };

/**
 * The safety gate. Accepts the model's chosen metric id + raw params and returns
 * an executable entry ONLY if (a) the id is in the allowlist and (b) the params
 * pass the entry's Zod schema. Otherwise it ABSTAINS — it never falls through to
 * arbitrary execution. This is what makes the lane injection-safe: an unknown
 * metric ("none", "all_orgs_revenue", "'; drop table") or malformed params can
 * never reach a query.
 */
export function resolveMetric(
  choice: { metric: string; params: Record<string, unknown> } | null,
): ResolveMetricResult {
  if (!choice) return { ok: false, reason: 'unparseable classification' };
  if (choice.metric === 'none') return { ok: false, reason: 'no matching metric' };
  const entry = METRIC_CATALOG[choice.metric];
  if (!entry) return { ok: false, reason: `unknown metric "${choice.metric}"` };
  const parsed = entry.paramsSchema.safeParse(choice.params ?? {});
  if (!parsed.success) return { ok: false, reason: 'parameters failed validation' };
  return { ok: true, entry, params: parsed.data };
}

/** The abstain answer — lists what the copilot CAN answer, never guesses a number. */
export function abstainMessage(): string {
  const list = Object.values(METRIC_CATALOG)
    .map((m) => `• ${m.title}`)
    .join('\n');
  return (
    "I can't answer that from the ledger. I can answer questions like these, scoped to your organization:\n" +
    list
  );
}
