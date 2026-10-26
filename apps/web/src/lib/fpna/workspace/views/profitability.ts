/**
 * Profitability tab (exceed X11): league tables with sparklines by company, department,
 * class, job and customer, plus contribution margin.
 *
 *  - by company: registry metrics per company over the same dataset (one load);
 *  - by department / class / job: the 3A balances store (`loadBalances`, one round trip,
 *    governed by the server before it gets here), classified with the SAME account-class
 *    mapping the metrics use (revenue, cost of revenue, opex, operating D&A, variable opex),
 *    CLOSING entries excluded — so the columns tie to the engine's P&L by dimension (AC-W6);
 *  - by customer: invoiced revenue from the AR sub-ledger (margin by customer needs cost by
 *    customer, which is not on file — said so, never invented).
 * PURE.
 */

import type { MonthKey } from '@/lib/analytics/months';
import type { AccountClass, EvaluateRequest, MetricDataset } from '@/lib/metrics/types';
import type { BalanceRow } from '@/lib/reports/engine/types';
import { evalAt, monthStatus, scopedCompanies, trailing, valueOf, withCompanies, type EvalCtx } from '../series';
import type { WsBlock, WsLeagueBlock, WsLeagueColumn, WsLeagueRow, WsPeriodStatus, WsValue } from '../types';
import { axisMonth, fmt } from '../units';
import { customerTotals } from './working-capital';

export type DimKey = 'department' | 'class' | 'job';
export type ProfitBy = 'company' | DimKey | 'customer';

const COMPANY_METRICS = ['revenue', 'gross_profit', 'gross_margin', 'contribution_margin_pct', 'ebitda', 'ebitda_margin', 'net_margin'] as const;

const PCT_COLS: WsLeagueColumn[] = [
  { key: 'revenue', label: 'Revenue', unit: 'money', direction: 'higher_is_better' },
  { key: 'gross_profit', label: 'Gross profit', unit: 'money', direction: 'higher_is_better' },
  { key: 'gross_margin', label: 'Gross margin', unit: 'percent', direction: 'higher_is_better' },
  { key: 'contribution', label: 'Contribution', unit: 'money', direction: 'higher_is_better' },
  { key: 'contribution_margin', label: 'Contribution margin', unit: 'percent', direction: 'higher_is_better' },
  { key: 'ebitda', label: 'EBITDA', unit: 'money', direction: 'higher_is_better' },
  { key: 'ebitda_margin', label: 'EBITDA margin', unit: 'percent', direction: 'higher_is_better' },
  { key: 'share', label: 'Share of revenue', unit: 'percent', direction: 'neutral' },
];

export function profitabilityPlan(end: MonthKey, basis: EvaluateRequest['basis']): EvaluateRequest[] {
  const scope = { companyIds: [], weighting: 'full' as const };
  return [
    ...COMPANY_METRICS.map((m) => ({ metric: m, scope, periodEnd: end, basis, comparison: 'none' as const, sparkline: 0 as const })),
    { metric: 'contribution_margin', scope, periodEnd: end, basis, comparison: 'none', sparkline: 0 },
    { metric: 'revenue', scope, periodEnd: end, basis: 'month', comparison: 'none', sparkline: 12 },
  ];
}

const ratio = (n: number | null, d: number | null): WsValue => (n === null || d === null || d <= 0 ? null : n / d);

function shareColumn(rows: WsLeagueRow[]): void {
  const total = rows.reduce((s, r) => s + Math.max(0, r.values[0] ?? 0), 0);
  for (const r of rows) r.values[7] = total > 0 && r.values[0] !== null && r.values[0] > 0 ? r.values[0] / total : null;
}

function sortByRevenue(rows: WsLeagueRow[]): WsLeagueRow[] {
  return rows.sort((a, b) => (b.values[0] ?? -Infinity) - (a.values[0] ?? -Infinity) || a.label.localeCompare(b.label));
}

function totalRow(rows: WsLeagueRow[], label: string): { label: string; values: WsValue[] } {
  const sum = (i: number) => rows.reduce((s, r) => s + (r.values[i] ?? 0), 0);
  const rev = sum(0);
  const gp = sum(1);
  const con = sum(3);
  const eb = sum(5);
  // ratios are recomputed on the totals, never averaged
  return { label, values: [rev, gp, ratio(gp, rev), con, ratio(con, rev), eb, ratio(eb, rev), rev > 0 ? 1 : null] };
}

export function companyLeague(ctx: EvalCtx, end: MonthKey, basis: EvaluateRequest['basis'], periodLabel: string): WsLeagueBlock {
  const months = trailing(end, 12);
  const rows: WsLeagueRow[] = scopedCompanies(ctx).map((c) => {
    const one = withCompanies(ctx, [c.id]);
    const v = (m: string) => {
      const r = evalAt(one, m, end, basis);
      return { v: valueOf(m, r.current), why: r.current.status === 'ok' ? null : r.current.message };
    };
    const rev = v('revenue');
    const gp = v('gross_profit');
    const con = v('contribution_margin');
    const eb = v('ebitda');
    const spark = evalAt(one, 'revenue', end, 'month', 'none', 12).sparkline;
    return {
      key: c.id,
      label: c.name,
      sub: c.closedThrough ? `Closed through ${axisMonth(c.closedThrough)} ’${c.closedThrough.slice(2, 4)}` : 'Not closed',
      values: [rev.v, gp.v, ratio(gp.v, rev.v), con.v, ratio(con.v, rev.v), eb.v, ratio(eb.v, rev.v), null],
      reasons: [rev.why, gp.why, null, con.why, null, eb.why, null, null],
      spark: spark.map((p) => p.value),
      sparkStatuses: spark.map((p) => (p.preliminary ? 'preliminary' : 'closed') as WsPeriodStatus),
      href: `/fpna?tab=performance&companies=${c.id}`,
    };
  });
  shareColumn(rows);
  sortByRevenue(rows);
  return leagueBlock('prof-company', 'By company', 'Company', rows, months, periodLabel, 'Contribution = revenue − cost of revenue − variable operating costs (accounts mapped as variable).');
}

function leagueBlock(id: string, title: string, rowHeading: string, rows: WsLeagueRow[], months: MonthKey[], periodLabel: string, extra?: string): WsLeagueBlock {
  const top = rows.find((r) => r.values[0] !== null);
  const bestMargin = [...rows].filter((r) => r.values[6] !== null).sort((a, b) => (b.values[6] as number) - (a.values[6] as number))[0];
  return {
    kind: 'league',
    id,
    title: `Profitability ${title.toLowerCase()}`,
    eyebrow: 'Profitability',
    basis: `${periodLabel} · ratios on each row's own totals · sparkline = revenue by month, last 12 months`,
    period: periodLabel,
    summary: top
      ? `${top.label} brings in the most revenue (${fmt(top.values[0], 'money')}, ${top.values[7] !== null ? `${((top.values[7] as number) * 100).toFixed(1)}% of the total` : 'n/m share'}).${bestMargin ? ` ${bestMargin.label} has the best EBITDA margin at ${fmt(bestMargin.values[6], 'percent')}.` : ''}`
      : 'Nothing posted for this window.',
    footnotes: extra ? [extra] : [],
    rowHeading,
    columns: PCT_COLS,
    rows,
    sparkLabel: 'Revenue, last 12 months',
    sparkUnit: 'money',
    sparkPeriods: months.map((m) => `${axisMonth(m)} ’${m.slice(2, 4)}`),
    total: totalRow(rows, 'Total'),
    ...(rows.length === 0 ? { state: { kind: 'empty' as const, title: 'Nothing to rank', body: 'There is no posted activity for this window.' } } : {}),
  };
}

// ── dimension leagues from balances ───────────────────────────────────────

interface ClassSets {
  revenue: Set<string>;
  cogs: Set<string>;
  opex: Set<string>;
  da: Set<string>;
  variable: Set<string>;
}

export function classSets(ds: MetricDataset): ClassSets {
  const ids = (c: AccountClass) => new Set(ds.classMapping[c]?.accountIds ?? []);
  return { revenue: ids('revenue'), cogs: ids('cogs'), opex: ids('opex'), da: ids('da_operating'), variable: ids('variable_opex') };
}

export interface DimAgg {
  revenue: number;
  cogs: number;
  opex: number;
  da: number;
  variable: number;
}

const ZERO: DimAgg = { revenue: 0, cogs: 0, opex: 0, da: 0, variable: 0 };

function dimOf(r: BalanceRow, dim: DimKey): string | null {
  return dim === 'department' ? r.departmentId : dim === 'class' ? r.classId : r.jobId;
}

/**
 * Aggregate balance rows by dimension value × month (P&L activity only: CLOSING entries and
 * the opening bucket are excluded). Natural signs: revenue credit − debit; costs debit − credit.
 * Key '' = Unassigned (dimension IS NULL).
 */
export function aggregateByDimension(rows: readonly BalanceRow[], sets: ClassSets, dim: DimKey, months: readonly MonthKey[]): Map<string, Map<MonthKey, DimAgg>> {
  const keep = new Set(months);
  const out = new Map<string, Map<MonthKey, DimAgg>>();
  for (const r of rows) {
    if (r.period === null || r.kind === 'CLOSING') continue;
    const m = r.period.slice(0, 7);
    if (!keep.has(m)) continue;
    const acc = r.accountId;
    const inRev = sets.revenue.has(acc);
    const inCost = sets.cogs.has(acc) || sets.opex.has(acc);
    if (!inRev && !inCost) continue;
    const k = dimOf(r, dim) ?? '';
    const byMonth = out.get(k) ?? new Map<MonthKey, DimAgg>();
    const a = { ...(byMonth.get(m) ?? ZERO) };
    const net = r.debit - r.credit;
    if (inRev) a.revenue += -net;
    if (sets.cogs.has(acc)) a.cogs += net;
    if (sets.opex.has(acc)) a.opex += net;
    if (sets.da.has(acc)) a.da += net;
    if (sets.variable.has(acc)) a.variable += net;
    byMonth.set(m, a);
    out.set(k, byMonth);
  }
  return out;
}

export function dimensionLeague(
  rows: readonly BalanceRow[],
  sets: ClassSets,
  dim: DimKey,
  windowMonths: readonly MonthKey[],
  sparkMonths: readonly MonthKey[],
  names: ReadonlyMap<string, string>,
  periodLabel: string,
  status: (m: MonthKey) => WsPeriodStatus,
): WsLeagueBlock {
  const all = [...new Set([...windowMonths, ...sparkMonths])];
  const agg = aggregateByDimension(rows, sets, dim, all);
  const win = new Set(windowMonths);
  const out: WsLeagueRow[] = [];
  for (const [k, byMonth] of agg) {
    const t = { ...ZERO };
    for (const [m, a] of byMonth) {
      if (!win.has(m)) continue;
      t.revenue += a.revenue;
      t.cogs += a.cogs;
      t.opex += a.opex;
      t.da += a.da;
      t.variable += a.variable;
    }
    const gp = t.revenue - t.cogs;
    const con = t.revenue - t.cogs - t.variable;
    const eb = t.revenue - t.cogs - t.opex + t.da;
    out.push({
      key: k || 'unassigned',
      label: k ? names.get(k) ?? 'Unnamed' : 'Unassigned',
      values: [t.revenue, gp, ratio(gp, t.revenue), con, ratio(con, t.revenue), eb, ratio(eb, t.revenue), null],
      reasons: [null, null, t.revenue <= 0 ? 'No positive revenue' : null, null, null, null, null, null],
      spark: sparkMonths.map((m) => byMonth.get(m)?.revenue ?? 0),
      sparkStatuses: sparkMonths.map(status),
    });
  }
  shareColumn(out);
  sortByRevenue(out);
  const label = dim === 'department' ? 'Department' : dim === 'class' ? 'Class' : 'Job';
  return leagueBlock(`prof-${dim}`, `by ${label.toLowerCase()}`, label, out, [...sparkMonths], periodLabel, 'Lines with no dimension are shown as Unassigned so every column adds up to the company P&L. EBITDA by dimension excludes costs posted without the dimension.');
}

export function customerLeague(ctx: EvalCtx, windowMonths: readonly MonthKey[], sparkMonths: readonly MonthKey[], names: ReadonlyMap<string, string>, periodLabel: string): WsLeagueBlock {
  const totals = customerTotals(ctx, windowMonths);
  const monthly = sparkMonths.map((m) => customerTotals(ctx, [m]));
  const rows: WsLeagueRow[] = [...totals.entries()]
    .filter(([, v]) => v !== 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([id, v]) => ({
      key: id,
      label: names.get(id) ?? 'Customer',
      values: [v, null, null, null, null, null, null, null],
      reasons: [null, 'Cost by customer is not on file', null, 'Cost by customer is not on file', null, 'Cost by customer is not on file', null, null],
      spark: monthly.map((mm) => mm.get(id) ?? 0),
      sparkStatuses: sparkMonths.map((m) => monthStatus(ctx, m)),
    }));
  shareColumn(rows);
  const block = leagueBlock('prof-customer', 'by customer', 'Customer', rows, [...sparkMonths], periodLabel, 'Invoiced revenue from the AR sub-ledger (top 50). Gross margin by customer needs costs tagged to the customer (job cost or counterparty), which are not on file.');
  return { ...block, columns: PCT_COLS, total: undefined };
}

export function profitabilityBlocks(parts: { company?: WsLeagueBlock; dimension?: WsLeagueBlock; customer?: WsLeagueBlock }): WsBlock[] {
  return [parts.company, parts.dimension, parts.customer].filter((b): b is WsLeagueBlock => Boolean(b));
}
