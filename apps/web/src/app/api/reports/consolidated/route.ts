export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';

/**
 * Consolidated P&L across entities, with proper intercompany elimination.
 *
 * Intercompany correctness (Session 22): the previous implementation eliminated
 * by dropping every gl_entry whose source_module = 'INTERCOMPANY'. That erased
 * legitimate group costs — an "expense paid on behalf" books a REAL third-party
 * expense on the receiving entity, which must remain in the consolidated P&L;
 * only the reciprocal Intercompany Receivable/Payable (balance-sheet) positions
 * eliminate. So the P&L is built from all posted entries, and the elimination is
 * reported as the matched intercompany AR/AP balance across the group.
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
      eliminatedCents,
      eliminationsApplied: eliminateIc,
      intercompany,
    });
  }

  // P&L lines (income-statement accounts only)
  const { data: lines } = await supabase
    .from('gl_entry_lines')
    .select(`
      account_id, debit_cents, credit_cents, location_id,
      accounts!inner(account_number, name, account_type)
    `)
    .in('gl_entry_id', entries.map((e) => e.id))
    .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']);

  // Aggregate by account × location
  const accountMap = new Map<string, {
    accountNumber: string;
    accountName: string;
    accountType: string;
    byLocation: Record<string, number>;
    consolidatedCents: number;
  }>();

  for (const line of lines ?? []) {
    const acct = line.accounts as unknown as { account_number: string; name: string; account_type: string };
    const key = acct.account_number;
    const isCredit = acct.account_type === 'REVENUE';
    const net = isCredit
      ? Number(line.credit_cents ?? 0) - Number(line.debit_cents ?? 0)
      : Number(line.debit_cents ?? 0) - Number(line.credit_cents ?? 0);

    const existing = accountMap.get(key);
    if (existing) {
      existing.byLocation[line.location_id] = (existing.byLocation[line.location_id] ?? 0) + net;
      existing.consolidatedCents += net;
    } else {
      accountMap.set(key, {
        accountNumber: acct.account_number,
        accountName: acct.name,
        accountType: acct.account_type,
        byLocation: { [line.location_id]: net },
        consolidatedCents: net,
      });
    }
  }

  const accounts = Array.from(accountMap.values()).sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  return NextResponse.json({
    period: { startDate, endDate },
    locations: locOut,
    accounts,
    eliminatedCents,
    eliminationsApplied: eliminateIc,
    intercompany,
  });
}
