/**
 * Expression DSL for metric formulas + the formula-string generator + tree walkers.
 *
 * Registry entries are written with these builders so a formula reads close to the
 * accounting definition, and the human formula string shown in the (i) tooltip is
 * GENERATED from the same tree the evaluator runs (it can never drift).
 */

import { ACCOUNT_CLASSES } from './classes';
import { OPERATIONAL_INPUTS } from './operational-inputs';
import type {
  AccountClass,
  CannotComputeReason,
  BalanceAt,
  Basis,
  ConcentrationDataset,
  ConcentrationMeasure,
  Expr,
  OperationalKey,
} from './types';

// ── Builders ────────────────────────────────────────────────────────────────

export const flow = (cls: AccountClass): Expr => ({ op: 'flow', cls });
export const bal = (cls: AccountClass, at: BalanceAt = 'end'): Expr => ({ op: 'balance', cls, at });
export const budget = (cls: AccountClass): Expr => ({ op: 'budget', cls });
export const opIn = (key: OperationalKey, opts: { at?: BalanceAt; minMonths?: number } = {}): Expr => ({
  op: 'operational',
  key,
  ...opts,
});
export const metric = (key: string): Expr => ({ op: 'metric', key });
export const k = (value: number, label?: string): Expr => ({ op: 'const', value, ...(label ? { label } : {}) });
export const days = (): Expr => ({ op: 'days' });
export const add = (...args: Expr[]): Expr => ({ op: 'add', args });
export const sub = (a: Expr, b: Expr): Expr => ({ op: 'sub', a, b });
export const mul = (...args: Expr[]): Expr => ({ op: 'mul', args });
export const div = (num: Expr, den: Expr, guard: 'nonzero' | 'positive' = 'nonzero'): Expr => ({ op: 'div', num, den, guard });
export const neg = (arg: Expr): Expr => ({ op: 'neg', arg });
export const growth = (arg: Expr, lagMonths: number): Expr => ({ op: 'growth', arg, lagMonths });
export const cagrOf = (arg: Expr, years: number): Expr => ({ op: 'cagr', arg, years });
export const shift = (arg: Expr, months: number): Expr => ({ op: 'shift', arg, months });
export const onBasis = (arg: Expr, basis: Basis): Expr => ({ op: 'basis', arg, basis });
export const trailingAvg = (arg: Expr, months: number): Expr => ({ op: 'trailing_avg', arg, months });
export const positive = (arg: Expr, why: string): Expr => ({ op: 'positive', arg, why });
export const fallback = (arg: Expr, value: number, when: CannotComputeReason[], note: string): Expr => ({ op: 'fallback', arg, value, when, note });
export const concentration = (dataset: ConcentrationDataset, measure: ConcentrationMeasure): Expr => ({ op: 'concentration', dataset, measure });

// ── Walkers ─────────────────────────────────────────────────────────────────

export function children(e: Expr): Expr[] {
  switch (e.op) {
    case 'add':
    case 'mul':
      return e.args;
    case 'sub':
      return [e.a, e.b];
    case 'div':
      return [e.num, e.den];
    case 'neg':
    case 'growth':
    case 'cagr':
    case 'shift':
    case 'basis':
    case 'trailing_avg':
    case 'positive':
    case 'fallback':
      return [e.arg];
    default:
      return [];
  }
}

/** Every node in the tree (pre-order). */
export function walk(e: Expr): Expr[] {
  const out: Expr[] = [e];
  for (const c of children(e)) out.push(...walk(c));
  return out;
}

/** Metric keys referenced directly by this expression. */
export function metricRefs(e: Expr): string[] {
  return [...new Set(walk(e).flatMap((n) => (n.op === 'metric' ? [n.key] : [])))];
}

export function classRefs(e: Expr): AccountClass[] {
  return [...new Set(walk(e).flatMap((n) => (n.op === 'flow' || n.op === 'balance' || n.op === 'budget' ? [n.cls] : [])))];
}

export function operationalRefs(e: Expr): OperationalKey[] {
  return [...new Set(walk(e).flatMap((n) => (n.op === 'operational' ? [n.key] : [])))];
}

// ── Formula strings ─────────────────────────────────────────────────────────

const AT_LABEL: Record<BalanceAt, (s: string) => string> = {
  end: (s) => `${s} (end of period)`,
  start: (s) => `${s} (start of period)`,
  average: (s) => `average ${s}`,
  window_average: (s) => `average month-end ${s}`,
};

const BASIS_LABEL: Record<Basis, string> = { month: 'month', qtd: 'quarter to date', ytd: 'year to date', ttm: 'trailing 12 months' };

const CONC_LABEL: Record<ConcentrationDataset, Record<ConcentrationMeasure, string>> = {
  customer_revenue: {
    top1: "largest customer's share of revenue",
    top5: 'top 5 customers’ share of revenue',
    hhi: 'Herfindahl index of revenue by customer',
  },
  vendor_spend: {
    top1: "largest vendor's share of spend",
    top5: 'top 5 vendors’ share of spend',
    hhi: 'Herfindahl index of spend by vendor',
  },
};

function needsParens(e: Expr): boolean {
  return e.op === 'add' || e.op === 'sub';
}

/**
 * Render an expression as a readable formula ("Gross profit ÷ Revenue").
 * @param nameOf resolves a referenced metric key to its display name.
 */
export function formatExpr(e: Expr, nameOf: (key: string) => string = (key) => key): string {
  const f = (x: Expr) => formatExpr(x, nameOf);
  const p = (x: Expr) => (needsParens(x) ? `(${f(x)})` : f(x));
  switch (e.op) {
    case 'flow':
      return ACCOUNT_CLASSES[e.cls].label;
    case 'balance':
      return AT_LABEL[e.at](ACCOUNT_CLASSES[e.cls].label);
    case 'budget':
      return `budgeted ${ACCOUNT_CLASSES[e.cls].label}`;
    case 'operational': {
      const label = OPERATIONAL_INPUTS[e.key].label;
      return e.at && e.at !== 'end' ? AT_LABEL[e.at](label) : label;
    }
    case 'metric':
      return nameOf(e.key);
    case 'const':
      return e.label ?? String(e.value);
    case 'days':
      return 'days in period';
    case 'add':
      return e.args.map(f).join(' + ');
    case 'sub':
      return `${f(e.a)} − ${p(e.b)}`;
    case 'mul':
      return e.args.map(p).join(' × ');
    case 'div':
      return `${p(e.num)} ÷ ${p(e.den)}`;
    case 'neg':
      return `−${p(e.arg)}`;
    case 'growth':
      return `change in ${p(e.arg)} vs ${e.lagMonths} months earlier`;
    case 'cagr':
      return `${e.years}-year compound annual growth of ${p(e.arg)} (trailing 12 months to trailing 12 months)`;
    case 'shift':
      return `${p(e.arg)} ${e.months} months earlier`;
    case 'basis':
      return `${p(e.arg)} (${BASIS_LABEL[e.basis]})`;
    case 'trailing_avg':
      return `average monthly ${p(e.arg)} over the last ${e.months} months`;
    case 'positive':
      return f(e.arg);
    case 'fallback':
      return f(e.arg);
    case 'concentration':
      return CONC_LABEL[e.dataset][e.measure];
    default: {
      const never: never = e;
      return never;
    }
  }
}
