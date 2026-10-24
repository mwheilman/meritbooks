/**
 * Department budget bridges (Wave 4B, AC-B15) — pure, on 3B's `buildBridge` (steps always sum to
 * end − start; nothing plugged silently).
 *
 *   pyToBudget       prior-year actual → this year's budget, steps by DRIVER: volume, rate / price,
 *                    headcount, inflation & cost changes, new initiatives, one-time items. A line's
 *                    driver comes from its budget_line_drivers row (explicit bridge driver, else its
 *                    method), else from what the line is (new / dropped / payroll / revenue / cost).
 *   budgetToActual   budget → actual for a window, steps by account group (largest first).
 *   budgetToForecast budget → latest forecast for the fiscal year, same shape.
 *
 * Measure: a department with revenue bridges its CONTRIBUTION (income − expense, higher is
 * better); a cost-only department bridges its SPEND (expense, lower is better).
 */
import { buildBridge, type Bridge } from '@/lib/analytics';
import { contributionOf } from './bva';
import type { BridgeDriver, BridgeOut, BridgeStepOut, DriverMethod } from './types';
import { BRIDGE_DRIVER_LABEL } from './types';

export type Measure = 'contribution' | 'spend';

export interface PyBudgetRow {
  accountId: string;
  label: string;
  nature: 'income' | 'expense';
  pyCents: number;
  budgetCents: number;
  method: DriverMethod | null;
  bridgeDriver: BridgeDriver;
  isPayroll: boolean;
}

export interface CompareRowIn {
  accountId: string;
  label: string;
  groupName: string | null;
  accountType: string;
  nature: 'income' | 'expense';
  baseCents: number;
  compareCents: number;
}

const PAYROLL_RE = /wage|salar|payroll|bonus|commission|benefit|401k|health ins|workers.? comp|payroll tax/i;

export function isPayrollAccount(name: string, groupName: string | null): boolean {
  return PAYROLL_RE.test(name) || (groupName !== null && PAYROLL_RE.test(groupName));
}

export function measureFor(rows: ReadonlyArray<{ nature: 'income' | 'expense' }>): Measure {
  return rows.some((r) => r.nature === 'income') ? 'contribution' : 'spend';
}

/** Natural amount → the measure's signed amount. */
export function inMeasure(measure: Measure, nature: 'income' | 'expense', naturalCents: number): number {
  if (measure === 'contribution') return contributionOf(nature, naturalCents);
  return nature === 'expense' ? naturalCents : -naturalCents;
}

/** Which bridge step a PY → budget line reports under. */
export function classifyDriver(r: PyBudgetRow): Exclude<BridgeDriver, 'AUTO'> {
  if (r.bridgeDriver !== 'AUTO') return r.bridgeDriver;
  if (r.pyCents === 0 && r.budgetCents !== 0) return 'NEW_INITIATIVE';
  if (r.budgetCents === 0 && r.pyCents !== 0) return 'ONE_TIME';
  if (r.method === 'HEADCOUNT_RATE' || r.isPayroll) return 'HEADCOUNT';
  if (r.nature === 'income') {
    if (r.method === 'PY_GROWTH' || r.method === 'PRIOR_BUDGET_GROWTH') return 'RATE';
    return 'VOLUME';
  }
  if (r.method === 'PCT_OF_REVENUE' || r.method === 'UNITS_RATE') return 'VOLUME';
  return 'INFLATION';
}

const DRIVER_ORDER: ReadonlyArray<Exclude<BridgeDriver, 'AUTO'>> = ['VOLUME', 'RATE', 'HEADCOUNT', 'INFLATION', 'NEW_INITIATIVE', 'ONE_TIME'];

function out(title: string, measure: Measure, b: Bridge, steps: BridgeStepOut[], note: string | null): BridgeOut {
  return {
    title,
    measure,
    direction: measure === 'contribution' ? 'higher_is_better' : 'lower_is_better',
    start: b.start,
    steps,
    end: b.end,
    ties: b.ties,
    note,
  };
}

function topDetail(items: Array<{ accountId: string; label: string; cents: number }>, n = 5) {
  return [...items].filter((x) => x.cents !== 0).sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents)).slice(0, n);
}

/** Prior-year actual → this year's budget, by driver. */
export function pyToBudgetBridge(rows: readonly PyBudgetRow[], measureOverride?: Measure): BridgeOut {
  const measure = measureOverride ?? measureFor(rows);
  const word = measure === 'contribution' ? 'contribution' : 'spend';
  const start = rows.reduce((t, r) => t + inMeasure(measure, r.nature, r.pyCents), 0);
  const end = rows.reduce((t, r) => t + inMeasure(measure, r.nature, r.budgetCents), 0);
  const buckets = new Map<Exclude<BridgeDriver, 'AUTO'>, Array<{ accountId: string; label: string; cents: number }>>();
  for (const r of rows) {
    const d = inMeasure(measure, r.nature, r.budgetCents - r.pyCents);
    if (d === 0) continue;
    const k = classifyDriver(r);
    buckets.set(k, [...(buckets.get(k) ?? []), { accountId: r.accountId, label: r.label, cents: d }]);
  }
  const steps: BridgeStepOut[] = DRIVER_ORDER.filter((k) => buckets.has(k)).map((k) => {
    const items = buckets.get(k)!;
    return { key: k.toLowerCase(), label: BRIDGE_DRIVER_LABEL[k], cents: items.reduce((t, x) => t + x.cents, 0), detail: topDetail(items) };
  });
  const b = buildBridge({ label: `Last year ${word}`, cents: start }, { label: `Budget ${word}`, cents: end }, steps.map(({ key, label, cents }) => ({ key, label, cents })));
  const note = rows.length === 0 ? 'No prior-year actuals or budget lines for this department.' : null;
  return out(`Last year → budget`, measure, b, steps, note);
}

/**
 * Base → comparison by account group (budget → actual, budget → forecast). Steps are measured
 * group deltas; beyond `maxSteps` the remaining groups are one measured "All other accounts" step.
 */
export function groupBridge(
  title: string,
  labels: { start: string; end: string },
  rows: readonly CompareRowIn[],
  opts: { measure?: Measure; maxSteps?: number; note?: string | null } = {},
): BridgeOut {
  const measure = opts.measure ?? measureFor(rows);
  const maxSteps = opts.maxSteps ?? 7;
  const start = rows.reduce((t, r) => t + inMeasure(measure, r.nature, r.baseCents), 0);
  const end = rows.reduce((t, r) => t + inMeasure(measure, r.nature, r.compareCents), 0);
  const groups = new Map<string, Array<{ accountId: string; label: string; cents: number }>>();
  for (const r of rows) {
    const d = inMeasure(measure, r.nature, r.compareCents - r.baseCents);
    if (d === 0) continue;
    const g = r.groupName ?? fallbackGroup(r.accountType);
    groups.set(g, [...(groups.get(g) ?? []), { accountId: r.accountId, label: r.label, cents: d }]);
  }
  let steps: BridgeStepOut[] = [...groups.entries()]
    .map(([g, items]) => ({ key: `group:${g}`, label: g, cents: items.reduce((t, x) => t + x.cents, 0), detail: topDetail(items) }))
    .filter((s) => s.cents !== 0)
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents) || a.label.localeCompare(b.label));
  if (steps.length > maxSteps) {
    const rest = steps.slice(maxSteps - 1);
    steps = [
      ...steps.slice(0, maxSteps - 1),
      { key: 'group:__other', label: `All other accounts (${rest.length} groups)`, cents: rest.reduce((t, s) => t + s.cents, 0), detail: topDetail(rest.flatMap((s) => s.detail ?? [])) },
    ];
  }
  const b = buildBridge({ label: labels.start, cents: start }, { label: labels.end, cents: end }, steps.map(({ key, label, cents }) => ({ key, label, cents })));
  return out(title, measure, b, steps, opts.note ?? null);
}

function fallbackGroup(type: string): string {
  return { REVENUE: 'Revenue', COGS: 'Cost of revenue', OPEX: 'Operating expenses', OTHER: 'Other income & expense' }[type] ?? 'Other';
}

/** start + Σ steps === end (the tie every bridge must satisfy). */
export function bridgeTies(b: BridgeOut): boolean {
  return b.start.cents + b.steps.reduce((t, s) => t + s.cents, 0) === b.end.cents;
}
