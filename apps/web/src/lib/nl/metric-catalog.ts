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
    // Tolerate an unseeded role — it simply contributes nothing.
    const roleKeys = ['OPERATING_BANK', 'CASH_ON_HAND'] as const;
    const accountIds: string[] = [];
    for (const role of roleKeys) {
      try {
        const ref = await resolveRole(ctx.supabase, ctx.orgId, role, params.location_id);
        if (ref?.id) accountIds.push(ref.id);
      } catch (e) {
        if (!(e instanceof PostingError)) throw e;
      }
    }
    if (accountIds.length === 0) {
      const href = reportHref('cash-flow', { location_id: params.location_id });
      return {
        answer:
          'No operating-bank or cash-on-hand account is mapped for this entity, so a cash position ' +
          'cannot be computed. Map the cash roles on the Account Roles screen.',
        rows: [],
        citations: [{ label: 'Cash Flow', href }],
        drilldownHref: href,
      };
    }

    let query = ctx.supabase
      .from('v_trial_balance')
      .select('account_number, account_name, net_balance, account_id')
      .in('account_id', accountIds);
    if (params.location_id) query = query.eq('location_id', params.location_id);
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
    const totalCash = rows.reduce((s, r) => s + r.balanceCents, 0);
    const href = reportHref('cash-flow', { location_id: params.location_id });
    const answer = `Current cash on hand is ${formatMoney(totalCash)} across ${rows.length} cash/bank account${
      rows.length === 1 ? '' : 's'
    }.`;
    return {
      answer,
      rows,
      citations: [{ label: 'Cash Flow', href }],
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
