export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { z } from 'zod';
import { buildReforecast, type ReforecastAccountInput } from '@/lib/budget/reforecast';
import type { AccountType } from '@/lib/budget/drivers';
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all';
import { resolveCashAccountIds } from '@/lib/cash/book-cash';
import { getOrgToday } from '@/lib/dates/org-today';
import {
  computeKpiSet,
  computeRunway,
  computePlanVariance,
  computeTrend,
  type PnlAggregate,
  type KpiInputs,
  type PlanRow,
  type PnlSection,
  type TrendPointInput,
} from '@/lib/fpna/dashboard';
import { keepMonths, loadBudgetPnlByMonth, loadPnlByMonth, sumPnl } from '@/lib/fpna/pnl-range';
import { governedClosedThrough, governedNetIncomeSeries, lastShownMonth, MAX_FPNA_WINDOW_MONTHS, withholdActualBuckets } from '@/lib/fpna/governed';
import { governRouteMonths, memoFactsLoader, resolveRouteAudience, type RouteGuardContext } from '@/lib/reports/governance/route-guard';
import {
  isMonthKey,
  minMonth,
  monthRange,
  normalizeFyStart,
  resolveComparison,
  windowBounds,
  type PeriodBasis,
  type ResolvedComparison,
} from '@/lib/period/resolve';

/**
 * GET /api/fpna/dashboard — the read-only FP&A command center (Pillar 3).
 *
 * Deterministic. RLS-scoped (runs AS THE USER — tenant isolation enforced by the
 * DB). Gated on `reports:view`. It NEVER writes. It reuses the EXACT account-type
 * math the income-statement / balance-sheet / budget-vs-actual routes use, and
 * the `buildReforecast` blend engine for the forecast column — nothing is forked.
 *
 * Returns, for a fiscal year + as-of month:
 *  - KPIs for the current month with prior-month deltas (revenue, gross margin,
 *    operating income, net income, cash, AR, AP, working capital, current ratio),
 *  - monthly burn + cash runway,
 *  - a variance table (Actual YTD / Budget FY / Forecast FY) by section + net income,
 *  - 12-month trend series (revenue, profit tiers, margins).
 *
 * PERIOD-AWARE KPIs (shared PeriodPicker): pass `period_end` (YYYY-MM) + `basis` (month · qtd ·
 * quarter · ytd · fy · ttm · range, with `period_start` for range) and `compare` (prior_period ·
 * prior_year · budget · none). The P&L KPIs then cover the whole window (YTD, TTM, last year, a
 * quarter, a custom range) and the deltas compare with the chosen window; balance-sheet KPIs are
 * as of the window end vs the comparison end (budget has no balance sheet → no BS deltas). The
 * fiscal year / as-of month for the variance table and trend follow the window's end month.
 * Without `period_end` the route behaves exactly as before (one month vs the prior month).
 *
 * NUMBER GOVERNANCE (route-guard; FPB §18): for a non-finance caller every actual figure is
 * limited to RELEASED months — withheld months' actuals are zeroed before any figure is
 * computed and dropped from the trend; the reforecast never treats a withheld month as actual;
 * KPIs whose window (or whose as-of balance — cumulative rule) is not released are withheld
 * (`kpis` / `priorKpis` null, `deltas` {}), and so is runway. Without an explicit as-of month a
 * non-finance caller sees the year as of the latest released month. Finance passes through
 * (preview). A window longer than 60 months is refused (400).
 */

const querySchema = z.object({
  fiscal_year: z.string().regex(/^\d{4}$/).optional(),
  as_of_month: z.string().regex(/^([1-9]|1[0-2])$/).optional(),
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  department_id: z.string().optional(),
  method: z.enum(['budget_remaining', 'run_rate']).optional(),
  period_end: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  period_start: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  basis: z.enum(['month', 'qtd', 'quarter', 'ytd', 'fy', 'ttm', 'range']).optional(),
  compare: z.enum(['none', 'prior_period', 'prior_year', 'budget']).optional(),
});

const PNL_TYPES: AccountType[] = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];
const CURRENT_ASSET_SUBTYPES = ['CASH', 'CURRENT_ASSET'];
const CURRENT_LIAB_SUBTYPES = ['CURRENT_LIABILITY'];

/** One account's 12-month budget + actual buckets, natural sign. */
interface AcctBuckets {
  accountNumber: string;
  accountName: string;
  accountType: AccountType;
  budget: number[];
  actual: number[];
}

/** Natural-sign period amount for a P&L line. */
function naturalPnl(type: string, debit: number, credit: number): number {
  return type === 'REVENUE' ? credit - debit : debit - credit;
}

/** Sum the 4 section buckets across accounts for a given month index. */
function monthPnl(accts: AcctBuckets[], monthIdx: number): PnlAggregate {
  const agg: PnlAggregate = { revenueCents: 0, cogsCents: 0, opexCents: 0, otherCents: 0 };
  for (const a of accts) {
    const v = a.actual[monthIdx] ?? 0;
    switch (a.accountType) {
      case 'REVENUE': agg.revenueCents += v; break;
      case 'COGS': agg.cogsCents += v; break;
      case 'OPEX': agg.opexCents += v; break;
      case 'OTHER': agg.otherCents += v; break;
    }
  }
  return agg;
}

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  // RBAC: gate on financial-reports view (same permission that guards the
  // statements this dashboard summarizes). Fails closed.
  const guard = await requirePermission(ctx.userId, 'reports', 'view');
  if (!guard.ok) return guard.response;

  const { supabase } = ctx;
  // "Now" is the ORG's calendar date, not the server's UTC clock.
  const [todayY, todayM] = (await getOrgToday(supabase, ctx.orgId)).split('-').map(Number);
  const ranged = Boolean(params.period_end && isMonthKey(params.period_end));
  const fiscalYear = ranged ? Number(params.period_end!.slice(0, 4)) : parseInt(params.fiscal_year ?? String(todayY), 10);
  const isCurrentYear = fiscalYear === todayY;
  const defaultMonth = isCurrentYear ? todayM : 12;
  // Ranged: the window's end month, capped at today's month (a whole current year / quarter
  // runs past today — balances, burn and the variance cut-off stop at today).
  let asOfMonth = ranged
    ? Math.min(Number(params.period_end!.slice(5, 7)), defaultMonth)
    : params.as_of_month ? parseInt(params.as_of_month, 10) : defaultMonth;

  const locationIds = [
    ...(params.location_id && params.location_id !== 'all' ? [params.location_id] : []),
    ...(params.location_ids?.split(',').filter(Boolean) ?? []),
  ];
  const departmentId = params.department_id ?? null;
  const method = params.method ?? 'budget_remaining';

  const pad = (n: number) => String(n).padStart(2, '0');

  // ── 0. Window (ranged) + number governance ─────────────────────────────────
  let fyStart = 1;
  let win: { basis: PeriodBasis; start: string; end: string; months: string[] } | null = null;
  let comparison: ResolvedComparison | null = null;
  if (ranged) {
    const { data: orgRow } = await supabase.schema('core').from('organizations').select('fiscal_year_start_month').eq('id', ctx.orgId).maybeSingle();
    fyStart = normalizeFyStart((orgRow as { fiscal_year_start_month?: number | null } | null)?.fiscal_year_start_month ?? 1);
    const basis: PeriodBasis = params.basis ?? (params.period_start ? 'range' : 'month');
    const b = windowBounds({ basis, end: params.period_end!, start: params.period_start }, fyStart);
    const months = monthRange(b.start, b.end);
    if (months.length > MAX_FPNA_WINDOW_MONTHS) {
      return NextResponse.json({ error: 'Pick a window of five years or less', code: 'RANGE_TOO_LONG' }, { status: 400 });
    }
    win = { basis, start: b.start, end: b.end, months };
    comparison = resolveComparison(basis, { start: b.start, end: b.end, months }, params.compare ?? 'prior_period', fyStart);
    if (comparison && comparison.kind !== 'budget' && comparison.months.length > MAX_FPNA_WINDOW_MONTHS) {
      return NextResponse.json({ error: 'Pick a window of five years or less', code: 'RANGE_TOO_LONG' }, { status: 400 });
    }
  }
  const fyMonths = Array.from({ length: 12 }, (_, i) => `${fiscalYear}-${pad(i + 1)}`);
  const govCtx: RouteGuardContext = { supabase, orgId: ctx.orgId, userId: ctx.userId, deps: { loadFacts: memoFactsLoader() } };
  govCtx.audience = await resolveRouteAudience(govCtx);
  const actualMonths = new Set<string>(fyMonths);
  for (const m of win?.months ?? []) actualMonths.add(m);
  if (comparison && comparison.kind !== 'budget') for (const m of comparison.months) actualMonths.add(m);
  const gov = await governRouteMonths(govCtx, { months: Array.from(actualMonths), locationIds });
  const finance = gov.finance;
  const fyShown = fyMonths.map((m) => gov.isShown(m));
  // Default view for a non-finance caller: the year as of its latest released month.
  if (!finance && !ranged && !params.as_of_month) {
    const last = lastShownMonth(fyShown);
    if (last > 0) asOfMonth = Math.min(asOfMonth, last);
  }
  const asOfDate = `${fiscalYear}-${pad(asOfMonth)}-${pad(new Date(fiscalYear, asOfMonth, 0).getDate())}`;
  const priorMonthEnd =
    asOfMonth > 1 ? `${fiscalYear}-${pad(asOfMonth - 1)}-${pad(new Date(fiscalYear, asOfMonth - 1, 0).getDate())}` : `${fiscalYear - 1}-12-31`;

  // ── 1. Budgets by account × month ──────────────────────────────────────────
  // Every read below is paged (PostgREST caps a response at 1,000 rows).
  const buildBudgetQ = () => {
    let budgetQ = supabase
      .from('budgets')
      .select(`account_id, amount_cents, period_number,
               account:accounts!budgets_account_id_fkey(account_number, name, account_type)`)
      .eq('fiscal_year', fiscalYear);
    if (locationIds.length === 1) budgetQ = budgetQ.eq('location_id', locationIds[0]);
    else if (locationIds.length > 1) budgetQ = budgetQ.in('location_id', locationIds);
    if (departmentId) budgetQ = budgetQ.eq('department_id', departmentId);
    return budgetQ;
  };
  const { data: budgetData, error: budgetErr } = await fetchAll(buildBudgetQ, { label: 'fpna budgets' });
  if (budgetErr) return NextResponse.json({ error: budgetErr.message, code: 'QUERY_ERROR' }, { status: 500 });

  const acctMap = new Map<string, AcctBuckets>();
  const ensure = (id: string, type: AccountType, num: string, name: string): AcctBuckets => {
    let m = acctMap.get(id);
    if (!m) {
      m = { accountNumber: num, accountName: name, accountType: type, budget: new Array<number>(12).fill(0), actual: new Array<number>(12).fill(0) };
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
    ensure(b.account_id, type, acct.account_number, acct.name).budget[period - 1] += Number(b.amount_cents);
  }

  // ── 2. Actuals from posted GL, bucketed by month ───────────────────────────
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
  const { data: entries, error: entryErr } = await fetchAll(buildEntriesQ, { label: 'fpna gl_entries' });
  if (entryErr) return NextResponse.json({ error: entryErr.message, code: 'QUERY_ERROR' }, { status: 500 });

  const monthByEntry = new Map<string, number>();
  for (const e of entries ?? []) {
    const idx = parseInt(String(e.entry_date).slice(5, 7), 10) - 1;
    if (idx >= 0 && idx < 12) monthByEntry.set(e.id, idx);
  }
  const entryIds = Array.from(monthByEntry.keys());
  if (entryIds.length > 0) {
    const { data: lines, error: lineErr } = await fetchAllIn(
      entryIds,
      (chunk) => {
        let linesQ = supabase
          .from('gl_entry_lines')
          .select(`gl_entry_id, account_id, debit_cents, credit_cents,
                   account:accounts!gl_entry_lines_account_id_fkey(account_number, name, account_type)`)
          .in('gl_entry_id', chunk);
        if (departmentId) linesQ = linesQ.eq('department_id', departmentId);
        return linesQ;
      },
      { label: 'fpna gl_entry_lines' },
    );
    if (lineErr) return NextResponse.json({ error: lineErr.message, code: 'QUERY_ERROR' }, { status: 500 });
    for (const line of lines ?? []) {
      const idx = monthByEntry.get(line.gl_entry_id);
      if (idx == null) continue;
      const acct = Array.isArray(line.account) ? line.account[0] : line.account;
      if (!acct) continue;
      const type = acct.account_type as AccountType;
      if (!PNL_TYPES.includes(type)) continue;
      const m = ensure(line.account_id, type, acct.account_number, acct.name);
      m.actual[idx] += naturalPnl(type, Number(line.debit_cents ?? 0), Number(line.credit_cents ?? 0));
    }
  }
  const accts = Array.from(acctMap.values());
  // Withheld months' actuals never reach a figure (non-finance).
  if (!finance) withholdActualBuckets(accts, fyShown);

  // ── 3. Balance-sheet snapshot (as-of date) — cash / AR / AP / working capital
  //      Classified by account_type + sub_type + is_bank flag (never by number).
  // Cash uses the CANONICAL cash-account set (lib/cash/book-cash) so FP&A ties to
  // every other "cash" figure in the app.
  const cashIds = await resolveCashAccountIds(supabase, ctx.orgId);
  const snapshot = async (asOf: string) => {
    const buildQ = () => {
      let q = supabase
        .from('gl_entry_lines')
        .select(`account_id, debit_cents, credit_cents,
                 accounts!inner(account_type, account_sub_type, is_bank_account, name),
                 gl_entries!inner(entry_date, status)`)
        .eq('gl_entries.status', 'POSTED')
        .lte('gl_entries.entry_date', asOf)
        .in('accounts.account_type', ['ASSET', 'LIABILITY']);
      if (locationIds.length === 1) q = q.eq('location_id', locationIds[0]);
      else if (locationIds.length > 1) q = q.in('location_id', locationIds);
      return q;
    };
    const { data, error } = await fetchAll(buildQ, { label: 'fpna balance snapshot gl_entry_lines' });
    if (error) throw new Error(error.message);

    let cashCents = 0, arCents = 0, apCents = 0, currentAssetsCents = 0, currentLiabilitiesCents = 0;
    for (const line of data ?? []) {
      const acct = line.accounts as unknown as Record<string, unknown>;
      const type = acct.account_type as string;
      const subType = (acct.account_sub_type as string) ?? '';
      const name = ((acct.name as string) ?? '').toLowerCase();
      const debit = Number(line.debit_cents ?? 0);
      const credit = Number(line.credit_cents ?? 0);
      // Normal balance is deterministic for the two types queried: ASSET = debit-
      // normal, LIABILITY = credit-normal (CANON §3 — direction derives from type).
      const bal = type === 'ASSET' ? debit - credit : credit - debit;

      const isCurrentAsset = CURRENT_ASSET_SUBTYPES.includes(subType);
      const isCurrentLiab = CURRENT_LIAB_SUBTYPES.includes(subType);
      if (type === 'ASSET') {
        if (cashIds.has(line.account_id as string)) cashCents += bal;
        if (isCurrentAsset) currentAssetsCents += bal;
        // AR family: current assets named "…receivable" (control + sub-ledgers).
        if (isCurrentAsset && name.includes('receivable')) arCents += bal;
      } else if (type === 'LIABILITY') {
        if (isCurrentLiab) currentLiabilitiesCents += bal;
        // AP family: current liabilities named "…payable".
        if (isCurrentLiab && name.includes('payable')) apCents += bal;
      }
    }
    return { cashCents, arCents, apCents, currentAssetsCents, currentLiabilitiesCents };
  };

  // Balances are point-in-time: the cumulative rule (every month through the as-of month).
  const monthKeyOfDate = (d: string) => d.slice(0, 7);
  const balanceMonths = [monthKeyOfDate(asOfDate), monthKeyOfDate(priorMonthEnd)];
  if (comparison && comparison.kind !== 'budget') balanceMonths.push(monthKeyOfDate(comparison.endDate));
  const balGov = await governRouteMonths(govCtx, { months: balanceMonths, locationIds, cumulative: true });
  const balanceShown = (d: string) => balGov.isShown(monthKeyOfDate(d));

  let currentBalance, priorBalance;
  try {
    [currentBalance, priorBalance] = await Promise.all([snapshot(asOfDate), snapshot(priorMonthEnd)]);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Balance query failed', code: 'QUERY_ERROR' }, { status: 500 });
  }

  // ── 4. KPIs + deltas ───────────────────────────────────────────────────────
  //   legacy: current month vs prior month (within the year)
  //   ranged: the picked window vs the picked comparison (any months, across years)
  // A KPI set is shown only when its whole P&L window AND its as-of balance are shown.
  let kpiSet: ReturnType<typeof computeKpiSet> | null;
  let range: { start: string; end: string; months: number; basis: PeriodBasis } | null = null;
  const allShown = (months: readonly string[]) => months.every((m) => gov.isShown(m));
  if (win) {
    const { months } = win;
    range = { start: win.start, end: win.end, months: months.length, basis: win.basis };
    const scope = { orgId: ctx.orgId as string, locationIds, departmentId };
    const fetchFrom = comparison && comparison.kind !== 'budget' ? minMonth(comparison.start, win.start) : win.start;
    const loaded = await loadPnlByMonth(supabase, scope, fetchFrom, win.end);
    if (loaded.error) return NextResponse.json({ error: loaded.error, code: 'QUERY_ERROR' }, { status: 500 });
    const actuals = { data: finance ? loaded.data : keepMonths(loaded.data, (m) => gov.isShown(m)) };
    // Balances are as of asOfDate = the window end (or today's month end when the window runs past it).
    const curBal = currentBalance;
    const curOk = allShown(months) && balanceShown(asOfDate);
    const curInputs: KpiInputs = { pnl: sumPnl(actuals.data, months), balance: curBal };
    let priInputs: KpiInputs | null = null;
    if (comparison?.kind === 'budget') {
      const budget = await loadBudgetPnlByMonth(supabase, scope, win.start, win.end, fyStart);
      if (budget.error) return NextResponse.json({ error: budget.error, code: 'QUERY_ERROR' }, { status: 500 });
      priInputs = budget.hasBudget ? { pnl: sumPnl(budget.data, months), balance: curBal } : null;
    } else if (comparison && allShown(comparison.months) && balanceShown(comparison.endDate)) {
      let cmpBal;
      try {
        cmpBal = await snapshot(comparison.endDate);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : 'Balance query failed', code: 'QUERY_ERROR' }, { status: 500 });
      }
      priInputs = { pnl: sumPnl(actuals.data, comparison.months), balance: cmpBal };
    }
    kpiSet = curOk ? computeKpiSet(curInputs, priInputs) : null;
    // A budget has no balance sheet: drop the (meaningless, always-flat) balance deltas.
    if (kpiSet && comparison?.kind === 'budget') {
      for (const k of ['cash', 'ar', 'ap', 'workingCapital', 'currentRatio']) delete kpiSet.deltas[k];
    }
  } else {
    const curOk = fyShown[asOfMonth - 1] === true && balanceShown(asOfDate);
    const priOk = asOfMonth > 1 && fyShown[asOfMonth - 2] === true && balanceShown(priorMonthEnd);
    const curMonthPnl = monthPnl(accts, asOfMonth - 1);
    const priMonthPnl = priOk ? monthPnl(accts, asOfMonth - 2) : null;
    const curInputs: KpiInputs = { pnl: curMonthPnl, balance: currentBalance };
    const priInputs: KpiInputs | null = priMonthPnl ? { pnl: priMonthPnl, balance: priorBalance } : null;
    kpiSet = curOk ? computeKpiSet(curInputs, priInputs) : null;
  }

  // ── 5. Trend series (12 months) + runway from the trailing net-income series
  const trendInputs: TrendPointInput[] = [];
  const netIncomeByMonth: number[] = [];
  for (let m = 0; m < 12; m++) {
    const p = monthPnl(accts, m);
    netIncomeByMonth.push((p.revenueCents - p.cogsCents) - p.opexCents - p.otherCents);
    // Withheld months are dropped from the trend (never plotted as zero).
    if (!fyShown[m]) continue;
    trendInputs.push({ label: new Date(fiscalYear, m, 1).toLocaleString('en-US', { month: 'short' }), pnl: p });
  }
  const trend = computeTrend(trendInputs);
  // Only closed/elapsed (and shown) months feed the burn average; no released balance → no runway.
  const runway = balanceShown(asOfDate)
    ? computeRunway(currentBalance.cashCents, governedNetIncomeSeries(netIncomeByMonth, asOfMonth, fyShown))
    : null;

  // ── 6. Variance table (Actual YTD / Budget FY / Forecast FY) ────────────────
  const reforecastInputs: ReforecastAccountInput[] = accts.map((m) => ({
    accountId: `${m.accountNumber}-${m.accountName}`,
    accountNumber: m.accountNumber,
    accountName: m.accountName,
    accountType: m.accountType,
    budgetByMonth: m.budget,
    actualByMonth: m.actual,
  }));
  const reforecast = buildReforecast(reforecastInputs, { closedThroughPeriod: governedClosedThrough(asOfMonth, fyShown, finance), method });
  const planRows: PlanRow[] = reforecast.accounts.map((a) => ({
    key: a.accountNumber,
    label: a.accountName,
    section: a.accountType as PnlSection,
    actualCents: a.actualToDateCents,
    budgetCents: a.budgetFullYearCents,
    forecastCents: a.reforecastFullYearCents,
  }));
  const variance = computePlanVariance(planRows);

  return NextResponse.json({
    period: {
      fiscalYear,
      asOfMonth,
      asOfDate,
      label: `${new Date(fiscalYear, asOfMonth - 1).toLocaleString('en-US', { month: 'long' })} ${fiscalYear}`,
      forecastMethod: method,
    },
    range,
    comparison: comparison
      ? { kind: comparison.kind, start: comparison.start, end: comparison.end, label: comparison.label, vsLabel: comparison.vsLabel }
      : null,
    kpis: kpiSet?.current ?? null,
    priorKpis: kpiSet?.prior ?? null,
    deltas: kpiSet?.deltas ?? {},
    runway,
    variance,
    trend,
    filters: {
      locationIds: locationIds.length > 0 ? locationIds : ['all'],
      departmentId,
    },
    meta: {
      accountCount: accts.length,
      hasBudget: (budgetData ?? []).length > 0,
      generatedAt: new Date().toISOString(),
    },
    governance: { ...gov.info, withheldPeriods: fyMonths.filter((_, i) => !fyShown[i]), kpisWithheld: kpiSet === null, runwayWithheld: runway === null },
  });
});
