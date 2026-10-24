/**
 * The metric data source servers should use (Wave 3 integration). SERVER ONLY.
 *
 *   const source = createMetricSource({ supabase, orgId, userId }, { today });
 *   const { results } = await evaluateFromSource(source, requests);
 *
 * Ledger figures come from the 3A report engine's balances store (migration 185,
 * `loadEngineFeed`): one jsonb round-trip, client-scope validated, RLS-scoped, kept correct
 * inside the posting transaction — the same numbers every statement shows. Sub-ledger inputs
 * (AR/AP aging, jobs, headcount, dealer, close cycle) still come from the GL-query adapter.
 * If the store is not deployed in this database (the RPC is missing), the whole load falls
 * back to the GL-query adapter so metrics keep working; any other error (including a
 * client-scope refusal) propagates — a refusal is never turned into a different answer.
 *
 * NUMBER GOVERNANCE (./governed.ts): every loaded dataset is governed for the reader
 * (`ctx.userId`; null → non-finance, fail closed) before the evaluator sees it — months not
 * released under the cumulative rule are dropped and `latestMonth` is pulled back, so a
 * metric is never computed from a withheld month. Finance passes through.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isStoreUnavailable, loadEngineFeed, type EngineContext } from '@/lib/reports/engine/adapter';
import { createGlQuerySource } from './adapters/gl-queries';
import { createPeriodBalanceSource } from './adapters/period-balances';
import type { MetricDataSource } from './data-source';
import { governDataset } from './governed';
import type { RouteGuardDeps } from '@/lib/reports/governance/route-guard';

export { isStoreUnavailable };

export interface MetricSourceOptions {
  /** Org-local today ('YYYY-MM-DD', lib/dates/org-today). */
  today: string;
  /** Governance dependency overrides (tests): capability probe / facts loader. */
  governance?: RouteGuardDeps;
}

/** Fiscal years with an approved budget per company: the current BUDGET version, APPROVED / LOCKED (migration 189). */
async function approvedBudgetYears(db: SupabaseClient, companyIds: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (companyIds.length === 0) return out;
  const { data, error } = await db.from('budget_plan_versions').select('location_id, fiscal_year').in('location_id', companyIds)
    .eq('kind', 'BUDGET').eq('is_current', true).in('status', ['APPROVED', 'LOCKED']);
  if (error) throw new Error(`metrics budget_plan_versions: ${error.message}`);
  for (const r of (data ?? []) as Array<{ location_id: string; fiscal_year: number }>) {
    const list = out.get(r.location_id) ?? [];
    if (!list.includes(Number(r.fiscal_year))) list.push(Number(r.fiscal_year));
    out.set(r.location_id, list);
  }
  return out;
}

export function createMetricSource(ctx: EngineContext, opts: MetricSourceOptions): MetricDataSource {
  const gl = createGlQuerySource(ctx.supabase, { orgId: ctx.orgId, today: opts.today });
  const store = createPeriodBalanceSource({
    loadFeed: (r) => loadEngineFeed(ctx, { companyIds: r.companyIds, from: r.from, to: r.to, includeBudgets: r.includeBudgets }),
    approvedBudgetYears: (ids) => approvedBudgetYears(ctx.supabase, ids),
    operational: gl,
    today: opts.today,
  });
  return {
    id: 'period-balances-3a',
    fiscalYearStartMonth: () => gl.fiscalYearStartMonth(),
    async load(req) {
      let ds;
      try {
        ds = await store.load(req);
      } catch (e) {
        if (!isStoreUnavailable(e)) throw e;
        ds = await gl.load(req);
      }
      return governDataset({ supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId, deps: opts.governance }, req, ds);
    },
  };
}
