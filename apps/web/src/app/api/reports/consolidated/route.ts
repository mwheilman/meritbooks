export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { applyEliminations, type ConsolAccountInput } from './eliminations';

/**
 * Consolidated P&L across entities, with proper intercompany/interdepartmental
 * elimination (GATE 11a).
 *
 * Two eliminations happen at the group roll-up:
 *  1. P&L eliminations (this statement): every `is_eliminating` account (the
 *     interdepartmental Services Revenue / Cost accounts, migration 015, set by
 *     internal-invoices.ts) is NETTED TO ZERO in the consolidated column, so
 *     consolidated revenue / expense / NI are unaffected by internal activity —
 *     while genuine third-party costs (an "expense paid on behalf" books a REAL
 *     third-party expense on the receiving entity, on a non-eliminating account)
 *     REMAIN. Per-entity values are preserved so the internal activity is still
 *     visible before it nets out.
 *  2. Balance-sheet eliminations (reported informationally here): the reciprocal
 *     Intercompany Receivable/Payable positions (roles INTERCOMPANY_AR/AP,
 *     accounts 1160/2020) net across the group; surfaced in the `intercompany`
 *     block for the (P&L-only) statement.
 *
 * Historical note (Session 22): an earlier version dropped every INTERCOMPANY
 * source_module entry, which erased legitimate third-party costs — the reason the
 * P&L is built from all posted entries and only `is_eliminating` accounts net.
 */
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('start_date') ?? new Date().toISOString().slice(0, 8) + '01';
  const endDate = searchParams.get('end_date') ?? new Date().toISOString().slice(0, 10);
  const eliminateIc = searchParams.get('eliminate_ic') !== 'false'; // default true

  // Entities
  const { data: locations } = await supabase
    .schema('core').from('locations')
    .select('id, name, short_code')
    .eq('is_active', true)
    .order('name');

  // Posted entries in period
  const { data: entries } = await supabase
    .from('gl_entries')
    .select('id, location_id')
    .eq('status', 'POSTED')
    .gte('entry_date', startDate)
    .lte('entry_date', endDate);

  const locOut = (locations ?? []).map((l) => ({ id: l.id, name: l.name, shortCode: l.short_code }));

  // ---- Intercompany elimination: net AR vs AP across the group (informational
  //      to the P&L; the P&L itself is not reduced by intercompany funding). ----
  let totalReceivableCents = 0;
  let totalPayableCents = 0;
  if (eliminateIc && orgId) {
    try {
      const icAr = await resolveRole(supabase, orgId, 'INTERCOMPANY_AR');
      const icAp = await resolveRole(supabase, orgId, 'INTERCOMPANY_AP');
      const { data: postedAll } = await supabase
        .from('gl_entries').select('id').eq('org_id', orgId).eq('status', 'POSTED');
      const postedIds = (postedAll ?? []).map((e) => e.id as string);
      if (postedIds.length > 0) {
        const { data: arLines } = await supabase
          .from('gl_entry_lines').select('debit_cents, credit_cents')
          .eq('account_id', icAr.id).in('gl_entry_id', postedIds);
        totalReceivableCents = (arLines ?? []).reduce(
          (s, l) => s + Number(l.debit_cents ?? 0) - Number(l.credit_cents ?? 0), 0);
        const { data: apLines } = await supabase
          .from('gl_entry_lines').select('debit_cents, credit_cents')
          .eq('account_id', icAp.id).in('gl_entry_id', postedIds);
        totalPayableCents = (apLines ?? []).reduce(
          (s, l) => s + Number(l.credit_cents ?? 0) - Number(l.debit_cents ?? 0), 0);
      }
    } catch (e) {
      if (!(e instanceof PostingError)) throw e;
      // roles not seeded → nothing to eliminate
    }
  }
  const eliminatedCents = Math.min(Math.abs(totalReceivableCents), Math.abs(totalPayableCents));
  const intercompany = {
    totalReceivableCents,
    totalPayableCents,
    differenceCents: totalReceivableCents - totalPayableCents,
    balanced: totalReceivableCents === totalPayableCents,
  };

  if (!entries || entries.length === 0) {
    return NextResponse.json({
      period: { startDate, endDate },
      locations: locOut,
      accounts: [],
      eliminationsColumnCents: 0,
      eliminatedCents,
      eliminationsApplied: eliminateIc,
      intercompany,
    });
  }

  // P&L lines (income-statement accounts only). `is_eliminating` marks the
  // interdepartmental Services Revenue/Cost accounts that must net to zero.
  const { data: lines } = await supabase
    .from('gl_entry_lines')
    .select(`
      account_id, debit_cents, credit_cents, location_id,
      accounts!inner(account_number, name, account_type, is_eliminating)
    `)
    .in('gl_entry_id', entries.map((e) => e.id))
    .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']);

  // Aggregate by account × location (per-entity net, signed revenue-positive).
  const accountMap = new Map<string, ConsolAccountInput>();

  for (const line of lines ?? []) {
    const acct = line.accounts as unknown as { account_number: string; name: string; account_type: string; is_eliminating: boolean };
    const key = acct.account_number;
    const isCredit = acct.account_type === 'REVENUE';
    const net = isCredit
      ? Number(line.credit_cents ?? 0) - Number(line.debit_cents ?? 0)
      : Number(line.debit_cents ?? 0) - Number(line.credit_cents ?? 0);

    const existing = accountMap.get(key);
    if (existing) {
      existing.byLocation[line.location_id] = (existing.byLocation[line.location_id] ?? 0) + net;
    } else {
      accountMap.set(key, {
        accountNumber: acct.account_number,
        accountName: acct.name,
        accountType: acct.account_type,
        isEliminating: Boolean(acct.is_eliminating),
        byLocation: { [line.location_id]: net },
      });
    }
  }

  // Net every is_eliminating account to zero at the group roll-up (GATE 11a).
  // `eliminateIc` gates it so a reader can flip back to the pre-elimination view.
  const { accounts: netted, totalEliminationCents } = applyEliminations(
    Array.from(accountMap.values()),
    eliminateIc
  );
  const accounts = netted.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  return NextResponse.json({
    period: { startDate, endDate },
    locations: locOut,
    accounts,
    // Eliminations column total (interdepartmental Services Revenue/Cost netted).
    eliminationsColumnCents: totalEliminationCents,
    eliminatedCents,
    eliminationsApplied: eliminateIc,
    intercompany,
  });
}
