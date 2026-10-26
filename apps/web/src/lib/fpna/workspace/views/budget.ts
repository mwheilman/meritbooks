/**
 * Budget vs actual tab (portal M4 / M13): variance bars by account group from the ENGINE
 * (income statement vs the approved budget — `public.budgets` holds only the current
 * approved version since migration 189), revenue and EBITDA vs budget by month from the
 * metric dataset, attainment tiles, and the department BvA link. PURE.
 */

import { fiscalYearOf, fiscalYearStart, monthRange, type MonthKey } from '@/lib/analytics/months';
import { isMaterial, type MaterialityRule } from '@/lib/analytics/variance';
import type { EvaluateRequest } from '@/lib/metrics/types';
import type { ReportResult, ReportRow } from '@/lib/reports/engine/types';
import { budgetValues, chartPeriods, evalAt, monthlyValues, scopedCompanies, valueOf, type EvalCtx } from '../series';
import type { WsBlock, WsTilesBlock, WsVarianceBlock, WsVarianceRow } from '../types';
import { fmt, longMonth } from '../units';

export const DEFAULT_MATERIALITY: Required<Pick<MaterialityRule, 'amountCents' | 'pct'>> & { mode: 'or' } = { amountCents: 1_000_000, pct: 0.1, mode: 'or' };

export function budgetPlan(end: MonthKey, fyStartMonth: number): EvaluateRequest[] {
  const scope = { companyIds: [], weighting: 'full' as const };
  const start = fiscalYearStart(end, fyStartMonth);
  const out: EvaluateRequest[] = [];
  for (const m of ['revenue', 'ebitda', 'gross_profit', 'opex']) {
    out.push({ metric: m, scope, periodEnd: end, basis: 'ytd', comparison: 'budget', sparkline: 0 });
    out.push({ metric: m, scope, periodEnd: start, basis: 'month', comparison: 'budget', sparkline: 0 });
  }
  for (const m of ['revenue_budget_attainment', 'revenue_budget_variance', 'ebitda_budget_variance', 'opex_budget_variance', 'gross_profit_budget_variance']) {
    out.push({ metric: m, scope, periodEnd: end, basis: 'ytd', comparison: 'none', sparkline: 0 });
  }
  return out;
}

/** Is there an approved budget for the fiscal year of `end` for every company in scope? */
export function budgetCoverage(ctx: EvalCtx, end: MonthKey): { fy: number; covered: string[]; missing: string[] } {
  const fy = fiscalYearOf(end, ctx.ds.fyStartMonth);
  const covered: string[] = [];
  const missing: string[] = [];
  for (const c of scopedCompanies(ctx)) (c.budgetApprovedFy.includes(fy) ? covered : missing).push(c.name);
  return { fy, covered, missing };
}

/** Monthly BvA for revenue and EBITDA through the fiscal year to date. */
export function monthlyBvaBlocks(ctx: EvalCtx, end: MonthKey): WsVarianceBlock[] {
  const months = monthRange(fiscalYearStart(end, ctx.ds.fyStartMonth), end);
  const periods = chartPeriods(ctx, months);
  return (['revenue', 'ebitda'] as const).map((metric) => {
    const actual = monthlyValues(ctx, metric, months).values;
    const plan = budgetValues(ctx, metric, months);
    const rows: WsVarianceRow[] = months.map((m, i) => ({ key: m, label: periods[i].longLabel, actual: actual[i], plan: plan[i], direction: 'higher_is_better', material: false }));
    const ytd = evalAt(ctx, metric, end, 'ytd', 'budget');
    const a = valueOf(metric, ytd.current);
    const p = valueOf(metric, ytd.comparison?.outcome);
    const name = metric === 'revenue' ? 'Revenue' : 'EBITDA';
    const noPlan = plan.every((v) => v === null);
    return {
      kind: 'variance',
      id: `bva-${metric}-month`,
      title: `${name} against budget, by month`,
      eyebrow: 'Plan',
      basis: `Fiscal year to date, ${longMonth(months[0])} – ${longMonth(end)} · favourable to the right`,
      period: `FYTD ${longMonth(end)}`,
      unit: 'money',
      planLabel: 'Approved budget',
      summary:
        a !== null && p !== null
          ? `${name} is ${fmt(Math.abs(a - p), 'money')} ${a >= p ? 'ahead of' : 'behind'} the approved budget for the year to date (${fmt(a, 'money')} against ${fmt(p, 'money')}).`
          : `${name} has no approved budget to compare for these months.`,
      footnotes: periods.some((x) => x.status === 'preliminary') ? ['Months after books-closed-through are preliminary'] : [],
      rows,
      ...(a !== null && p !== null ? { totals: { actual: a, plan: p, variance: a - p, favourable: a >= p } } : {}),
      ...(noPlan ? { state: { kind: 'unavailable' as const, reason: 'no_approved_budget' as const, detail: 'Approve a budget version for this fiscal year to see actual against plan.' } } : {}),
    };
  });
}

export function attainmentTiles(ctx: EvalCtx, end: MonthKey): WsTilesBlock {
  const t = (metric: string, label: string, unit: 'money' | 'percent') => {
    const r = evalAt(ctx, metric, end, 'ytd');
    return { key: metric, label, unit, value: valueOf(metric, r.current), sub: r.current.status === 'ok' ? `YTD ${longMonth(end)}` : r.current.message };
  };
  const tiles = [
    t('revenue_budget_attainment', 'Revenue attainment', 'percent'),
    t('revenue_budget_variance', 'Revenue vs budget', 'money'),
    t('gross_profit_budget_variance', 'Gross profit vs budget', 'money'),
    t('opex_budget_variance', 'Opex vs budget', 'money'),
    t('ebitda_budget_variance', 'EBITDA vs budget', 'money'),
  ];
  const att = tiles[0].value;
  return {
    kind: 'tiles',
    id: 'bva-tiles',
    title: 'Year to date against the approved budget',
    eyebrow: 'Plan',
    basis: 'Approved budget only (draft versions are never compared)',
    period: `YTD ${longMonth(end)}`,
    summary: att !== null ? `Revenue is at ${fmt(att, 'percent')} of budget for the year to date.` : 'No approved budget for the year to date.',
    footnotes: [],
    tiles,
  };
}

function lineRows(result: ReportResult): ReportRow[] {
  // account groups, plus accounts that sit directly in a section (a section with one group has no group row)
  return result.rows.filter((r) => r.kind === 'group' || (r.kind === 'account' && r.depth === 1 && !r.synthetic));
}

/** Variance bars by account group from the engine's income statement vs budget. */
export function bvaByGroup(result: ReportResult, rule: MaterialityRule = DEFAULT_MATERIALITY, periodLabel: string): WsVarianceBlock {
  const actualIdx = result.columns.findIndex((c) => c.kind === 'amount' && c.source === 'actual');
  const budgetIdx = result.columns.findIndex((c) => c.kind === 'amount' && c.source === 'budget');
  const companyIds = result.columns[actualIdx]?.drill?.companyIds ?? result.companies.map((c) => c.id);
  const range = result.columns[actualIdx]?.range;
  const rows: WsVarianceRow[] = [];
  if (actualIdx >= 0 && budgetIdx >= 0) {
    for (const r of lineRows(result)) {
      const actual = r.values[actualIdx] ?? null;
      const plan = r.values[budgetIdx] ?? null;
      if ((actual ?? 0) === 0 && (plan ?? 0) === 0) continue;
      const direction = r.goodWhen === 'down' ? 'lower_is_better' : 'higher_is_better';
      const material = actual !== null && plan !== null ? isMaterial(actual - plan, plan, rule) : false;
      rows.push({ key: r.id, label: r.label, actual, plan, direction, material, accountIds: r.accountIds ?? [] });
    }
  }
  rows.sort((a, b) => Math.abs((b.actual ?? 0) - (b.plan ?? 0)) - Math.abs((a.actual ?? 0) - (a.plan ?? 0)));
  const fav = rows.filter((r) => r.actual !== null && r.plan !== null && (r.direction === 'higher_is_better' ? r.actual > r.plan : r.actual < r.plan));
  const material = rows.filter((r) => r.material);
  const top = material[0] ?? rows[0];
  const noBudget = budgetIdx < 0 || rows.every((r) => r.plan === null || r.plan === 0);
  const ruleText = `${fmt(rule.amountCents ?? 0, 'money')} or ${Math.round((rule.pct ?? 0) * 100)}%`;
  return {
    kind: 'variance',
    id: 'bva-groups',
    title: 'Where the plan was missed or beaten',
    eyebrow: 'Variance',
    basis: `Income statement by account group against the approved budget · material at ${ruleText} · sorted by size`,
    period: periodLabel,
    unit: 'money',
    planLabel: 'Approved budget',
    summary: noBudget
      ? 'There is no approved budget for this window.'
      : `${material.length} of ${rows.length} lines move by more than ${ruleText}; ${fav.length} are favourable.${top && top.actual !== null && top.plan !== null ? ` The largest is ${top.label} at ${fmt(top.actual - top.plan, 'money')} against plan.` : ''}`,
    footnotes: ['F = favourable (income above or cost below plan) · U = unfavourable', ...(result.warnings.filter((w) => w.code === 'NO_BUDGET').map((w) => w.message))],
    rows,
    ...(range ? { drillRange: { from: range.start ?? range.end, to: range.end, companyIds } } : {}),
    ...(noBudget ? { state: { kind: 'unavailable' as const, reason: 'no_approved_budget' as const, detail: 'Approve a budget version for this fiscal year (Budgets → Versions) to compare against it.' } } : {}),
  };
}

export function budgetBlocks(ctx: EvalCtx, end: MonthKey, engine: ReportResult | null, rule: MaterialityRule, periodLabel: string): WsBlock[] {
  const out: WsBlock[] = [attainmentTiles(ctx, end)];
  if (engine) out.push(bvaByGroup(engine, rule, periodLabel));
  out.push(...monthlyBvaBlocks(ctx, end));
  return out;
}
