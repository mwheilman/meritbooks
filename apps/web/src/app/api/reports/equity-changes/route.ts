export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
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

  // Get beginning balances (all entries before start_date)
  let priorQ = supabase.from('gl_entries').select('id').eq('status', 'POSTED').lt('entry_date', startDate);
  if (locationId) priorQ = priorQ.eq('location_id', locationId);
  const { data: priorEntries } = await priorQ;

  const beginMap = new Map<string, number>();
  if (priorEntries && priorEntries.length > 0) {
    const { data: priorLines } = await supabase
      .from('gl_entry_lines')
      .select('account_id, debit_cents, credit_cents')
      .in('gl_entry_id', priorEntries.map((e) => e.id))
      .in('account_id', accountIds);
    for (const line of priorLines ?? []) {
      const existing = beginMap.get(line.account_id) ?? 0;
      beginMap.set(line.account_id, existing + Number(line.credit_cents ?? 0) - Number(line.debit_cents ?? 0));
    }
  }

  // Get period activity
  let periodQ = supabase.from('gl_entries').select('id').eq('status', 'POSTED').gte('entry_date', startDate).lte('entry_date', endDate);
  if (locationId) periodQ = periodQ.eq('location_id', locationId);
  const { data: periodEntries } = await periodQ;

  const activityMap = new Map<string, number>();
  if (periodEntries && periodEntries.length > 0) {
    const { data: periodLines } = await supabase
      .from('gl_entry_lines')
      .select('account_id, debit_cents, credit_cents')
      .in('gl_entry_id', periodEntries.map((e) => e.id))
      .in('account_id', accountIds);
    for (const line of periodLines ?? []) {
      const existing = activityMap.get(line.account_id) ?? 0;
      activityMap.set(line.account_id, existing + Number(line.credit_cents ?? 0) - Number(line.debit_cents ?? 0));
    }
  }

  // Get net income for the period (revenue - expenses)
  let netIncome = 0;
  if (periodEntries && periodEntries.length > 0) {
    const { data: pnlLines } = await supabase
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents, accounts!inner(account_type)')
      .in('gl_entry_id', periodEntries.map((e) => e.id))
      .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']);
    for (const line of pnlLines ?? []) {
      const acct = line.accounts as any;
      if (acct.account_type === 'REVENUE') {
        netIncome += Number(line.credit_cents ?? 0) - Number(line.debit_cents ?? 0);
      } else {
        netIncome -= Number(line.debit_cents ?? 0) - Number(line.credit_cents ?? 0);
      }
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
