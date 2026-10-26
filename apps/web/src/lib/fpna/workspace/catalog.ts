/**
 * The KPI card catalog (AC-W1): every registry metric with its generated formula string,
 * definition, unit, direction and requirements — the card picker's data. PURE.
 */

import { formulaOf, listMetrics } from '@/lib/metrics/registry';
import type { MetricGroup, Requirement } from '@/lib/metrics/types';
import type { CatalogEntry } from './types';
import { wsDirection, wsUnit } from './units';

export const GROUP_LABEL: Record<MetricGroup, string> = {
  growth: 'Growth',
  profitability: 'Profitability',
  plan: 'Plan',
  liquidity: 'Cash & liquidity',
  working_capital: 'Working capital',
  receivables: 'Receivables',
  payables: 'Payables',
  leverage: 'Debt & lenders',
  returns: 'Returns',
  efficiency: 'Efficiency',
  construction: 'Jobs & construction',
  dealer: 'Dealer',
  practice: 'Books health',
  strategic: 'Strategic',
};

export const GROUP_ORDER: readonly MetricGroup[] = [
  'profitability', 'growth', 'plan', 'liquidity', 'working_capital', 'receivables', 'payables', 'leverage', 'returns', 'efficiency', 'strategic', 'construction', 'dealer', 'practice',
];

export const REQUIREMENT_LABEL: Record<Requirement, string> = {
  gl: 'Posted ledger',
  budget: 'An approved budget',
  headcount: 'Headcount (payroll)',
  jobs: 'Jobs',
  ar_subledger: 'Invoices (receivables)',
  ap_subledger: 'Bills (payables)',
  inventory: 'Inventory',
  dealer: 'Dealer pack',
  practice: 'Close and workload data',
  addbacks: 'Documented add-backs',
  covenants: 'Loan covenants',
  ap_discounts: 'Early-pay discount terms',
};

let cache: CatalogEntry[] | null = null;

export function metricCatalog(): CatalogEntry[] {
  if (cache) return cache;
  const order = new Map(GROUP_ORDER.map((g, i) => [g, i]));
  cache = listMetrics()
    .map((m) => ({
      key: m.key,
      name: m.name,
      group: m.group,
      groupLabel: GROUP_LABEL[m.group],
      unit: wsUnit(m.unit),
      direction: wsDirection(m.direction),
      definition: m.definition,
      formula: formulaOf(m.key),
      requires: m.requires,
      requiresLabel: m.requires.map((r) => REQUIREMENT_LABEL[r]),
      basis: m.period.basis,
      audiences: m.audiences,
      hasBenchmark: Boolean(m.benchmark?.bands.length),
    }))
    .sort((a, b) => (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99));
  return cache;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9%&/ ]+/g, ' ');
}

/**
 * Search by name, key, group and formula text. Every whitespace-separated term must match
 * somewhere (AND); name hits rank above formula / definition hits.
 */
export function searchCatalog(entries: readonly CatalogEntry[], query: string, group?: MetricGroup | null): CatalogEntry[] {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  const pool = group ? entries.filter((e) => e.group === group) : entries;
  if (terms.length === 0) return [...pool];
  const scored: Array<{ e: CatalogEntry; s: number }> = [];
  for (const e of pool) {
    const name = norm(`${e.name} ${e.key.replace(/_/g, ' ')}`);
    const rest = norm(`${e.groupLabel} ${e.formula} ${e.definition}`);
    let score = 0;
    let all = true;
    for (const t of terms) {
      if (name.includes(t)) score += name.startsWith(t) ? 3 : 2;
      else if (rest.includes(t)) score += 1;
      else {
        all = false;
        break;
      }
    }
    if (all) scored.push({ e, s: score });
  }
  return scored.sort((a, b) => b.s - a.s).map((x) => x.e);
}
