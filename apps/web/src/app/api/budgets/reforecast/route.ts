export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { budgetReadScope } from '@/lib/budgets/route-support';
import {
  buildReforecast,
  type ReforecastAccountInput,
  type ReforecastMethod,
} from '@/lib/budget/reforecast';
import type { AccountType } from '@/lib/budget/drivers';
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all';

// ─────────────────────────────────────────────────────────────────────────────
// Rolling reforecast — closed-month ACTUALS + projected open months, measured
// against the original budget. Reads the SAME sources as budget-vs-actual (the
// budgets table + posted GL) but buckets both by month, then hands them to the
// pure `buildReforecast` blend engine. RLS-scoped (runs AS THE USER).
// ─────────────────────────────────────────────────────────────────────────────

const PNL_TYPES: AccountType[] = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  const { searchParams } = new URL(request.url);
  const locationIds = [
    ...(searchParams.get('location_id') ? [searchParams.get('location_id') as string] : []),
    ...(searchParams.get('location_ids')?.split(',').filter(Boolean) ?? []),
  ];
  const deptRaw = searchParams.get('department_id'); // optional dimension scope
  // SECURITY (H6): budget view permission per company + department scope (a department owner sees
  // only their departments, never company-level lines) — public.budgets / GL carry no dept RLS.
  const scope = await budgetReadScope(ctx, locationIds, deptRaw && deptRaw !== 'null' ? deptRaw : null);
  if (scope instanceof NextResponse) return scope;
  const deptIds = scope.departmentIds;
  const fiscalYear = parseInt(
    searchParams.get('fiscal_year') ?? String(new Date().getFullYear()),
    10
  );
  const method: ReforecastMethod =
    searchParams.get('method') === 'run_rate' ? 'run_rate' : 'budget_remaining';

  // How much of the year is closed. Default: months strictly before the current
  // month IF the year is the current one, else the whole year for a past year,
  // else 0 for a future year. Caller may override with ?closed_through=N.
  const now = new Date();
  let defaultClosed = 0;
  if (fiscalYear < now.getFullYear()) defaultClosed = 12;
  else if (fiscalYear === now.getFullYear()) defaultClosed = now.getMonth(); // months fully closed
  const closedThroughPeriod = searchParams.get('closed_through')
    ? parseInt(searchParams.get('closed_through') as string, 10)
    : defaultClosed;

  // ── Budgets by account × month ──
  // Paged: an annual budget (accounts × 12 periods × entities) passes PostgREST's 1,000-row cap.
  const buildBudgetQ = () => {
    let budgetQ = supabase
      .from('budgets')
      .select(
        `account_id, amount_cents, period_number,
         account:accounts!budgets_account_id_fkey(account_number, name, account_type)`
      )
      .eq('fiscal_year', fiscalYear);
    if (locationIds.length === 1) budgetQ = budgetQ.eq('location_id', locationIds[0]);
    else if (locationIds.length > 1) budgetQ = budgetQ.in('location_id', locationIds);
    if (deptIds) budgetQ = budgetQ.in('department_id', deptIds);
    return budgetQ;
  };

  const { data: budgetData, error: budgetErr } = await fetchAll(buildBudgetQ, { label: 'reforecast budgets' });
  if (budgetErr) return NextResponse.json({ error: budgetErr.message }, { status: 500 });

  interface AcctMeta {
    accountNumber: string;
    accountName: string;
    accountType: AccountType;
    budget: number[];
    actual: number[];
  }
  const acctMap = new Map<string, AcctMeta>();
  const ensure = (id: string, type: AccountType, num: string, name: string): AcctMeta => {
    let m = acctMap.get(id);
    if (!m) {
      m = {
        accountNumber: num,
        accountName: name,
        accountType: type,
        budget: new Array<number>(12).fill(0),
        actual: new Array<number>(12).fill(0),
      };
      acctMap.set(id, m);
    }
    return m;
  };

  for (const b of budgetData ?? []) {
    const acct = Array.isArray(b.account) ? b.account[0] : b.account;
    if (!acct) continue;
    const type = acct.account_type as AccountType;
    if (!PNL_TYPES.includes(type)) continue;
    const period = Number(b.period_number);
    if (period < 1 || period > 12) continue;
    const m = ensure(b.account_id, type, acct.account_number, acct.name);
    m.budget[period - 1] += Number(b.amount_cents);
  }

  // ── Actuals from posted GL, bucketed by month ──
  // Paged + chunked: PostgREST caps a response at 1,000 rows and a long
  // `.in(gl_entry_id, …)` list overflows the URL.
  const buildEntriesQ = () => {
    let entriesQ = supabase
      .from('gl_entries')
      .select('id, entry_date')
      .eq('status', 'POSTED')
      .gte('entry_date', `${fiscalYear}-01-01`)
      .lte('entry_date', `${fiscalYear}-12-31`);
    if (locationIds.length === 1) entriesQ = entriesQ.eq('location_id', locationIds[0]);
    else if (locationIds.length > 1) entriesQ = entriesQ.in('location_id', locationIds);
    return entriesQ;
  };

  const { data: entries, error: entryErr } = await fetchAll(buildEntriesQ, { label: 'reforecast gl_entries' });
  if (entryErr) return NextResponse.json({ error: entryErr.message }, { status: 500 });

  const monthByEntry = new Map<string, number>(); // entryId → month index 0..11
  for (const e of entries ?? []) {
    const monthIdx = parseInt(String(e.entry_date).slice(5, 7), 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) monthByEntry.set(e.id, monthIdx);
  }
  const entryIds = Array.from(monthByEntry.keys());

  if (entryIds.length > 0) {
    const { data: lines, error: lineErr } = await fetchAllIn(
      entryIds,
      (chunk) => {
        let linesQ = supabase
          .from('gl_entry_lines')
          .select(
            `gl_entry_id, account_id, debit_cents, credit_cents,
             account:accounts!gl_entry_lines_account_id_fkey(account_number, name, account_type)`
          )
          .in('gl_entry_id', chunk);
        if (deptIds) linesQ = linesQ.in('department_id', deptIds);
        return linesQ;
      },
      { label: 'reforecast gl_entry_lines' },
    );
    if (lineErr) return NextResponse.json({ error: lineErr.message }, { status: 500 });

    for (const line of lines ?? []) {
      const monthIdx = monthByEntry.get(line.gl_entry_id);
      if (monthIdx == null) continue;
      const acct = Array.isArray(line.account) ? line.account[0] : line.account;
      if (!acct) continue;
      const type = acct.account_type as AccountType;
      if (!PNL_TYPES.includes(type)) continue;
      const m = ensure(line.account_id, type, acct.account_number, acct.name);
      const debit = Number(line.debit_cents ?? 0);
      const credit = Number(line.credit_cents ?? 0);
      // Natural sign: revenue = credits − debits; expense lines = debits − credits.
      const natural = type === 'REVENUE' ? credit - debit : debit - credit;
      m.actual[monthIdx] += natural;
    }
  }

  const inputs: ReforecastAccountInput[] = Array.from(acctMap.entries()).map(([id, m]) => ({
    accountId: id,
    accountNumber: m.accountNumber,
    accountName: m.accountName,
    accountType: m.accountType,
    budgetByMonth: m.budget,
    actualByMonth: m.actual,
  }));

  const result = buildReforecast(inputs, { closedThroughPeriod, method });
  result.accounts.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  return NextResponse.json({
    fiscalYear,
    method,
    closedThroughPeriod: result.closedThroughPeriod,
    accounts: result.accounts,
    totalsByType: result.totalsByType,
    grandTotals: result.grandTotals,
  });
}
