/**
 * ONE governed dataset load per view (AC-W5, AC-W7). SERVER ONLY.
 *
 * The 3B metric source (`createMetricSource`: the 3A balances store + sub-ledger inputs, GL
 * fallback) is governed for the reader inside `load()` (`governDataset`, cumulative rule —
 * months a non-finance reader may not see are dropped and `latestMonth` pulled back). The
 * reader's audience is resolved ONCE here and shared (with one memoised facts loader) with
 * every other guard this request runs (dimension balances, covenants).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { compareMonths, monthOfIso, type MonthKey } from '@/lib/analytics/months';
import { planLoad } from '@/lib/metrics/data-source';
import { createMetricSource } from '@/lib/metrics/server-source';
import { assertScopedCompanies } from '@/lib/reports/engine/adapter';
import type { EvaluateRequest, MetricDataset } from '@/lib/metrics/types';
import { memoFactsLoader, resolveRouteAudience, type RouteGuardDeps } from '@/lib/reports/governance/route-guard';
import { getOrgToday } from '@/lib/dates/org-today';
import { WS_REGISTRY } from '../ws-registry';
import type { WsGovernance } from '../types';
import { longMonth } from '../units';

export interface WsServerCtx {
  /** The caller's RLS client. */
  supabase: SupabaseClient;
  orgId: string;
  /** null = scheduled delivery (governed as non-finance). */
  userId: string | null;
  /** Service client for the engine's governed RPCs (tests inject the harness client). */
  service?: SupabaseClient | null;
  /** Org-local today (tests); default: lib/dates/org-today. */
  today?: string;
  /** Governance dependency overrides (tests). */
  governance?: RouteGuardDeps;
}

export interface Prepared {
  ctx: WsServerCtx;
  today: string;
  currentMonth: MonthKey;
  fyStartMonth: number;
  finance: boolean;
  /** Shared by every guard in this request: one audience, one facts read. */
  deps: RouteGuardDeps;
  source: ReturnType<typeof createMetricSource>;
}

/** Resolve audience, today and the fiscal calendar (before the period is known). */
export async function prepare(ctx: WsServerCtx): Promise<Prepared> {
  const today = ctx.today ?? (await getOrgToday(ctx.supabase, ctx.orgId));
  const audience = await resolveRouteAudience({ userId: ctx.userId, deps: ctx.governance });
  const finance = audience.audience === 'finance';
  const deps: RouteGuardDeps = {
    ...ctx.governance,
    probe: { has: async () => finance },
    loadFacts: memoFactsLoader(ctx.governance?.loadFacts),
  };
  const source = createMetricSource({ supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId, service: ctx.service ?? null }, { today, governance: deps });
  const fyStartMonth = await source.fiscalYearStartMonth();
  return { ctx, today, currentMonth: monthOfIso(today), fyStartMonth, finance, deps, source };
}

export interface LoadSpec {
  companyIds: string[];
  requests: EvaluateRequest[];
  /** Widen the first month (series that the requests' own windows don't reach). */
  from?: MonthKey;
  customerRevenue?: boolean;
}

/** The counter tests use to prove one load per view. */
export const loadCounter = { loads: 0 };

export async function loadDataset(p: Prepared, spec: LoadSpec): Promise<MetricDataset> {
  // Client scope first: an empty request means every company the reader may see; a named
  // company outside the reader's scope is refused (EngineScopeError → 403), never dropped.
  const companyIds = await assertScopedCompanies(p.ctx.supabase, p.ctx.orgId, spec.companyIds);
  const reqs = spec.requests.map((r) => ({ ...r, scope: { companyIds, weighting: r.scope.weighting } }));
  const plan = planLoad(reqs, p.fyStartMonth, { registry: WS_REGISTRY });
  if (spec.from && compareMonths(spec.from, plan.from) < 0) plan.from = spec.from;
  if (spec.customerRevenue) plan.customerRevenue = true;
  // never ask for months after today (they are not on file)
  if (compareMonths(plan.to, p.currentMonth) > 0) plan.to = p.currentMonth;
  loadCounter.loads++;
  return p.source.load(plan);
}

export function governanceOf(p: Prepared, ds: MetricDataset, companyIds: readonly string[], end: MonthKey): WsGovernance {
  const ids = new Set(companyIds);
  const inScope = ds.companies.filter((c) => ids.has(c.id));
  let closed: MonthKey | null = null;
  let unknown = inScope.length === 0;
  for (const c of inScope) {
    if (c.closedThrough === null) unknown = true;
    else if (closed === null || compareMonths(c.closedThrough, closed) < 0) closed = c.closedThrough;
  }
  const closedThrough = unknown ? null : closed;
  const preview = p.finance && (closedThrough === null || compareMonths(closedThrough, end) < 0);
  const parts: string[] = [closedThrough ? `Books closed through ${longMonth(closedThrough)}` : 'Books not closed yet'];
  if (!p.finance) parts.push(`Shows released months only — through ${longMonth(ds.latestMonth)}`);
  else if (preview) parts.push('Months after that are preliminary and shown as a preview');
  return {
    audience: p.finance ? 'finance' : 'non_finance',
    closedThrough,
    releasedThrough: p.finance ? null : ds.latestMonth,
    preview,
    footnote: parts.join(' · '),
  };
}
