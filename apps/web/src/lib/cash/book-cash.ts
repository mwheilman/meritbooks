/**
 * CANONICAL CASH — the one definition every "cash" figure in the app uses
 * (audit L6: one company read $213.5K / $1.4M / $1.41M / $488 / $0 on five pages).
 *
 * DEFINITION (book cash, GAAP "cash and cash equivalents" per the ledger):
 *
 *   cash(scope, asOf) = Σ (debit_cents − credit_cents)
 *     over gl_entry_lines L joined to gl_entries E
 *     where E.status = 'POSTED'
 *       and E.entry_date ≤ asOf
 *       and L.account_id ∈ CASH ACCOUNTS
 *       and L.location_id ∈ scope            (line-level company scope — the same
 *                                             scoping the balance sheet uses, so
 *                                             cash ties to the BS cash lines)
 *
 *   CASH ACCOUNTS = ASSET accounts that are
 *       • flagged `is_bank_account = true` and NOT `is_credit_card`, OR
 *       • mapped to a cash role (OPERATING_BANK / CASH_ON_HAND / UNDEPOSITED_FUNDS)
 *         in public.account_roles (any location), OR
 *       • the role's standard COA number (1000 / 1050 / 1090) when that role has
 *         no explicit mapping (the resolver's documented fallback).
 *   Accounts are identified BY ROLE / FLAG — never by a number range (canon §2).
 *   Excluded on purpose: credit-card liabilities, payment-processor / settlement
 *   clearing and payments-in-transit (not yet cash), restricted / escrow assets
 *   not flagged as bank accounts.
 *
 * Bank-feed balances (`bank_accounts.current_balance_cents`) are the BANK's view,
 * not the books. Surfaces may show them only as a separately-labelled
 * "Bank balance (per feed)" reconciliation reference — never as "cash".
 *
 * Money is bigint cents (JS number, integer-only arithmetic).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { ROLE_DEFAULT_NUMBER, type AccountRoleKey } from '@/lib/posting/account-roles';

export const CASH_ROLE_KEYS: readonly AccountRoleKey[] = ['OPERATING_BANK', 'CASH_ON_HAND', 'UNDEPOSITED_FUNDS'];

export const CASH_DEFINITION =
  'Cash = posted GL balance of bank-flagged and cash-role asset accounts (operating bank, cash on hand, undeposited funds) as of the date, scoped to the selected companies.';

// ─────────────────────────────────────────────────────────────────────────────
// Pure core (unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

export interface CashAccountCandidate {
  id: string;
  account_number: string;
  account_type: string;
  is_bank_account: boolean | null;
  is_credit_card: boolean | null;
}

export interface CashRoleMapping {
  role_key: string;
  account_id: string;
}

/** Select the cash-account id set from the COA + role mappings (see DEFINITION). */
export function selectCashAccountIds(
  accounts: readonly CashAccountCandidate[],
  roleMappings: readonly CashRoleMapping[],
): Set<string> {
  const ids = new Set<string>();
  const assetById = new Map<string, CashAccountCandidate>();
  for (const a of accounts) if (a.account_type === 'ASSET') assetById.set(a.id, a);

  for (const a of assetById.values()) {
    if (a.is_bank_account && !a.is_credit_card) ids.add(a.id);
  }
  const mappedRoles = new Set<string>();
  for (const m of roleMappings) {
    if (!CASH_ROLE_KEYS.includes(m.role_key as AccountRoleKey)) continue;
    mappedRoles.add(m.role_key);
    const a = assetById.get(m.account_id);
    if (a && !a.is_credit_card) ids.add(a.id);
  }
  for (const role of CASH_ROLE_KEYS) {
    if (mappedRoles.has(role)) continue;
    const num = ROLE_DEFAULT_NUMBER[role];
    for (const a of assetById.values()) {
      if (a.account_number === num && !a.is_credit_card) ids.add(a.id);
    }
  }
  return ids;
}

export interface CashLine {
  accountId: string;
  locationId: string | null;
  entryDate: string;
  debitCents: number;
  creditCents: number;
}

export interface BookCash {
  asOfDate: string;
  totalCents: number;
  byLocation: Record<string, number>;
  byAccount: Record<string, number>;
}

/** Sum cash lines as of `asOf` (inclusive), optionally restricted to locations. */
export function sumCashAsOf(
  lines: readonly CashLine[],
  cashIds: ReadonlySet<string>,
  asOf: string,
  locationIds?: readonly string[] | null,
): BookCash {
  const scope = locationIds && locationIds.length > 0 ? new Set(locationIds) : null;
  const byLocation: Record<string, number> = {};
  const byAccount: Record<string, number> = {};
  let total = 0;
  for (const l of lines) {
    if (!cashIds.has(l.accountId)) continue;
    if (l.entryDate > asOf) continue;
    if (scope && (!l.locationId || !scope.has(l.locationId))) continue;
    const net = Math.round(l.debitCents) - Math.round(l.creditCents);
    total += net;
    const loc = l.locationId ?? 'unassigned';
    byLocation[loc] = (byLocation[loc] ?? 0) + net;
    byAccount[l.accountId] = (byAccount[l.accountId] ?? 0) + net;
  }
  return { asOfDate: asOf, totalCents: total, byLocation, byAccount };
}

/** Cash at several as-of dates from ONE line set (trend strips, cash flow begin/end). */
export function cashSeries(
  lines: readonly CashLine[],
  cashIds: ReadonlySet<string>,
  asOfDates: readonly string[],
  locationIds?: readonly string[] | null,
): number[] {
  return asOfDates.map((d) => sumCashAsOf(lines, cashIds, d, locationIds).totalCents);
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O (RLS-scoped — pass the user-scoped client)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the tenant's cash-account ids (see DEFINITION). */
export async function resolveCashAccountIds(supabase: SupabaseClient, orgId: string | null | undefined): Promise<Set<string>> {
  const { data: accts } = await fetchAll(
    () => {
      // Fresh builder per page — PostgREST builders are mutable.
      let q = supabase
        .from('accounts')
        .select('id, account_number, account_type, is_bank_account, is_credit_card')
        .eq('account_type', 'ASSET');
      if (orgId) q = q.eq('org_id', orgId);
      return q;
    },
    { label: 'book-cash accounts' },
  );

  let roleQ = supabase.from('account_roles').select('role_key, account_id').in('role_key', [...CASH_ROLE_KEYS]);
  if (orgId) roleQ = roleQ.eq('org_id', orgId);
  const { data: roles } = await roleQ;

  return selectCashAccountIds(
    (accts ?? []) as unknown as CashAccountCandidate[],
    (roles ?? []) as unknown as CashRoleMapping[],
  );
}

interface CashLineRow {
  account_id: string;
  location_id: string | null;
  debit_cents: number | string | null;
  credit_cents: number | string | null;
  gl_entries: { entry_date: string } | null;
}

/** Load every POSTED cash line through `maxAsOf` for the scope (paged). */
export async function loadCashLines(
  supabase: SupabaseClient,
  cashIds: ReadonlySet<string>,
  opts: { maxAsOf: string; locationIds?: readonly string[] | null },
): Promise<CashLine[]> {
  if (cashIds.size === 0) return [];
  const ids = Array.from(cashIds);
  const locs = opts.locationIds ?? [];
  const { data, error } = await fetchAll(
    () => {
      let q = supabase
        .from('gl_entry_lines')
        .select('id, account_id, location_id, debit_cents, credit_cents, gl_entries!inner(entry_date, status)')
        .eq('gl_entries.status', 'POSTED')
        .lte('gl_entries.entry_date', opts.maxAsOf)
        .in('account_id', ids);
      if (locs.length === 1) q = q.eq('location_id', locs[0]);
      else if (locs.length > 1) q = q.in('location_id', [...locs]);
      return q;
    },
    { label: 'book-cash gl_entry_lines' },
  );
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as CashLineRow[]).map((r) => ({
    accountId: r.account_id,
    locationId: r.location_id,
    entryDate: r.gl_entries?.entry_date ?? '9999-12-31',
    debitCents: Number(r.debit_cents ?? 0),
    creditCents: Number(r.credit_cents ?? 0),
  }));
}

/** Canonical book cash as of one date. */
export async function fetchBookCash(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
  opts: { asOfDate: string; locationIds?: readonly string[] | null },
): Promise<BookCash> {
  const cashIds = await resolveCashAccountIds(supabase, orgId);
  const lines = await loadCashLines(supabase, cashIds, { maxAsOf: opts.asOfDate, locationIds: opts.locationIds });
  return sumCashAsOf(lines, cashIds, opts.asOfDate, opts.locationIds);
}

/** Canonical book cash at several dates (one line read). */
export async function fetchBookCashSeries(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
  opts: { asOfDates: readonly string[]; locationIds?: readonly string[] | null },
): Promise<number[]> {
  if (opts.asOfDates.length === 0) return [];
  const maxAsOf = opts.asOfDates.reduce((a, b) => (a > b ? a : b));
  const cashIds = await resolveCashAccountIds(supabase, orgId);
  const lines = await loadCashLines(supabase, cashIds, { maxAsOf, locationIds: opts.locationIds });
  return cashSeries(lines, cashIds, opts.asOfDates, opts.locationIds);
}
