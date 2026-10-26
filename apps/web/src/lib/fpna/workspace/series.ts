/**
 * Series and card helpers over ONE loaded MetricDataset (AC-W5: a view loads once, then
 * evaluates every card / month against the same dataset). PURE — the evaluator is I/O-free.
 */

import { addMonths, compareMonths, monthRange, type MonthKey } from '@/lib/analytics/months';
import { evaluateMetric, benchmarkTone } from '@/lib/metrics/evaluate';
import { formulaOf } from '@/lib/metrics/registry';
import { WS_REGISTRY } from './ws-registry';
import { ACCOUNT_CLASSES } from '@/lib/metrics/classes';
import type { AccountClass } from '@/lib/metrics/types';
import { REASON_TITLE } from '@/lib/metrics/wording';
import type { Basis, CannotComputeReason, ComparisonKind, MetricDataset, MetricDefinition, MetricResult, MetricScope, Outcome } from '@/lib/metrics/types';
import type { CardModel, WsChartPeriod, WsUnavailable, WsValue } from './types';
import { axisMonth, changeWords, fmt, longMonth, toWs, wsDirection, wsUnit } from './units';

export interface EvalCtx {
  ds: MetricDataset;
  scope: MetricScope;
  /** Company names for "excluded" notes. */
  names: ReadonlyMap<string, string>;
  /** Evaluation memo (one view asks for the same metric × month more than once). */
  memo?: Map<string, MetricResult>;
}

export function defOf(metric: string): MetricDefinition {
  const d = WS_REGISTRY.get(metric);
  if (!d) throw new Error(`Unknown metric "${metric}"`);
  return d;
}

export function evalAt(ctx: EvalCtx, metric: string, end: MonthKey, basis: Basis, comparison: ComparisonKind = 'none', sparkline: 0 | 12 | 24 = 0): MetricResult {
  const key = `${metric}|${end}|${basis}|${comparison}|${sparkline}`;
  const hit = ctx.memo?.get(key);
  if (hit) return hit;
  const r = evaluateMetric(ctx.ds, { metric, scope: ctx.scope, periodEnd: end, basis, comparison, sparkline }, { registry: WS_REGISTRY });
  ctx.memo?.set(key, r);
  return r;
}

/** A context for a different company set over the same dataset (league tables). */
export function withCompanies(ctx: EvalCtx, companyIds: string[]): EvalCtx {
  return { ...ctx, scope: { ...ctx.scope, companyIds }, memo: new Map() };
}

export function unavailableOf(o: Outcome): WsUnavailable | null {
  if (o.status === 'ok') return null;
  return { reason: o.reason, title: REASON_TITLE[o.reason], message: o.message };
}

export function valueOf(metric: string, o: Outcome | undefined | null): WsValue {
  if (!o || o.status !== 'ok') return null;
  return toWs(defOf(metric).unit, o.value);
}

/** Monthly (or basis-windowed) values ending at each month; null for a gap with its reason. */
export function monthlyValues(ctx: EvalCtx, metric: string, months: readonly MonthKey[], basis: Basis = 'month'): { values: WsValue[]; reasons: Array<CannotComputeReason | null> } {
  const values: WsValue[] = [];
  const reasons: Array<CannotComputeReason | null> = [];
  for (const m of months) {
    const r = evalAt(ctx, metric, m, basis);
    values.push(valueOf(metric, r.current));
    reasons.push(r.current.status === 'ok' ? null : r.current.reason);
  }
  return { values, reasons };
}

/** Approved-budget values for each month (null where no approved budget). */
export function budgetValues(ctx: EvalCtx, metric: string, months: readonly MonthKey[], basis: Basis = 'month'): WsValue[] {
  return months.map((m) => {
    const r = evalAt(ctx, metric, m, basis, 'budget');
    return valueOf(metric, r.comparison?.outcome);
  });
}

/** Companies in scope as dataset entries. */
export function scopedCompanies(ctx: EvalCtx) {
  const ids = new Set(ctx.scope.companyIds);
  return ctx.ds.companies.filter((c) => ids.has(c.id));
}

/** A month is preliminary when any company in scope has not hard-closed it. */
export function monthStatus(ctx: EvalCtx, m: MonthKey): 'closed' | 'preliminary' {
  return scopedCompanies(ctx).some((c) => c.closedThrough === null || compareMonths(c.closedThrough, m) < 0) ? 'preliminary' : 'closed';
}

export function chartPeriods(ctx: EvalCtx, months: readonly MonthKey[]): WsChartPeriod[] {
  return months.map((m) => ({ key: m, label: axisMonth(m), longLabel: longMonth(m), status: monthStatus(ctx, m) }));
}

export function trailing(end: MonthKey, n: number): MonthKey[] {
  return monthRange(addMonths(end, -(n - 1)), end);
}

/** "YTD Sep 2026" · "Sep 2026" · "TTM to Sep 2026" · "QTD Sep 2026". */
export function windowLabel(end: MonthKey, basis: Basis): string {
  switch (basis) {
    case 'month':
      return longMonth(end);
    case 'qtd':
      return `QTD ${longMonth(end)}`;
    case 'ytd':
      return `YTD ${longMonth(end)}`;
    case 'ttm':
      return `TTM to ${longMonth(end)}`;
    default: {
      const never: never = basis;
      return never;
    }
  }
}

export const COMPARISON_SHORT: Record<Exclude<ComparisonKind, 'none'>, string> = {
  prior_year: 'the same period last year',
  prior_period: 'the prior period',
  budget: 'the approved budget',
};

/** −1 when the class is credit-natured (revenue, liabilities…), else +1. */
export function drillSign(input: string): 1 | -1 {
  const def = (ACCOUNT_CLASSES as Partial<Record<string, { measure: string }>>)[input as AccountClass];
  return def && (def.measure === 'net_credit' || def.measure === 'credit_activity') ? -1 : 1;
}

/** One KPI card from one evaluation (AC-W2). */
export function buildCard(ctx: EvalCtx, metric: string, end: MonthKey, basis: Basis, comparison: ComparisonKind, sparkline: 12 | 24): CardModel {
  const def = defOf(metric);
  // The trend is by MONTH for flow measures (a YTD sparkline would saw-tooth at every
  // fiscal-year start); balances and fixed-window measures trend on their own basis.
  const monthlyTrend = def.period.basis === 'request' && def.period.nature !== 'balance' && basis !== 'month';
  const r = evalAt(ctx, metric, end, basis, comparison, monthlyTrend ? 0 : sparkline);
  const trend = monthlyTrend ? evalAt(ctx, metric, end, 'month', 'none', sparkline).sparkline : r.sparkline;
  const unit = wsUnit(def.unit);
  const value = valueOf(metric, r.current);
  const cmpValue = r.comparison ? valueOf(metric, r.comparison.outcome) : null;
  const tone = r.current.status === 'ok' ? benchmarkTone(def, r.current.value) : null;
  const label = windowLabel(end, r.period.basis);
  let summary: string;
  if (r.current.status !== 'ok') summary = `${def.name}: ${r.current.message}.`;
  else if (r.comparison && cmpValue !== null && value !== null) {
    summary = `${def.name} was ${fmt(value, unit)} for ${label}, ${changeWords(value, cmpValue, unit)} on ${COMPARISON_SHORT[r.comparison.kind]} (${fmt(cmpValue, unit)}).`;
  } else summary = `${def.name} was ${fmt(value, unit)} for ${label}.`;
  if (r.preliminary) summary += ' Figures include months that are not closed.';
  return {
    metric,
    name: def.name,
    group: def.group,
    unit,
    direction: wsDirection(def.direction),
    definition: def.definition,
    formula: formulaOf(metric),
    value,
    comparison: r.comparison
      ? { kind: r.comparison.kind, label: COMPARISON_SHORT[r.comparison.kind], value: cmpValue, unavailable: unavailableOf(r.comparison.outcome), likeForLike: r.comparison.likeForLike }
      : null,
    change: r.change
      ? {
          delta: def.unit === 'percent' || def.unit === 'points' ? r.change.delta / 100 : r.change.delta,
          pct: r.change.pct,
          inPoints: r.change.inPoints,
          verdict: r.change.verdict,
          arrow: r.change.arrow,
          sentence: r.change.sentence,
        }
      : null,
    sparkline: trend.map((p) => ({ month: p.month, value: toWs(def.unit, p.value), preliminary: p.preliminary })),
    sparkBasis: monthlyTrend ? 'month' : r.period.basis,
    status: tone,
    benchmarkSource: def.benchmark?.source ?? null,
    unavailable: unavailableOf(r.current),
    preliminary: r.preliminary,
    notes: r.notes,
    window: { from: r.period.from, to: r.period.to, basis: r.period.basis },
    drill: r.drill.map((d) => ({ input: d.input, sign: drillSign(d.input), label: d.label, statement: d.statement ?? null, kind: d.kind, accountIds: d.accountIds ?? [], source: d.source ?? null })),
    scope: {
      included: r.scope.included,
      excluded: r.scope.excluded.map((x) => ({ companyId: x.companyId, name: ctx.names.get(x.companyId) ?? 'A company', message: x.message })),
    },
    summary,
  };
}
