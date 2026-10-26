/**
 * Bridges tab (portal M4 "EBITDA bridge", FPB AC-W9): EBITDA, working-capital and cash
 * waterfalls between ANY two period ends of the same basis. Steps always sum to end − start
 * (lib/analytics/bridge.ts ties by construction or names its residual). PURE.
 *
 *   EBITDA bridge    window ending `from` → window ending `to` (same basis), or approved
 *                    budget → actual for the current window.
 *   Working capital  operating working capital at `from` → at `to`.
 *   Cash             cash at `from` → cash at `to`, flows summed over the months in between.
 */

import { addMonths, compareMonths, monthRange, type MonthKey } from '@/lib/analytics/months';
import { cashBridge, ebitdaBridge, operatingWorkingCapital, workingCapitalBridge, type Bridge, type WorkingCapitalPosition } from '@/lib/analytics/bridge';
import type { Basis, EvaluateRequest } from '@/lib/metrics/types';
import { evalAt, valueOf, type EvalCtx } from '../series';
import type { WsBlock, WsBridgeBlock, WsBridgeStep } from '../types';
import { fmt, longMonth } from '../units';
import { windowLabel } from '../series';

const EBITDA_INPUTS = ['revenue', 'gross_profit', 'sga', 'ebitda'] as const;
const POSITION = ['ws_cash', 'ws_ar', 'ws_inventory', 'ws_current_assets', 'ws_ap', 'ws_current_liabilities'] as const;
const CASH_FLOWS = ['net_income', 'depreciation_amortization', 'capex', 'ws_debt_drawn', 'ws_debt_repaid', 'ws_contributions', 'ws_distributions'] as const;

export function bridgesPlan(from: MonthKey, to: MonthKey, basis: Basis): EvaluateRequest[] {
  const scope = { companyIds: [], weighting: 'full' as const };
  const out: EvaluateRequest[] = [];
  for (const m of EBITDA_INPUTS) {
    out.push({ metric: m, scope, periodEnd: to, basis, comparison: 'budget', sparkline: 0 });
    out.push({ metric: m, scope, periodEnd: from, basis, comparison: 'none', sparkline: 0 });
  }
  for (const m of POSITION) for (const end of [from, to]) out.push({ metric: m, scope, periodEnd: end, basis: 'month', comparison: 'none', sparkline: 0 });
  for (const m of CASH_FLOWS) out.push({ metric: m, scope, periodEnd: addMonths(from, 1), basis: 'month', comparison: 'none', sparkline: 0 }, { metric: m, scope, periodEnd: to, basis: 'month', comparison: 'none', sparkline: 0 });
  return out;
}

function toSteps(b: Bridge): WsBridgeStep[] {
  return [
    { key: 'start', label: b.start.label, kind: 'start', value: b.start.cents },
    ...b.steps.map((s) => ({ key: s.key, label: s.label, kind: 'delta' as const, value: s.cents, ...(s.residual ? { residual: true } : {}) })),
    { key: 'end', label: b.end.label, kind: 'end', value: b.end.cents },
  ];
}

function largest(b: Bridge): string {
  const top = [...b.steps].sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents))[0];
  return top ? ` The largest step is ${top.label.toLowerCase()} (${top.cents >= 0 ? '+' : ''}${fmt(top.cents, 'money')}).` : '';
}

type Inputs = Record<(typeof EBITDA_INPUTS)[number], number>;

function ebitdaInputs(ctx: EvalCtx, end: MonthKey, basis: Basis, budget: boolean): { ok: true; v: Inputs } | { ok: false; why: string } {
  const v = {} as Inputs;
  for (const m of EBITDA_INPUTS) {
    const r = evalAt(ctx, m, end, basis, budget ? 'budget' : 'none');
    const o = budget ? r.comparison?.outcome : r.current;
    const x = valueOf(m, o);
    if (x === null) return { ok: false, why: o && o.status !== 'ok' ? o.message : `No figure for ${m}` };
    v[m] = Math.round(x);
  }
  return { ok: true, v };
}

export function ebitdaBridgeBlock(ctx: EvalCtx, from: MonthKey, to: MonthKey, basis: Basis, mode: 'periods' | 'budget'): WsBridgeBlock {
  const cur = ebitdaInputs(ctx, to, basis, false);
  const base = mode === 'budget' ? ebitdaInputs(ctx, to, basis, true) : ebitdaInputs(ctx, from, basis, false);
  const toLabel = windowLabel(to, basis);
  const fromLabel = mode === 'budget' ? `Budget, ${toLabel}` : windowLabel(from, basis);
  const common = {
    kind: 'bridge' as const,
    id: 'bridge-ebitda',
    title: mode === 'budget' ? 'EBITDA bridge, budget to actual' : `EBITDA bridge, ${fromLabel} to ${toLabel}`,
    eyebrow: 'Bridge',
    basis: 'Revenue at the earlier gross margin (volume), the change in margin rate, operating expenses before D&A; steps sum exactly',
    period: toLabel,
    unit: 'money' as const,
    from: { label: mode === 'budget' ? 'Budget' : 'From', window: fromLabel },
    to: { label: 'Actual', window: toLabel },
    definition: { text: 'EBITDA = operating income plus the depreciation and amortization inside operating costs, computed from account roles.', source: 'Posted GL and the approved budget' },
  };
  if (!cur.ok || !base.ok) {
    const why = !cur.ok ? cur.why : (base as { why: string }).why;
    return { ...common, summary: `The EBITDA bridge can't be drawn: ${why}.`, footnotes: [], steps: [], ties: true, state: { kind: 'unavailable', reason: mode === 'budget' ? 'no_approved_budget' : 'not_on_file', detail: why } };
  }
  const p = base.v;
  const c = cur.v;
  const b = ebitdaBridge(
    { revenueCents: p.revenue, grossProfitCents: p.gross_profit, opexExDaCents: p.sga, ebitdaCents: p.ebitda },
    { revenueCents: c.revenue, grossProfitCents: c.gross_profit, opexExDaCents: c.sga, ebitdaCents: c.ebitda },
  );
  return {
    ...common,
    summary: `EBITDA moved from ${fmt(b.start.cents, 'money')} to ${fmt(b.end.cents, 'money')} (${b.end.cents - b.start.cents >= 0 ? '+' : ''}${fmt(b.end.cents - b.start.cents, 'money')}).${largest(b)}`,
    footnotes: [`Steps sum to ${fmt(b.end.cents - b.start.cents, 'money')}`],
    steps: toSteps(b),
    ties: b.ties,
  };
}

function position(ctx: EvalCtx, end: MonthKey): { ok: true; p: WorkingCapitalPosition; cash: number } | { ok: false; why: string } {
  const v: Record<string, number> = {};
  for (const m of POSITION) {
    const r = evalAt(ctx, m, end, 'month');
    const x = valueOf(m, r.current);
    if (x === null) return { ok: false, why: r.current.status !== 'ok' ? r.current.message : `No balance for ${m}` };
    v[m] = Math.round(x);
  }
  return {
    ok: true,
    cash: v.ws_cash,
    p: {
      receivablesCents: v.ws_ar,
      inventoryCents: v.ws_inventory,
      otherCurrentAssetsCents: v.ws_current_assets - v.ws_cash - v.ws_ar - v.ws_inventory,
      payablesCents: v.ws_ap,
      otherCurrentLiabilitiesCents: v.ws_current_liabilities - v.ws_ap,
    },
  };
}

export function workingCapitalBridgeBlock(ctx: EvalCtx, from: MonthKey, to: MonthKey): WsBridgeBlock {
  const a = position(ctx, from);
  const z = position(ctx, to);
  const common = {
    kind: 'bridge' as const,
    id: 'bridge-wc',
    title: `Working capital, ${longMonth(from)} to ${longMonth(to)}`,
    eyebrow: 'Bridge',
    basis: 'Operating working capital (current assets other than cash, less current liabilities), by component; payables and other liabilities are shown with the sign that moves working capital',
    period: `At ${longMonth(to)}`,
    unit: 'money' as const,
    from: { label: 'Opening', window: `At ${longMonth(from)}` },
    to: { label: 'Closing', window: `At ${longMonth(to)}` },
  };
  if (!a.ok || !z.ok) {
    const why = !a.ok ? a.why : (z as { why: string }).why;
    return { ...common, summary: `The working-capital bridge can't be drawn: ${why}.`, footnotes: [], steps: [], ties: true, state: { kind: 'unavailable', reason: 'not_mapped', detail: why } };
  }
  const b = workingCapitalBridge(a.p, z.p);
  return {
    ...common,
    summary: `Operating working capital went from ${fmt(b.start.cents, 'money')} to ${fmt(b.end.cents, 'money')}.${largest(b)}`,
    footnotes: ['An increase in working capital uses cash', `Steps sum to ${fmt(b.end.cents - b.start.cents, 'money')}`],
    steps: toSteps(b),
    ties: b.ties,
  };
}

export function cashBridgeBlock(ctx: EvalCtx, from: MonthKey, to: MonthKey): WsBridgeBlock {
  const a = position(ctx, from);
  const z = position(ctx, to);
  const months = monthRange(addMonths(from, 1), to);
  const common = {
    kind: 'bridge' as const,
    id: 'bridge-cash',
    title: `Cash, ${longMonth(from)} to ${longMonth(to)}`,
    eyebrow: 'Bridge',
    basis: `Cash at ${longMonth(from)} to cash at ${longMonth(to)}: profit, non-cash charges, working capital, capital spending, borrowing and owners; anything else is named`,
    period: `${months.length} month${months.length === 1 ? '' : 's'} to ${longMonth(to)}`,
    unit: 'money' as const,
    from: { label: 'Opening cash', window: `At ${longMonth(from)}` },
    to: { label: 'Closing cash', window: `At ${longMonth(to)}` },
  };
  const sums: Record<string, number> = {};
  let why: string | null = !a.ok ? a.why : !z.ok ? (z as { why: string }).why : null;
  if (!why) {
    for (const m of CASH_FLOWS) {
      let total = 0;
      for (const mo of months) {
        const r = evalAt(ctx, m, mo, 'month');
        const x = valueOf(m, r.current);
        if (x === null) {
          why = r.current.status !== 'ok' ? `${longMonth(mo)}: ${r.current.message}` : `No figure for ${longMonth(mo)}`;
          break;
        }
        total += Math.round(x);
      }
      if (why) break;
      sums[m] = total;
    }
  }
  if (why || !a.ok || !z.ok) {
    return { ...common, summary: `The cash bridge can't be drawn: ${why}.`, footnotes: [], steps: [], ties: true, state: { kind: 'unavailable', reason: 'not_on_file', detail: why ?? '' } };
  }
  const b = cashBridge(a.cash, z.cash, {
    netIncomeCents: sums.net_income,
    depreciationAmortizationCents: sums.depreciation_amortization,
    workingCapitalIncreaseCents: operatingWorkingCapital(z.p) - operatingWorkingCapital(a.p),
    capexCents: sums.capex,
    netBorrowingCents: sums.ws_debt_drawn - sums.ws_debt_repaid,
    equityNetCents: sums.ws_contributions - sums.ws_distributions,
  });
  return {
    ...common,
    summary: `Cash went from ${fmt(b.start.cents, 'money')} to ${fmt(b.end.cents, 'money')}.${largest(b)}`,
    footnotes: ['"Other balance-sheet movements" is the part the measured drivers do not explain (other assets and liabilities, reclasses)', `Steps sum to ${fmt(b.end.cents - b.start.cents, 'money')}`],
    steps: toSteps(b),
    ties: b.ties,
  };
}

export interface BridgeWindows {
  from: MonthKey;
  to: MonthKey;
  basis: Basis;
  mode: 'periods' | 'budget';
}

export function bridgeBlocks(ctx: EvalCtx, w: BridgeWindows): WsBlock[] {
  if (compareMonths(w.from, w.to) >= 0) throw new Error('The bridge start must be before its end.');
  return [ebitdaBridgeBlock(ctx, w.from, w.to, w.basis, w.mode), workingCapitalBridgeBlock(ctx, w.from, w.to), cashBridgeBlock(ctx, w.from, w.to)];
}
