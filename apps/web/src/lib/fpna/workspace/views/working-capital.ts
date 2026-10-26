/**
 * Working-capital tab (portal M4 "WC days + CCC", exceed X7): DSO / DPO / DIO / cash
 * conversion cycle by month (month ↔ TTM switch), receivables and payables aging by company
 * from the sub-ledgers, top-customer share bars (any customer over 10% flagged), and the
 * collection effectiveness index. PURE over one dataset (operational inputs are governed
 * with it).
 */

import type { MonthKey } from '@/lib/analytics/months';
import type { EvaluateRequest, OperationalKey } from '@/lib/metrics/types';
import { chartPeriods, defOf, evalAt, monthlyValues, scopedCompanies, trailing, type EvalCtx } from '../series';
import type { WsAgingBlock, WsBlock, WsMultiLineBlock, WsShareBlock, WsSeriesBlock, WsValue } from '../types';
import { fmt, longMonth, wsDirection } from '../units';
import { footnotesFor, rangeLabel } from './common';

const DAYS = ['dso', 'dpo', 'dio', 'cash_conversion_cycle'] as const;
const AR_BUCKETS: Array<{ key: OperationalKey; label: string }> = [
  { key: 'ar_current', label: 'Current' },
  { key: 'ar_1_30', label: '1–30' },
  { key: 'ar_31_60', label: '31–60' },
  { key: 'ar_61_90', label: '61–90' },
  { key: 'ar_over_90', label: 'Over 90' },
];
const AP_BUCKETS: Array<{ key: OperationalKey; label: string }> = [
  { key: 'ap_current', label: 'Current' },
  { key: 'ap_1_30', label: '1–30' },
  { key: 'ap_31_60', label: '31–60' },
  { key: 'ap_61_90', label: '61–90' },
  { key: 'ap_over_90', label: 'Over 90' },
];

export function workingCapitalPlan(end: MonthKey, range: number): EvaluateRequest[] {
  const scope = { companyIds: [], weighting: 'full' as const };
  const first = trailing(end, range)[0];
  const out: EvaluateRequest[] = [];
  for (const m of [...DAYS, 'collection_effectiveness_index', 'average_days_delinquent', 'best_possible_dso', 'top_customer_concentration']) {
    out.push({ metric: m, scope, periodEnd: end, basis: 'month', comparison: 'none', sparkline: 0 });
    out.push({ metric: m, scope, periodEnd: first, basis: 'ttm', comparison: 'none', sparkline: 0 });
  }
  return out;
}

function daysBlock(ctx: EvalCtx, end: MonthKey, range: number): WsMultiLineBlock {
  const months = trailing(end, range);
  const lines = DAYS.map((m) => ({ key: m, label: defOf(m).name.replace(/ \(.*\)$/, ''), metric: m, direction: wsDirection(defOf(m).direction), values: monthlyValues(ctx, m, months).values }));
  const ttm = DAYS.map((m) => ({ key: m, values: monthlyValues(ctx, m, months, 'ttm').values }));
  const last = (k: number) => lines[k].values[lines[k].values.length - 1];
  const ccc = last(3);
  return {
    kind: 'multi_line',
    id: 'wc-days',
    title: 'Working-capital days and the cash conversion cycle',
    eyebrow: 'Working capital',
    basis: 'Days of revenue in receivables (DSO), of cost in payables (DPO) and inventory (DIO); cycle = DSO + DIO − DPO. Switch between each month and the trailing twelve months.',
    period: rangeLabel(months),
    unit: 'days',
    summary:
      ccc !== null
        ? `Cash takes ${Math.round(ccc)} days to come back round in ${longMonth(end)}: DSO ${fmt(last(0), 'days')}, DIO ${fmt(last(2), 'days')}, DPO ${fmt(last(1), 'days')}.`
        : `The cash conversion cycle needs receivables, payables and cost of revenue on file for ${longMonth(end)}.${last(0) !== null ? ` DSO is ${fmt(last(0), 'days')}.` : ''}`,
    footnotes: ['DIO is blank where no inventory account is mapped'],
    periods: chartPeriods(ctx, months),
    lines,
    alternates: { ttm },
  };
}

function aging(ctx: EvalCtx, end: MonthKey, side: 'ar' | 'ap'): WsAgingBlock {
  const buckets = side === 'ar' ? AR_BUCKETS : AP_BUCKETS;
  const companies = scopedCompanies(ctx);
  const available = buckets.every((b) => ctx.ds.operationalAvailable.includes(b.key));
  const rows = companies.map((c) => ({ key: c.id, label: c.name, values: buckets.map((b) => (available ? (c.operational[b.key]?.[end] ?? null) : null)) as WsValue[] }));
  const totals = buckets.map((_, i) => rows.reduce((s, r) => s + (r.values[i] ?? 0), 0));
  const total = totals.reduce((s, v) => s + v, 0);
  const overdue = totals.slice(1).reduce((s, v) => s + v, 0);
  const noun = side === 'ar' ? 'receivables' : 'payables';
  const hasAny = rows.some((r) => r.values.some((v) => v !== null && v !== 0));
  return {
    kind: 'aging',
    id: `wc-aging-${side}`,
    title: side === 'ar' ? 'Who owes us, and how late' : 'Whom we owe, and how late',
    eyebrow: side === 'ar' ? 'Receivables' : 'Payables',
    basis: `Open ${side === 'ar' ? 'invoices' : 'bills'} at ${longMonth(end)} by days past due, from the sub-ledger, by company`,
    period: `At ${longMonth(end)}`,
    summary: hasAny ? `${fmt(total, 'money')} of ${noun} are open; ${fmt(overdue, 'money')} (${total > 0 ? ((overdue / total) * 100).toFixed(1) : '0.0'}%) is past due, ${fmt(totals[4], 'money')} over 90 days.` : `No open ${noun} at ${longMonth(end)}.`,
    footnotes: [],
    buckets: buckets.map((b) => ({ key: b.key, label: b.label })),
    rows: rows.length > 1 ? [{ key: 'all', label: 'All companies', values: totals }, ...rows] : rows,
    ...(!available
      ? { state: { kind: 'unavailable' as const, reason: 'not_on_file' as const, detail: `The ${noun} sub-ledger is not available for this scope.` } }
      : !hasAny
        ? { state: { kind: 'empty' as const, title: `Nothing ${side === 'ar' ? 'is owed to you' : 'is owed'}`, body: `There are no open ${side === 'ar' ? 'invoices' : 'bills'} at ${longMonth(end)}.`, actionHref: side === 'ar' ? '/invoices' : '/bills', actionLabel: side === 'ar' ? 'Open invoices' : 'Open bills' } }
        : {}),
  };
}

/** Revenue by customer over the window, across the companies in scope (cents). */
export function customerTotals(ctx: EvalCtx, months: readonly MonthKey[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of scopedCompanies(ctx)) {
    for (const m of months) {
      const rec = c.customerRevenue?.[m];
      if (!rec) continue;
      for (const [id, cents] of Object.entries(rec)) out.set(id, (out.get(id) ?? 0) + cents);
    }
  }
  return out;
}

export function customerShareBlock(ctx: EvalCtx, months: readonly MonthKey[], names: ReadonlyMap<string, string>, periodLabel: string): WsShareBlock {
  const totals = [...customerTotals(ctx, months).entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const all = totals.reduce((s, [, v]) => s + v, 0);
  const items = totals.map(([id, v]) => ({ key: id, label: names.get(id) ?? 'Customer', value: v }));
  const top = items[0];
  const flagged = items.filter((i) => all > 0 && (i.value ?? 0) / all >= 0.1);
  return {
    kind: 'share',
    id: 'wc-customers',
    title: 'Where the revenue comes from',
    eyebrow: 'Concentration',
    basis: `Invoiced revenue by customer, ${periodLabel}; any customer over 10% is flagged`,
    period: periodLabel,
    unit: 'money',
    itemLabel: 'Customer',
    threshold: 0.1,
    summary: top && all > 0 ? `${top.label} is ${(((top.value ?? 0) / all) * 100).toFixed(1)}% of invoiced revenue; ${flagged.length} customer${flagged.length === 1 ? '' : 's'} are over 10%.` : 'No invoiced revenue in this window.',
    footnotes: ['Invoices issued in the window (the sub-ledger), not GL revenue — the two differ by revenue-recognition timing'],
    items,
    ...(items.length === 0 ? { state: { kind: 'empty' as const, title: 'No invoices in this window', body: 'Customer concentration appears once invoices are issued.', actionHref: '/invoices', actionLabel: 'Open invoices' } } : {}),
  };
}

function ceiBlock(ctx: EvalCtx, end: MonthKey, range: number): WsSeriesBlock {
  const months = trailing(end, range);
  const def = defOf('collection_effectiveness_index');
  const actual = monthlyValues(ctx, 'collection_effectiveness_index', months).values;
  const periods = chartPeriods(ctx, months);
  const last = actual[actual.length - 1];
  const r = evalAt(ctx, 'collection_effectiveness_index', end, 'month');
  return {
    kind: 'series',
    id: 'wc-cei',
    metric: def.key,
    unit: 'percent',
    direction: 'higher_is_better',
    chart: 'line',
    title: 'Collection effectiveness',
    eyebrow: 'Collections',
    basis: 'Share of collectible receivables actually collected each month (100% = everything due was collected)',
    period: rangeLabel(months),
    summary: last !== null ? `Collection effectiveness was ${fmt(last, 'percent')} in ${longMonth(end)}.` : `${def.name}: ${r.current.status !== 'ok' ? r.current.message : 'no figure'}.`,
    definition: { text: def.definition, source: 'Invoices and receipts (AR sub-ledger)' },
    footnotes: footnotesFor(periods, actual),
    data: { periods, actual },
    ...(actual.every((v) => v === null) ? { state: { kind: 'unavailable' as const, reason: 'not_on_file' as const, detail: r.current.status !== 'ok' ? r.current.message : 'No receivables activity on file.' } } : {}),
  };
}

export function workingCapitalBlocks(ctx: EvalCtx, end: MonthKey, range: number, windowMonths: readonly MonthKey[], customerNames: ReadonlyMap<string, string>, periodLabel: string): WsBlock[] {
  return [daysBlock(ctx, end, range), aging(ctx, end, 'ar'), aging(ctx, end, 'ap'), customerShareBlock(ctx, windowMonths, customerNames, periodLabel), ceiBlock(ctx, end, range)];
}

