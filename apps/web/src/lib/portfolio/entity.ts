/**
 * Per-entity portfolio snapshot — the drill-in behind the portfolio board.
 *
 * From the cross-entity board (lib/portfolio/board.ts) an operator picks ONE
 * company (a `core.locations` row) and drills into a compact, tie-out-honest
 * snapshot for a fiscal month:
 *   • a mini P&L — revenue, gross profit, net income for the period, each with a
 *     prior-period delta, plus gross/net margins;
 *   • key balance-sheet lines — cash, AR, AP and equity as of period end;
 *   • close status — period state, HARD_CLOSE readiness and the named blockers;
 *   • top open items — the largest overdue AR / AP and the newest open exceptions.
 *
 * It REUSES the existing engines rather than recomputing statements:
 *   • P&L + BS roll-up ....... the PURE `consolidate()` engine (lib/consolidation),
 *     which is the same income-statement / balance-sheet math the consolidated
 *     report runs. A single entity consolidates to itself (FULL / 100%), so the
 *     totals ARE that entity's statements. A thin single-location trial-balance
 *     loader feeds it natural-balance cents (P&L within the period, BS cumulative
 *     through period end — the same treatment as lib/consolidation/load.ts).
 *   • cash / AR / AP lines ... resolved BY ROLE (`resolveRole`), never by hardcoded
 *     account number (canon: reference accounts by role) — degrade-safe if unmapped.
 *   • close + exceptions ..... `gatherHardCloseGate` (lib/close/readiness), the same
 *     signal set the Close Command Center scores.
 *   • overdue AR / AP ........ `v_ar_aging` / `v_ap_aging` (aging_bucket <> CURRENT).
 *   • open exceptions ........ `ai_decisions` status='PROPOSED' for the entity.
 *
 * Everything runs through the RLS-scoped client, so tenant isolation is enforced by
 * the database. All money is bigint cents. Read-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  consolidate,
  DEBIT_NORMAL_TYPES,
  type AccountType,
  type EntityAccountBalance,
} from '@/lib/consolidation/consolidate';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import { gatherHardCloseGate, type BoardPeriodStatus } from '@/lib/close/readiness';

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const pad2 = (n: number): string => String(n).padStart(2, '0');
const ROW_CAP = 500;
const PAGE = 1000;
const MAX_LINES = 200_000; // hard safety bound on a single-entity line scan

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/** A current figure with its prior-period comparison. */
export interface PeriodDelta {
  currentCents: number;
  priorCents: number;
  deltaCents: number;
  /** null when the prior figure is zero (division undefined). */
  deltaPct: number | null;
}

export interface EntityPnl {
  revenue: PeriodDelta;
  grossProfit: PeriodDelta;
  netIncome: PeriodDelta;
  grossMarginPct: number;
  netMarginPct: number;
  cogsCents: number;
  opexCents: number;
  otherCents: number;
}

export interface EntityBalanceSheet {
  cashCents: number;
  arCents: number;
  apCents: number;
  equityCents: number;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  /** assets − (liabilities + equity section); 0 when the entity's TB ties. */
  balanceCheckCents: number;
  isBalanced: boolean;
  /** Which key lines resolved to a mapped account (degrade-safe transparency). */
  rolesResolved: { cash: boolean; ar: boolean; ap: boolean };
}

export interface OverdueItem {
  id: string;
  name: string; // customer (AR) or vendor (AP)
  reference: string; // invoice / bill number
  amountCents: number;
  bucket: string;
  dueDate: string | null;
}

export interface OpenExceptionItem {
  id: string;
  feature: string;
  summary: string;
  confidence: number | null;
  createdAt: string;
}

export interface EntityCloseState {
  periodId: string | null;
  periodStatus: BoardPeriodStatus;
  closedAt: string | null;
  readyToClose: boolean;
  blockers: string[];
  blockerCount: number;
}

export interface EntitySnapshot {
  locationId: string;
  name: string;
  shortCode: string;
  period: { year: number; month: number; label: string; startDate: string; endDate: string };
  priorPeriod: { year: number; month: number; label: string };
  generatedAt: string;
  pnl: EntityPnl;
  balanceSheet: EntityBalanceSheet;
  /** Live bank cash (bank_accounts) — the same figure the board card shows. */
  bankCashCents: number;
  minimumCashCents: number;
  overdueAr: { totalCents: number; items: OverdueItem[] };
  overdueAp: { totalCents: number; items: OverdueItem[] };
  openExceptions: { total: number; items: OpenExceptionItem[] };
  close: EntityCloseState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers (UTC — avoid tz drift in the ISO date strings)
// ─────────────────────────────────────────────────────────────────────────────

function monthRange(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start, end: `${year}-${pad2(month)}-${pad2(lastDay)}` };
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function priorMonth(year: number, month: number): { year: number; month: number } {
  return month <= 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function deltaOf(current: number, prior: number): PeriodDelta {
  return {
    currentCents: current,
    priorCents: prior,
    deltaCents: current - prior,
    deltaPct: prior === 0 ? null : Number((((current - prior) / Math.abs(prior)) * 100).toFixed(1)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-entity trial-balance loader → the PURE consolidate() engine
// ─────────────────────────────────────────────────────────────────────────────

interface TbLineRow {
  account_id: string;
  debit_cents: number | string | null;
  credit_cents: number | string | null;
  accounts: { account_number: string; name: string; account_type: AccountType } | null;
  gl_entries: { entry_date: string } | null;
}

/** Natural-balance cents for a line given its account type. */
function naturalBalance(type: AccountType, debit: number, credit: number): number {
  return DEBIT_NORMAL_TYPES.has(type) ? debit - credit : credit - debit;
}

/**
 * Load ONE location's trial balance from POSTED gl_entry_lines and fold it into
 * `EntityAccountBalance[]`: balance-sheet accounts accrue cumulatively THROUGH the
 * as-of date; income-statement accounts count only WITHIN [startDate, endDate].
 * Paginated + RLS-scoped.
 */
async function loadEntityTrialBalance(
  supabase: SupabaseClient,
  locationId: string,
  startDate: string,
  endDate: string,
): Promise<EntityAccountBalance[]> {
  const byAccount = new Map<string, EntityAccountBalance>();

  for (let from = 0; from < MAX_LINES; from += PAGE) {
    const { data, error } = await supabase
      .from('gl_entry_lines')
      .select(
        `account_id, debit_cents, credit_cents,
         accounts!inner(account_number, name, account_type),
         gl_entries!inner(entry_date, status)`,
      )
      .eq('location_id', locationId)
      .eq('gl_entries.status', 'POSTED')
      .lte('gl_entries.entry_date', endDate)
      .order('account_id', { ascending: true })
      .range(from, from + PAGE - 1);

    if (error || !data || data.length === 0) break;

    for (const raw of data as unknown as TbLineRow[]) {
      const acct = raw.accounts;
      const entry = raw.gl_entries;
      if (!acct || !entry) continue;
      const type = acct.account_type;
      const isPnl = !isBalanceSheet(type);
      // P&L only counts within the period; BS accrues cumulatively.
      if (isPnl && entry.entry_date < startDate) continue;
      const natural = naturalBalance(type, num(raw.debit_cents), num(raw.credit_cents));
      const key = acct.account_number;
      const existing = byAccount.get(key);
      if (existing) {
        existing.naturalBalanceCents += natural;
      } else {
        byAccount.set(key, {
          entityId: locationId,
          accountNumber: acct.account_number,
          accountName: acct.name,
          accountType: type,
          isEliminating: false,
          role: null,
          naturalBalanceCents: natural,
        });
      }
    }

    if (data.length < PAGE) break;
  }

  return Array.from(byAccount.values());
}

const BALANCE_SHEET_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'ASSET',
  'LIABILITY',
  'EQUITY',
]);
function isBalanceSheet(t: AccountType): boolean {
  return BALANCE_SHEET_TYPES.has(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Key balance-sheet lines by ROLE
// ─────────────────────────────────────────────────────────────────────────────

/** Cash family + AR/AP control accounts, resolved by role, matched into the TB. */
async function resolveKeyLines(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  balanceByNumber: Map<string, number>,
): Promise<{ cashCents: number; arCents: number; apCents: number; resolved: { cash: boolean; ar: boolean; ap: boolean } }> {
  // Sum the (unique) resolved account numbers for a set of roles into the TB.
  const sumRoles = async (roles: AccountRoleKey[]): Promise<{ cents: number; hit: boolean }> => {
    const numbers = new Set<string>();
    for (const role of roles) {
      try {
        const ref = await resolveRole(supabase, orgId, role, locationId);
        numbers.add(ref.account_number);
      } catch (e) {
        if (!(e instanceof PostingError)) throw e; // real error — surface it
      }
    }
    let cents = 0;
    for (const n of numbers) cents += balanceByNumber.get(n) ?? 0;
    return { cents, hit: numbers.size > 0 };
  };

  const cash = await sumRoles(['OPERATING_BANK', 'CASH_ON_HAND', 'UNDEPOSITED_FUNDS']);
  const ar = await sumRoles(['AR_CONTROL']);
  const ap = await sumRoles(['AP_CONTROL']);

  return {
    cashCents: cash.cents,
    arCents: ar.cents,
    apCents: ap.cents,
    resolved: { cash: cash.hit, ar: ar.hit, ap: ap.hit },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overdue AR / AP + open exceptions
// ─────────────────────────────────────────────────────────────────────────────

async function loadOverdue(
  supabase: SupabaseClient,
  locationId: string,
  view: 'v_ar_aging' | 'v_ap_aging',
): Promise<{ totalCents: number; items: OverdueItem[] }> {
  const isAr = view === 'v_ar_aging';

  // Literal per-view selects (matches the proven board.ts pattern).
  const { data } = isAr
    ? await supabase
        .from('v_ar_aging')
        .select('invoice_id, invoice_number, customer_name, balance_cents, aging_bucket, due_date')
        .eq('location_id', locationId)
        .neq('aging_bucket', 'CURRENT')
        .gt('balance_cents', 0)
        .order('balance_cents', { ascending: false })
        .limit(ROW_CAP)
    : await supabase
        .from('v_ap_aging')
        .select('bill_id, bill_number, vendor_name, balance_cents, aging_bucket, due_date')
        .eq('location_id', locationId)
        .neq('aging_bucket', 'CURRENT')
        .gt('balance_cents', 0)
        .order('balance_cents', { ascending: false })
        .limit(ROW_CAP);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const items: OverdueItem[] = rows.map((r) => ({
    id: String((isAr ? r.invoice_id : r.bill_id) ?? ''),
    name: String((isAr ? r.customer_name : r.vendor_name) ?? '—'),
    reference: String((isAr ? r.invoice_number : r.bill_number) ?? '—'),
    amountCents: num(r.balance_cents as number | string | null),
    bucket: String(r.aging_bucket ?? ''),
    dueDate: (r.due_date as string | null) ?? null,
  }));
  const totalCents = items.reduce((s, i) => s + i.amountCents, 0);
  return { totalCents, items: items.slice(0, 5) };
}

async function loadOpenExceptions(
  supabase: SupabaseClient,
  locationId: string,
): Promise<{ total: number; items: OpenExceptionItem[] }> {
  const [{ count }, { data }] = await Promise.all([
    supabase
      .from('ai_decisions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PROPOSED')
      .eq('location_id', locationId),
    supabase
      .from('ai_decisions')
      .select('id, feature, input_summary, confidence, created_at')
      .eq('status', 'PROPOSED')
      .eq('location_id', locationId)
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const items: OpenExceptionItem[] = ((data ?? []) as Array<{
    id: string;
    feature: string | null;
    input_summary: string | null;
    confidence: number | string | null;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    feature: r.feature ?? 'AI decision',
    summary: r.input_summary ?? '',
    confidence: r.confidence == null ? null : num(r.confidence),
    createdAt: r.created_at,
  }));

  return { total: count ?? items.length, items };
}

// ─────────────────────────────────────────────────────────────────────────────
// Location master + supporting reads
// ─────────────────────────────────────────────────────────────────────────────

interface LocationRow {
  id: string;
  name: string;
  short_code: string | null;
  minimum_cash_cents: number | string | null;
}

async function loadLocation(supabase: SupabaseClient, locationId: string): Promise<LocationRow | null> {
  const { data } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code, minimum_cash_cents')
    .eq('id', locationId)
    .maybeSingle();
  return (data as unknown as LocationRow | null) ?? null;
}

async function loadBankCash(supabase: SupabaseClient, locationId: string): Promise<number> {
  const { data } = await supabase
    .from('bank_accounts')
    .select('current_balance_cents')
    .eq('location_id', locationId)
    .eq('is_active', true)
    .limit(ROW_CAP);
  let cents = 0;
  for (const r of (data ?? []) as Array<{ current_balance_cents: number | string | null }>) {
    cents += num(r.current_balance_cents);
  }
  return cents;
}

async function loadCloseState(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  year: number,
  month: number,
): Promise<EntityCloseState> {
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('id, status, closed_at')
    .eq('period_year', year)
    .eq('period_month', month)
    .eq('location_id', locationId)
    .maybeSingle();

  const periodRow = period as unknown as {
    id: string;
    status: BoardPeriodStatus;
    closed_at: string | null;
  } | null;
  if (!periodRow) {
    return {
      periodId: null,
      periodStatus: 'NO_PERIOD',
      closedAt: null,
      readyToClose: false,
      blockers: [],
      blockerCount: 0,
    };
  }

  // Reuse the same HARD_CLOSE gate the Close Command Center consults.
  try {
    const bundle = await gatherHardCloseGate(supabase, orgId, {
      locationId,
      fiscalPeriodId: periodRow.id,
    });
    const blockers = bundle.evaluation.blockers.map((b) => b.label);
    return {
      periodId: periodRow.id,
      periodStatus: periodRow.status,
      closedAt: periodRow.closed_at,
      readyToClose: bundle.evaluation.readyToHardClose,
      blockers,
      blockerCount: blockers.length,
    };
  } catch (e) {
    console.warn('[portfolio/entity] close gate failed:', e instanceof Error ? e.message : e);
    return {
      periodId: periodRow.id,
      periodStatus: periodRow.status,
      closedAt: periodRow.closed_at,
      readyToClose: false,
      blockers: [],
      blockerCount: 0,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the per-entity snapshot for one company + fiscal month. Returns null
 * when the location is not visible to this tenant (RLS) — the caller 404s.
 */
export async function gatherEntitySnapshot(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  year: number,
  month: number,
): Promise<EntitySnapshot | null> {
  const location = await loadLocation(supabase, locationId);
  if (!location) return null;

  const { start, end } = monthRange(year, month);
  const prior = priorMonth(year, month);
  const priorRange = monthRange(prior.year, prior.month);

  const [
    currentTb,
    priorTb,
    bankCashCents,
    overdueAr,
    overdueAp,
    openExceptions,
    close,
  ] = await Promise.all([
    loadEntityTrialBalance(supabase, locationId, start, end),
    loadEntityTrialBalance(supabase, locationId, priorRange.start, priorRange.end),
    loadBankCash(supabase, locationId),
    loadOverdue(supabase, locationId, 'v_ar_aging'),
    loadOverdue(supabase, locationId, 'v_ap_aging'),
    loadOpenExceptions(supabase, locationId),
    loadCloseState(supabase, orgId, locationId, year, month),
  ]);

  const entityMeta = [{ entityId: locationId, name: location.name, method: 'FULL' as const, ownershipPercent: 100 }];
  const current = consolidate({ entities: entityMeta, balances: currentTb, eliminate: false });
  const priorC = consolidate({ entities: entityMeta, balances: priorTb, eliminate: false });

  const ct = current.totals;
  const pt = priorC.totals;
  const curGross = ct.revenueCents - ct.cogsCents;
  const priGross = pt.revenueCents - pt.cogsCents;

  // Key BS lines by role, matched into the current-period consolidated balances.
  const balanceByNumber = new Map<string, number>();
  for (const a of current.accounts) balanceByNumber.set(a.accountNumber, a.consolidatedCents);
  const keyLines = await resolveKeyLines(supabase, orgId, locationId, balanceByNumber);

  const pnl: EntityPnl = {
    revenue: deltaOf(ct.revenueCents, pt.revenueCents),
    grossProfit: deltaOf(curGross, priGross),
    netIncome: deltaOf(ct.netIncomeFullCents, pt.netIncomeFullCents),
    grossMarginPct: ct.revenueCents > 0 ? Number(((curGross / ct.revenueCents) * 100).toFixed(1)) : 0,
    netMarginPct:
      ct.revenueCents > 0 ? Number(((ct.netIncomeFullCents / ct.revenueCents) * 100).toFixed(1)) : 0,
    cogsCents: ct.cogsCents,
    opexCents: ct.opexCents,
    otherCents: ct.otherCents,
  };

  const balanceSheet: EntityBalanceSheet = {
    cashCents: keyLines.cashCents,
    arCents: keyLines.arCents,
    apCents: keyLines.apCents,
    equityCents: ct.equitySectionCents,
    totalAssetsCents: ct.assetsCents,
    totalLiabilitiesCents: ct.liabilitiesCents,
    balanceCheckCents: ct.balanceCheckCents,
    isBalanced: ct.balanceCheckCents === 0,
    rolesResolved: keyLines.resolved,
  };

  return {
    locationId,
    name: location.name,
    shortCode: location.short_code ?? '',
    period: { year, month, label: monthLabel(year, month), startDate: start, endDate: end },
    priorPeriod: { year: prior.year, month: prior.month, label: monthLabel(prior.year, prior.month) },
    generatedAt: new Date().toISOString(),
    pnl,
    balanceSheet,
    bankCashCents,
    minimumCashCents: num(location.minimum_cash_cents),
    overdueAr,
    overdueAp,
    openExceptions,
    close,
  };
}
