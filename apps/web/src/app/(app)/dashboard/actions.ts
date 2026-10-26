'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { fetchBookCash } from '@/lib/cash/book-cash';
import { fetchControlBalances } from '@/lib/reports/control-balances';
import { getOrgToday } from '@/lib/dates/org-today';
import { loadClientScope } from '@/lib/rbac/client-scope';
import {
  countNeedsAttention,
  countsForLocation,
  emptyCounts,
  type LaneCounts,
  type LocationCounts,
  type NeedsAttentionCounts,
} from '@/lib/work/needs-attention';

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
 *
 * EVERYTHING "WAITING ON YOU" (approvals, exceptions/AI proposals, alerts, drafts,
 * flagged lines) comes from lib/work/needs-attention — the same counting service the
 * Inbox tabs and the rail badge use, with the same client scope — so the home can
 * never say "Nothing waiting" while the Inbox says 100+. Only the to-review feed
 * (unflagged open bank lines, receipts, bills) and the money figures are read here.
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
  /** core.locations.is_tenant_own_books — the tenant's own books (Electric own-books shell). */
  isOwnBooks: boolean;
  /** Items waiting to be processed: pending bank txns + receipts + bills. */
  toReview: number;
  /** Items a human must look at now: flagged bank lines/receipts + bills on hold (shared service). */
  needsAttention: number;
  /** Open AI proposals (shared service — the Exceptions tab's AI rows). */
  openExceptions: number;
  /** Unposted manual journal entries (shared service — the Drafts tab). */
  draftJEs: number;
  /** This client's Inbox lanes — identical to its Inbox tab counts. */
  lanes: LaneCounts;
  /** This client's Inbox total (= the rail badge when the client is active). */
  needsYou: number;
  /** Current-month fiscal period status for this company. */
  periodStatus: PeriodStatus;
  /** CANONICAL book cash (lib/cash/book-cash) as of today in the org's timezone. */
  cashCents: number;
  cashStatus: CashStatus;
  /** Payables / receivables — the AP / AR CONTROL balances per the GL (lib/reports/control-balances), as of today. */
  openAPCents: number;
  openARCents: number;
  /** The open-item subledgers behind them (unpaid bills / issued unpaid invoices). */
  subledgerAPCents: number;
  subledgerARCents: number;
  /** Total actionable items (toReview + everything in the Inbox). */
  totalOpen: number;
}

/** Board figures for one client, from the shared needs-attention counts. */
function workFigures(c: LocationCounts): Pick<CompanyBoard, 'needsAttention' | 'openExceptions' | 'draftJEs' | 'lanes' | 'needsYou'> {
  return {
    needsAttention: c.sources.bank + c.sources.receipt + c.sources.bill_hold,
    openExceptions: c.sources.ai_proposal,
    draftJEs: c.lanes.drafts,
    lanes: c.lanes,
    needsYou: c.total,
  };
}

/**
 * The shared needs-attention counts for a scope (null = all clients). Degrades to
 * zeros (and `degraded: ['needs_attention']`) rather than blanking the home.
 */
async function loadWork(
  supabase: SupabaseClient,
  locationId: string | null,
  asOf: string,
): Promise<{ counts: NeedsAttentionCounts; degraded: string[] }> {
  try {
    const state = await loadClientScope({ supabase });
    const r = await countNeedsAttention(supabase, { scope: { locationId, state }, asOf });
    return { counts: r.counts, degraded: r.degraded };
  } catch (e) {
    console.error('[dashboard] needs-attention degraded:', e instanceof Error ? e.message : e);
    return { counts: emptyCounts(), degraded: ['needs_attention'] };
  }
}

export interface WorkboardConsolidated {
  companyCount: number;
  toReview: number;
  needsAttention: number;
  openExceptions: number;
  draftJEs: number;
  /** Approvals lane across every client + organization-level items. */
  pendingApprovals: number;
  /** The Inbox (all clients) lanes and total — identical to the Inbox tabs + rail badge. */
  lanes: LaneCounts;
  needsYou: number;
  cashCents: number;
  /** GL control balances (see CompanyBoard). */
  openAPCents: number;
  openARCents: number;
  subledgerAPCents: number;
  subledgerARCents: number;
  /** Companies whose current-month period is hard-closed. */
  companiesClosed: number;
}

export interface Workboard {
  status: CardStatus;
  companies: CompanyBoard[];
  consolidated: WorkboardConsolidated;
  /** The org-calendar date the board is "as of" (YYYY-MM-DD); '' when unknown. */
  today: string;
}

const EMPTY_CONSOLIDATED: WorkboardConsolidated = {
  companyCount: 0,
  toReview: 0,
  needsAttention: 0,
  openExceptions: 0,
  draftJEs: 0,
  pendingApprovals: 0,
  lanes: { approvals: 0, exceptions: 0, alerts: 0, drafts: 0 },
  needsYou: 0,
  cashCents: 0,
  openAPCents: 0,
  openARCents: 0,
  subledgerAPCents: 0,
  subledgerARCents: 0,
  companiesClosed: 0,
};

interface LocationRow {
  id: string;
  name: string;
  short_code: string | null;
  minimum_cash_cents: number | null;
  is_tenant_own_books: boolean | null;
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
  if (!supabase) return { status: 'error', companies: [], consolidated: EMPTY_CONSOLIDATED, today: '' };

  // Company list (locations live in `core`; the ledger/queue tables in `public`).
  // RLS scopes these to the caller's tenant.
  const { data: locData, error: locErr } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code, minimum_cash_cents, is_tenant_own_books')
    .eq('is_active', true)
    .order('name');

  if (locErr) return { status: 'error', companies: [], consolidated: EMPTY_CONSOLIDATED, today: '' };
  const locations = (locData ?? []) as LocationRow[];
  if (locations.length === 0) return { status: 'empty', companies: [], consolidated: EMPTY_CONSOLIDATED, today: '' };

  // "Now" is the ORG's calendar date (core.organizations.timezone), not UTC.
  const today = await getOrgToday(supabase, null);
  const [year, month] = today.split('-').map(Number);

  // Fire every source in parallel. Each degrades to empty on error (see below), so
  // one broken queue never blanks the whole board.
  const [bankRes, receiptRes, billRes, invoiceRes, bookCash, periodRes, work, control] = await Promise.all([
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
    // Cash = the CANONICAL book cash (posted GL, bank/cash-role accounts), not
    // bank-feed balances — the same figure every other surface shows (audit L6).
    fetchBookCash(supabase, null, { asOfDate: today }).catch(() => null),
    supabase
      .from('fiscal_periods')
      .select('location_id, status')
      .eq('period_year', year)
      .eq('period_month', month),
    // Everything waiting on a human — the SAME service + scope as the Inbox (all clients).
    loadWork(supabase, null, today),
    // Receivables / payables = the GL control balances (the balance-sheet figures).
    fetchControlBalances(supabase, null, { asOfDate: today }).catch(() => null),
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

  const toReview = new Map<string, number>();

  const bump = (m: Map<string, number>, loc: string | null, by = 1) => {
    if (!loc) return;
    m.set(loc, (m.get(loc) ?? 0) + by);
  };

  // FLAGGED lines and ON_HOLD bills are "needs you" — counted by the shared service.
  for (const r of bankRows) {
    if (r.status !== 'FLAGGED') bump(toReview, r.location_id);
  }
  for (const r of receiptRows) {
    if (r.status !== 'FLAGGED') bump(toReview, r.location_id);
  }

  const openAP = new Map<string, number>();
  for (const b of billRows) {
    if (b.status === 'PENDING') bump(toReview, b.location_id);
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

  const cash = new Map<string, number>(Object.entries(bookCash?.byLocation ?? {}));


  const periodByLoc = new Map<string, PeriodStatus>();
  for (const p of (periodRes.data ?? []) as Array<{ location_id: string; status: PeriodStatus }>) {
    periodByLoc.set(p.location_id, p.status);
  }

  // ── Compose per-company cards ───────────────────────────────────────────────
  const companies: CompanyBoard[] = locations.map((loc) => {
    const rev = toReview.get(loc.id) ?? 0;
    const w = workFigures(countsForLocation(work.counts, loc.id));
    const cashCents = cash.get(loc.id) ?? 0;
    return {
      id: loc.id,
      name: loc.name,
      shortCode: (loc.short_code || loc.name).slice(0, 4).toUpperCase(),
      isOwnBooks: loc.is_tenant_own_books === true,
      toReview: rev,
      ...w,
      periodStatus: periodByLoc.get(loc.id) ?? 'NO_PERIOD',
      cashCents,
      cashStatus: cashStatusFor(cashCents, loc.minimum_cash_cents),
      openAPCents: control ? control.byLocation[loc.id]?.apCents ?? 0 : openAP.get(loc.id) ?? 0,
      openARCents: control ? control.byLocation[loc.id]?.arCents ?? 0 : openAR.get(loc.id) ?? 0,
      subledgerAPCents: openAP.get(loc.id) ?? 0,
      subledgerARCents: openAR.get(loc.id) ?? 0,
      totalOpen: rev + w.needsYou,
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
    // All-clients Inbox figures straight from the shared service — they include
    // organization-level items (e.g. an approval with no client, a loan file), which
    // is why they are not a sum over the client rows.
    needsAttention: work.counts.bySource.bank + work.counts.bySource.receipt + work.counts.bySource.bill_hold,
    openExceptions: work.counts.bySource.ai_proposal,
    draftJEs: work.counts.byLane.drafts,
    pendingApprovals: work.counts.byLane.approvals,
    lanes: work.counts.byLane,
    needsYou: work.counts.total,
    cashCents: companies.reduce((n, c) => n + c.cashCents, 0),
    openAPCents: companies.reduce((n, c) => n + c.openAPCents, 0),
    openARCents: companies.reduce((n, c) => n + c.openARCents, 0),
    subledgerAPCents: companies.reduce((n, c) => n + c.subledgerAPCents, 0),
    subledgerARCents: companies.reduce((n, c) => n + c.subledgerARCents, 0),
    companiesClosed: companies.filter((c) => c.periodStatus === 'HARD_CLOSE').length,
  };

  return { status: 'ok', companies, consolidated, today };
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

export async function getRecentActivity(limit = 20, locationId?: string | null): Promise<RecentActivity[]> {
  const supabase = await createAuthedServerSupabase();
  if (!supabase) return [];

  // NOTE: `locations` lives in the `core` schema (post core-carve) while
  // bank_transactions is in `public`, so a PostgREST embed (`locations(name)`)
  // fails with PGRST200 "no relationship found" — REST embeds don't cross the
  // public→core boundary here. Two-step instead: fetch the transactions, then
  // resolve location names from core.locations by id.
  let txnQuery = supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, status, created_at, location_id')
    .order('created_at', { ascending: false })
    .limit(limit);
  // A client home shows only that client's feed (a sub-filter within RLS).
  if (locationId) txnQuery = txnQuery.eq('location_id', locationId);
  const { data: txns } = await txnQuery;

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

// ── Client home (one client's books-review loop) ────────────────────────────────

/** One open bank/card line, for the client home's "Decide" list. */
export interface ClientQueueItem {
  id: string;
  date: string;
  description: string;
  amountCents: number;
  status: 'PENDING' | 'CATEGORIZED' | 'FLAGGED';
  /** 0–100, or null when the AI hasn't scored it yet. */
  confidence: number | null;
}

/** IA-SPEC §6.1 confidence bands over the client's open feed. */
export interface ConfidenceBand {
  count: number;
  amountCents: number;
}

export interface ClientHome {
  status: CardStatus;
  /** The same per-client figures the workspace board shows, for this client only. */
  board: CompanyBoard | null;
  bands: { decide: ConfidenceBand; check: ConfidenceBand; ready: ConfidenceBand };
  /** Decide band, lowest confidence first (FLAGGED and unscored lead). */
  decide: ClientQueueItem[];
  /** This client's Approvals tab count (shared service). */
  pendingApprovals: number;
  /** This client's Inbox counts — the same numbers its Inbox tabs and the rail show. */
  work: LocationCounts;
  /** Shared-service sources that didn't answer (shown as a quiet notice). */
  workDegraded: string[];
  /** The org-calendar date the figures are "as of" (YYYY-MM-DD). */
  today: string;
}

const EMPTY_BANDS = { decide: { count: 0, amountCents: 0 }, check: { count: 0, amountCents: 0 }, ready: { count: 0, amountCents: 0 } };

/** Decide < 70 (or flagged, or unscored) · Check 70–89 · Ready 90+ — the bank-feed bands. */
function bandOf(status: string, confidence: number | null): 'decide' | 'check' | 'ready' {
  if (status === 'FLAGGED' || confidence === null || confidence < 70) return 'decide';
  if (confidence < 90) return 'check';
  return 'ready';
}

/**
 * The client home for ONE client: the workboard figures filtered to that client,
 * plus its open bank/card feed split into the Decide / Check / Ready bands with
 * the Decide list itself. Every read is RLS-scoped through the caller's client and
 * sub-filtered by location_id; each source degrades on its own.
 */
export async function getClientHome(locationId: string): Promise<ClientHome> {
  const fail = (today: string): ClientHome => ({
    status: 'error',
    board: null,
    bands: EMPTY_BANDS,
    decide: [],
    pendingApprovals: 0,
    work: countsForLocation(emptyCounts(), locationId),
    workDegraded: [],
    today,
  });
  const supabase = await createAuthedServerSupabase();
  if (!supabase) return fail('');

  const { data: loc, error: locErr } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code, minimum_cash_cents, is_tenant_own_books')
    .eq('id', locationId)
    .maybeSingle();
  const today = await getOrgToday(supabase, null);
  if (locErr || !loc) return fail(today);
  const location = loc as LocationRow;
  const [year, month] = today.split('-').map(Number);

  const [bankRes, receiptRes, billRes, invoiceRes, bookCash, periodRes, workRes, control] = await Promise.all([
    fetchAll(
      () =>
        supabase
          .from('bank_transactions')
          .select('id, transaction_date, description, amount_cents, status, ai_confidence')
          .eq('location_id', locationId)
          .in('status', ['PENDING', 'CATEGORIZED', 'FLAGGED']),
      { label: 'client home open bank_transactions' },
    ),
    supabase.from('receipts').select('id, status').eq('location_id', locationId).in('status', ['PENDING', 'CATEGORIZED', 'FLAGGED']).limit(ROW_CAP),
    supabase.from('bills').select('status, balance_cents').eq('location_id', locationId).neq('status', 'VOIDED').limit(ROW_CAP),
    supabase
      .from('invoices')
      .select('balance_cents')
      .eq('location_id', locationId)
      .not('status', 'in', '("PAID","VOIDED","DRAFT","WRITTEN_OFF")')
      .limit(ROW_CAP),
    fetchBookCash(supabase, null, { asOfDate: today, locationIds: [locationId] }).catch(() => null),
    supabase.from('fiscal_periods').select('status').eq('location_id', locationId).eq('period_year', year).eq('period_month', month).maybeSingle(),
    // Everything waiting on a human for THIS client — the same service + scope as its Inbox.
    loadWork(supabase, locationId, today),
    fetchControlBalances(supabase, null, { asOfDate: today, locationIds: [locationId] }).catch(() => null),
  ]);
  const work = countsForLocation(workRes.counts, locationId);
  const w = workFigures(work);

  type BankRow = { id: string; transaction_date: string; description: string; amount_cents: number | string; status: string; ai_confidence: number | string | null };
  const bankRows = (bankRes.data ?? []) as BankRow[];
  const bands = { decide: { count: 0, amountCents: 0 }, check: { count: 0, amountCents: 0 }, ready: { count: 0, amountCents: 0 } };
  const decide: ClientQueueItem[] = [];
  let bankReview = 0;
  for (const r of bankRows) {
    const conf = r.ai_confidence === null || r.ai_confidence === undefined ? null : Math.round(Number(r.ai_confidence) * 100);
    const cents = num(r.amount_cents);
    const band = bandOf(r.status, conf);
    bands[band].count += 1;
    bands[band].amountCents += cents;
    if (r.status !== 'FLAGGED') bankReview += 1;
    if (band === 'decide') {
      decide.push({
        id: r.id,
        date: r.transaction_date,
        description: r.description,
        amountCents: cents,
        status: r.status as ClientQueueItem['status'],
        confidence: conf,
      });
    }
  }
  // Flagged first, then unscored, then lowest confidence; oldest first within a tie.
  decide.sort(
    (a, b) =>
      Number(b.status === 'FLAGGED') - Number(a.status === 'FLAGGED') ||
      (a.confidence ?? -1) - (b.confidence ?? -1) ||
      a.date.localeCompare(b.date),
  );

  const receiptRows = (receiptRes.data ?? []) as Array<{ status: string }>;
  const billRows = (billRes.data ?? []) as Array<{ status: string; balance_cents: number | string | null }>;
  // FLAGGED lines and ON_HOLD bills are "needs you" — counted by the shared service.
  let review = bankReview;
  for (const r of receiptRows) {
    if (r.status !== 'FLAGGED') review += 1;
  }
  let openAP = 0;
  for (const b of billRows) {
    if (b.status === 'PENDING') review += 1;
    if (b.status !== 'PAID') openAP += num(b.balance_cents);
  }
  const openAR = ((invoiceRes.data ?? []) as Array<{ balance_cents: number | string | null }>).reduce((n, i) => n + num(i.balance_cents), 0);
  const cashCents = num(bookCash?.byLocation?.[locationId]);
  const status = (periodRes.data as { status?: PeriodStatus } | null)?.status;

  const board: CompanyBoard = {
    id: location.id,
    name: location.name,
    shortCode: (location.short_code || location.name).slice(0, 4).toUpperCase(),
    isOwnBooks: location.is_tenant_own_books === true,
    toReview: review,
    ...w,
    periodStatus: status ?? 'NO_PERIOD',
    cashCents,
    cashStatus: cashStatusFor(cashCents, location.minimum_cash_cents),
    openAPCents: control ? control.apCents : openAP,
    openARCents: control ? control.arCents : openAR,
    subledgerAPCents: openAP,
    subledgerARCents: openAR,
    totalOpen: review + w.needsYou,
  };

  return {
    status: 'ok',
    board,
    bands,
    decide: decide.slice(0, 8),
    pendingApprovals: work.lanes.approvals,
    work,
    workDegraded: workRes.degraded,
    today,
  };
}
