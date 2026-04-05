export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const startDate = searchParams.get('start_date');
  const endDate = searchParams.get('end_date');
  const fiscalYear = parseInt(searchParams.get('fiscal_year') ?? String(new Date().getFullYear()), 10);
  const periodNumber = parseInt(searchParams.get('period_number') ?? '0', 10);

  // Get budget data
  let budgetQ = supabase
    .from('budgets')
    .select(`
      account_id, amount_cents, period_number,
      account:accounts!budgets_account_id_fkey(account_number, name, account_type)
    `)
    .eq('fiscal_year', fiscalYear);

  if (locationId) budgetQ = budgetQ.eq('location_id', locationId);
  if (periodNumber > 0) budgetQ = budgetQ.eq('period_number', periodNumber);

  const { data: budgetData } = await budgetQ;

  // Aggregate budgets by account
  const budgetMap = new Map<string, { accountNumber: string; accountName: string; accountType: string; budgetCents: number }>();
  for (const b of budgetData ?? []) {
    const acct = Array.isArray(b.account) ? b.account[0] : b.account;
    if (!acct) continue;
    const existing = budgetMap.get(b.account_id);
    if (existing) {
      existing.budgetCents += Number(b.amount_cents);
    } else {
      budgetMap.set(b.account_id, {
        accountNumber: acct.account_number,
        accountName: acct.name,
        accountType: acct.account_type,
        budgetCents: Number(b.amount_cents),
      });
    }
  }

  // Get actual data from GL for the same period
  const actualStart = startDate ?? `${fiscalYear}-01-01`;
  const actualEnd = endDate ?? `${fiscalYear}-12-31`;

  let entriesQ = supabase
    .from('gl_entries')
    .select('id')
    .eq('status', 'POSTED')
    .gte('entry_date', actualStart)
    .lte('entry_date', actualEnd);
  if (locationId) entriesQ = entriesQ.eq('location_id', locationId);

  const { data: entries } = await entriesQ;
  const entryIds = (entries ?? []).map((e) => e.id);

  const actualMap = new Map<string, number>();
  if (entryIds.length > 0) {
    const { data: lines } = await supabase
      .from('gl_entry_lines')
      .select('account_id, debit_cents, credit_cents')
      .in('gl_entry_id', entryIds);

    for (const line of lines ?? []) {
      const existing = actualMap.get(line.account_id) ?? 0;
      // Net amount: for expense accounts (debit-normal), net = debits - credits
      // For revenue accounts (credit-normal), net = credits - debits
      // We'll figure out the sign in the merge step
      actualMap.set(line.account_id, existing + Number(line.debit_cents ?? 0) - Number(line.credit_cents ?? 0));
    }
  }

  // Merge budget + actual
  const allAccountIds = new Set([...budgetMap.keys(), ...actualMap.keys()]);
  const rows: {
    accountId: string;
    accountNumber: string;
    accountName: string;
    accountType: string;
    budgetCents: number;
    actualCents: number;
    varianceCents: number;
    variancePct: number;
    isFavorable: boolean;
  }[] = [];

  for (const accountId of allAccountIds) {
    const budget = budgetMap.get(accountId);
    const actualNet = actualMap.get(accountId) ?? 0;

    // Get account info if we only have actual (no budget)
    let accountNumber = budget?.accountNumber ?? '';
    let accountName = budget?.accountName ?? '';
    let accountType = budget?.accountType ?? '';

    if (!budget && accountNumber === '') {
      // Look up account info
      const { data: acct } = await supabase
        .from('accounts')
        .select('account_number, name, account_type')
        .eq('id', accountId)
        .single();
      if (acct) {
        accountNumber = acct.account_number;
        accountName = acct.name;
        accountType = acct.account_type;
      }
    }

    // Skip non-P&L accounts for budget comparison
    if (!['REVENUE', 'COGS', 'OPEX', 'OTHER'].includes(accountType)) continue;

    // For revenue: actual = credits - debits (flip sign)
    const actualCents = accountType === 'REVENUE' ? -actualNet : actualNet;
    const budgetCents = budget?.budgetCents ?? 0;
    const varianceCents = budgetCents - actualCents;

    // Favorable: revenue over budget is good, expenses under budget is good
    const isFavorable = accountType === 'REVENUE'
      ? actualCents > budgetCents
      : actualCents < budgetCents;

    const variancePct = budgetCents !== 0 ? Math.round((varianceCents / Math.abs(budgetCents)) * 10000) / 100 : 0;

    rows.push({
      accountId,
      accountNumber,
      accountName,
      accountType,
      budgetCents,
      actualCents,
      varianceCents,
      variancePct,
      isFavorable,
    });
  }

  rows.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  // Totals by type
  const totals: Record<string, { budget: number; actual: number; variance: number }> = {};
  for (const r of rows) {
    if (!totals[r.accountType]) totals[r.accountType] = { budget: 0, actual: 0, variance: 0 };
    totals[r.accountType].budget += r.budgetCents;
    totals[r.accountType].actual += r.actualCents;
    totals[r.accountType].variance += r.varianceCents;
  }

  return NextResponse.json({
    period: { fiscalYear, startDate: actualStart, endDate: actualEnd },
    data: rows,
    totals,
  });
}
