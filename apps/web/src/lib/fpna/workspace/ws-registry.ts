/**
 * The workspace's evaluation registry: the 3B registry plus a few INTERNAL helper inputs the
 * bridges need as separate figures (receivables, inventory, payables, debt drawn / repaid,
 * contributions / distributions). Helpers never appear in the card catalog (keys start `ws_`).
 * Same expression language, same evaluator, same governed dataset — nothing is forked.
 */

import { bal, fallback, flow } from '@/lib/metrics/expr';
import { METRICS } from '@/lib/metrics/registry';
import type { Expr, MetricDefinition } from '@/lib/metrics/types';

function helper(key: string, name: string, formula: Expr, nature: 'flow' | 'balance'): MetricDefinition {
  return {
    key,
    name,
    definition: `${name} (workspace bridge input).`,
    group: nature === 'balance' ? 'liquidity' : 'liquidity',
    formula,
    unit: 'money',
    direction: 'neutral',
    period: { nature, basis: 'request' },
    requires: ['gl'],
    audiences: ['cfo'],
  };
}

const zeroIfUnmapped = (e: Expr, what: string): Expr => fallback(e, 0, ['not_mapped'], `No ${what} accounts are mapped; counted as zero.`);

const HELPERS: MetricDefinition[] = [
  helper('ws_cash', 'Cash', bal('cash'), 'balance'),
  helper('ws_ar', 'Receivables', zeroIfUnmapped(bal('ar'), 'receivables'), 'balance'),
  helper('ws_inventory', 'Inventory', zeroIfUnmapped(bal('inventory'), 'inventory'), 'balance'),
  helper('ws_current_assets', 'Current assets', bal('current_assets'), 'balance'),
  helper('ws_ap', 'Payables', zeroIfUnmapped(bal('ap'), 'payables'), 'balance'),
  helper('ws_current_liabilities', 'Current liabilities', bal('current_liabilities'), 'balance'),
  helper('ws_debt_drawn', 'Debt drawn', flow('debt_drawn'), 'flow'),
  helper('ws_debt_repaid', 'Debt repaid', flow('debt_repaid'), 'flow'),
  helper('ws_contributions', 'Owner contributions', flow('contributions'), 'flow'),
  helper('ws_distributions', 'Distributions', flow('distributions'), 'flow'),
];

export const WS_HELPER_KEYS: readonly string[] = HELPERS.map((h) => h.key);

export const WS_REGISTRY: ReadonlyMap<string, MetricDefinition> = new Map<string, MetricDefinition>([
  ...METRICS,
  ...HELPERS.map((h) => [h.key, h] as [string, MetricDefinition]),
]);
