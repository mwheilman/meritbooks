/**
 * Group tab (portal M5 parity, exceed X1): every client the reader can see —
 *   combined (100% each) and ownership-weighted totals, consolidated (eliminated) figures
 *   with an elimination bridge from the ENGINE, combined revenue / EBITDA by month, share of
 *   revenue and EBITDA by company, a sortable league table with sparklines and stale flags,
 *   the Rule-of-40 scatter, and a company × metric heat grid.
 * UI copy says "clients" / "group" (never "portfolio"). PURE.
 */

import { addMonths, type MonthKey } from '@/lib/analytics/months';
import { eliminationBridge } from '@/lib/analytics/bridge';
import type { Basis, EvaluateRequest } from '@/lib/metrics/types';
import type { ReportResult } from '@/lib/reports/engine/types';
import { chartPeriods, defOf, evalAt, monthlyValues, scopedCompanies, trailing, valueOf, withCompanies, windowLabel, type EvalCtx } from '../series';
import type { WsBlock, WsBridgeBlock, WsHeatBlock, WsLeagueBlock, WsLeagueColumn, WsLeagueRow, WsScatterBlock, WsShareBlock, WsTilesBlock, WsValue } from '../types';
import { axisMonth, fmt, longMonth, wsDirection, wsUnit } from '../units';
import { footnotesFor, rangeLabel } from './common';

const LEAGUE = ['revenue', 'revenue_growth_yoy', 'gross_margin', 'ebitda', 'ebitda_margin', 'rule_of_40'] as const;
const HEAT = ['revenue_growth_yoy', 'gross_margin', 'ebitda_margin', 'dso', 'current_ratio', 'net_debt_to_ebitda', 'cash_runway_months'] as const;

export function groupPlan(end: MonthKey, basis: Basis): EvaluateRequest[] {
  const scope = { companyIds: [], weighting: 'full' as const };
  const keys = [...new Set([...LEAGUE, ...HEAT, 'net_income', 'cash'])];
  return [
    ...keys.map((m) => ({ metric: m, scope, periodEnd: end, basis, comparison: 'prior_year' as const, sparkline: 12 as const })),
    { metric: 'revenue', scope, periodEnd: end, basis: 'ttm', comparison: 'none', sparkline: 12 },
    { metric: 'ebitda', scope, periodEnd: end, basis: 'ttm', comparison: 'none', sparkline: 12 },
  ];
}

function totalsTiles(ctx: EvalCtx, end: MonthKey, basis: Basis): WsTilesBlock {
  const w = { ...ctx, scope: { ...ctx.scope, weighting: 'ownership' as const }, memo: new Map() };
  const f = { ...ctx, scope: { ...ctx.scope, weighting: 'full' as const }, memo: new Map() };
  const t = (c: EvalCtx, m: string, label: string, sub: string) => {
    const r = evalAt(c, m, end, basis);
    return { key: `${m}-${c.scope.weighting}`, label, unit: wsUnit(defOf(m).unit), value: valueOf(m, r.current), sub: r.current.status === 'ok' ? sub : r.current.message };
  };
  const tiles = [
    t(f, 'revenue', 'Revenue, combined', '100% of each company'),
    t(w, 'revenue', 'Revenue, ownership-weighted', 'Each company × the group’s share'),
    t(f, 'ebitda', 'EBITDA, combined', '100% of each company'),
    t(w, 'ebitda', 'EBITDA, ownership-weighted', 'Each company × the group’s share'),
    t(f, 'ebitda_margin', 'EBITDA margin, combined', 'On combined revenue'),
    t(f, 'cash', 'Cash, combined', `At ${longMonth(end)}`),
  ];
  const assumed = evalAt(w, 'revenue', end, basis).scope.assumedFullOwnership.map((id) => ctx.names.get(id) ?? id);
  return {
    kind: 'tiles',
    id: 'group-totals',
    title: 'The group at a glance',
    eyebrow: 'Group',
    basis: `${windowLabel(end, basis)} · combined adds companies at 100%; ownership-weighted multiplies each by the group's ownership`,
    period: windowLabel(end, basis),
    summary: tiles[0].value !== null ? `Combined revenue is ${fmt(tiles[0].value, 'money')}; ownership-weighted it is ${fmt(tiles[1].value, 'money')}.` : 'No combined figures for this window yet.',
    footnotes: assumed.length ? [`No ownership on file for ${assumed.join(', ')}; counted at 100%`] : [],
    tiles,
  };
}

function combinedCombo(ctx: EvalCtx, metric: 'revenue' | 'ebitda', end: MonthKey): WsBlock {
  const months = trailing(end, 12);
  const def = defOf(metric);
  const actual = monthlyValues(ctx, metric, months).values;
  const priorYear = monthlyValues(ctx, metric, months.map((m) => addMonths(m, -12))).values;
  const ttm = monthlyValues(ctx, metric, months, 'ttm').values;
  const periods = chartPeriods(ctx, months);
  const last = actual[actual.length - 1];
  return {
    kind: 'series',
    id: `group-${metric}`,
    metric,
    unit: 'money',
    direction: wsDirection(def.direction),
    chart: 'combo',
    title: `Combined ${def.name.toLowerCase() === 'ebitda' ? 'EBITDA' : def.name.toLowerCase()} by month`,
    eyebrow: 'Group',
    basis: `Every company in scope added together at 100%, ${rangeLabel(months)}, with the same month a year earlier and the trailing twelve months`,
    period: rangeLabel(months),
    summary: last !== null ? `Combined ${def.name === 'EBITDA' ? 'EBITDA' : def.name.toLowerCase()} was ${fmt(last, 'money')} in ${longMonth(end)}; ${fmt(ttm[ttm.length - 1], 'money')} over the trailing twelve months.` : `No combined ${def.name} for ${longMonth(end)}.`,
    footnotes: [...footnotesFor(periods, actual), 'Combined, not eliminated — see the consolidated bridge for intercompany eliminations'],
    data: { periods, actual, priorYear, ttm },
    headline: { value: last, label: longMonth(end), base: priorYear[priorYear.length - 1], baseLabel: 'a year earlier' },
  };
}

interface CompanyRow {
  id: string;
  name: string;
  closedThrough: MonthKey | null;
  values: Record<string, WsValue>;
  reasons: Record<string, string | null>;
  spark: WsValue[];
  sparkPrelim: boolean[];
}

function perCompany(ctx: EvalCtx, end: MonthKey, basis: Basis): CompanyRow[] {
  return scopedCompanies(ctx).map((c) => {
    const one = withCompanies(ctx, [c.id]);
    const values: Record<string, WsValue> = {};
    const reasons: Record<string, string | null> = {};
    for (const m of [...new Set([...LEAGUE, ...HEAT])]) {
      const r = evalAt(one, m, end, basis);
      values[m] = valueOf(m, r.current);
      reasons[m] = r.current.status === 'ok' ? null : r.current.message;
    }
    const spark = evalAt(one, 'revenue', end, 'month', 'none', 12).sparkline;
    return { id: c.id, name: c.name, closedThrough: c.closedThrough, values, reasons, spark: spark.map((p) => p.value), sparkPrelim: spark.map((p) => p.preliminary) };
  });
}

function shareBlock(rows: CompanyRow[], metric: 'revenue' | 'ebitda', label: string): WsShareBlock {
  const items = rows.map((r) => ({ key: r.id, label: r.name, value: r.values[metric] }));
  const pos = items.filter((i) => (i.value ?? 0) > 0);
  const total = pos.reduce((s, i) => s + (i.value ?? 0), 0);
  const top = [...pos].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
  const losses = items.filter((i) => (i.value ?? 0) < 0).map((i) => i.label);
  return {
    kind: 'share',
    id: `group-share-${metric}`,
    title: `Where the ${label} comes from`,
    eyebrow: 'Mix',
    basis: `Each company's share of the group's ${label}; a loss-maker is shown hatched and left out of the shares`,
    period: '',
    unit: 'money',
    itemLabel: 'Company',
    summary: top && total > 0 ? `${top.label} provides ${(((top.value ?? 0) / total) * 100).toFixed(1)}% of the group's ${label}.${losses.length ? ` ${losses.join(', ')} ${losses.length === 1 ? 'is' : 'are'} loss-making.` : ''}` : `No positive ${label} in this window.`,
    footnotes: losses.length ? [`Loss-making: ${losses.join(', ')}`] : [],
    items,
  };
}

const LEAGUE_COLS: WsLeagueColumn[] = LEAGUE.map((m) => ({ key: m, label: defOf(m).name, unit: wsUnit(defOf(m).unit), direction: wsDirection(defOf(m).direction) }));

function leagueBlock(rows: CompanyRow[], end: MonthKey, basis: Basis, latest: MonthKey): WsLeagueBlock {
  const out: WsLeagueRow[] = rows
    .map((r) => ({
      key: r.id,
      label: r.name,
      sub: r.closedThrough && r.closedThrough < latest ? `Stale: closed through ${longMonth(r.closedThrough)}` : r.closedThrough ? `Closed through ${longMonth(r.closedThrough)}` : 'Not closed',
      values: LEAGUE.map((m) => r.values[m]),
      reasons: LEAGUE.map((m) => r.reasons[m]),
      spark: r.spark,
      sparkStatuses: r.sparkPrelim.map((p) => (p ? 'preliminary' : 'closed') as 'preliminary' | 'closed'),
      href: `/fpna?tab=performance&companies=${r.id}`,
    }))
    .sort((a, b) => (b.values[0] ?? -Infinity) - (a.values[0] ?? -Infinity));
  const best = [...out].filter((r) => r.values[5] !== null).sort((a, b) => (b.values[5] as number) - (a.values[5] as number))[0];
  const months = trailing(end, 12);
  return {
    kind: 'league',
    id: 'group-league',
    title: 'Companies compared',
    eyebrow: 'League',
    basis: `${windowLabel(end, basis)} · click a column to sort · Rule of 40 = revenue growth + EBITDA margin`,
    period: windowLabel(end, basis),
    summary: out[0] ? `${out[0].label} is the largest by revenue.${best ? ` ${best.label} scores highest on the Rule of 40 (${fmt(best.values[5], 'percent')}).` : ''}` : 'No company in scope.',
    footnotes: ['Each company is ranked on its own books; ratios are never averaged'],
    rowHeading: 'Company',
    columns: LEAGUE_COLS,
    rows: out,
    sparkLabel: 'Revenue, last 12 months',
    sparkUnit: 'money',
    sparkPeriods: months.map((m) => `${axisMonth(m)} ’${m.slice(2, 4)}`),
  };
}

function scatterBlock(rows: CompanyRow[], end: MonthKey): WsScatterBlock {
  const points = rows.map((r) => ({ key: r.id, label: r.name, x: r.values.revenue_growth_yoy, y: r.values.ebitda_margin, size: r.values.revenue }));
  const notPlaced = points.filter((p) => p.x === null || p.y === null).map((p) => p.label);
  const placed = points.filter((p) => p.x !== null && p.y !== null);
  const clear = placed.filter((p) => (p.x as number) + (p.y as number) >= 0.4).length;
  return {
    kind: 'scatter',
    id: 'group-r40',
    title: 'Rule of 40',
    eyebrow: 'Growth and margin',
    basis: 'Revenue growth against EBITDA margin, one square per company (size = revenue); above the line clears 40',
    period: longMonth(end),
    summary: placed.length ? `${clear} of ${placed.length} companies clear the Rule of 40.` : 'No company has the history to be placed yet.',
    footnotes: notPlaced.length ? [`Not placed (not enough history): ${notPlaced.join(', ')}`] : [],
    xLabel: 'Revenue growth',
    yLabel: 'EBITDA margin',
    xUnit: 'percent',
    yUnit: 'percent',
    sumLine: 0.4,
    points,
    notPlaced,
  };
}

function heatBlock(rows: CompanyRow[], end: MonthKey, basis: Basis): WsHeatBlock {
  const columns: WsLeagueColumn[] = HEAT.map((m) => ({ key: m, label: defOf(m).name.replace(/ \(.*\)$/, ''), unit: wsUnit(defOf(m).unit), direction: wsDirection(defOf(m).direction) }));
  return {
    kind: 'heat',
    id: 'group-heat',
    title: 'Clients × measures',
    eyebrow: 'Heat grid',
    basis: 'Each column ranked within itself; darker is better for that measure (↑ higher is better, ↓ lower is better)',
    period: windowLabel(end, basis),
    summary: `${rows.length} companies across ${columns.length} measures.`,
    footnotes: [],
    rowHeading: 'Company',
    columns,
    rows: rows.map((r) => ({ key: r.id, label: r.name, values: HEAT.map((m) => r.values[m]) })),
  };
}

/** Elimination bridge from the engine's consolidated P&L by company (rows `rev` / `ebitda`). */
export function eliminationBlock(result: ReportResult, rowId: 'rev' | 'ebitda', periodLabel: string): WsBridgeBlock {
  const row = result.rows.find((r) => r.id === rowId);
  const idx = (id: string) => result.columns.findIndex((c) => c.id === id);
  const label = rowId === 'rev' ? 'revenue' : 'EBITDA';
  const companies = result.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.id.startsWith('co:'))
    .map(({ c, i }) => ({ id: c.id.slice(3), label: c.sublabel ?? c.label, cents: Math.round(row?.values[i] ?? 0) }));
  const elim = Math.round(row?.values[idx('elim')] ?? 0);
  const consol = row?.values[idx('consol')] ?? null;
  const b = eliminationBridge(companies, elim);
  const steps = [
    ...b.steps.map((s) => ({ key: s.key, label: s.label, kind: 'delta' as const, value: s.cents })),
    { key: 'end', label: 'Consolidated', kind: 'end' as const, value: b.end.cents },
  ];
  const ties = consol === null || Math.round(consol) === b.end.cents;
  return {
    kind: 'bridge',
    id: `group-elim-${rowId}`,
    title: `Consolidated ${label}: companies, eliminations, group`,
    eyebrow: 'Consolidation',
    basis: 'Each company in full, then intercompany eliminations (counterparty inside the group, and interdepartment revenue and cost) to the consolidated figure',
    period: periodLabel,
    unit: 'money',
    summary: `Consolidated ${label} is ${fmt(b.end.cents, 'money')} after ${fmt(elim, 'money')} of intercompany eliminations.`,
    footnotes: [...result.notes.slice(0, 2), ...result.warnings.filter((w) => w.code === 'ELIMINATION_RESIDUAL' || w.code === 'NON_FULL_ENTITIES').map((w) => w.message)],
    steps,
    ties,
    from: { label: 'Companies', window: periodLabel },
    to: { label: 'Consolidated', window: periodLabel },
    ...(companies.length < 2 ? { state: { kind: 'empty' as const, title: 'One company in scope', body: 'Add two or more companies to see the consolidation bridge.' } } : {}),
  };
}

export function groupBlocks(ctx: EvalCtx, end: MonthKey, basis: Basis, consolidated: ReportResult | null, periodLabel: string): WsBlock[] {
  const rows = perCompany(ctx, end, basis);
  const latest = ctx.ds.latestMonth;
  const blocks: WsBlock[] = [
    totalsTiles(ctx, end, basis),
    combinedCombo(ctx, 'revenue', end),
    combinedCombo(ctx, 'ebitda', end),
    shareBlock(rows, 'revenue', 'revenue'),
    shareBlock(rows, 'ebitda', 'EBITDA'),
    leagueBlock(rows, end, basis, latest),
    scatterBlock(rows, end),
    heatBlock(rows, end, basis),
  ];
  if (consolidated) blocks.splice(1, 0, eliminationBlock(consolidated, 'rev', periodLabel), eliminationBlock(consolidated, 'ebitda', periodLabel));
  return blocks;
}
