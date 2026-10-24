/**
 * MetricDataSource — the seam between the pure evaluator and the database.
 *
 * Two adapters implement it:
 *   - `createGlQuerySource` (adapters/gl-queries.ts): today's RLS-scoped reads over
 *     gl_entry_lines, budgets, invoices, bills, core.jobs, payroll, dealer, periods.
 *   - `createPeriodBalanceSource` (adapters/period-balances.ts): over the 3A
 *     report-engine balances store. Servers use `createMetricSource` (server-source.ts),
 *     which wires it to the engine feed with the GL-query adapter as fallback.
 * The evaluator never sees which one produced the dataset (except `dataset.source`).
 */

import { compareMonths, type MonthKey } from '@/lib/analytics/months';
import { evaluateMetric, requiredRange, type EvaluateOptions } from './evaluate';
import { operationalRefs, walk } from './expr';
import { METRICS } from './registry';
import type { EvaluateRequest, MetricDataset, MetricDefinition, MetricResult, OperationalKey } from './types';

export interface DataSourceRequest {
  companyIds: string[];
  /** First month whose flows are needed (balances before it arrive as openings). */
  from: MonthKey;
  /** Last month needed. */
  to: MonthKey;
  needsBudget: boolean;
  operational: OperationalKey[];
  customerRevenue: boolean;
  vendorSpend: boolean;
}

export interface MetricDataSource {
  readonly id: string;
  /** Tenant fiscal-year start month (1 = January). */
  fiscalYearStartMonth(): Promise<number>;
  load(req: DataSourceRequest): Promise<MetricDataset>;
}

function closure(def: MetricDefinition, registry: ReadonlyMap<string, MetricDefinition>, seen = new Set<string>()): MetricDefinition[] {
  if (seen.has(def.key)) return [];
  seen.add(def.key);
  const out = [def];
  for (const n of walk(def.formula)) {
    if (n.op === 'metric') {
      const child = registry.get(n.key);
      if (child) out.push(...closure(child, registry, seen));
    }
  }
  return out;
}

/** Union of everything a batch of requests needs, as one load. Pure. */
export function planLoad(reqs: EvaluateRequest[], fyStartMonth: number, opts: EvaluateOptions = {}): DataSourceRequest {
  const registry = opts.registry ?? METRICS;
  if (reqs.length === 0) throw new Error('planLoad needs at least one request');
  const companyIds = new Set<string>();
  const operational = new Set<OperationalKey>();
  let from: MonthKey | null = null;
  let to: MonthKey | null = null;
  let needsBudget = false;
  let customerRevenue = false;
  let vendorSpend = false;
  for (const r of reqs) {
    r.scope.companyIds.forEach((id) => companyIds.add(id));
    const range = requiredRange(r, fyStartMonth, { registry });
    if (!from || compareMonths(range.from, from) < 0) from = range.from;
    if (!to || compareMonths(range.to, to) > 0) to = range.to;
    const def = registry.get(r.metric);
    if (!def) throw new Error(`Unknown metric "${r.metric}"`);
    if (r.comparison === 'budget') needsBudget = true;
    for (const d of closure(def, registry)) {
      operationalRefs(d.formula).forEach((k) => operational.add(k));
      for (const n of walk(d.formula)) {
        if (n.op === 'budget') needsBudget = true;
        if (n.op === 'concentration') {
          if (n.dataset === 'customer_revenue') customerRevenue = true;
          else vendorSpend = true;
        }
      }
    }
  }
  return {
    companyIds: [...companyIds],
    from: from as MonthKey,
    to: to as MonthKey,
    needsBudget,
    operational: [...operational],
    customerRevenue,
    vendorSpend,
  };
}

/** Load once, evaluate many. */
export async function evaluateFromSource(source: MetricDataSource, reqs: EvaluateRequest[], opts: EvaluateOptions = {}): Promise<{ dataset: MetricDataset; results: MetricResult[] }> {
  const fy = await source.fiscalYearStartMonth();
  const plan = planLoad(reqs, fy, opts);
  const dataset = await source.load(plan);
  return { dataset, results: reqs.map((r) => evaluateMetric(dataset, r, opts)) };
}
