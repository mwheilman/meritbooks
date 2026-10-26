/**
 * Performance tab (portal M3 / M4): revenue, gross profit and EBITDA by month (actual, the
 * same month a year earlier, approved budget ticks, TTM sub-panel, unclosed months hatched),
 * the YoY table (Month · FYTD · TTM; margins in points), the CAGR ladder (TTM-to-TTM),
 * margins trend with a month / TTM switch, and the seasonality index. PURE over one dataset.
 */

import { addMonths, fiscalYearStart, monthRange, type MonthKey } from '@/lib/analytics/months';
import { yoyDollarRow, yoyMarginRow, type YoyCell } from '@/lib/analytics/growth';
import { bestWorstMonth, quarterShares, seasonalityIndex, seasonalOverlay } from '@/lib/analytics/seasonality';
import type { MonthlySeries } from '@/lib/analytics/series';
import type { EvaluateRequest } from '@/lib/metrics/types';
import { budgetValues, chartPeriods, defOf, evalAt, monthlyValues, trailing, unavailableOf, valueOf, type EvalCtx } from '../series';
import type { WsBlock, WsCagrBlock, WsMultiLineBlock, WsSeasonalityBlock, WsSeriesBlock, WsValue, WsYoyBlock, WsYoyCell } from '../types';
import { changeWords, fmt, longMonth, wsDirection, wsUnit } from '../units';
import { footnotesFor, rangeLabel } from './common';

export type ChartRange = 12 | 24 | 36;

const COMBO_METRICS = ['revenue', 'gross_profit', 'ebitda'] as const;
const MARGIN_METRICS = ['gross_margin', 'ebitda_margin', 'sga_pct_revenue'] as const;
const CAGR = [
  { key: 'revenue', label: 'Revenue', metrics: ['revenue_cagr_1y', 'revenue_cagr_3y', 'revenue_cagr_5y'] },
  { key: 'ebitda', label: 'EBITDA', metrics: ['ebitda_cagr_1y', 'ebitda_cagr_3y', 'ebitda_cagr_5y'] },
] as const;
const SEASON_MONTHS = 48;

/** Requests whose union `planLoad` turns into ONE dataset load covering every month this tab reads. */
export function performancePlan(end: MonthKey, range: ChartRange): EvaluateRequest[] {
  const scope = { companyIds: [], weighting: 'full' as const };
  const earliest = addMonths(end, -(range + 12));
  const out: EvaluateRequest[] = [];
  for (const m of [...COMBO_METRICS, 'net_income', ...MARGIN_METRICS]) {
    out.push({ metric: m, scope, periodEnd: end, basis: 'month', comparison: 'budget', sparkline: 0 });
    out.push({ metric: m, scope, periodEnd: earliest, basis: 'ttm', comparison: 'none', sparkline: 0 });
  }
  out.push({ metric: 'revenue', scope, periodEnd: addMonths(end, -(SEASON_MONTHS - 12)), basis: 'ttm', comparison: 'none', sparkline: 0 });
  for (const row of CAGR) for (const m of row.metrics) out.push({ metric: m, scope, periodEnd: end, basis: 'ttm', comparison: 'none', sparkline: 0 });
  return out;
}

function comboBlock(ctx: EvalCtx, metric: (typeof COMBO_METRICS)[number], end: MonthKey, range: ChartRange): WsSeriesBlock {
  const def = defOf(metric);
  const months = trailing(end, range);
  const actual = monthlyValues(ctx, metric, months).values;
  const priorYear = monthlyValues(ctx, metric, months.map((m) => addMonths(m, -12))).values;
  const budget = budgetValues(ctx, metric, months);
  const ttm = monthlyValues(ctx, metric, months, 'ttm').values;
  const periods = chartPeriods(ctx, months);
  const last = actual.length - 1;
  const cur = actual[last];
  const py = priorYear[last];
  const unit = wsUnit(def.unit);
  const hasBudget = budget.some((v) => v !== null);
  let summary: string;
  if (cur === null) summary = `${def.name} has no figure for ${longMonth(end)} yet.`;
  else {
    summary = `${def.name} was ${fmt(cur, unit)} in ${longMonth(end)}`;
    summary += py !== null ? `, ${changeWords(cur, py, unit)} on ${longMonth(addMonths(end, -12))}.` : '.';
    if (ttm[last] !== null) summary += ` The trailing twelve months total ${fmt(ttm[last], unit)}.`;
  }
  // the accounts whose Σ(credit − debit) IS the figure (EBITDA leaves operating D&A out)
  const ids = (c: 'revenue' | 'cogs' | 'opex' | 'da_operating') => ctx.ds.classMapping[c]?.accountIds ?? [];
  const da = new Set(ids('da_operating'));
  const accountIds =
    metric === 'revenue' ? ids('revenue') : metric === 'gross_profit' ? [...ids('revenue'), ...ids('cogs')] : [...ids('revenue'), ...ids('cogs'), ...ids('opex')].filter((a) => !da.has(a));
  return {
    kind: 'series',
    id: `perf-${metric}`,
    metric,
    unit,
    direction: wsDirection(def.direction),
    chart: 'combo',
    title: `${def.name} by month`,
    eyebrow: def.name,
    basis: `By month, ${rangeLabel(months)}, with the same month a year earlier${hasBudget ? ', the approved budget' : ''} and the trailing twelve months`,
    period: rangeLabel(months),
    summary,
    definition: { text: def.definition, formula: undefined, source: 'Posted GL, accrual basis' },
    footnotes: [...footnotesFor(periods, actual), ...(hasBudget ? [] : ['No approved budget for these months'])],
    data: { periods, actual, priorYear, budget: hasBudget ? budget : undefined, ttm },
    headline: { value: cur, label: longMonth(end), base: py, baseLabel: longMonth(addMonths(end, -12)) },
    drill: { accountIds, statement: 'income_statement', sign: -1 },
    ...(actual.every((v) => v === null) ? { state: { kind: 'unavailable' as const, reason: 'not_on_file' as const, detail: `No posted ${def.name.toLowerCase()} for ${rangeLabel(months)}.` } } : {}),
  };
}

function cell(c: YoyCell, margin: boolean): WsYoyCell {
  return { current: c.current, prior: c.prior, change: c.change, pct: margin ? null : c.pct, points: margin ? c.points : null };
}

function series(months: MonthKey[], values: WsValue[]): MonthlySeries {
  return months.map((month, i) => ({ month, value: values[i] }));
}

function yoyBlock(ctx: EvalCtx, end: MonthKey): WsYoyBlock {
  const fy = ctx.ds.fyStartMonth;
  const months = monthRange(addMonths(end, -23), end);
  const s: Record<string, MonthlySeries> = {};
  for (const m of ['revenue', 'gross_profit', 'ebitda', 'net_income']) s[m] = series(months, monthlyValues(ctx, m, months).values);
  const dollar = (k: string, label: string) => {
    const r = yoyDollarRow(s[k], end, fy);
    return { key: k, label, unit: 'money' as const, direction: 'higher_is_better' as const, month: cell(r.month, false), fytd: cell(r.fytd, false), ttm: cell(r.ttm, false) };
  };
  const margin = (k: string, label: string, num: string) => {
    const r = yoyMarginRow(s[num], s.revenue, end, fy);
    return { key: k, label, unit: 'percent' as const, direction: 'higher_is_better' as const, month: cell(r.month, true), fytd: cell(r.fytd, true), ttm: cell(r.ttm, true) };
  };
  const rows = [
    dollar('revenue', 'Revenue'),
    dollar('gross_profit', 'Gross profit'),
    margin('gross_margin', 'Gross margin', 'gross_profit'),
    dollar('ebitda', 'EBITDA'),
    margin('ebitda_margin', 'EBITDA margin', 'ebitda'),
    dollar('net_income', 'Net income'),
  ];
  const rev = rows[0];
  const summary =
    rev.fytd.current !== null && rev.fytd.prior !== null
      ? `Fiscal year-to-date revenue is ${fmt(rev.fytd.current, 'money')}, ${changeWords(rev.fytd.current, rev.fytd.prior, 'money')} on the same months last year.`
      : 'Year-over-year comparisons appear once the same months last year are on file.';
  const fyStart = fiscalYearStart(end, fy);
  return {
    kind: 'yoy',
    id: 'perf-yoy',
    title: 'Year over year',
    eyebrow: 'Comparison',
    basis: 'Each line against the same window a year earlier. Dollar lines change in %, margins in points.',
    period: longMonth(end),
    summary,
    footnotes: ['n/m: the base is zero or negative, or the sign flips'],
    headings: { month: longMonth(end), fytd: `FYTD (${longMonth(fyStart)} – ${longMonth(end)})`, ttm: `TTM to ${longMonth(end)}` },
    rows,
  };
}

function cagrBlock(ctx: EvalCtx, end: MonthKey): WsCagrBlock {
  const rows = CAGR.map((row) => ({
    key: row.key,
    label: row.label,
    rungs: row.metrics.map((metric, i) => {
      const r = evalAt(ctx, metric, end, 'ttm');
      return { years: [1, 3, 5][i], metric, value: valueOf(metric, r.current), unavailable: unavailableOf(r.current) };
    }),
  }));
  const r3 = rows[0].rungs[1];
  const summary = r3.value !== null ? `Revenue has compounded at ${fmt(r3.value, 'percent')} a year over three years (TTM to TTM).` : `Three-year revenue growth needs 48 months on file. ${r3.unavailable?.message ?? ''}`.trim();
  return {
    kind: 'cagr',
    id: 'perf-cagr',
    title: 'Growth rates',
    eyebrow: 'Growth',
    basis: 'Compound annual growth, trailing twelve months against the trailing twelve months 1, 3 and 5 years earlier (removes seasonality)',
    period: `TTM to ${longMonth(end)}`,
    summary,
    footnotes: [],
    rows,
  };
}

function marginsBlock(ctx: EvalCtx, end: MonthKey, range: ChartRange): WsMultiLineBlock {
  const months = trailing(end, range);
  const periods = chartPeriods(ctx, months);
  const lines = MARGIN_METRICS.map((m) => ({ key: m, label: defOf(m).name, metric: m, direction: wsDirection(defOf(m).direction), values: monthlyValues(ctx, m, months).values }));
  const ttm = MARGIN_METRICS.map((m) => ({ key: m, values: monthlyValues(ctx, m, months, 'ttm').values }));
  const gm = lines[0].values[lines[0].values.length - 1];
  const gmTtm = ttm[0].values[ttm[0].values.length - 1];
  return {
    kind: 'multi_line',
    id: 'perf-margins',
    title: 'Margins',
    eyebrow: 'Margins',
    basis: 'Gross, EBITDA and SG&A as a share of revenue. Switch between each month and the trailing twelve months.',
    period: rangeLabel(months),
    unit: 'percent',
    summary: gm !== null ? `Gross margin was ${fmt(gm, 'percent')} in ${longMonth(end)}${gmTtm !== null ? ` and ${fmt(gmTtm, 'percent')} over the trailing twelve months` : ''}.` : 'Margins appear once revenue is posted.',
    footnotes: ['A month with no positive revenue has no margin (gap, not zero)'],
    periods,
    lines,
    alternates: { ttm },
  };
}

function seasonalityBlock(ctx: EvalCtx, end: MonthKey): WsSeasonalityBlock {
  const fy = ctx.ds.fyStartMonth;
  const months = trailing(end, SEASON_MONTHS);
  const s = series(months, monthlyValues(ctx, 'revenue', months).values);
  const idx = seasonalityIndex(s, { fyStartMonth: fy, maxYears: 3 });
  const fyStart = fiscalYearStart(end, fy);
  const overlay = seasonalOverlay(s, idx, fyStart, end);
  const byCal = new Map(overlay.map((o) => [Number(o.month.slice(5, 7)), o.ratio]));
  const q = quarterShares(s, { fyStartMonth: fy, maxYears: 3 });
  const bw = bestWorstMonth(s, fyStart, end);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Fiscal order: start at the fiscal-year start month.
  const order = Array.from({ length: 12 }, (_, i) => ((fy - 1 + i) % 12) + 1);
  const peak = idx.index.reduce<{ m: number; v: number } | null>((best, v, i) => (v !== null && (!best || v > best.v) ? { m: i + 1, v } : best), null);
  const state = idx.yearsUsed.length === 0 ? { kind: 'unavailable' as const, reason: 'not_enough_history' as const, detail: 'The seasonality index needs at least one complete fiscal year of revenue on file.' } : undefined;
  return {
    kind: 'seasonality',
    id: 'perf-seasonality',
    title: 'Seasonality',
    eyebrow: 'Shape of the year',
    basis: `Each calendar month's revenue ÷ the average month, from ${idx.yearsUsed.length || 'no'} complete fiscal year${idx.yearsUsed.length === 1 ? '' : 's'}; this fiscal year against it`,
    period: `FY to ${longMonth(end)}`,
    summary: peak ? `${names[peak.m - 1]} is the strongest month (${peak.v.toFixed(2)}× an average month).${bw.best ? ` This year's best month so far is ${longMonth(bw.best.month)}.` : ''}` : 'Not enough complete years to index the seasons yet.',
    footnotes: idx.yearsSkipped.length ? [`Skipped incomplete or non-positive years: ${idx.yearsSkipped.join(', ')}`] : [],
    months: order.map((m) => ({ key: String(m), label: names[m - 1], index: idx.index[m - 1], current: byCal.get(m) ?? null })),
    quarterShares: q.shares,
    yearsUsed: idx.yearsUsed,
    best: bw.best,
    worst: bw.worst,
    ...(state ? { state } : {}),
  };
}

export function performanceBlocks(ctx: EvalCtx, end: MonthKey, range: ChartRange): WsBlock[] {
  return [
    ...COMBO_METRICS.map((m) => comboBlock(ctx, m, end, range)),
    yoyBlock(ctx, end),
    cagrBlock(ctx, end),
    marginsBlock(ctx, end, range),
    seasonalityBlock(ctx, end),
  ];
}
