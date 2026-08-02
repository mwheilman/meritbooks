/**
 * SEARCH lane retrieval orchestrator (deterministic core).
 *
 * Read-only: every query is a `.select()` through the RLS-scoped Supabase client
 * the API route hands in (`ctx.supabase`), so org isolation is enforced at the
 * database and nothing here can write. All DB filters are built mechanically
 * from the deterministic parse (+ optional AI-supplied intent that is merged
 * into that same structure) — no model ever authors SQL or returns rows.
 *
 * Cross-schema names (vendor / customer, which live in `core`) are stitched in
 * JS via `fetchCoreMap` because PostgREST cannot embed `core` from `public`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import { fetchCoreMap } from '../stitch-core';
import { computeScore, deriveFieldMatches, type FieldValue } from './rank';
import { hasNoConstraint, isAmbiguous, parseQuery } from './parse';
import { aiParseIntent } from './ai-parse';
import {
  ALL_SEARCH_TYPES,
  TYPE_LABELS,
  type ParsedQuery,
  type SearchGroup,
  type SearchResponse,
  type SearchResult,
  type SearchType,
} from './types';

const FETCH_PER_TYPE = 25;
const MAX_PER_GROUP = 10;
const DEFAULT_LIMIT = 40;

export interface RunSearchArgs {
  supabase: SupabaseClient;
  orgId: string;
  userId: string | null;
  query: string;
  /** Optional caller-supplied type restriction. */
  types?: SearchType[];
  limit?: number;
  /** When present, ambiguous queries may be enriched via the Core AI gateway. */
  anthropicApiKey?: string | null;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/** Sanitize a term for safe interpolation into a PostgREST `.or()` filter. */
function sanitizeIlike(term: string): string {
  return term.replace(/[^a-z0-9 &.\-]/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** Build a comma-joined ILIKE OR clause across fields × needles, or null. */
function orIlike(fields: string[], needles: string[]): string | null {
  const clauses: string[] = [];
  for (const raw of needles) {
    const t = sanitizeIlike(raw);
    if (t.length < 2) continue;
    for (const f of fields) clauses.push(`${f}.ilike.*${t}*`);
  }
  return clauses.length > 0 ? clauses.join(',') : null;
}

/** Structural view of the PostgREST filter builder for date bounds. */
interface DateFilterable<T> {
  gte(col: string, value: string): T;
  lte(col: string, value: string): T;
}

function applyDate<T extends DateFilterable<T>>(q: T, col: string, parsed: ParsedQuery): T {
  const r = parsed.dateRange;
  if (!r) return q;
  let out = q;
  if (r.from) out = out.gte(col, r.from);
  if (r.to) out = out.lte(col, r.to);
  return out;
}

/** Amount `.or()` clause for a single positive column, or null. */
function amountOr(col: string, parsed: ParsedQuery, alsoNegative = false): string | null {
  const parts: string[] = [];
  for (const c of parsed.amounts.exact) {
    parts.push(`${col}.eq.${c}`);
    if (alsoNegative) parts.push(`${col}.eq.${-c}`);
  }
  return parts.length > 0 ? parts.join(',') : null;
}

function hasAmountExact(parsed: ParsedQuery): boolean {
  return parsed.amounts.exact.length > 0;
}

function needles(parsed: ParsedQuery): string[] {
  return [...parsed.numberTokens, ...parsed.terms];
}

function score(
  fields: FieldValue[],
  parsed: ParsedQuery,
  date: string | null,
  amountCents: number | null,
  nowMs: number,
): number {
  const fm = deriveFieldMatches(fields, parsed.terms, parsed.numberTokens);
  return computeScore({ fieldMatches: fm, date, amountCents, amounts: parsed.amounts, nowMs });
}

// ── Per-type retrieval ────────────────────────────────────────────────────────

async function searchBankTransactions(a: RunSearchArgs, parsed: ParsedQuery, nowMs: number): Promise<SearchResult[]> {
  const textOr = orIlike(['description', 'category', 'plaid_transaction_id'], needles(parsed));
  const amtOr = amountOr('amount_cents', parsed, true);
  if (!textOr && !amtOr && !parsed.dateRange) return [];

  let q = a.supabase
    .from('bank_transactions')
    .select('id, transaction_date, description, amount_cents, category, final_vendor_id, ai_vendor_id')
    .limit(FETCH_PER_TYPE);
  if (textOr) q = q.or(textOr);
  if (amtOr) q = q.or(amtOr);
  q = applyDate(q, 'transaction_date', parsed);

  const { data, error } = await q;
  if (error || !data) return [];

  const rows = data as Array<{
    id: string; transaction_date: string; description: string; amount_cents: number;
    category: string | null; final_vendor_id: string | null; ai_vendor_id: string | null;
  }>;
  const vendorMap = await fetchCoreMap<{ id: string; name: string }>(
    a.supabase, 'vendors', 'id, name',
    rows.flatMap((r) => [r.final_vendor_id, r.ai_vendor_id]),
  );

  return rows.map((r) => {
    const vendor = vendorMap.get(r.final_vendor_id ?? r.ai_vendor_id ?? '')?.name ?? null;
    const fields: FieldValue[] = [
      { field: 'description', value: r.description },
      { field: 'category', value: r.category },
      { field: 'name', value: vendor },
    ];
    return {
      type: 'bank_transaction' as const,
      id: r.id,
      title: r.description || 'Bank transaction',
      subtitle: `${formatMoney(r.amount_cents)} · ${r.transaction_date}${vendor ? ` · ${vendor}` : ''}`,
      amountCents: r.amount_cents,
      date: r.transaction_date,
      href: `/bank-feed?txn=${r.id}`,
      snippet: r.category ? `Category: ${r.category}` : '',
      score: score(fields, parsed, r.transaction_date, r.amount_cents, nowMs),
    };
  });
}

async function searchInvoices(a: RunSearchArgs, parsed: ParsedQuery, nowMs: number): Promise<SearchResult[]> {
  const textOr = orIlike(['invoice_number', 'memo'], needles(parsed));
  const amtOr = amountOr('total_cents', parsed);
  if (!textOr && !amtOr && !parsed.dateRange) return [];

  let q = a.supabase
    .from('invoices')
    .select('id, invoice_number, invoice_date, total_cents, balance_cents, status, memo, customer_id')
    .limit(FETCH_PER_TYPE);
  if (textOr) q = q.or(textOr);
  if (amtOr) q = q.or(amtOr);
  q = applyDate(q, 'invoice_date', parsed);

  const { data, error } = await q;
  if (error || !data) return [];

  const rows = data as Array<{
    id: string; invoice_number: string; invoice_date: string; total_cents: number;
    balance_cents: number; status: string; memo: string | null; customer_id: string;
  }>;
  const custMap = await fetchCoreMap<{ id: string; name: string }>(
    a.supabase, 'customers', 'id, name', rows.map((r) => r.customer_id),
  );

  return rows.map((r) => {
    const customer = custMap.get(r.customer_id)?.name ?? null;
    const fields: FieldValue[] = [
      { field: 'number', value: r.invoice_number },
      { field: 'memo', value: r.memo },
      { field: 'name', value: customer },
    ];
    return {
      type: 'invoice' as const,
      id: r.id,
      title: `Invoice ${r.invoice_number} · ${formatMoney(r.total_cents)}`,
      subtitle: `${customer ?? 'Customer'} · ${r.invoice_date} · ${r.status}`,
      amountCents: r.total_cents,
      date: r.invoice_date,
      href: `/invoices?invoice=${r.id}`,
      snippet: r.balance_cents > 0 ? `Balance ${formatMoney(r.balance_cents)}` : (r.memo ?? ''),
      score: score(fields, parsed, r.invoice_date, r.total_cents, nowMs),
    };
  });
}

async function searchBills(a: RunSearchArgs, parsed: ParsedQuery, nowMs: number): Promise<SearchResult[]> {
  const textOr = orIlike(['bill_number'], needles(parsed));
  const amtOr = amountOr('total_cents', parsed);
  if (!textOr && !amtOr && !parsed.dateRange) return [];

  let q = a.supabase
    .from('bills')
    .select('id, bill_number, bill_date, total_cents, balance_cents, status, vendor_id')
    .limit(FETCH_PER_TYPE);
  if (textOr) q = q.or(textOr);
  if (amtOr) q = q.or(amtOr);
  q = applyDate(q, 'bill_date', parsed);

  const { data, error } = await q;
  if (error || !data) return [];

  const rows = data as Array<{
    id: string; bill_number: string | null; bill_date: string; total_cents: number;
    balance_cents: number; status: string; vendor_id: string;
  }>;
  const vendorMap = await fetchCoreMap<{ id: string; name: string }>(
    a.supabase, 'vendors', 'id, name', rows.map((r) => r.vendor_id),
  );

  return rows.map((r) => {
    const vendor = vendorMap.get(r.vendor_id)?.name ?? null;
    const fields: FieldValue[] = [
      { field: 'number', value: r.bill_number },
      { field: 'name', value: vendor },
    ];
    return {
      type: 'bill' as const,
      id: r.id,
      title: `Bill ${r.bill_number ?? '(no #)'} · ${formatMoney(r.total_cents)}`,
      subtitle: `${vendor ?? 'Vendor'} · ${r.bill_date} · ${r.status}`,
      amountCents: r.total_cents,
      date: r.bill_date,
      href: `/bills?bill=${r.id}`,
      snippet: r.balance_cents > 0 ? `Balance ${formatMoney(r.balance_cents)}` : '',
      score: score(fields, parsed, r.bill_date, r.total_cents, nowMs),
    };
  });
}

async function searchJournalEntries(a: RunSearchArgs, parsed: ParsedQuery, nowMs: number): Promise<SearchResult[]> {
  const textOr = orIlike(['entry_number', 'memo', 'source_module'], needles(parsed));
  const wantAmount = hasAmountExact(parsed);
  if (!textOr && !wantAmount && !parsed.dateRange) return [];

  const entryIds = new Set<string>();

  // Text / date branch on the header.
  if (textOr || parsed.dateRange) {
    let q = a.supabase
      .from('gl_entries')
      .select('id, entry_number, entry_date, memo, source_module, status')
      .limit(FETCH_PER_TYPE);
    if (textOr) q = q.or(textOr);
    q = applyDate(q, 'entry_date', parsed);
    const { data } = await q;
    for (const r of (data ?? []) as Array<{ id: string }>) entryIds.add(r.id);
  }

  // Amount branch on the lines (JE totals live on gl_entry_lines).
  if (wantAmount) {
    const amtOr = [
      ...parsed.amounts.exact.map((c) => `debit_cents.eq.${c}`),
      ...parsed.amounts.exact.map((c) => `credit_cents.eq.${c}`),
    ].join(',');
    let lq = a.supabase.from('gl_entry_lines').select('gl_entry_id').limit(FETCH_PER_TYPE);
    lq = lq.or(amtOr);
    const { data } = await lq;
    for (const r of (data ?? []) as Array<{ gl_entry_id: string }>) entryIds.add(r.gl_entry_id);
  }

  if (entryIds.size === 0) return [];
  const ids = Array.from(entryIds).slice(0, FETCH_PER_TYPE);

  const { data: entries } = await a.supabase
    .from('gl_entries')
    .select('id, entry_number, entry_date, memo, source_module, status')
    .in('id', ids);
  if (!entries) return [];

  // One batched lines query to compute each entry's debit total for display.
  const { data: lines } = await a.supabase
    .from('gl_entry_lines')
    .select('gl_entry_id, debit_cents')
    .in('gl_entry_id', ids);
  const totals = new Map<string, number>();
  for (const l of (lines ?? []) as Array<{ gl_entry_id: string; debit_cents: number }>) {
    totals.set(l.gl_entry_id, (totals.get(l.gl_entry_id) ?? 0) + Number(l.debit_cents));
  }

  return (entries as Array<{
    id: string; entry_number: string; entry_date: string; memo: string | null;
    source_module: string | null; status: string;
  }>).map((r) => {
    const total = totals.get(r.id) ?? null;
    const fields: FieldValue[] = [
      { field: 'number', value: r.entry_number },
      { field: 'memo', value: r.memo },
      { field: 'category', value: r.source_module },
    ];
    return {
      type: 'journal_entry' as const,
      id: r.id,
      title: `JE ${r.entry_number}${total != null ? ` · ${formatMoney(total)}` : ''}`,
      subtitle: `${r.entry_date} · ${r.status}${r.source_module ? ` · ${r.source_module}` : ''}`,
      amountCents: total,
      date: r.entry_date,
      href: `/journal-entries?entry=${r.id}`,
      snippet: r.memo ?? '',
      score: score(fields, parsed, r.entry_date, total, nowMs),
    };
  });
}

async function searchVendors(a: RunSearchArgs, parsed: ParsedQuery, nowMs: number): Promise<SearchResult[]> {
  const textOr = orIlike(['name', 'display_name', 'email', 'city'], needles(parsed));
  if (!textOr) return []; // masters have no amount/date anchor
  const { data, error } = await a.supabase
    .schema('core')
    .from('vendors')
    .select('id, name, display_name, email, city, state, ytd_spend_cents')
    .or(textOr)
    .limit(FETCH_PER_TYPE);
  if (error || !data) return [];

  return (data as Array<{
    id: string; name: string; display_name: string | null; email: string | null;
    city: string | null; state: string | null; ytd_spend_cents: number | null;
  }>).map((r) => {
    const fields: FieldValue[] = [
      { field: 'name', value: r.name },
      { field: 'name', value: r.display_name },
      { field: 'other', value: r.email },
      { field: 'other', value: r.city },
    ];
    const loc = [r.city, r.state].filter(Boolean).join(', ');
    return {
      type: 'vendor' as const,
      id: r.id,
      title: r.display_name || r.name,
      subtitle: `Vendor${loc ? ` · ${loc}` : ''}${r.ytd_spend_cents ? ` · YTD ${formatMoney(r.ytd_spend_cents)}` : ''}`,
      amountCents: r.ytd_spend_cents ?? null,
      date: null,
      href: `/vendors?vendor=${r.id}`,
      snippet: r.email ?? '',
      score: score(fields, parsed, null, null, nowMs),
    };
  });
}

async function searchCustomers(a: RunSearchArgs, parsed: ParsedQuery, nowMs: number): Promise<SearchResult[]> {
  const textOr = orIlike(['name', 'email', 'city'], needles(parsed));
  if (!textOr) return [];
  const { data, error } = await a.supabase
    .schema('core')
    .from('customers')
    .select('id, name, email, city, state')
    .or(textOr)
    .limit(FETCH_PER_TYPE);
  if (error || !data) return [];

  return (data as Array<{ id: string; name: string; email: string | null; city: string | null; state: string | null }>).map((r) => {
    const fields: FieldValue[] = [
      { field: 'name', value: r.name },
      { field: 'other', value: r.email },
      { field: 'other', value: r.city },
    ];
    const loc = [r.city, r.state].filter(Boolean).join(', ');
    return {
      type: 'customer' as const,
      id: r.id,
      title: r.name,
      subtitle: `Customer${loc ? ` · ${loc}` : ''}`,
      amountCents: null,
      date: null,
      href: `/customers?customer=${r.id}`,
      snippet: r.email ?? '',
      score: score(fields, parsed, null, null, nowMs),
    };
  });
}

async function searchAccounts(a: RunSearchArgs, parsed: ParsedQuery, nowMs: number): Promise<SearchResult[]> {
  const textOr = orIlike(['name', 'account_number', 'description'], needles(parsed));
  if (!textOr) return [];
  const { data, error } = await a.supabase
    .from('accounts')
    .select('id, account_number, name, description, account_type, is_active')
    .or(textOr)
    .limit(FETCH_PER_TYPE);
  if (error || !data) return [];

  return (data as Array<{
    id: string; account_number: string; name: string; description: string | null;
    account_type: string; is_active: boolean;
  }>).map((r) => {
    const fields: FieldValue[] = [
      { field: 'number', value: r.account_number },
      { field: 'name', value: r.name },
      { field: 'description', value: r.description },
    ];
    return {
      type: 'account' as const,
      id: r.id,
      title: `${r.account_number} · ${r.name}`,
      subtitle: `${r.account_type}${r.is_active ? '' : ' · inactive'}`,
      amountCents: null,
      date: null,
      href: `/chart-of-accounts?account=${r.id}`,
      snippet: r.description ?? '',
      score: score(fields, parsed, null, null, nowMs),
    };
  });
}

const RETRIEVERS: Record<SearchType, (a: RunSearchArgs, p: ParsedQuery, nowMs: number) => Promise<SearchResult[]>> = {
  journal_entry: searchJournalEntries,
  bank_transaction: searchBankTransactions,
  invoice: searchInvoices,
  bill: searchBills,
  vendor: searchVendors,
  customer: searchCustomers,
  account: searchAccounts,
};

/** Merge AI-supplied intent into the deterministic parse (fill gaps only). */
function mergeAiIntent(parsed: ParsedQuery, ai: NonNullable<Awaited<ReturnType<typeof aiParseIntent>>>): ParsedQuery {
  const terms = [...parsed.terms];
  for (const t of ai.terms) if (!terms.includes(t)) terms.push(t);
  const exact = [...parsed.amounts.exact];
  for (const d of ai.amountsDollars) {
    const c = Math.round(d * 100);
    if (!exact.includes(c)) exact.push(c);
  }
  const dateRange = parsed.dateRange ?? (ai.dateFrom || ai.dateTo ? { from: ai.dateFrom, to: ai.dateTo } : null);
  const types = parsed.types ?? ai.types;
  return { ...parsed, terms, amounts: { ...parsed.amounts, exact }, dateRange, types };
}

/**
 * Run a full search: parse → (optional AI intent) → deterministic retrieval
 * across the selected object types → field-weighted ranking → grouped results.
 */
export async function runSearch(args: RunSearchArgs): Promise<SearchResponse> {
  const now = args.now ?? new Date();
  const nowMs = now.getTime();
  let parsed = parseQuery(args.query, now);
  let aiAssisted = false;

  if (isAmbiguous(parsed) && args.anthropicApiKey) {
    const ai = await aiParseIntent({
      supabase: args.supabase,
      anthropicApiKey: args.anthropicApiKey,
      orgId: args.orgId,
      userId: args.userId,
      query: parsed.raw,
    });
    if (ai) {
      parsed = mergeAiIntent(parsed, ai);
      aiAssisted = true;
    }
  }

  const emptyResponse = (): SearchResponse => ({
    query: parsed.raw,
    parsed: {
      terms: parsed.terms,
      numberTokens: parsed.numberTokens,
      amounts: parsed.amounts,
      dateRange: parsed.dateRange,
      types: parsed.types,
    },
    groups: [],
    total: 0,
    aiAssisted,
  });

  if (hasNoConstraint(parsed)) return emptyResponse();

  // Effective type set: caller restriction ∩ parsed hint, else parsed hint, else all.
  let effective: SearchType[] = [...ALL_SEARCH_TYPES];
  if (parsed.types) effective = effective.filter((t) => parsed.types!.includes(t));
  if (args.types && args.types.length > 0) effective = effective.filter((t) => args.types!.includes(t));
  if (effective.length === 0) effective = args.types && args.types.length > 0 ? [...args.types] : [...ALL_SEARCH_TYPES];

  const perType = await Promise.all(effective.map((t) => RETRIEVERS[t](args, parsed, nowMs)));

  const groups: SearchGroup[] = [];
  let total = 0;
  effective.forEach((t, i) => {
    const results = perType[i]
      .filter((r) => r.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, MAX_PER_GROUP);
    if (results.length > 0) {
      groups.push({ type: t, label: TYPE_LABELS[t], results });
      total += results.length;
    }
  });

  // Order groups by their best hit's score so the strongest lane leads.
  groups.sort((a, b) => (b.results[0]?.score ?? 0) - (a.results[0]?.score ?? 0));

  const limit = args.limit ?? DEFAULT_LIMIT;
  if (total > limit) {
    let remaining = limit;
    for (const g of groups) {
      if (remaining <= 0) { g.results = []; continue; }
      if (g.results.length > remaining) g.results = g.results.slice(0, remaining);
      remaining -= g.results.length;
    }
    total = groups.reduce((s, g) => s + g.results.length, 0);
  }

  return {
    query: parsed.raw,
    parsed: {
      terms: parsed.terms,
      numberTokens: parsed.numberTokens,
      amounts: parsed.amounts,
      dateRange: parsed.dateRange,
      types: parsed.types,
    },
    groups: groups.filter((g) => g.results.length > 0),
    total,
    aiAssisted,
  };
}
