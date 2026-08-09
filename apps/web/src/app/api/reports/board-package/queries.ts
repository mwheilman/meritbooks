/**
 * RLS-scoped report queries for the Board Package assembler.
 *
 * These reproduce the aggregation shapes of the existing report endpoints
 * (income-statement, balance-sheet, cash-flow, ar-aging, ap-aging,
 * debt-schedule) so the board package pulls the SAME deterministic figures the
 * on-screen statements show — but within ONE RLS-scoped request, using
 * `ctx.supabase` (org isolation enforced by the database). Read-only. No writes.
 *
 * Account families are resolved BY ROLE (never by hard-coded number ranges) —
 * CANON-ANCHOR §2. Money stays bigint cents throughout.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import { fetchCoreMap } from '@/lib/stitch-core';
import type {
  IncomeStatementPayload,
  BalanceSheetPayload,
  CashFlowPayload,
  AgingPayload,
  DebtPayload,
  TrendPoint,
} from '@/lib/reports/board-package';

export interface PeriodScope {
  startDate: string;
  endDate: string;
  asOfDate: string;
  locationIds: string[];
  basis: 'accrual' | 'cash';
}

const IS_SELECT = `
  account_id, debit_cents, credit_cents, location_id, gl_entry_id,
  accounts!inner(
    account_number, name, account_type, display_order,
    account_groups!inner(
      name, display_order,
      account_sub_types!inner(
        name, display_order,
        account_types!inner(name, display_order, normal_balance)
      )
    )
  ),
  gl_entries!inner(id, entry_date, status)
`;

function applyLoc<T>(q: T, locationIds: string[]): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = q as any;
  if (locationIds.length === 1) return query.eq('location_id', locationIds[0]);
  if (locationIds.length > 1) return query.in('location_id', locationIds);
  return query;
}

// ── Income Statement ─────────────────────────────────────────────────────────
export async function fetchIncomeStatement(
  supabase: SupabaseClient,
  scope: { startDate: string; endDate: string; locationIds: string[]; basis: 'accrual' | 'cash' },
): Promise<IncomeStatementPayload> {
  let query = applyLoc(
    supabase
      .from('gl_entry_lines')
      .select(IS_SELECT)
      .eq('gl_entries.status', 'POSTED')
      .gte('gl_entries.entry_date', scope.startDate)
      .lte('gl_entries.entry_date', scope.endDate)
      .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']),
    scope.locationIds,
  );

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  let rows = (data ?? []) as unknown as Record<string, unknown>[];

  // Cash-basis: keep only entries matched to a cleared bank transaction.
  if (scope.basis === 'cash' && rows.length > 0) {
    const entryIds = [
      ...new Set(rows.map((line) => (line.gl_entries as Record<string, unknown>).id as string)),
    ];
    const { data: bankTxns } = await supabase
      .from('bank_transactions')
      .select('gl_entry_id')
      .in('gl_entry_id', entryIds)
      .in('status', ['APPROVED', 'CATEGORIZED', 'RECONCILED']);
    const cashEntryIds = new Set((bankTxns ?? []).map((t) => t.gl_entry_id as string));
    rows = rows.filter((line) => cashEntryIds.has((line.gl_entries as Record<string, unknown>).id as string));
  }

  interface Acc {
    accountId: string;
    accountNumber: string;
    accountName: string;
    accountType: string;
    groupName: string;
    groupOrder: number;
    normalBalance: string;
    debits: number;
    credits: number;
  }
  const accountMap = new Map<string, Acc>();
  for (const line of rows) {
    const acct = line.accounts as Record<string, unknown>;
    const group = acct.account_groups as Record<string, unknown>;
    const key = acct.account_number as string;
    const existing = accountMap.get(key);
    if (existing) {
      existing.debits += Number(line.debit_cents ?? 0);
      existing.credits += Number(line.credit_cents ?? 0);
    } else {
      const acctType = (group.account_sub_types as Record<string, unknown>).account_types as Record<string, unknown>;
      accountMap.set(key, {
        accountId: line.account_id as string,
        accountNumber: acct.account_number as string,
        accountName: acct.name as string,
        accountType: acct.account_type as string,
        groupName: group.name as string,
        groupOrder: group.display_order as number,
        normalBalance: acctType.normal_balance as string,
        debits: Number(line.debit_cents ?? 0),
        credits: Number(line.credit_cents ?? 0),
      });
    }
  }

  const sectionConfig = [
    { type: 'REVENUE', label: 'Revenue' },
    { type: 'COGS', label: 'Cost of Goods Sold' },
    { type: 'OPEX', label: 'Operating Expenses' },
    { type: 'OTHER', label: 'Other Income / Expense' },
  ];
  const sections: IncomeStatementPayload['sections'] = [];
  for (const cfg of sectionConfig) {
    const accounts = Array.from(accountMap.values())
      .filter((a) => a.accountType === cfg.type)
      .map((a) => ({
        accountId: a.accountId,
        accountNumber: a.accountNumber,
        accountName: a.accountName,
        groupName: a.groupName,
        groupOrder: a.groupOrder,
        amountCents: a.normalBalance === 'CREDIT' ? a.credits - a.debits : a.debits - a.credits,
      }))
      .sort((a, b) => a.groupOrder - b.groupOrder || a.accountNumber.localeCompare(b.accountNumber));

    const groupMap = new Map<string, { accounts: typeof accounts; totalCents: number }>();
    for (const acct of accounts) {
      const existing = groupMap.get(acct.groupName);
      if (existing) {
        existing.accounts.push(acct);
        existing.totalCents += acct.amountCents;
      } else {
        groupMap.set(acct.groupName, { accounts: [acct], totalCents: acct.amountCents });
      }
    }
    const groups = Array.from(groupMap.entries()).map(([name, g]) => ({
      name,
      accounts: g.accounts.map((a) => ({ accountNumber: a.accountNumber, accountName: a.accountName, amountCents: a.amountCents, accountId: a.accountId, groupName: a.groupName })),
      totalCents: g.totalCents,
    }));
    sections.push({ type: cfg.type, label: cfg.label, groups, totalCents: groups.reduce((s, g) => s + g.totalCents, 0) });
  }

  const revenue = sections.find((s) => s.type === 'REVENUE')?.totalCents ?? 0;
  const cogs = sections.find((s) => s.type === 'COGS')?.totalCents ?? 0;
  const opex = sections.find((s) => s.type === 'OPEX')?.totalCents ?? 0;
  const other = sections.find((s) => s.type === 'OTHER')?.totalCents ?? 0;
  const grossProfit = revenue - cogs;
  const ebitda = grossProfit - opex;
  const netIncome = ebitda - other;

  return {
    sections,
    summary: {
      revenueCents: revenue,
      cogsCents: cogs,
      grossProfitCents: grossProfit,
      opexCents: opex,
      ebitdaCents: ebitda,
      otherCents: other,
      netIncomeCents: netIncome,
      grossMarginPct: revenue > 0 ? Math.round((grossProfit / revenue) * 10000) / 100 : 0,
      netMarginPct: revenue > 0 ? Math.round((netIncome / revenue) * 10000) / 100 : 0,
    },
    filters: { startDate: scope.startDate, endDate: scope.endDate, basis: scope.basis },
  };
}

// ── Balance Sheet ────────────────────────────────────────────────────────────
export async function fetchBalanceSheet(
  supabase: SupabaseClient,
  scope: { asOfDate: string; locationIds: string[] },
): Promise<BalanceSheetPayload> {
  let query = applyLoc(
    supabase
      .from('gl_entry_lines')
      .select(IS_SELECT)
      .eq('gl_entries.status', 'POSTED')
      .lte('gl_entries.entry_date', scope.asOfDate)
      .in('accounts.account_type', ['ASSET', 'LIABILITY', 'EQUITY']),
    scope.locationIds,
  );
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  interface Acc {
    accountId: string;
    accountNumber: string;
    accountName: string;
    accountType: string;
    groupName: string;
    subTypeName: string;
    groupOrder: number;
    subTypeOrder: number;
    normalBalance: string;
    debits: number;
    credits: number;
  }
  const accountMap = new Map<string, Acc>();
  for (const line of (data ?? []) as unknown as Record<string, unknown>[]) {
    const acct = line.accounts as Record<string, unknown>;
    const group = acct.account_groups as Record<string, unknown>;
    const subType = group.account_sub_types as Record<string, unknown>;
    const key = acct.account_number as string;
    const existing = accountMap.get(key);
    if (existing) {
      existing.debits += Number(line.debit_cents ?? 0);
      existing.credits += Number(line.credit_cents ?? 0);
    } else {
      const acctType = subType.account_types as Record<string, unknown>;
      accountMap.set(key, {
        accountId: line.account_id as string,
        accountNumber: acct.account_number as string,
        accountName: acct.name as string,
        accountType: acct.account_type as string,
        groupName: group.name as string,
        subTypeName: subType.name as string,
        groupOrder: group.display_order as number,
        subTypeOrder: subType.display_order as number,
        normalBalance: acctType.normal_balance as string,
        debits: Number(line.debit_cents ?? 0),
        credits: Number(line.credit_cents ?? 0),
      });
    }
  }

  const sectionConfig = [
    { type: 'ASSET', label: 'Assets' },
    { type: 'LIABILITY', label: 'Liabilities' },
    { type: 'EQUITY', label: 'Equity' },
  ];
  const sections: BalanceSheetPayload['sections'] = [];
  for (const cfg of sectionConfig) {
    const accounts = Array.from(accountMap.values())
      .filter((a) => a.accountType === cfg.type)
      .map((a) => ({ ...a, balanceCents: a.normalBalance === 'DEBIT' ? a.debits - a.credits : a.credits - a.debits }))
      .sort((a, b) => a.subTypeOrder - b.subTypeOrder || a.groupOrder - b.groupOrder || a.accountNumber.localeCompare(b.accountNumber));

    const subTypeMap = new Map<string, Map<string, { accountNumber: string; accountName: string; balanceCents: number; accountId: string }[]>>();
    for (const acct of accounts) {
      if (!subTypeMap.has(acct.subTypeName)) subTypeMap.set(acct.subTypeName, new Map());
      const groupMap = subTypeMap.get(acct.subTypeName)!;
      if (!groupMap.has(acct.groupName)) groupMap.set(acct.groupName, []);
      groupMap.get(acct.groupName)!.push({
        accountNumber: acct.accountNumber,
        accountName: acct.accountName,
        balanceCents: acct.balanceCents,
        accountId: acct.accountId,
      });
    }
    const subTypes: BalanceSheetPayload['sections'][number]['subTypes'] = [];
    for (const [stName, groupMap] of subTypeMap) {
      const groups = Array.from(groupMap.entries()).map(([gName, accts]) => ({
        name: gName,
        accounts: accts,
        totalCents: accts.reduce((s, a) => s + a.balanceCents, 0),
      }));
      subTypes.push({ name: stName, groups, totalCents: groups.reduce((s, g) => s + g.totalCents, 0) });
    }
    sections.push({ type: cfg.type, label: cfg.label, subTypes, totalCents: subTypes.reduce((s, st) => s + st.totalCents, 0) });
  }

  const totalAssets = sections.find((s) => s.type === 'ASSET')?.totalCents ?? 0;
  const totalLiabilities = sections.find((s) => s.type === 'LIABILITY')?.totalCents ?? 0;
  const totalEquity = sections.find((s) => s.type === 'EQUITY')?.totalCents ?? 0;

  return {
    sections,
    summary: {
      totalAssetsCents: totalAssets,
      totalLiabilitiesCents: totalLiabilities,
      totalEquityCents: totalEquity,
      liabilitiesPlusEquityCents: totalLiabilities + totalEquity,
      isBalanced: totalAssets === totalLiabilities + totalEquity,
      varianceCents: totalAssets - (totalLiabilities + totalEquity),
    },
    filters: { asOfDate: scope.asOfDate },
  };
}

// ── Cash Flow (indirect) ───────────────────────────────────────────────────
interface AcctMeta { type: string; subType: string; isBank: boolean; name: string }
const isDep = (n: string) => n.toLowerCase().includes('depreciation') || n.toLowerCase().includes('amortization');
const isAccumDep = (n: string) => n.toLowerCase().includes('accumulated') && isDep(n);

async function resolveRoleIds(supabase: SupabaseClient, orgId: string, roles: AccountRoleKey[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const role of roles) {
    try {
      const ref = await resolveRole(supabase, orgId, role);
      ids.add(ref.id);
    } catch (e) {
      if (!(e instanceof PostingError)) throw e;
    }
  }
  return ids;
}

export async function fetchCashFlow(
  supabase: SupabaseClient,
  orgId: string,
  scope: { startDate: string; endDate: string; locationIds: string[] },
): Promise<CashFlowPayload> {
  const empty: CashFlowPayload = {
    period: { startDate: scope.startDate, endDate: scope.endDate },
    operating: { netIncome: 0, adjustments: [], changesInWorkingCapital: [], totalCents: 0 },
    investing: { items: [], totalCents: 0 },
    financing: { items: [], totalCents: 0 },
    netChangeCents: 0,
    beginningCashCents: 0,
    endingCashCents: 0,
  };

  let entriesQ = applyLoc(
    supabase.from('gl_entries').select('id').eq('status', 'POSTED').gte('entry_date', scope.startDate).lte('entry_date', scope.endDate),
    scope.locationIds,
  );
  const { data: entryIds } = await entriesQ;
  if (!entryIds || entryIds.length === 0) return empty;

  const { data: accts } = await supabase.from('accounts').select('id, account_type, account_sub_type, is_bank_account, name');
  const acctMeta = new Map<string, AcctMeta>();
  for (const a of accts ?? []) {
    acctMeta.set(a.id as string, {
      type: (a.account_type as string) ?? '',
      subType: (a.account_sub_type as string) ?? '',
      isBank: Boolean(a.is_bank_account),
      name: (a.name as string) ?? '',
    });
  }

  const cashIds = new Set<string>();
  for (const [id, m] of acctMeta) if (m.isBank) cashIds.add(id);
  if (orgId) for (const id of await resolveRoleIds(supabase, orgId, ['CASH_ON_HAND', 'UNDEPOSITED_FUNDS', 'OPERATING_BANK'])) cashIds.add(id);
  const arIds = orgId ? await resolveRoleIds(supabase, orgId, ['AR_CONTROL', 'UNBILLED_RECEIVABLE', 'RETAINAGE_RECEIVABLE', 'ALLOWANCE_DOUBTFUL']) : new Set<string>();
  const apIds = orgId ? await resolveRoleIds(supabase, orgId, ['AP_CONTROL', 'RETAINAGE_PAYABLE', 'ACCRUED_EXPENSES']) : new Set<string>();

  const { data: lines } = await supabase
    .from('gl_entry_lines')
    .select('account_id, debit_cents, credit_cents')
    .in('gl_entry_id', entryIds.map((e: { id: string }) => e.id));

  let revenue = 0, cogs = 0, opex = 0, otherIncome = 0, otherExpense = 0, depreciation = 0;
  let arChange = 0, otherCurrentAssetChange = 0, apChange = 0, otherCurrentLiabChange = 0;
  let fixedAssetChange = 0, debtChange = 0, equityChange = 0;

  for (const line of lines ?? []) {
    const m = acctMeta.get(line.account_id as string);
    if (!m) continue;
    const debit = Number(line.debit_cents ?? 0);
    const credit = Number(line.credit_cents ?? 0);
    if (cashIds.has(line.account_id as string)) continue;
    switch (m.type) {
      case 'REVENUE': revenue += credit - debit; break;
      case 'COGS': cogs += debit - credit; break;
      case 'OPEX': opex += debit - credit; if (isDep(m.name)) depreciation += debit - credit; break;
      case 'OTHER': if (m.subType === 'OTHER_INCOME') otherIncome += credit - debit; else otherExpense += debit - credit; break;
      case 'ASSET':
        if (m.subType === 'FIXED_ASSET' || m.subType === 'OTHER_ASSET') { if (!isAccumDep(m.name)) fixedAssetChange += debit - credit; }
        else if (arIds.has(line.account_id as string)) arChange += debit - credit;
        else otherCurrentAssetChange += debit - credit;
        break;
      case 'LIABILITY':
        if (m.subType === 'LONG_TERM_LIABILITY') debtChange += credit - debit;
        else if (apIds.has(line.account_id as string)) apChange += credit - debit;
        else otherCurrentLiabChange += credit - debit;
        break;
      case 'EQUITY': equityChange += credit - debit; break;
      default: break;
    }
  }

  const netIncome = revenue - cogs - opex + otherIncome - otherExpense;
  const operatingTotal = netIncome + depreciation - arChange - otherCurrentAssetChange + apChange + otherCurrentLiabChange;
  const investingTotal = -fixedAssetChange;
  const financingTotal = debtChange + equityChange;
  const netChange = operatingTotal + investingTotal + financingTotal;

  let beginningCash = 0;
  if (cashIds.size > 0) {
    let priorQ = applyLoc(
      supabase.from('gl_entries').select('id').eq('status', 'POSTED').lt('entry_date', scope.startDate),
      scope.locationIds,
    );
    const { data: priorEntries } = await priorQ;
    if (priorEntries && priorEntries.length > 0) {
      const { data: cashLines } = await supabase
        .from('gl_entry_lines')
        .select('account_id, debit_cents, credit_cents')
        .in('gl_entry_id', priorEntries.map((e: { id: string }) => e.id))
        .in('account_id', Array.from(cashIds));
      for (const cl of cashLines ?? []) beginningCash += Number(cl.debit_cents ?? 0) - Number(cl.credit_cents ?? 0);
    }
  }

  return {
    period: { startDate: scope.startDate, endDate: scope.endDate },
    operating: {
      netIncome,
      adjustments: [{ label: 'Depreciation & Amortization', amountCents: depreciation }].filter((a) => a.amountCents !== 0),
      changesInWorkingCapital: [
        { label: 'Accounts Receivable', amountCents: -arChange },
        { label: 'Other Current Assets', amountCents: -otherCurrentAssetChange },
        { label: 'Accounts Payable', amountCents: apChange },
        { label: 'Other Current Liabilities', amountCents: otherCurrentLiabChange },
      ].filter((a) => a.amountCents !== 0),
      totalCents: operatingTotal,
    },
    investing: { items: [{ label: 'Capital Expenditures', amountCents: -fixedAssetChange }].filter((a) => a.amountCents !== 0), totalCents: investingTotal },
    financing: {
      items: [
        { label: 'Debt Proceeds / (Payments)', amountCents: debtChange },
        { label: 'Equity Transactions', amountCents: equityChange },
      ].filter((a) => a.amountCents !== 0),
      totalCents: financingTotal,
    },
    netChangeCents: netChange,
    beginningCashCents: beginningCash,
    endingCashCents: beginningCash + netChange,
  };
}

// ── AR / AP Aging ────────────────────────────────────────────────────────────
async function fetchAging(supabase: SupabaseClient, view: 'v_ar_aging' | 'v_ap_aging', locationIds: string[]): Promise<AgingPayload> {
  // `> 0` defensively excludes WRITTEN_OFF/settled rows (balance 0) from aging,
  // for both AR and AP, before the v_ar_aging view drops WRITTEN_OFF.
  let query = applyLoc(supabase.from(view).select('*').gt('balance_cents', 0), locationIds);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const buckets: AgingPayload['buckets'] = {
    CURRENT: { count: 0, totalCents: 0 },
    '1-30': { count: 0, totalCents: 0 },
    '31-60': { count: 0, totalCents: 0 },
    '61-90': { count: 0, totalCents: 0 },
    '90+': { count: 0, totalCents: 0 },
  };
  for (const row of data ?? []) {
    const b = row.aging_bucket as string;
    if (buckets[b]) {
      buckets[b].count++;
      buckets[b].totalCents += Number(row.balance_cents ?? 0);
    }
  }
  return { buckets, totalOutstanding: Object.values(buckets).reduce((s, b) => s + b.totalCents, 0) };
}

export const fetchArAging = (supabase: SupabaseClient, locationIds: string[]) => fetchAging(supabase, 'v_ar_aging', locationIds);
export const fetchApAging = (supabase: SupabaseClient, locationIds: string[]) => fetchAging(supabase, 'v_ap_aging', locationIds);

// ── Debt Schedule ────────────────────────────────────────────────────────────
export async function fetchDebt(supabase: SupabaseClient, locationIds: string[]): Promise<DebtPayload> {
  let query = supabase
    .from('debt_instruments')
    .select('id, name, lender, instrument_type, original_amount_cents, current_balance_cents, interest_rate, maturity_date, monthly_payment_cents, payment_type, location_id')
    .order('current_balance_cents', { ascending: false });
  if (locationIds.length > 0) query = query.in('location_id', locationIds);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase,
    'locations',
    'id, name, short_code',
    rows.map((r) => r.location_id as string),
  );

  const instruments = rows.map((d) => {
    const loc = d.location_id ? locMap.get(d.location_id as string) ?? null : null;
    const monthly = Number(d.monthly_payment_cents ?? 0);
    return {
      name: (d.name as string) ?? '',
      lender: (d.lender as string) ?? '',
      type: (d.instrument_type as string) ?? '',
      balanceCents: Number(d.current_balance_cents ?? 0),
      interestRate: Number(d.interest_rate ?? 0),
      maturityDate: (d.maturity_date as string) ?? null,
      monthlyPaymentCents: monthly,
      annualPaymentCents: monthly * 12,
      locationName: (loc as { name: string } | null)?.name ?? '',
    };
  });

  const totalBalance = instruments.reduce((s, d) => s + d.balanceCents, 0);
  const totalMonthly = instruments.reduce((s, d) => s + d.monthlyPaymentCents, 0);
  const weightedRate = totalBalance > 0 ? instruments.reduce((s, d) => s + d.interestRate * d.balanceCents, 0) / totalBalance : 0;

  return {
    data: instruments,
    summary: {
      totalBalanceCents: totalBalance,
      totalMonthlyPaymentCents: totalMonthly,
      instrumentCount: instruments.length,
      weightedAvgRate: Math.round(weightedRate * 100) / 100,
    },
  };
}

// ── Trend series (multi-period sparkline data) ─────────────────────────────────
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function lastDom(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Ending cash as-of each of `asOfDates`, computed in ONE query: pull all POSTED
 * cash-account lines (with their entry date) up to the latest date, then take a
 * cumulative debit−credit balance per as-of. Cash accounts are resolved BY ROLE
 * plus the `is_bank_account` flag — never by number range.
 */
async function fetchCashAsOfSeries(
  supabase: SupabaseClient,
  orgId: string,
  asOfDates: string[],
  locationIds: string[],
): Promise<number[]> {
  if (asOfDates.length === 0) return [];
  const maxDate = asOfDates.reduce((a, b) => (a > b ? a : b));

  const { data: accts } = await supabase.from('accounts').select('id, is_bank_account');
  const cashIds = new Set<string>();
  for (const a of accts ?? []) if (a.is_bank_account) cashIds.add(a.id as string);
  if (orgId) for (const id of await resolveRoleIds(supabase, orgId, ['CASH_ON_HAND', 'UNDEPOSITED_FUNDS', 'OPERATING_BANK'])) cashIds.add(id);
  if (cashIds.size === 0) return asOfDates.map(() => 0);

  const q = applyLoc(
    supabase
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents, gl_entries!inner(entry_date, status)')
      .eq('gl_entries.status', 'POSTED')
      .lte('gl_entries.entry_date', maxDate)
      .in('account_id', Array.from(cashIds)),
    locationIds,
  );
  const { data: lines } = await q;
  const rows = (lines ?? []) as unknown as Array<{ debit_cents: number; credit_cents: number; gl_entries: { entry_date: string } }>;

  return asOfDates.map((asOf) => {
    let bal = 0;
    for (const l of rows) {
      if (l.gl_entries.entry_date <= asOf) bal += Number(l.debit_cents ?? 0) - Number(l.credit_cents ?? 0);
    }
    return bal;
  });
}

/**
 * Trailing whole-month P&L + ending-cash series ending in `endDate`'s month.
 * Powers the board package's KPI trend strip. Deterministic and RLS-scoped:
 * revenue / gross profit / margin / net income come from the SAME income-statement
 * aggregation the statements use (basis-aware); ending cash from the ledger.
 */
export async function fetchTrendSeries(
  supabase: SupabaseClient,
  orgId: string,
  scope: { endDate: string; locationIds: string[]; basis: 'accrual' | 'cash'; periods: number },
): Promise<TrendPoint[]> {
  const periods = Math.max(1, Math.min(24, scope.periods));
  const [ey, em] = scope.endDate.split('-').map(Number);
  if (!ey || !em) return [];

  const windows: { start: string; end: string; label: string }[] = [];
  for (let i = periods - 1; i >= 0; i--) {
    const idx = ey * 12 + (em - 1) - i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    windows.push({
      start: `${y}-${pad2(m)}-01`,
      end: `${y}-${pad2(m)}-${pad2(lastDom(y, m))}`,
      label: `${MONTH_ABBR[m - 1]} ${String(y).slice(2)}`,
    });
  }

  const [isResults, cashSeries] = await Promise.all([
    Promise.all(
      windows.map((w) =>
        fetchIncomeStatement(supabase, { startDate: w.start, endDate: w.end, locationIds: scope.locationIds, basis: scope.basis }),
      ),
    ),
    fetchCashAsOfSeries(supabase, orgId, windows.map((w) => w.end), scope.locationIds),
  ]);

  return windows.map((w, i) => ({
    periodLabel: w.label,
    periodStart: w.start,
    periodEnd: w.end,
    revenueCents: isResults[i].summary.revenueCents,
    grossProfitCents: isResults[i].summary.grossProfitCents,
    grossMarginPct: isResults[i].summary.grossMarginPct,
    netIncomeCents: isResults[i].summary.netIncomeCents,
    endingCashCents: cashSeries[i] ?? 0,
  }));
}
