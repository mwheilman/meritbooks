/**
 * Leverage & covenants tab (portal M8 tiles, exceed X8): debt / EBITDA, net debt / EBITDA,
 * DSCR, interest coverage and FCCR trends from the registry (TTM), debt tiles, and covenant
 * headroom gauges computed from the GL by lib/covenants (with the projected breach date).
 * PURE (covenant statuses are computed server-side and passed in).
 */

import type { MonthKey } from '@/lib/analytics/months';
import type { EvaluateRequest } from '@/lib/metrics/types';
import type { CovenantStatus } from '@/lib/covenants/status';
import { chartPeriods, defOf, evalAt, monthlyValues, trailing, valueOf, type EvalCtx } from '../series';
import type { WsBlock, WsGaugeBlock, WsMultiLineBlock, WsTilesBlock } from '../types';
import { fmt, longMonth, wsDirection, wsUnit } from '../units';
import { rangeLabel } from './common';

const LEVERAGE = ['debt_to_ebitda', 'net_debt_to_ebitda'] as const;
const COVERAGE = ['dscr', 'interest_coverage', 'fccr'] as const;
const TILES = ['total_debt', 'net_debt', 'interest_expense', 'debt_service', 'covenant_headroom_min'] as const;

export function leveragePlan(end: MonthKey, range: number): EvaluateRequest[] {
  const scope = { companyIds: [], weighting: 'full' as const };
  const first = trailing(end, range)[0];
  return [...LEVERAGE, ...COVERAGE, ...TILES].flatMap((m) => [
    { metric: m, scope, periodEnd: end, basis: 'ttm' as const, comparison: 'prior_year' as const, sparkline: 0 as const },
    { metric: m, scope, periodEnd: first, basis: 'ttm' as const, comparison: 'none' as const, sparkline: 0 as const },
  ]);
}

function lines(ctx: EvalCtx, keys: readonly string[], end: MonthKey, range: number, id: string, title: string, basis: string): WsMultiLineBlock {
  const months = trailing(end, range);
  const ls = keys.map((m) => ({ key: m, label: defOf(m).name, metric: m, direction: wsDirection(defOf(m).direction), values: monthlyValues(ctx, m, months, 'ttm').values }));
  const lastOf = (i: number) => ls[i].values[ls[i].values.length - 1];
  const first = ls[0];
  const v = lastOf(0);
  return {
    kind: 'multi_line',
    id,
    title,
    eyebrow: 'Lenders',
    basis,
    period: rangeLabel(months),
    unit: 'multiple',
    summary: v !== null ? `${first.label} is ${fmt(v, 'multiple')} at ${longMonth(end)}${ls[1] && lastOf(1) !== null ? `; ${ls[1].label.toLowerCase()} ${fmt(lastOf(1), 'multiple')}` : ''}.` : `${first.label}: ${evalAt(ctx, first.metric, end, 'ttm').current.status !== 'ok' ? (evalAt(ctx, first.metric, end, 'ttm').current as { message: string }).message : 'no figure'}.`,
    footnotes: ['Each point uses the trailing twelve months of EBITDA / debt service to that month'],
    periods: chartPeriods(ctx, months),
    lines: ls,
  };
}

function tiles(ctx: EvalCtx, end: MonthKey): WsTilesBlock {
  const ts = TILES.map((m) => {
    const r = evalAt(ctx, m, end, 'ttm');
    return { key: m, label: defOf(m).name, unit: wsUnit(defOf(m).unit), value: valueOf(m, r.current), sub: r.current.status === 'ok' ? (defOf(m).period.nature === 'balance' ? `At ${longMonth(end)}` : `TTM to ${longMonth(end)}`) : r.current.message };
  });
  return {
    kind: 'tiles',
    id: 'lev-tiles',
    title: 'Debt at a glance',
    eyebrow: 'Debt',
    basis: 'Balances at the period end; interest and debt service over the trailing twelve months',
    period: longMonth(end),
    summary: ts[0].value !== null ? `Total debt is ${fmt(ts[0].value, 'money')}; net of cash ${fmt(ts[1].value, 'money')}.` : 'No debt accounts are on file.',
    footnotes: [],
    tiles: ts,
  };
}

const TYPE_LABEL: Record<string, string> = { DSCR: 'DSCR', FCCR: 'Fixed-charge cover', LEVERAGE: 'Debt / EBITDA', CURRENT_RATIO: 'Current ratio', MIN_LIQUIDITY: 'Minimum liquidity', TNW: 'Tangible net worth', CUSTOM: 'Custom covenant' };

export function covenantBlock(statuses: readonly CovenantStatus[] | null, end: MonthKey, withheld: string | null): WsGaugeBlock {
  const gauges = (statuses ?? []).map((s) => {
    const e = s.evaluation;
    const unit = e.unit === 'CURRENCY' ? ('money' as const) : ('multiple' as const);
    const toWs = (v: number | null) => (v === null ? null : unit === 'money' ? Math.round(v * 100) : v);
    const threshold = Number(s.covenant.threshold);
    const warnPct = Number(s.covenant.warn_headroom_pct);
    const watch = Number.isFinite(warnPct) && warnPct > 0 ? (s.covenant.direction === 'MIN' ? threshold * (1 + warnPct / 100) : threshold * (1 - warnPct / 100)) : undefined;
    return {
      key: s.covenant.id,
      label: `${TYPE_LABEL[s.covenant.covenant_type] ?? s.covenant.covenant_type} (${s.covenant.direction === 'MIN' ? 'min' : 'max'} ${unit === 'money' ? fmt(Math.round(threshold * 100), 'money') : `${threshold.toFixed(2)}x`})`,
      sub: `${s.covenant.loan_name}${s.covenant.lender_name ? ` · ${s.covenant.lender_name}` : ''}${s.breach.breachDate ? ` · projected breach ${s.breach.crossingDate ?? s.breach.breachDate}` : ''}`,
      value: toWs(e.value),
      threshold: unit === 'money' ? Math.round(threshold * 100) : threshold,
      thresholdKind: s.covenant.direction === 'MIN' ? ('min' as const) : ('max' as const),
      unit,
      ...(watch !== undefined ? { watch: unit === 'money' ? Math.round(watch * 100) : watch } : {}),
      projected: null,
      band: e.band,
      headroomPct: e.headroomPct,
      breachDate: s.breach.crossingDate ?? s.breach.breachDate,
    };
  });
  const tight = [...gauges].filter((g) => g.headroomPct !== null).sort((a, b) => (a.headroomPct as number) - (b.headroomPct as number))[0];
  const breaches = gauges.filter((g) => g.band === 'BREACH').length;
  return {
    kind: 'gauges',
    id: 'lev-covenants',
    title: 'Covenant headroom',
    eyebrow: 'Covenants',
    basis: `Each active covenant measured from the GL at ${longMonth(end)} (lib/covenants), with the breach date projected from the cash forecast`,
    period: `At ${longMonth(end)}`,
    summary: withheld
      ? withheld
      : gauges.length === 0
        ? 'No active loan covenants are set up.'
        : `${gauges.length} covenant${gauges.length === 1 ? '' : 's'} tested; ${breaches} in breach.${tight ? ` The tightest is ${tight.label} with ${((tight.headroomPct as number) * 100).toFixed(1)}% headroom.` : ''}`,
    footnotes: ['Headroom = distance to the threshold as a share of the threshold; negative means in breach'],
    gauges: withheld ? [] : gauges,
    ...(withheld
      ? { state: { kind: 'unavailable' as const, reason: 'not_on_file' as const, detail: withheld } }
      : gauges.length === 0
        ? { state: { kind: 'empty' as const, title: 'No covenants set up', body: 'Add a loan covenant (or drop in the loan agreement) to see headroom here.', actionHref: '/covenants', actionLabel: 'Set up covenants' } }
        : {}),
  };
}

export function leverageBlocks(ctx: EvalCtx, end: MonthKey, range: number, covenants: readonly CovenantStatus[] | null, covenantWithheld: string | null): WsBlock[] {
  return [
    tiles(ctx, end),
    lines(ctx, LEVERAGE, end, range, 'lev-leverage', 'Leverage', 'Debt (and debt net of cash) as a multiple of trailing-twelve-month EBITDA — lower is safer'),
    lines(ctx, COVERAGE, end, range, 'lev-coverage', 'Coverage', 'How many times EBITDA covers debt service, interest and fixed charges — higher is safer'),
    covenantBlock(covenants, end, covenantWithheld),
  ];
}
