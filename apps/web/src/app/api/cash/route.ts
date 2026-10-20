export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchBookCash, CASH_DEFINITION } from '@/lib/cash/book-cash';
import { getOrgToday } from '@/lib/dates/org-today';

/**
 * GET /api/cash?location_id=<uuid>
 *
 * Current cash position grouped by company (location). Optional `location_id`
 * narrows to one company.
 *
 * `totalCashCents` is the CANONICAL book cash (lib/cash/book-cash — posted GL
 * balance of bank/cash-role accounts as of today in the org's timezone), the
 * same figure the dashboard, entity snapshot, board package and FP&A show.
 * Bank-feed balances are returned per account and as `bankBalanceCents` (credit
 * cards excluded — they are liabilities, not cash) with the book−bank gap as
 * `unreconciledCents`, a reconciliation reference only.
 *
 * RLS-scoped: runs as the user so tenant isolation is enforced by the database
 * (previously this route used the RLS-bypassing admin client + v_cash_position
 * view). Cash-health thresholds mirror the v_cash_position view.
 */

interface BankAccountRow {
  id: string;
  location_id: string;
  institution_name: string | null;
  account_name: string | null;
  account_mask: string | null;
  account_type: string | null;
  current_balance_cents: number | string | null;
  available_balance_cents: number | string | null;
  balance_updated_at: string | null;
}
interface LocationRow {
  id: string;
  name: string;
  minimum_cash_cents: number | string | null;
}

interface CashAccount {
  id: string;
  name: string;
  mask: string;
  type: string;
  balanceCents: number;
  availableCents: number;
  status: string;
  updatedAt: string | null;
  /** No feed activity in STALE_DAYS (or never updated) — the balance may be out of date. */
  stale: boolean;
}
interface CashLocation {
  locationId: string;
  locationName: string;
  minimumCashCents: number;
  accounts: CashAccount[];
  /** Canonical book cash (GL). */
  totalCashCents: number;
  /** Σ bank-feed balances of non-credit-card accounts (the bank's view). */
  bankBalanceCents: number;
  /** totalCashCents − bankBalanceCents (unreconciled items / stale feed). */
  unreconciledCents: number;
  cashStatus: string;
  staleCount: number;
}

// A balance not refreshed within this many days is flagged stale (bank feeds
// normally update daily; a few days' grace covers weekends/holidays).
const STALE_DAYS = 4;

// Same banding as the v_cash_position view, applied to the location total.
function cashStatus(totalCents: number, minimumCents: number): string {
  if (minimumCents <= 0) return 'ADEQUATE';
  if (totalCents >= minimumCents * 2) return 'HEALTHY';
  if (totalCents >= minimumCents) return 'ADEQUATE';
  if (totalCents >= minimumCents * 0.5) return 'NEAR_MINIMUM';
  return 'CRITICAL';
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const locationId = new URL(request.url).searchParams.get('location_id');

  let q = supabase
    .from('bank_accounts')
    .select(
      'id, location_id, institution_name, account_name, account_mask, account_type, current_balance_cents, available_balance_cents, balance_updated_at'
    )
    .eq('is_active', true);
  if (locationId) q = q.eq('location_id', locationId);
  const { data: acctData, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const accounts = (acctData ?? []) as BankAccountRow[];

  // Resolve location names + minimum-cash targets (core schema).
  const locIds = [...new Set(accounts.map((a) => a.location_id))];
  const locMap = new Map<string, LocationRow>();
  if (locIds.length) {
    const { data: locs, error: locErr } = await supabase
      .schema('core')
      .from('locations')
      .select('id, name, minimum_cash_cents')
      .in('id', locIds);
    if (locErr) return NextResponse.json({ error: locErr.message }, { status: 500 });
    for (const l of (locs ?? []) as LocationRow[]) locMap.set(l.id, l);
  }

  const today = await getOrgToday(supabase, orgId);
  let bookCash;
  try {
    bookCash = await fetchBookCash(supabase, orgId, { asOfDate: today, locationIds: locationId ? [locationId] : [] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to compute cash' }, { status: 500 });
  }
  // Companies that carry book cash but have no bank feed still appear.
  const bookLocIds = Object.keys(bookCash.byLocation).filter((id) => id !== 'unassigned' && !locMap.has(id));
  if (bookLocIds.length) {
    const { data: more } = await supabase.schema('core').from('locations').select('id, name, minimum_cash_cents').in('id', bookLocIds);
    for (const l of (more ?? []) as LocationRow[]) locMap.set(l.id, l);
  }

  const staleBefore = Date.now() - STALE_DAYS * 86_400_000;
  let asOfDate: string | null = null;

  const byLoc = new Map<string, CashLocation>();
  for (const row of accounts) {
    const loc = locMap.get(row.location_id);
    const updatedAt = row.balance_updated_at;
    const stale = !updatedAt || new Date(updatedAt).getTime() < staleBefore;
    if (updatedAt && (!asOfDate || updatedAt > asOfDate)) asOfDate = updatedAt;
    const account: CashAccount = {
      id: row.id,
      name: row.account_name ?? row.institution_name ?? 'Unknown',
      mask: row.account_mask ?? '',
      type: row.account_type ?? 'CHECKING',
      balanceCents: Number(row.current_balance_cents ?? 0),
      availableCents: Number(row.available_balance_cents ?? row.current_balance_cents ?? 0),
      status: 'ADEQUATE',
      updatedAt,
      stale,
    };
    const bankCash = account.type === 'CREDIT_CARD' ? 0 : account.balanceCents;
    const existing = byLoc.get(row.location_id);
    if (existing) {
      existing.accounts.push(account);
      existing.bankBalanceCents += bankCash;
      if (stale) existing.staleCount += 1;
    } else {
      byLoc.set(row.location_id, {
        locationId: row.location_id,
        locationName: loc?.name ?? 'Unknown',
        minimumCashCents: Number(loc?.minimum_cash_cents ?? 0),
        accounts: [account],
        totalCashCents: 0,
        bankBalanceCents: bankCash,
        unreconciledCents: 0,
        cashStatus: 'ADEQUATE',
        staleCount: stale ? 1 : 0,
      });
    }
  }
  for (const [locId, cents] of Object.entries(bookCash.byLocation)) {
    if (locId === 'unassigned' || byLoc.has(locId)) continue;
    const loc = locMap.get(locId);
    byLoc.set(locId, {
      locationId: locId,
      locationName: loc?.name ?? 'Unknown',
      minimumCashCents: Number(loc?.minimum_cash_cents ?? 0),
      accounts: [],
      totalCashCents: cents,
      bankBalanceCents: 0,
      unreconciledCents: 0,
      cashStatus: 'ADEQUATE',
      staleCount: 0,
    });
  }

  const locations = Array.from(byLoc.values())
    .map((l) => {
      const book = bookCash.byLocation[l.locationId] ?? 0;
      return {
        ...l,
        totalCashCents: book,
        unreconciledCents: book - l.bankBalanceCents,
        cashStatus: cashStatus(book, l.minimumCashCents),
      };
    })
    .sort((a, b) => a.locationName.localeCompare(b.locationName));

  const totalCash = locations.reduce((s, l) => s + l.totalCashCents, 0);
  const totalBank = locations.reduce((s, l) => s + l.bankBalanceCents, 0);
  const criticalCount = locations.filter((l) => l.cashStatus === 'CRITICAL').length;
  const nearMinCount = locations.filter((l) => l.cashStatus === 'NEAR_MINIMUM').length;
  const totalAccounts = locations.reduce((s, l) => s + l.accounts.length, 0);
  const staleCount = locations.reduce((s, l) => s + l.staleCount, 0);

  return NextResponse.json({
    locations,
    summary: {
      totalCashCents: totalCash,
      bankBalanceCents: totalBank,
      unreconciledCents: totalCash - totalBank,
      cashAsOfDate: today,
      definition: CASH_DEFINITION,
      entityCount: locations.length,
      accountCount: totalAccounts,
      criticalCount,
      nearMinCount,
      staleCount,
      asOfDate,
    },
  });
}
