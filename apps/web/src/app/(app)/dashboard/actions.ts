'use server';

import { createAuthedServerSupabase } from '@/lib/supabase/authed';

/**
 * Dashboard = the ONE consolidated, cross-company landing on the processing side.
 * On login a processor sees a status board for each of their companies, then
 * clicks into one (EnterCompany) to pin it and start working. These server
 * actions build that board from live, RLS-scoped ledger/queue state — never AI,
 * never a typed-in checklist. Every read runs through the authenticated user's
 * client, so the database (RLS) enforces tenant isolation; company scope here is
 * a sub-filter WITHIN the tenant, bucketed by `location_id`.
 *
 * Each source degrades independently: a failed sub-query drops to zero for that
 * signal rather than blanking the whole board. Only a failure to resolve the
 * company list itself yields an error state.
 */

// A tenant has a bounded number of companies (Merit: 17) and open work items;
// cap defensively so a runaway queue can't balloon the payload.
const ROW_CAP = 20000;

export type CardStatus = 'ok' | 'empty' | 'error';
export type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'NO_PERIOD';
export type CashStatus = 'HEALTHY' | 'ADEQUATE' | 'NEAR_MINIMUM' | 'BELOW_MINIMUM' | 'UNKNOWN';

export interface CompanyBoard {
  id: string;
  name: string;
  shortCode: string;
  /** Items waiting to be processed: pending bank txns + receipts + bills. */
  toReview: number;
  /** Items a human must look at now: flagged bank/receipts + on-hold bills. */
  needsAttention: number;
  /** Open AI proposals in the review queue (ai_decisions PROPOSED). */
  openExceptions: number;
  /** Unposted manual journal-entry drafts (gl_entries DRAFT). */
  draftJEs: number;
  /** Current-month fiscal period status for this company. */
  periodStatus: PeriodStatus;
  cashCents: number;
  cashStatus: CashStatus;
  openAPCents: number;
  openARCents: number;
  /** Total actionable items (toReview + needsAttention + openExceptions + draftJEs). */
  totalOpen: number;
}

export interface WorkboardConsolidated {
  companyCount: number;
  toReview: number;
  needsAttention: number;
  openExceptions: number;
  draftJEs: number;
  /** Org-wide money-movement approvals awaiting sign-off (not company-scoped). */
  pendingApprovals: number;
  cashCents: number;
  openAPCents: number;
  openARCents: number;
  /** Companies whose current-month period is hard-closed. */
  companiesClosed: number;
}

export interface Workboard {
  status: CardStatus;
  companies: CompanyBoard[];
  consolidated: WorkboardConsolidated;
}

const EMPTY_CONSOLIDATED: WorkboardConsolidated = {
  companyCount: 0,
  toReview: 0,
  needsAttention: 0,
  openExceptions: 0,
  draftJEs: 0,
  pendingApprovals: 0,
  cashCents: 0,
  openAPCents: 0,
  openARCents: 0,
  companiesClosed: 0,
};

interface LocationRow {
  id: string;
  name: string;
  short_code: string | null;
  minimum_cash_cents: number | null;
}

function tally(rows: Array<{ location_id: string | null }> | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows ?? []) {
    if (!r.location_id) continue;
    m.set(r.location_id, (m.get(r.location_id) ?? 0) + 1);
  }
  return m;
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function cashStatusFor(cashCents: number, minCashCents: number | null): CashStatus {
  if (!minCashCents || minCashCents <= 0) return 'UNKNOWN';
  const ratio = cashCents / minCashCents;
  if (ratio < 1) return 'BELOW_MINIMUM';
  if (ratio < 1.2) return 'NEAR_MINIMUM';
  if (ratio < 2) return 'ADEQUATE';
  return 'HEALTHY';
}

export async function getWorkboard(): Promise<Workboard> {
  const supabase = await createAuthedServerSupabase();
  if (!supabase) return { status: 'error', companies: [], consolidated: EMPTY_CONSOLIDATED };

  // Company list (locations live in `core`; the ledger/queue tables in `public`).
  // RLS scopes these to the caller's tenant.
  const { data: locData, error: locErr } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code, minimum_cash_cents')
    .eq('is_active', true)
    .order('name');

  if (locErr) return { status: 'error', companies: [], consolidated: EMPTY_CONSOLIDATED };
  const locations = (locData ?? []) as LocationRow[];
  if (locations.length === 0) return { status: 'empty', companies: [], consolidated: EMPTY_CONSOLIDATED };

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  // Fire every source in parallel. Each degrades to empty on error (see below), so
  // one broken queue never blanks the whole board.
  const [
    bankRes,
    receiptRes,
    billRes,
    invoiceRes,
    bankAcctRes,
    aiRes,
    jeRes,
    periodRes,
    approvalRes,
  ] = await Promise.all([
    supabase
      .from('bank_transactions')
      .select('location_id, status')
      .in('status', ['PENDING', 'CATEGORIZED', 'FLAGGED'])
      .limit(ROW_CAP),
    supabase
      .from('receipts')
      .select('location_id, status')
      .in('status', ['PENDING', 'CATEGORIZED', 'FLAGGED'])
      .limit(ROW_CAP),
    // Everything except voided bills: PENDING → to-review; ON_HOLD → attention;
    // balance on anything not yet PAID → open AP.
    supabase
      .from('bills')
      .select('location_id, status, balance_cents')
      .neq('status', 'VOIDED')
      .limit(ROW_CAP),
    // Open AR: outstanding balance on issued, unpaid invoices.
    supabase
      .from('invoices')
      .select('location_id, balance_cents')
      .not('status', 'in', '("PAID","VOIDED","DRAFT","WRITTEN_OFF")')
      .limit(ROW_CAP),
    supabase
      .from('bank_accounts')
      .select('location_id, current_balance_cents')
      .eq('is_active', true)
      .limit(ROW_CAP),
    supabase.from('ai_decisions').select('location_id').eq('status', 'PROPOSED').limit(ROW_CAP),
    supabase.from('gl_entries').select('location_id').eq('status', 'DRAFT').limit(ROW_CAP),
    supabase
      .from('fiscal_periods')
      .select('location_id, status')
      .eq('period_year', year)
      .eq('period_month', month),
    // Money-movement approvals are org-wide (no location_id); a consolidated count.
    supabase
      .from('approvals')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PENDING_APPROVAL'),
  ]);

  // ── Bucket per company ──────────────────────────────────────────────────────
  const bankRows = (bankRes.data ?? []) as Array<{ location_id: string | null; status: string }>;
  const receiptRows = (receiptRes.data ?? []) as Array<{ location_id: string | null; status: string }>;
  const billRows = (billRes.data ?? []) as Array<{
    location_id: string | null;
    status: string;
    balance_cents: number | string | null;
  }>;
  const invoiceRows = (invoiceRes.data ?? []) as Array<{
    location_id: string | null;
    balance_cents: number | string | null;
  }>;
  const bankAcctRows = (bankAcctRes.data ?? []) as Array<{
    location_id: string | null;
    current_balance_cents: number | string | null;
  }>;

  const toReview = new Map<string, number>();
  const attention = new Map<string, number>();

  const bump = (m: Map<string, number>, loc: string | null, by = 1) => {
    if (!loc) return;
    m.set(loc, (m.get(loc) ?? 0) + by);
  };

  for (const r of bankRows) {
    if (r.status === 'FLAGGED') bump(attention, r.location_id);
    else bump(toReview, r.location_id);
  }
  for (const r of receiptRows) {
    if (r.status === 'FLAGGED') bump(attention, r.location_id);
    else bump(toReview, r.location_id);
  }

  const openAP = new Map<string, number>();
  for (const b of billRows) {
    if (b.status === 'ON_HOLD') bump(attention, b.location_id);
    else if (b.status === 'PENDING') bump(toReview, b.location_id);
    if (b.status !== 'PAID' && b.location_id) {
      openAP.set(b.location_id, (openAP.get(b.location_id) ?? 0) + num(b.balance_cents));
    }
  }

  const openAR = new Map<string, number>();
  for (const inv of invoiceRows) {
    if (inv.location_id) {
      openAR.set(inv.location_id, (openAR.get(inv.location_id) ?? 0) + num(inv.balance_cents));
    }
  }

  const cash = new Map<string, number>();
  for (const a of bankAcctRows) {
    if (a.location_id) {
      cash.set(a.location_id, (cash.get(a.location_id) ?? 0) + num(a.current_balance_cents));
    }
  }

  const exceptions = tally(aiRes.data as Array<{ location_id: string | null }> | null);
  const draftJEs = tally(jeRes.data as Array<{ location_id: string | null }> | null);

  const periodByLoc = new Map<string, PeriodStatus>();
  for (const p of (periodRes.data ?? []) as Array<{ location_id: string; status: PeriodStatus }>) {
    periodByLoc.set(p.location_id, p.status);
  }

  // ── Compose per-company cards ───────────────────────────────────────────────
  const companies: CompanyBoard[] = locations.map((loc) => {
    const rev = toReview.get(loc.id) ?? 0;
    const att = attention.get(loc.id) ?? 0;
    const exc = exceptions.get(loc.id) ?? 0;
    const drafts = draftJEs.get(loc.id) ?? 0;
    const cashCents = cash.get(loc.id) ?? 0;
    return {
      id: loc.id,
      name: loc.name,
      shortCode: (loc.short_code || loc.name).slice(0, 4).toUpperCase(),
      toReview: rev,
      needsAttention: att,
      openExceptions: exc,
      draftJEs: drafts,
      periodStatus: periodByLoc.get(loc.id) ?? 'NO_PERIOD',
      cashCents,
      cashStatus: cashStatusFor(cashCents, loc.minimum_cash_cents),
      openAPCents: openAP.get(loc.id) ?? 0,
      openARCents: openAR.get(loc.id) ?? 0,
      totalOpen: rev + att + exc + drafts,
    };
  });

  // Worst-first: most work to do at the top so a processor starts where it matters.
  companies.sort(
    (a, b) =>
      b.needsAttention - a.needsAttention ||
      b.openExceptions - a.openExceptions ||
      b.totalOpen - a.totalOpen ||
      a.name.localeCompare(b.name),
  );

  const consolidated: WorkboardConsolidated = {
    companyCount: companies.length,
    toReview: companies.reduce((n, c) => n + c.toReview, 0),
    needsAttention: companies.reduce((n, c) => n + c.needsAttention, 0),
    openExceptions: companies.reduce((n, c) => n + c.openExceptions, 0),
    draftJEs: companies.reduce((n, c) => n + c.draftJEs, 0),
    pendingApprovals: approvalRes.count ?? 0,
    cashCents: companies.reduce((n, c) => n + c.cashCents, 0),
    openAPCents: companies.reduce((n, c) => n + c.openAPCents, 0),
    openARCents: companies.reduce((n, c) => n + c.openARCents, 0),
    companiesClosed: companies.filter((c) => c.periodStatus === 'HARD_CLOSE').length,
  };

  return { status: 'ok', companies, consolidated };
}

export interface RecentActivity {
  id: string;
  type: 'receipt' | 'bill' | 'bank_txn' | 'je' | 'approval';
  description: string;
  amount_cents: number | null;
  status: string;
  location_name: string | null;
  created_at: string;
  user_name: string | null;
}

export async function getRecentActivity(limit = 20): Promise<RecentActivity[]> {
  const supabase = await createAuthedServerSupabase();
  if (!supabase) return [];

  // NOTE: `locations` lives in the `core` schema (post core-carve) while
  // bank_transactions is in `public`, so a PostgREST embed (`locations(name)`)
  // fails with PGRST200 "no relationship found" — REST embeds don't cross the
  // public→core boundary here. Two-step instead: fetch the transactions, then
  // resolve location names from core.locations by id.
  const { data: txns } = await supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, status, created_at, location_id')
    .order('created_at', { ascending: false })
    .limit(limit);

  const rows = txns ?? [];
  const locIds = [...new Set(rows.map((t) => t.location_id).filter(Boolean))];
  let names: Record<string, string> = {};
  if (locIds.length) {
    const { data: locs } = await supabase
      .schema('core').from('locations')
      .select('id, name')
      .in('id', locIds);
    names = Object.fromEntries((locs ?? []).map((l) => [l.id as string, l.name as string]));
  }

  return rows.map((t) => ({
    id: t.id,
    type: 'bank_txn' as const,
    description: t.description,
    amount_cents: t.amount_cents,
    status: t.status,
    location_name: t.location_id ? names[t.location_id] ?? null : null,
    created_at: t.created_at,
    user_name: null,
  }));
}
