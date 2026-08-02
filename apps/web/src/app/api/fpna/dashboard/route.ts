export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { z } from 'zod';
import { buildReforecast, type ReforecastAccountInput } from '@/lib/budget/reforecast';
import type { AccountType } from '@/lib/budget/drivers';
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
 */

const querySchema = z.object({
  fiscal_year: z.string().regex(/^\d{4}$/).optional(),
  as_of_month: z.string().regex(/^([1-9]|1[0-2])$/).optional(),
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  department_id: z.string().optional(),
  method: z.enum(['budget_remaining', 'run_rate']).optional(),
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
  const now = new Date();
  const fiscalYear = parseInt(params.fiscal_year ?? String(now.getFullYear()), 10);
  const isCurrentYear = fiscalYear === now.getFullYear();
  const defaultMonth = isCurrentYear ? now.getMonth() + 1 : 12;
  const asOfMonth = params.as_of_month ? parseInt(params.as_of_month, 10) : defaultMonth;

  const locationIds = [
    ...(params.location_id && params.location_id !== 'all' ? [params.location_id] : []),
    ...(params.location_ids?.split(',').filter(Boolean) ?? []),
  ];
  const departmentId = params.department_id ?? null;
  const method = params.method ?? 'budget_remaining';

  const pad = (n: number) => String(n).padStart(2, '0');
  const asOfDate = `${fiscalYear}-${pad(asOfMonth)}-${pad(new Date(fiscalYear, asOfMonth, 0).getDate())}`;
  const priorMonthEnd =
    asOfMonth > 1 ? `${fiscalYear}-${pad(asOfMonth - 1)}-${pad(new Date(fiscalYear, asOfMonth - 1, 0).getDate())}` : `${fiscalYear - 1}-12-31`;

  // ── 1. Budgets by account × month ──────────────────────────────────────────
  let budgetQ = supabase
    .from('budgets')
    .select(`account_id, amount_cents, period_number,
             account:accounts!budgets_account_id_fkey(account_number, name, account_type)`)
    .eq('fiscal_year', fiscalYear);
  if (locationIds.length === 1) budgetQ = budgetQ.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) budgetQ = budgetQ.in('location_id', locationIds);
  if (departmentId) budgetQ = budgetQ.eq('department_id', departmentId);
  const { data: budgetData, error: budgetErr } = await budgetQ;
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
  let entriesQ = supabase
    .from('gl_entries')
    .select('id, entry_date')
    .eq('status', 'POSTED')
    .gte('entry_date', `${fiscalYear}-01-01`)
    .lte('entry_date', `${fiscalYear}-12-31`);
  if (locationIds.length === 1) entriesQ = entriesQ.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) entriesQ = entriesQ.in('location_id', locationIds);
  const { data: entries, error: entryErr } = await entriesQ;
  if (entryErr) return NextResponse.json({ error: entryErr.message, code: 'QUERY_ERROR' }, { status: 500 });

  const monthByEntry = new Map<string, number>();
  for (const e of entries ?? []) {
    const idx = parseInt(String(e.entry_date).slice(5, 7), 10) - 1;
    if (idx >= 0 && idx < 12) monthByEntry.set(e.id, idx);
  }
  const entryIds = Array.from(monthByEntry.keys());
  if (entryIds.length > 0) {
    let linesQ = supabase
      .from('gl_entry_lines')
      .select(`gl_entry_id, account_id, debit_cents, credit_cents,
               account:accounts!gl_entry_lines_account_id_fkey(account_number, name, account_type)`)
      .in('gl_entry_id', entryIds);
    if (departmentId) linesQ = linesQ.eq('department_id', departmentId);
    const { data: lines, error: lineErr } = await linesQ;
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

  // ── 3. Balance-sheet snapshot (as-of date) — cash / AR / AP / working capital
  //      Classified by account_type + sub_type + is_bank flag (never by number).
  const snapshot = async (asOf: string) => {
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
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    let cashCents = 0, arCents = 0, apCents = 0, currentAssetsCents = 0, currentLiabilitiesCents = 0;
    for (const line of data ?? []) {
      const acct = line.accounts as unknown as Record<string, unknown>;
      const type = acct.account_type as string;
      const subType = (acct.account_sub_type as string) ?? '';
      const isBank = Boolean(acct.is_bank_account);
      const name = ((acct.name as string) ?? '').toLowerCase();
      const debit = Number(line.debit_cents ?? 0);
      const credit = Number(line.credit_cents ?? 0);
      // Normal balance is deterministic for the two types queried: ASSET = debit-
      // normal, LIABILITY = credit-normal (CANON §3 — direction derives from type).
      const bal = type === 'ASSET' ? debit - credit : credit - debit;

      const isCurrentAsset = CURRENT_ASSET_SUBTYPES.includes(subType);
      const isCurrentLiab = CURRENT_LIAB_SUBTYPES.includes(subType);
      if (type === 'ASSET') {
        if (isBank || subType === 'CASH') cashCents += bal;
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

  let currentBalance, priorBalance;
  try {
    [currentBalance, priorBalance] = await Promise.all([snapshot(asOfDate), snapshot(priorMonthEnd)]);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Balance query failed', code: 'QUERY_ERROR' }, { status: 500 });
  }

  // ── 4. KPIs + deltas (current month vs prior month) ────────────────────────
  const curMonthPnl = monthPnl(accts, asOfMonth - 1);
  const priMonthPnl = asOfMonth > 1 ? monthPnl(accts, asOfMonth - 2) : null;
  const curInputs: KpiInputs = { pnl: curMonthPnl, balance: currentBalance };
  const priInputs: KpiInputs | null = priMonthPnl ? { pnl: priMonthPnl, balance: priorBalance } : null;
  const kpiSet = computeKpiSet(curInputs, priInputs);

  // ── 5. Trend series (12 months) + runway from the trailing net-income series
  const trendInputs: TrendPointInput[] = [];
  const netIncomeSeries: number[] = [];
  for (let m = 0; m < 12; m++) {
    const p = monthPnl(accts, m);
    trendInputs.push({ label: new Date(fiscalYear, m, 1).toLocaleString('en-US', { month: 'short' }), pnl: p });
    // Only closed/elapsed months feed the burn average.
    if (m < asOfMonth) netIncomeSeries.push((p.revenueCents - p.cogsCents) - p.opexCents - p.otherCents);
  }
  const trend = computeTrend(trendInputs);
  const runway = computeRunway(currentBalance.cashCents, netIncomeSeries);

  // ── 6. Variance table (Actual YTD / Budget FY / Forecast FY) ────────────────
  const reforecastInputs: ReforecastAccountInput[] = accts.map((m) => ({
    accountId: `${m.accountNumber}-${m.accountName}`,
    accountNumber: m.accountNumber,
    accountName: m.accountName,
    accountType: m.accountType,
    budgetByMonth: m.budget,
    actualByMonth: m.actual,
  }));
  const reforecast = buildReforecast(reforecastInputs, { closedThroughPeriod: asOfMonth, method });
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
    kpis: kpiSet.current,
    priorKpis: kpiSet.prior,
    deltas: kpiSet.deltas,
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
  });
});
