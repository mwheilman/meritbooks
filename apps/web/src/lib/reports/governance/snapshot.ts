/**
 * Release snapshots — the key statement totals of one company-month, captured at release
 * and re-captured whenever the month's posted activity changes (FPB §18.2).
 *
 *   summarizeActivity(lines, accounts)  PURE  period P&L totals + per-account activity + hash
 *   diffSnapshots(prior, next, names)   PURE  deltas + changed accounts
 *   loadPeriodActivity(...)             I/O   the month's POSTED gl_entry_lines (RLS client)
 *   loadBalanceSheetTotals(...)         I/O   cumulative A/L/E at month end
 *
 * Money is bigint cents carried as JS numbers (safe to ±2^53 cents ≈ $90 trillion). The hash
 * covers ONLY the month's own posted activity per account, so posting into, voiding in, or
 * re-coding a released month changes it; changes to earlier months are those months' own
 * restatements.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from '@/lib/supabase/fetch-all';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';

export interface AccountMeta {
  id: string;
  number: string;
  name: string;
  type: AccountType;
}

export interface ActivityLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
}

export interface ActivitySummary {
  revenueCents: number;
  cogsCents: number;
  opexCents: number;
  /** Other income − other expense (credit-normal, positive = income). */
  otherNetCents: number;
  netIncomeCents: number;
  /** account id → debit − credit for the month's posted activity (zero nets omitted). */
  accountBalances: Record<string, number>;
  lineCount: number;
  statementHash: string;
}

export interface SnapshotTotals extends ActivitySummary {
  assetsCents: number | null;
  liabilitiesCents: number | null;
  equityCents: number | null;
  postedEntryCount: number;
  lastPostedAt: string | null;
}

/** Deterministic SHA-256 over the sorted per-account nets. */
export function statementHash(balances: Record<string, number>): string {
  const body = Object.keys(balances)
    .sort()
    .map((id) => `${id}:${balances[id]}`)
    .join('|');
  return createHash('sha256').update(`v1|${body}`).digest('hex');
}

export function summarizeActivity(lines: readonly ActivityLine[], accounts: ReadonlyMap<string, AccountMeta>): ActivitySummary {
  const nets = new Map<string, number>();
  for (const l of lines) nets.set(l.accountId, (nets.get(l.accountId) ?? 0) + l.debitCents - l.creditCents);
  let revenue = 0;
  let cogs = 0;
  let opex = 0;
  let other = 0;
  const balances: Record<string, number> = {};
  for (const [id, net] of nets) {
    if (net === 0) continue;
    balances[id] = net;
    const t = accounts.get(id)?.type;
    if (t === 'REVENUE') revenue -= net;
    else if (t === 'COGS') cogs += net;
    else if (t === 'OPEX') opex += net;
    else if (t === 'OTHER') other -= net;
  }
  return {
    revenueCents: revenue,
    cogsCents: cogs,
    opexCents: opex,
    otherNetCents: other,
    netIncomeCents: revenue - cogs - opex + other,
    accountBalances: balances,
    lineCount: lines.length,
    statementHash: statementHash(balances),
  };
}

/** Cumulative balance-sheet totals (natural sign: assets debit-positive, L/E credit-positive). */
export function summarizeBalanceSheet(
  lines: readonly ActivityLine[],
  accounts: ReadonlyMap<string, AccountMeta>,
): { assetsCents: number; liabilitiesCents: number; equityCents: number } {
  let a = 0;
  let l = 0;
  let e = 0;
  for (const x of lines) {
    const t = accounts.get(x.accountId)?.type;
    const net = x.debitCents - x.creditCents;
    if (t === 'ASSET') a += net;
    else if (t === 'LIABILITY') l -= net;
    else if (t === 'EQUITY') e -= net;
  }
  return { assetsCents: a, liabilitiesCents: l, equityCents: e };
}

export interface SnapshotDiff {
  changed: boolean;
  revenueDeltaCents: number;
  cogsDeltaCents: number;
  opexDeltaCents: number;
  otherNetDeltaCents: number;
  netIncomeDeltaCents: number;
  assetsDeltaCents: number | null;
  liabilitiesDeltaCents: number | null;
  equityDeltaCents: number | null;
  changedAccounts: Array<{ account_id: string; account_number: string | null; name: string | null; prior_cents: number; new_cents: number; delta_cents: number }>;
}

export interface ComparableSnapshot {
  statementHash: string;
  revenueCents: number;
  cogsCents: number;
  opexCents: number;
  otherNetCents: number;
  netIncomeCents: number;
  assetsCents: number | null;
  liabilitiesCents: number | null;
  equityCents: number | null;
  accountBalances: Record<string, number>;
}

const delta = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : b - a);

export function diffSnapshots(prior: ComparableSnapshot, next: ComparableSnapshot, accounts: ReadonlyMap<string, AccountMeta>): SnapshotDiff {
  const ids = new Set([...Object.keys(prior.accountBalances), ...Object.keys(next.accountBalances)]);
  const changedAccounts: SnapshotDiff['changedAccounts'] = [];
  for (const id of ids) {
    const p = prior.accountBalances[id] ?? 0;
    const n = next.accountBalances[id] ?? 0;
    if (p === n) continue;
    const meta = accounts.get(id);
    changedAccounts.push({ account_id: id, account_number: meta?.number ?? null, name: meta?.name ?? null, prior_cents: p, new_cents: n, delta_cents: n - p });
  }
  changedAccounts.sort((x, y) => Math.abs(y.delta_cents) - Math.abs(x.delta_cents) || x.account_id.localeCompare(y.account_id));
  return {
    changed: prior.statementHash !== next.statementHash,
    revenueDeltaCents: next.revenueCents - prior.revenueCents,
    cogsDeltaCents: next.cogsCents - prior.cogsCents,
    opexDeltaCents: next.opexCents - prior.opexCents,
    otherNetDeltaCents: next.otherNetCents - prior.otherNetCents,
    netIncomeDeltaCents: next.netIncomeCents - prior.netIncomeCents,
    assetsDeltaCents: delta(prior.assetsCents, next.assetsCents),
    liabilitiesDeltaCents: delta(prior.liabilitiesCents, next.liabilitiesCents),
    equityDeltaCents: delta(prior.equityCents, next.equityCents),
    changedAccounts,
  };
}

// ── I/O ────────────────────────────────────────────────────────────────────────

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

interface AccountRow { id: string; account_number: string | null; name: string | null; account_type: AccountType }
interface LineRow { account_id: string; debit_cents: number | string | null; credit_cents: number | string | null }

export async function loadAccounts(supabase: SupabaseClient, orgId: string): Promise<Map<string, AccountMeta>> {
  const { data, error } = await fetchAll(
    () => supabase.from('accounts').select('id, account_number, name, account_type').eq('org_id', orgId),
    { label: 'governance accounts' },
  );
  if (error) throw new Error(`Could not read the chart of accounts: ${error.message}`);
  const out = new Map<string, AccountMeta>();
  for (const r of (data ?? []) as unknown as AccountRow[]) out.set(r.id, { id: r.id, number: r.account_number ?? '', name: r.name ?? '', type: r.account_type });
  return out;
}

export interface MonthBounds { startDate: string; endDate: string }

/** The month's POSTED lines for one company (line location), by entry date. */
export async function loadPeriodActivity(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  bounds: MonthBounds,
): Promise<ActivityLine[]> {
  const { data, error } = await fetchAll(
    () =>
      supabase
        .from('gl_entry_lines')
        .select('account_id, debit_cents, credit_cents, gl_entries!inner(entry_date, status)')
        .eq('org_id', orgId)
        .eq('location_id', locationId)
        .eq('gl_entries.status', 'POSTED')
        .gte('gl_entries.entry_date', bounds.startDate)
        .lte('gl_entries.entry_date', bounds.endDate),
    { label: 'governance period activity' },
  );
  if (error) throw new Error(`Could not read the month's activity: ${error.message}`);
  return ((data ?? []) as unknown as LineRow[]).map((r) => ({ accountId: r.account_id, debitCents: num(r.debit_cents), creditCents: num(r.credit_cents) }));
}

/** Every POSTED line through month end (balance-sheet totals). */
export async function loadLinesThrough(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  endDate: string,
): Promise<ActivityLine[]> {
  const { data, error } = await fetchAll(
    () =>
      supabase
        .from('gl_entry_lines')
        .select('account_id, debit_cents, credit_cents, gl_entries!inner(entry_date, status)')
        .eq('org_id', orgId)
        .eq('location_id', locationId)
        .eq('gl_entries.status', 'POSTED')
        .lte('gl_entries.entry_date', endDate),
    { label: 'governance balance sheet' },
  );
  if (error) throw new Error(`Could not read the balance sheet: ${error.message}`);
  return ((data ?? []) as unknown as LineRow[]).map((r) => ({ accountId: r.account_id, debitCents: num(r.debit_cents), creditCents: num(r.credit_cents) }));
}

interface EntryRow { id: string; posted_at: string | null }

export async function loadEntryStats(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  bounds: MonthBounds,
): Promise<{ postedEntryCount: number; lastPostedAt: string | null }> {
  const { data, error } = await fetchAll(
    () =>
      supabase
        .from('gl_entries')
        .select('id, posted_at')
        .eq('org_id', orgId)
        .eq('location_id', locationId)
        .eq('status', 'POSTED')
        .gte('entry_date', bounds.startDate)
        .lte('entry_date', bounds.endDate),
    { label: 'governance entry stats' },
  );
  if (error) throw new Error(`Could not read journal entries: ${error.message}`);
  const rows = (data ?? []) as unknown as EntryRow[];
  const last = rows.map((r) => r.posted_at).filter((x): x is string => !!x).sort().at(-1) ?? null;
  return { postedEntryCount: rows.length, lastPostedAt: last };
}

/**
 * Where the ledger figures come from. The default reads PostgREST through the caller's RLS
 * client; tests (and a future 3A balances store) can supply another source.
 */
export interface LedgerSource {
  periodActivity(orgId: string, locationId: string, bounds: MonthBounds): Promise<ActivityLine[]>;
  linesThrough(orgId: string, locationId: string, endDate: string): Promise<ActivityLine[]>;
  entryStats(orgId: string, locationId: string, bounds: MonthBounds): Promise<{ postedEntryCount: number; lastPostedAt: string | null }>;
}

export function postgrestLedger(supabase: SupabaseClient): LedgerSource {
  return {
    periodActivity: (o, l, b) => loadPeriodActivity(supabase, o, l, b),
    linesThrough: (o, l, e) => loadLinesThrough(supabase, o, l, e),
    entryStats: (o, l, b) => loadEntryStats(supabase, o, l, b),
  };
}

/** Full snapshot (activity + balance sheet + entry stats). */
export async function computeSnapshot(
  ledger: LedgerSource,
  orgId: string,
  locationId: string,
  bounds: MonthBounds,
  accounts: ReadonlyMap<string, AccountMeta>,
): Promise<SnapshotTotals> {
  const [activity, through, stats] = await Promise.all([
    ledger.periodActivity(orgId, locationId, bounds),
    ledger.linesThrough(orgId, locationId, bounds.endDate),
    ledger.entryStats(orgId, locationId, bounds),
  ]);
  const summary = summarizeActivity(activity, accounts);
  const bs = summarizeBalanceSheet(through, accounts);
  return { ...summary, ...bs, ...stats };
}

/** The row shape written to public.report_release_snapshots. */
export function snapshotRow(t: SnapshotTotals): Record<string, unknown> {
  return {
    revenue_cents: t.revenueCents,
    cogs_cents: t.cogsCents,
    opex_cents: t.opexCents,
    other_net_cents: t.otherNetCents,
    net_income_cents: t.netIncomeCents,
    assets_cents: t.assetsCents,
    liabilities_cents: t.liabilitiesCents,
    equity_cents: t.equityCents,
    posted_entry_count: t.postedEntryCount,
    line_count: t.lineCount,
    last_posted_at: t.lastPostedAt,
    statement_hash: t.statementHash,
    account_balances: t.accountBalances,
  };
}

export interface SnapshotDbRow {
  id: string;
  captured_at: string;
  revenue_cents: number | string;
  cogs_cents: number | string;
  opex_cents: number | string;
  other_net_cents: number | string;
  net_income_cents: number | string;
  assets_cents: number | string | null;
  liabilities_cents: number | string | null;
  equity_cents: number | string | null;
  statement_hash: string;
  account_balances: Record<string, number | string> | null;
}

export const SNAPSHOT_COLUMNS =
  'id, captured_at, revenue_cents, cogs_cents, opex_cents, other_net_cents, net_income_cents, assets_cents, liabilities_cents, equity_cents, statement_hash, account_balances';

/**
 * The snapshot's hash RECOMPUTED server-side from its stored per-account nets — never the
 * stored `statement_hash` column on its own (a row written or edited out of band can't vouch
 * for itself). Comparisons (re-release, restatement checks) use this.
 */
export function verifiedSnapshotHash(r: Pick<SnapshotDbRow, 'account_balances'>): string {
  const balances: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.account_balances ?? {})) {
    const n = num(v);
    if (n !== 0) balances[k] = n;
  }
  return statementHash(balances);
}

/** Does the stored hash agree with the stored nets? (false = the row is inconsistent / tampered) */
export function snapshotHashConsistent(r: Pick<SnapshotDbRow, 'account_balances' | 'statement_hash'>): boolean {
  return verifiedSnapshotHash(r) === r.statement_hash;
}

export function fromSnapshotRow(r: SnapshotDbRow): ComparableSnapshot {
  const nn = (v: number | string | null): number | null => (v === null || v === undefined ? null : num(v));
  const balances: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.account_balances ?? {})) balances[k] = num(v);
  return {
    // Recomputed from the stored nets (see verifiedSnapshotHash) — an inconsistent stored
    // hash can neither hide a change nor fake one.
    statementHash: verifiedSnapshotHash(r),
    revenueCents: num(r.revenue_cents),
    cogsCents: num(r.cogs_cents),
    opexCents: num(r.opex_cents),
    otherNetCents: num(r.other_net_cents),
    netIncomeCents: num(r.net_income_cents),
    assetsCents: nn(r.assets_cents),
    liabilitiesCents: nn(r.liabilities_cents),
    equityCents: nn(r.equity_cents),
    accountBalances: balances,
  };
}
