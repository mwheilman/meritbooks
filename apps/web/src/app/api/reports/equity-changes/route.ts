export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchAll } from '@/lib/supabase/fetch-all';

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;
  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');
  const locationId = searchParams.get('location_id');
  const locFilter = locationIds ? locationIds.split(',').filter(Boolean) : (locationId && locationId !== 'all' ? [locationId] : []);
  const startDate = searchParams.get('start_date') ?? new Date().toISOString().slice(0, 8) + '01';
  const endDate = searchParams.get('end_date') ?? new Date().toISOString().slice(0, 10);

  // Get equity accounts
  const { data: equityAccounts } = await supabase
    .from('accounts')
    .select('id, account_number, name')
    .eq('account_type', 'EQUITY')
    .eq('is_active', true)
    .order('account_number');

  if (!equityAccounts || equityAccounts.length === 0) {
    return NextResponse.json({ accounts: [], period: { startDate, endDate } });
  }

  const accountIds = equityAccounts.map((a) => a.id);

  // All reads below are PAGED inner joins from gl_entry_lines to gl_entries on the
  // same entry filters the old two-step used ("entry ids → .in(gl_entry_id)").
  // PostgREST caps any response at 1,000 rows, so the old unbounded entry-id lists
  // and line reads silently truncated beginning balances, activity and net income.
  type EntryWindow = { lt?: string; gte?: string; lte?: string };
  const linesFor = <Sel extends string>(select: Sel, w: EntryWindow) => {
    let q = supabase
      .from('gl_entry_lines')
      .select(`${select}, gl_entries!inner(id)`)
      .eq('gl_entries.status', 'POSTED');
    if (w.lt) q = q.lt('gl_entries.entry_date', w.lt);
    if (w.gte) q = q.gte('gl_entries.entry_date', w.gte);
    if (w.lte) q = q.lte('gl_entries.entry_date', w.lte);
    if (locationId) q = q.eq('gl_entries.location_id', locationId);
    return q;
  };

  // Get beginning balances (all entries before start_date)
  const beginMap = new Map<string, number>();
  const { data: priorLines } = await fetchAll(
    () => linesFor('account_id, debit_cents, credit_cents', { lt: startDate }).in('account_id', accountIds),
    { label: 'equity-changes beginning gl_entry_lines' },
  );
  for (const line of priorLines ?? []) {
    const existing = beginMap.get(line.account_id) ?? 0;
    beginMap.set(line.account_id, existing + Number(line.credit_cents ?? 0) - Number(line.debit_cents ?? 0));
  }

  // Get period activity
  const activityMap = new Map<string, number>();
  const { data: periodLines } = await fetchAll(
    () => linesFor('account_id, debit_cents, credit_cents', { gte: startDate, lte: endDate }).in('account_id', accountIds),
    { label: 'equity-changes activity gl_entry_lines' },
  );
  for (const line of periodLines ?? []) {
    const existing = activityMap.get(line.account_id) ?? 0;
    activityMap.set(line.account_id, existing + Number(line.credit_cents ?? 0) - Number(line.debit_cents ?? 0));
  }

  // Get net income for the period (revenue - expenses)
  let netIncome = 0;
  const { data: pnlLines } = await fetchAll(
    () =>
      linesFor('debit_cents, credit_cents, accounts!inner(account_type)', { gte: startDate, lte: endDate })
        .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']),
    { label: 'equity-changes net-income gl_entry_lines' },
  );
  for (const line of pnlLines ?? []) {
    const acct = line.accounts as unknown as { account_type: string };
    if (acct.account_type === 'REVENUE') {
      netIncome += Number(line.credit_cents ?? 0) - Number(line.debit_cents ?? 0);
    } else {
      netIncome -= Number(line.debit_cents ?? 0) - Number(line.credit_cents ?? 0);
    }
  }

  const accounts = equityAccounts.map((a) => {
    const beginning = beginMap.get(a.id) ?? 0;
    const activity = activityMap.get(a.id) ?? 0;
    return {
      accountNumber: a.account_number,
      accountName: a.name,
      beginningBalanceCents: beginning,
      activityCents: activity,
      endingBalanceCents: beginning + activity,
    };
  });

  const totalBeginning = accounts.reduce((s, a) => s + a.beginningBalanceCents, 0);
  const totalActivity = accounts.reduce((s, a) => s + a.activityCents, 0);
  const totalEnding = accounts.reduce((s, a) => s + a.endingBalanceCents, 0);

  return NextResponse.json({
    period: { startDate, endDate },
    accounts,
    netIncomeCents: netIncome,
    summary: { totalBeginning, totalActivity, totalEnding },
  });
}
