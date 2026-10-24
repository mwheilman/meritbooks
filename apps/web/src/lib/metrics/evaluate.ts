/**
 * Metric evaluator — pure, I/O-free (Wave 3B, FPB-reports-fpna §1.15a, AC-K3…K7).
 *
 * evaluateMetric(dataset, request) → value, comparison, change + verdict, sparkline,
 * status (ok | cannot_compute with a reason), drill references and scope notes.
 *
 * How it stays honest:
 *   1. A NEEDS pass walks the expression (through metric references, time shifts and
 *      fixed-basis windows) and lists every GL / budget / sub-ledger month it touches.
 *   2. Dataset-level checks: an input class with no accounts is "Not mapped"; a
 *      sub-ledger the source cannot supply is "Not on file".
 *   3. Company eligibility: a company contributes only when EVERY touched month is on
 *      file for it (books started, in group, budget approved, sub-ledger present).
 *      Ineligible companies are listed with the reason. This makes growth and
 *      comparisons like-for-like.
 *   4. Inputs are summed across eligible companies (× ownership weight when asked);
 *      ratios are computed on the combined inputs, never averaged.
 *   5. Division by zero, a non-positive base, or a sign flip produce named reasons —
 *      never 0, Infinity or NaN.
 */

import {
  addMonths,
  daysInMonths,
  fiscalQuarterStart,
  fiscalYearOf,
  fiscalYearStart,
  monthRange,
  shortMonthLabel,
  trailingMonths,
  type MonthKey,
} from '@/lib/analytics/months';
import { cagr, growthRate, roundCents, roundTo, type NotMeaningfulReason } from '@/lib/analytics/numbers';
import { hhi, topNShare, type Amount } from '@/lib/analytics/concentration';
import { ACCOUNT_CLASSES } from './classes';
import { formatExpr } from './expr';
import { OPERATIONAL_INPUTS } from './operational-inputs';
import { METRICS, metricName } from './registry';
import { COMPARISON_LABEL, describeChange, reasonMessage } from './wording';
import type {
  AccountClass,
  BalanceAt,
  Basis,
  CannotComputeReason,
  CompanyDataset,
  ComparisonKind,
  ConcentrationDataset,
  DrillRef,
  EvaluateRequest,
  Expr,
  MetricDataset,
  MetricDefinition,
  MetricResult,
  MetricUnit,
  OperationalKey,
  Outcome,
  SparkPoint,
} from './types';

type Registry = ReadonlyMap<string, MetricDefinition>;
type Mode = 'actual' | 'budget';

interface Ctx {
  end: MonthKey;
  basis: Basis;
  mode: Mode;
}

type Fail = { ok: false; reason: CannotComputeReason; detail: string };
type Val = { ok: true; v: number; notes: string[] } | Fail;

const fail = (reason: CannotComputeReason, detail: string): Fail => ({ ok: false, reason, detail });
const okv = (v: number, notes: string[] = []): Val => ({ ok: true, v, notes });

// ── Windows ─────────────────────────────────────────────────────────────────

export function windowMonths(end: MonthKey, basis: Basis, fyStartMonth: number): MonthKey[] {
  switch (basis) {
    case 'month':
      return [end];
    case 'qtd':
      return monthRange(fiscalQuarterStart(end, fyStartMonth), end);
    case 'ytd':
      return monthRange(fiscalYearStart(end, fyStartMonth), end);
    case 'ttm':
      return trailingMonths(end, 12);
    default: {
      const never: never = basis;
      return never;
    }
  }
}

/** Months to step back for "prior period": the length of a full window of that basis. */
export function priorPeriodShift(basis: Basis): number {
  switch (basis) {
    case 'month':
      return 1;
    case 'qtd':
      return 3;
    case 'ytd':
    case 'ttm':
      return 12;
    default: {
      const never: never = basis;
      return never;
    }
  }
}

function balanceMonths(window: MonthKey[], at: BalanceAt): MonthKey[] {
  const first = window[0];
  const last = window[window.length - 1];
  switch (at) {
    case 'end':
      return [last];
    case 'start':
      return [addMonths(first, -1)];
    case 'average':
      return [addMonths(first, -1), last];
    case 'window_average':
      return window;
    default: {
      const never: never = at;
      return never;
    }
  }
}

function effectiveBasis(def: MetricDefinition, requested: Basis): Basis {
  return def.period.basis === 'request' ? requested : def.period.basis;
}

// ── Needs pass ─────────────────────────────────────────────────────────────

type Need =
  | { kind: 'gl'; cls: AccountClass; months: MonthKey[]; balance: boolean; soft: boolean }
  | { kind: 'budget'; cls: AccountClass; months: MonthKey[]; soft: boolean }
  | { kind: 'op'; key: OperationalKey; months: MonthKey[]; minMonths?: number; soft: boolean }
  | { kind: 'conc'; dataset: ConcentrationDataset; months: MonthKey[]; soft: boolean }
  | { kind: 'impossible'; reason: CannotComputeReason; detail: string; soft: boolean };

interface Env {
  ds: MetricDataset;
  registry: Registry;
}

function budgetModeFailure(e: Expr): Need | null {
  if (e.op === 'balance') return { kind: 'impossible', reason: 'not_on_file', detail: 'budgets cover income-statement lines only, not balances', soft: false };
  if (e.op === 'operational') return { kind: 'impossible', reason: 'not_on_file', detail: `there is no budget for ${OPERATIONAL_INPUTS[e.key].label.toLowerCase()}`, soft: false };
  if (e.op === 'concentration') return { kind: 'impossible', reason: 'not_on_file', detail: 'there is no budget by customer or vendor', soft: false };
  return null;
}

function collectNeeds(env: Env, e: Expr, ctx: Ctx, soft: boolean, out: Need[], depth = 0): void {
  if (depth > 64) throw new Error('Metric expression nests too deeply (cycle?)');
  const window = () => windowMonths(ctx.end, ctx.basis, env.ds.fyStartMonth);
  if (ctx.mode === 'budget') {
    const f = budgetModeFailure(e);
    if (f) {
      out.push({ ...f, soft } as Need);
      return;
    }
  }
  switch (e.op) {
    case 'flow':
      if (ctx.mode === 'budget') out.push({ kind: 'budget', cls: e.cls, months: window(), soft });
      else out.push({ kind: 'gl', cls: e.cls, months: window(), balance: false, soft });
      return;
    case 'balance':
      out.push({ kind: 'gl', cls: e.cls, months: balanceMonths(window(), e.at), balance: true, soft });
      return;
    case 'budget':
      out.push({ kind: 'budget', cls: e.cls, months: window(), soft });
      return;
    case 'operational': {
      const def = OPERATIONAL_INPUTS[e.key];
      const months = def.nature === 'flow' ? window() : balanceMonths(window(), e.at ?? 'end');
      out.push({ kind: 'op', key: e.key, months, minMonths: e.minMonths, soft });
      return;
    }
    case 'concentration':
      out.push({ kind: 'conc', dataset: e.dataset, months: window(), soft });
      return;
    case 'const':
    case 'days':
      return;
    case 'metric': {
      const def = env.registry.get(e.key);
      if (!def) throw new Error(`Unknown metric "${e.key}"`);
      collectNeeds(env, def.formula, { ...ctx, basis: effectiveBasis(def, ctx.basis) }, soft, out, depth + 1);
      return;
    }
    case 'growth':
      collectNeeds(env, e.arg, ctx, soft, out, depth + 1);
      collectNeeds(env, e.arg, { ...ctx, end: addMonths(ctx.end, -e.lagMonths) }, soft, out, depth + 1);
      return;
    case 'cagr':
      collectNeeds(env, e.arg, { ...ctx, basis: 'ttm' }, soft, out, depth + 1);
      collectNeeds(env, e.arg, { ...ctx, basis: 'ttm', end: addMonths(ctx.end, -12 * e.years) }, soft, out, depth + 1);
      return;
    case 'shift':
      collectNeeds(env, e.arg, { ...ctx, end: addMonths(ctx.end, -e.months) }, soft, out, depth + 1);
      return;
    case 'basis':
      collectNeeds(env, e.arg, { ...ctx, basis: e.basis }, soft, out, depth + 1);
      return;
    case 'trailing_avg':
      for (let i = 0; i < e.months; i++) collectNeeds(env, e.arg, { ...ctx, end: addMonths(ctx.end, -i), basis: 'month' }, soft, out, depth + 1);
      return;
    case 'fallback':
      collectNeeds(env, e.arg, ctx, true, out, depth + 1);
      return;
    case 'add':
    case 'mul':
      for (const a of e.args) collectNeeds(env, a, ctx, soft, out, depth + 1);
      return;
    case 'sub':
      collectNeeds(env, e.a, ctx, soft, out, depth + 1);
      collectNeeds(env, e.b, ctx, soft, out, depth + 1);
      return;
    case 'div':
      collectNeeds(env, e.num, ctx, soft, out, depth + 1);
      collectNeeds(env, e.den, ctx, soft, out, depth + 1);
      return;
    case 'neg':
    case 'positive':
      collectNeeds(env, e.arg, ctx, soft, out, depth + 1);
      return;
    default: {
      const never: never = e;
      return never;
    }
  }
}

function classUnmapped(ds: MetricDataset, cls: AccountClass): boolean {
  const def = ACCOUNT_CLASSES[cls];
  const mapped = (ds.classMapping[cls]?.accountIds.length ?? 0) > 0;
  return !mapped && def.emptyMeans === 'not_mapped';
}

function notMappedDetail(cls: AccountClass): string {
  const def = ACCOUNT_CLASSES[cls];
  const roles = def.roles.length > 0 ? ` (account role ${def.roles.join(' / ')})` : '';
  return `no account is assigned to ${def.label}${roles}`;
}

/** Problems that apply to the whole dataset regardless of company. */
function datasetFailure(ds: MetricDataset, n: Need): Fail | null {
  switch (n.kind) {
    case 'impossible':
      return fail(n.reason, n.detail);
    case 'gl':
      if (classUnmapped(ds, n.cls)) return fail('not_mapped', notMappedDetail(n.cls));
      for (const m of n.months) {
        if (m > ds.latestMonth) return fail('not_on_file', `no figures after ${shortMonthLabel(ds.latestMonth)}`);
        const earliest = n.balance ? addMonths(ds.rangeStart, -1) : ds.rangeStart;
        if (m < earliest) return fail('not_enough_history', `needs figures from ${shortMonthLabel(m)}`);
      }
      return null;
    case 'budget':
      if (classUnmapped(ds, n.cls)) return fail('not_mapped', notMappedDetail(n.cls));
      return null;
    case 'op': {
      const def = OPERATIONAL_INPUTS[n.key];
      if (!ds.operationalAvailable.includes(n.key)) return fail(def.missing, `no ${def.missingWhat.toLowerCase()} on file`);
      return null;
    }
    case 'conc': {
      const key: OperationalKey = n.dataset === 'customer_revenue' ? 'credit_sales' : 'purchases';
      if (!ds.operationalAvailable.includes(key)) return fail('not_on_file', `no ${OPERATIONAL_INPUTS[key].missingWhat.toLowerCase()} on file`);
      return null;
    }
    default: {
      const never: never = n;
      return never;
    }
  }
}

function startOf(c: CompanyDataset): MonthKey | null {
  if (!c.firstMonthOnFile) return null;
  if (c.inGroupFrom && c.inGroupFrom > c.firstMonthOnFile) return c.inGroupFrom;
  return c.firstMonthOnFile;
}

function historyFail(c: CompanyDataset, m: MonthKey): Fail {
  const inGroup = c.inGroupFrom && (!c.firstMonthOnFile || c.inGroupFrom > c.firstMonthOnFile);
  const since = startOf(c);
  return fail(
    'not_enough_history',
    inGroup
      ? `needs figures from ${shortMonthLabel(m)}; ${c.name} is in the group from ${shortMonthLabel(c.inGroupFrom as MonthKey)}`
      : `needs figures from ${shortMonthLabel(m)}; ${c.name}'s books start ${since ? shortMonthLabel(since) : 'later'}`,
  );
}

/** Can company `c` supply need `n`? (Soft needs never disqualify.) */
function companyFailure(ds: MetricDataset, c: CompanyDataset, n: Need): Fail | null {
  if (n.soft) return null;
  switch (n.kind) {
    case 'impossible':
      return fail(n.reason, n.detail);
    case 'gl': {
      const start = startOf(c);
      if (!start) return fail('not_on_file', `${c.name} has no posted transactions`);
      for (const m of n.months) if (m < start) return historyFail(c, m);
      return null;
    }
    case 'budget': {
      for (const m of n.months) {
        const fy = fiscalYearOf(m, ds.fyStartMonth);
        if (!c.budgetApprovedFy.includes(fy)) return fail('no_approved_budget', `no approved budget for FY ${fy} at ${c.name}`);
      }
      return null;
    }
    case 'op': {
      const def = OPERATIONAL_INPUTS[n.key];
      const series = c.operational[n.key];
      const start = c.inGroupFrom;
      if (start) for (const m of n.months) if (m < start) return historyFail(c, m);
      const present = n.months.filter((m) => series?.[m] !== undefined).length;
      if (n.minMonths !== undefined) {
        if (present < n.minMonths) {
          return fail(
            present === 0 ? def.missing : 'not_enough_history',
            present === 0
              ? `no ${def.missingWhat.toLowerCase()} on file for ${c.name}`
              : `${def.label.toLowerCase()} on file for ${present} of ${n.months.length} months at ${c.name} (needs ${n.minMonths})`,
          );
        }
        return null;
      }
      if (present < n.months.length) {
        const missing = n.months.find((m) => series?.[m] === undefined) as MonthKey;
        // Data exists for other months (e.g. job positions kept for the current month only):
        // this month is simply not on file — not "no jobs".
        const hasAny = Object.values(series ?? {}).some((v) => v !== undefined);
        return fail(hasAny ? 'not_on_file' : def.missing, `no ${def.missingWhat.toLowerCase()} on file for ${shortMonthLabel(missing)} at ${c.name}`);
      }
      return null;
    }
    case 'conc': {
      const src = n.dataset === 'customer_revenue' ? c.customerRevenue : c.vendorSpend;
      const what = n.dataset === 'customer_revenue' ? 'revenue by customer' : 'spend by vendor';
      const missing = n.months.find((m) => src?.[m] === undefined);
      if (missing) return fail('not_on_file', `no ${what} on file for ${shortMonthLabel(missing)} at ${c.name}`);
      return null;
    }
    default: {
      const never: never = n;
      return never;
    }
  }
}

// ── Value pass ─────────────────────────────────────────────────────────────

interface Included {
  company: CompanyDataset;
  weight: number;
}

class Evaluator {
  private readonly balanceCache = new Map<string, number>();
  private readonly metricCache = new Map<string, Val>();

  constructor(
    private readonly env: Env,
    private readonly included: Included[],
  ) {}

  private window(ctx: Ctx): MonthKey[] {
    return windowMonths(ctx.end, ctx.basis, this.env.ds.fyStartMonth);
  }

  private flowOf(c: CompanyDataset, cls: AccountClass, months: MonthKey[], mode: Mode): number {
    let s = 0;
    if (mode === 'budget') {
      const b = c.budget[cls];
      for (const m of months) s += b?.[m] ?? 0;
      return s;
    }
    const g = c.gl[cls];
    for (const m of months) s += g?.months[m] ?? 0;
    return s;
  }

  private balanceOf(c: CompanyDataset, cls: AccountClass, m: MonthKey): number {
    const key = `${c.id}|${cls}|${m}`;
    const hit = this.balanceCache.get(key);
    if (hit !== undefined) return hit;
    const g = c.gl[cls];
    let b = g?.opening ?? 0;
    if (g && m >= this.env.ds.rangeStart) for (const mm of monthRange(this.env.ds.rangeStart, m)) b += g.months[mm] ?? 0;
    this.balanceCache.set(key, b);
    return b;
  }

  private operational(key: OperationalKey, at: BalanceAt | undefined, ctx: Ctx, soft: boolean): Val {
    const def = OPERATIONAL_INPUTS[key];
    const window = this.window(ctx);
    const per: { v: number; w: number }[] = [];
    for (const { company, weight } of this.included) {
      const s = company.operational[key];
      const read = (m: MonthKey) => s?.[m];
      let v: number | undefined;
      if (def.nature === 'flow') {
        if (window.every((m) => read(m) !== undefined)) v = window.reduce((acc, m) => acc + (read(m) as number), 0);
      } else {
        const months = balanceMonths(window, at ?? 'end');
        const vals = months.map(read).filter((x): x is number => x !== undefined);
        if ((at ?? 'end') === 'window_average') v = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
        else if (vals.length === months.length) v = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
      if (v !== undefined) per.push({ v, w: weight });
    }
    if (per.length === 0) return fail(def.missing, `no ${def.missingWhat.toLowerCase()} on file`);
    const notes = soft && per.length < this.included.length ? [`${def.label} on file for ${per.length} of ${this.included.length} companies.`] : [];
    switch (def.aggregate) {
      case 'sum':
        return okv(per.reduce((a, p) => a + p.v * p.w, 0), notes);
      case 'mean':
        return okv(per.reduce((a, p) => a + p.v, 0) / per.length, notes);
      case 'max':
        return okv(Math.max(...per.map((p) => p.v)), notes);
      case 'min':
        return okv(Math.min(...per.map((p) => p.v)), notes);
      default: {
        const never: never = def.aggregate;
        return never;
      }
    }
  }

  private concentration(dataset: ConcentrationDataset, measure: 'top1' | 'top5' | 'hhi', ctx: Ctx): Val {
    const merged = new Map<string, number>();
    for (const { company, weight } of this.included) {
      const src = dataset === 'customer_revenue' ? company.customerRevenue : company.vendorSpend;
      for (const m of this.window(ctx)) {
        const rec = src?.[m];
        if (!rec) continue;
        for (const [id, cents] of Object.entries(rec)) merged.set(id, (merged.get(id) ?? 0) + cents * weight);
      }
    }
    const amounts: Amount[] = [...merged.entries()].map(([key, cents]) => ({ key, cents }));
    const what = dataset === 'customer_revenue' ? 'invoiced revenue' : 'vendor spend';
    if (measure === 'hhi') {
      const h = hhi(amounts);
      return h.value === null ? fail('not_meaningful', `there is no ${what} in the period`) : okv(h.value);
    }
    const share = topNShare(amounts, measure === 'top1' ? 1 : 5);
    return share === null ? fail('not_meaningful', `there is no ${what} in the period`) : okv(share);
  }

  eval(e: Expr, ctx: Ctx, soft = false): Val {
    // Dataset-level guards are re-checked here so a SOFT (fallback) branch fails honestly.
    if ((e.op === 'flow' || e.op === 'balance' || e.op === 'budget') && classUnmapped(this.env.ds, e.cls)) return fail('not_mapped', notMappedDetail(e.cls));
    if (e.op === 'operational' && !this.env.ds.operationalAvailable.includes(e.key)) {
      const def = OPERATIONAL_INPUTS[e.key];
      return fail(def.missing, `no ${def.missingWhat.toLowerCase()} on file`);
    }
    switch (e.op) {
      case 'flow': {
        let s = 0;
        const months = this.window(ctx);
        for (const { company, weight } of this.included) s += this.flowOf(company, e.cls, months, ctx.mode) * weight;
        return okv(s);
      }
      case 'budget': {
        let s = 0;
        const months = this.window(ctx);
        for (const { company, weight } of this.included) s += this.flowOf(company, e.cls, months, 'budget') * weight;
        return okv(s);
      }
      case 'balance': {
        if (ctx.mode === 'budget') return fail('not_on_file', 'budgets cover income-statement lines only, not balances');
        const months = balanceMonths(this.window(ctx), e.at);
        const perMonth = months.map((m) => this.included.reduce((acc, { company, weight }) => acc + this.balanceOf(company, e.cls, m) * weight, 0));
        return okv(perMonth.reduce((a, b) => a + b, 0) / perMonth.length);
      }
      case 'operational':
        if (ctx.mode === 'budget') return fail('not_on_file', `there is no budget for ${OPERATIONAL_INPUTS[e.key].label.toLowerCase()}`);
        return this.operational(e.key, e.at, ctx, soft);
      case 'concentration':
        if (ctx.mode === 'budget') return fail('not_on_file', 'there is no budget by customer or vendor');
        return this.concentration(e.dataset, e.measure, ctx);
      case 'const':
        return okv(e.value);
      case 'days':
        return okv(daysInMonths(this.window(ctx)));
      case 'metric': {
        const def = this.env.registry.get(e.key);
        if (!def) throw new Error(`Unknown metric "${e.key}"`);
        const inner: Ctx = { ...ctx, basis: effectiveBasis(def, ctx.basis) };
        const cacheKey = `${e.key}|${inner.end}|${inner.basis}|${inner.mode}|${soft}`;
        const hit = this.metricCache.get(cacheKey);
        if (hit) return hit;
        const v = this.eval(def.formula, inner, soft);
        this.metricCache.set(cacheKey, v);
        return v;
      }
      case 'add':
      case 'mul': {
        const vals: number[] = [];
        const notes: string[] = [];
        for (const a of e.args) {
          const r = this.eval(a, ctx, soft);
          if (!r.ok) return r;
          vals.push(r.v);
          notes.push(...r.notes);
        }
        return okv(e.op === 'add' ? vals.reduce((x, y) => x + y, 0) : vals.reduce((x, y) => x * y, 1), notes);
      }
      case 'sub': {
        const a = this.eval(e.a, ctx, soft);
        if (!a.ok) return a;
        const b = this.eval(e.b, ctx, soft);
        if (!b.ok) return b;
        return okv(a.v - b.v, [...a.notes, ...b.notes]);
      }
      case 'neg': {
        const a = this.eval(e.arg, ctx, soft);
        return a.ok ? okv(-a.v, a.notes) : a;
      }
      case 'div': {
        const num = this.eval(e.num, ctx, soft);
        if (!num.ok) return num;
        const den = this.eval(e.den, ctx, soft);
        if (!den.ok) return den;
        const label = formatExpr(e.den, metricName);
        if (den.v === 0) return fail('zero_denominator', `${label} is zero`);
        if (e.guard === 'positive' && den.v < 0) return fail('not_meaningful', `${label} is negative`);
        return okv(num.v / den.v, [...num.notes, ...den.notes]);
      }
      case 'positive': {
        const a = this.eval(e.arg, ctx, soft);
        if (!a.ok) return a;
        return a.v > 0 ? a : fail('not_meaningful', e.why);
      }
      case 'growth': {
        const cur = this.eval(e.arg, ctx, soft);
        if (!cur.ok) return cur;
        const base = this.eval(e.arg, { ...ctx, end: addMonths(ctx.end, -e.lagMonths) }, soft);
        if (!base.ok) return base;
        const g = growthRate(cur.v, base.v);
        return g.value === null ? fail(g.reason === 'zero_base' ? 'zero_denominator' : 'not_meaningful', growthDetail(g.reason as NotMeaningfulReason, e.lagMonths)) : okv(g.value, [...cur.notes, ...base.notes]);
      }
      case 'cagr': {
        const end = this.eval(e.arg, { ...ctx, basis: 'ttm' }, soft);
        if (!end.ok) return end;
        const start = this.eval(e.arg, { ...ctx, basis: 'ttm', end: addMonths(ctx.end, -12 * e.years) }, soft);
        if (!start.ok) return start;
        const r = cagr(end.v, start.v, e.years);
        return r.value === null ? fail('not_meaningful', 'a compound growth rate needs a positive figure at both ends') : okv(r.value, [...end.notes, ...start.notes]);
      }
      case 'shift':
        return this.eval(e.arg, { ...ctx, end: addMonths(ctx.end, -e.months) }, soft);
      case 'basis':
        return this.eval(e.arg, { ...ctx, basis: e.basis }, soft);
      case 'trailing_avg': {
        let s = 0;
        const notes: string[] = [];
        for (let i = 0; i < e.months; i++) {
          const r = this.eval(e.arg, { ...ctx, end: addMonths(ctx.end, -i), basis: 'month' }, soft);
          if (!r.ok) return r;
          s += r.v;
          notes.push(...r.notes);
        }
        return okv(s / e.months, notes);
      }
      case 'fallback': {
        const r = this.eval(e.arg, ctx, true);
        if (r.ok) return r;
        return e.when.includes(r.reason) ? okv(e.value, [e.note]) : r;
      }
      default: {
        const never: never = e;
        return never;
      }
    }
  }
}

function growthDetail(reason: NotMeaningfulReason, lag: number): string {
  const when = lag === 12 ? 'a year earlier' : lag === 1 ? 'the month before' : `${lag} months earlier`;
  switch (reason) {
    case 'zero_base':
      return `the figure ${when} is zero`;
    case 'negative_base':
      return `the figure ${when} is negative, so a % change would mislead`;
    case 'sign_flip':
      return `the figure changed sign since ${when}, so a % change would mislead`;
    default:
      return 'the base is not positive';
  }
}

// ── Presentation ───────────────────────────────────────────────────────────

export function toPresentation(unit: MetricUnit, raw: number): number {
  switch (unit) {
    case 'money':
      return roundCents(raw);
    case 'percent':
    case 'points':
      return roundTo(raw * 100, 2);
    case 'ratio':
    case 'times':
    case 'count':
      return roundTo(raw, 2);
    case 'days':
    case 'months':
      return roundTo(raw, 1);
    default: {
      const never: never = unit;
      return never;
    }
  }
}

/** Benchmark tone for a presentation-unit value (first band that contains it). */
export function benchmarkTone(def: MetricDefinition, value: number): 'good' | 'watch' | 'poor' | null {
  for (const b of def.benchmark?.bands ?? []) {
    if ((b.min === undefined || value >= b.min) && (b.max === undefined || value < b.max)) return b.tone;
  }
  return null;
}

// ── Orchestration ──────────────────────────────────────────────────────────

interface Attempt {
  outcome: Outcome;
  raw: number | null;
  included: Included[];
  excluded: MetricResult['scope']['excluded'];
  notes: string[];
  needs: Need[];
}

function weightOf(c: CompanyDataset, weighting: EvaluateRequest['scope']['weighting']): number {
  return weighting === 'ownership' ? (c.ownershipPct ?? 100) / 100 : 1;
}

function scopeCompanies(ds: MetricDataset, ids: string[]): { found: CompanyDataset[]; missing: string[] } {
  const byId = new Map(ds.companies.map((c) => [c.id, c]));
  const found: CompanyDataset[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (c) found.push(c);
    else missing.push(id);
  }
  return { found, missing };
}

function needsFor(env: Env, def: MetricDefinition, ctx: Ctx): Need[] {
  const out: Need[] = [];
  collectNeeds(env, def.formula, { ...ctx, basis: effectiveBasis(def, ctx.basis) }, false, out);
  return out;
}

function outcomeOf(def: MetricDefinition, v: Val): { outcome: Outcome; raw: number | null; notes: string[] } {
  if (!v.ok) return { outcome: { status: 'cannot_compute', reason: v.reason, message: reasonMessage(v.reason, v.detail) }, raw: null, notes: [] };
  if (!Number.isFinite(v.v)) return { outcome: { status: 'cannot_compute', reason: 'not_meaningful', message: reasonMessage('not_meaningful') }, raw: null, notes: [] };
  return { outcome: { status: 'ok', value: toPresentation(def.unit, v.v), raw: v.v }, raw: v.v, notes: [...new Set(v.notes)] };
}

/**
 * One evaluation of `def` at `ctx` over the scope, restricted to companies eligible
 * for ALL of `eligibilityNeeds` (defaults to this evaluation's own needs).
 */
function attempt(env: Env, def: MetricDefinition, ctx: Ctx, req: EvaluateRequest, extraNeeds: Need[] = []): Attempt {
  const needs = needsFor(env, def, ctx);
  const all = [...needs, ...extraNeeds];
  const { found, missing } = scopeCompanies(env.ds, req.scope.companyIds);
  const excluded: Attempt['excluded'] = missing.map((companyId) => ({
    companyId,
    reason: 'not_on_file' as const,
    message: reasonMessage('not_on_file', 'this company is not in the data set (or you do not have access to it)'),
  }));
  const failOutcome = (f: Fail): Attempt => ({
    outcome: { status: 'cannot_compute', reason: f.reason, message: reasonMessage(f.reason, f.detail) },
    raw: null,
    included: [],
    excluded,
    notes: [],
    needs,
  });

  for (const n of all) {
    if (n.soft) continue;
    const f = datasetFailure(env.ds, n);
    if (f) return failOutcome(f);
  }

  const included: Included[] = [];
  let firstFail: Fail | null = null;
  for (const c of found) {
    let f: Fail | null = null;
    for (const n of all) {
      f = companyFailure(env.ds, c, n);
      if (f) break;
    }
    if (f) {
      firstFail = firstFail ?? f;
      excluded.push({ companyId: c.id, reason: f.reason, message: reasonMessage(f.reason, f.detail) });
    } else {
      included.push({ company: c, weight: weightOf(c, req.scope.weighting) });
    }
  }
  if (included.length === 0) {
    return failOutcome(firstFail ?? fail('not_on_file', 'no company in scope'));
  }
  const ev = new Evaluator(env, included);
  const { outcome, raw, notes } = outcomeOf(def, ev.eval(def.formula, { ...ctx, basis: effectiveBasis(def, ctx.basis) }));
  return { outcome, raw, included, excluded, notes, needs };
}

function usesBudget(e: Expr, registry: Registry, seen = new Set<string>()): boolean {
  if (e.op === 'budget') return true;
  if (e.op === 'metric') {
    if (seen.has(e.key)) return false;
    seen.add(e.key);
    const def = registry.get(e.key);
    return def ? usesBudget(def.formula, registry, seen) : false;
  }
  switch (e.op) {
    case 'add':
    case 'mul':
      return e.args.some((a) => usesBudget(a, registry, seen));
    case 'sub':
      return usesBudget(e.a, registry, seen) || usesBudget(e.b, registry, seen);
    case 'div':
      return usesBudget(e.num, registry, seen) || usesBudget(e.den, registry, seen);
    case 'neg':
    case 'growth':
    case 'cagr':
    case 'shift':
    case 'basis':
    case 'trailing_avg':
    case 'positive':
    case 'fallback':
      return usesBudget(e.arg, registry, seen);
    default:
      return false;
  }
}

function comparisonCtx(kind: Exclude<ComparisonKind, 'none'>, ctx: Ctx): Ctx {
  switch (kind) {
    case 'prior_year':
      return { ...ctx, end: addMonths(ctx.end, -12) };
    case 'prior_period':
      return { ...ctx, end: addMonths(ctx.end, -priorPeriodShift(ctx.basis)) };
    case 'budget':
      return { ...ctx, mode: 'budget' };
    default: {
      const never: never = kind;
      return never;
    }
  }
}

function isPreliminary(included: Included[], end: MonthKey): boolean {
  return included.some(({ company }) => company.closedThrough === null || company.closedThrough < end);
}

function drillRefs(ds: MetricDataset, needs: Need[]): DrillRef[] {
  const out = new Map<string, DrillRef>();
  for (const n of needs) {
    if (n.kind === 'gl' || n.kind === 'budget') {
      const def = ACCOUNT_CLASSES[n.cls];
      const kind: DrillRef['kind'] = n.kind === 'budget' ? 'budget' : n.balance ? 'gl_balance' : 'gl_flow';
      const id = `${kind}:${n.cls}`;
      if (!out.has(id)) out.set(id, { input: n.cls, label: def.label, kind, statement: def.statement, accountIds: ds.classMapping[n.cls]?.accountIds ?? [] });
    } else if (n.kind === 'op') {
      const def = OPERATIONAL_INPUTS[n.key];
      const id = `op:${n.key}`;
      if (!out.has(id)) out.set(id, { input: n.key, label: def.label, kind: 'operational', source: def.source });
    } else if (n.kind === 'conc') {
      const id = `conc:${n.dataset}`;
      if (!out.has(id)) out.set(id, { input: n.dataset, label: n.dataset === 'customer_revenue' ? 'Revenue by customer' : 'Spend by vendor', kind: 'concentration', source: n.dataset === 'customer_revenue' ? 'invoices' : 'bills' });
    }
  }
  return [...out.values()];
}

export interface EvaluateOptions {
  registry?: Registry;
}

/** Evaluate one metric for a scope, period, basis and comparison. Pure. */
export function evaluateMetric(ds: MetricDataset, req: EvaluateRequest, opts: EvaluateOptions = {}): MetricResult {
  const registry = opts.registry ?? METRICS;
  const def = registry.get(req.metric);
  if (!def) throw new Error(`Unknown metric "${req.metric}"`);
  const env: Env = { ds, registry };
  const basis = effectiveBasis(def, req.basis);
  const ctx: Ctx = { end: req.periodEnd, basis, mode: 'actual' };
  const window = windowMonths(req.periodEnd, basis, ds.fyStartMonth);

  const cur = attempt(env, def, ctx, req);
  const notes = [...cur.notes];

  // Comparison (like-for-like when the eligible company sets differ).
  let comparison: MetricResult['comparison'] = null;
  let change: MetricResult['change'] = null;
  if (req.comparison !== 'none') {
    const kind = req.comparison;
    if (kind === 'budget' && usesBudget(def.formula, registry)) {
      comparison = { kind, outcome: { status: 'cannot_compute', reason: 'not_meaningful', message: reasonMessage('not_meaningful', 'this measure already compares actual to budget') }, likeForLike: false };
    } else {
      const cctx = comparisonCtx(kind, ctx);
      // Companies eligible for BOTH periods (joint ⊆ current by construction).
      const joint = attempt(env, def, cctx, req, cur.needs);
      if (cur.outcome.status === 'ok' && joint.outcome.status === 'ok') {
        if (joint.included.length === cur.included.length) {
          comparison = { kind, outcome: joint.outcome, likeForLike: false };
          change = describeChange(cur.outcome.value, joint.outcome.value, def.unit, def.direction, kind);
        } else {
          // Fewer companies are on file for both periods: compare like-for-like on that set.
          const lfl = attempt(env, def, ctx, req, needsFor(env, def, cctx));
          comparison = { kind, outcome: joint.outcome, likeForLike: true };
          if (lfl.outcome.status === 'ok') {
            change = describeChange(lfl.outcome.value, joint.outcome.value, def.unit, def.direction, kind);
            notes.push(`Change is like-for-like on the ${joint.included.length} of ${cur.included.length} companies on file for both periods.`);
          }
        }
        notes.push(...joint.notes);
      } else {
        // No like-for-like pair: show the comparison on its own (value or reason), no change.
        const alone = attempt(env, def, cctx, req);
        comparison = { kind, outcome: alone.outcome, likeForLike: false };
      }
    }
  }

  // Sparkline: each month-end evaluated on its own; gaps are null, never 0.
  const n = req.sparkline ?? 12;
  const sparkline: SparkPoint[] = [];
  for (let i = n - 1; i >= 0 && n > 0; i--) {
    const end = addMonths(req.periodEnd, -i);
    const a = i === 0 ? cur : attempt(env, def, { ...ctx, end }, req);
    sparkline.push(
      a.outcome.status === 'ok'
        ? { month: end, value: a.outcome.value, preliminary: isPreliminary(a.included, end) }
        : { month: end, value: null, preliminary: false, reason: a.outcome.reason },
    );
  }

  const assumedFullOwnership =
    req.scope.weighting === 'ownership' ? cur.included.filter((i) => i.company.ownershipPct === null).map((i) => i.company.id) : [];
  if (assumedFullOwnership.length > 0) {
    const names = cur.included.filter((i) => i.company.ownershipPct === null).map((i) => i.company.name);
    notes.push(`No ownership on file for ${names.join(', ')}; counted at 100%.`);
  }

  return {
    key: def.key,
    name: def.name,
    unit: def.unit,
    direction: def.direction,
    period: { end: req.periodEnd, basis, from: window[0], to: window[window.length - 1] },
    current: cur.outcome,
    comparison,
    change,
    sparkline,
    preliminary: cur.outcome.status === 'ok' && isPreliminary(cur.included, req.periodEnd),
    scope: {
      weighting: req.scope.weighting,
      included: cur.included.map((i) => i.company.id),
      excluded: cur.excluded,
      assumedFullOwnership,
    },
    drill: drillRefs(ds, cur.needs),
    notes: [...new Set(notes)],
  };
}

/** Evaluate several metrics on one dataset. */
export function evaluateMetrics(ds: MetricDataset, reqs: EvaluateRequest[], opts: EvaluateOptions = {}): MetricResult[] {
  return reqs.map((r) => evaluateMetric(ds, r, opts));
}

/**
 * The month range a data source must load to evaluate `req` (current, comparison and
 * sparkline). Balances at or before `from` arrive as each class's opening balance plus
 * the flows from `from`, so a balance month is simply included in the range.
 */
export function requiredRange(req: EvaluateRequest, fyStartMonth: number, opts: EvaluateOptions = {}): { from: MonthKey; to: MonthKey } {
  const registry = opts.registry ?? METRICS;
  const def = registry.get(req.metric);
  if (!def) throw new Error(`Unknown metric "${req.metric}"`);
  const fakeDs: MetricDataset = {
    source: 'range-probe',
    fyStartMonth,
    rangeStart: req.periodEnd,
    latestMonth: req.periodEnd,
    companies: [],
    classMapping: {},
    operationalAvailable: [],
  };
  const env: Env = { ds: fakeDs, registry };
  const basis = effectiveBasis(def, req.basis);
  const ctxs: Ctx[] = [{ end: req.periodEnd, basis, mode: 'actual' }];
  if (req.comparison === 'prior_year' || req.comparison === 'prior_period') ctxs.push(comparisonCtx(req.comparison, ctxs[0]));
  const n = req.sparkline ?? 12;
  for (let i = 1; i < n; i++) ctxs.push({ ...ctxs[0], end: addMonths(req.periodEnd, -i) });
  let from = req.periodEnd;
  let to = req.periodEnd;
  for (const ctx of ctxs) {
    for (const need of needsFor(env, def, ctx)) {
      if (need.kind === 'impossible') continue;
      for (const m of need.months) {
        if (m < from) from = m;
        if (m > to) to = m;
      }
    }
  }
  return { from, to };
}

/** Comparison label for UI copy ("the same period last year"). */
export function comparisonLabel(kind: Exclude<ComparisonKind, 'none'>): string {
  return COMPARISON_LABEL[kind];
}
