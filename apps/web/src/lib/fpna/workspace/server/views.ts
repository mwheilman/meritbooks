/**
 * The /fpna view orchestrator. SERVER ONLY. One request → one governed dataset load
 * (AC-W5) + at most one engine statement (budget / consolidation) or one balances read
 * (dimension profitability) → the pure tab builders → one cached JSON response.
 */

import { addMonths, compareMonths, monthEndIso, monthRange, monthStartIso, type MonthKey } from '@/lib/analytics/months';
import { priorPeriodShift } from '@/lib/metrics/evaluate';
import type { Basis, MetricDataset } from '@/lib/metrics/types';
import { loadBalances, runReport } from '@/lib/reports/engine/adapter';
import type { PeriodPreset, ReportResult } from '@/lib/reports/engine/types';
import { governRouteMonths } from '@/lib/reports/governance/route-guard';
import { buildCovenantStatus, type CovenantRow, type CovenantStatus } from '@/lib/covenants/status';
import { resolveEffectiveDashboard } from '../dashboard-model';
import { workspacePeriod } from '../period';
import type { ViewQuery } from '../query';
import { chartPeriods, trailing, type EvalCtx } from '../series';
import type { BlocksViewResponse, DashboardViewResponse, EffectiveDashboardSummary, ViewResponse, WsBlock, WsCompany, WsEnvelope, WsPeriod } from '../types';
import { longMonth } from '../units';
import { bridgeBlocks, bridgesPlan } from '../views/bridges';
import { budgetBlocks, budgetCoverage, budgetPlan, DEFAULT_MATERIALITY } from '../views/budget';
import { dashboardCards, dashboardPlan } from '../views/dashboard';
import { groupBlocks, groupPlan } from '../views/group';
import { leverageBlocks, leveragePlan } from '../views/leverage';
import { performanceBlocks, performancePlan } from '../views/performance';
import { classSets, companyLeague, customerLeague, dimensionLeague, profitabilityPlan, type DimKey } from '../views/profitability';
import { customerTotals, workingCapitalBlocks, workingCapitalPlan } from '../views/working-capital';
import { ledgerEpoch, ViewCache, viewKey } from './cache';
import { listDashboards } from './dashboards-store';
import { governanceOf, loadDataset, type Prepared } from './load';

const cache = new ViewCache<ViewResponse>();

export function clearViewCache(): void {
  cache.clear();
}

const PRESET: Record<Basis, PeriodPreset> = { month: 'month', qtd: 'qtd', ytd: 'ytd', ttm: 'ttm' };

function evalCtx(ds: MetricDataset, companyIds: string[], weighting: 'full' | 'ownership'): EvalCtx {
  return { ds, scope: { companyIds, weighting }, names: new Map(ds.companies.map((c) => [c.id, c.name])), memo: new Map() };
}

function companiesOf(ds: MetricDataset, ids: readonly string[]): WsCompany[] {
  const want = new Set(ids);
  return ds.companies.filter((c) => want.has(c.id)).map((c) => ({ id: c.id, name: c.name, ownershipPct: c.ownershipPct, closedThrough: c.closedThrough }));
}

async function names(p: Prepared, table: 'departments' | 'classes' | 'jobs' | 'customers', ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = ids.filter(Boolean).slice(0, 500);
  if (!list.length) return out;
  const db = p.ctx.supabase;
  const q = table === 'classes' ? db.from('classes').select('id, name') : table === 'jobs' ? db.schema('core').from('jobs').select('id, name, job_number') : table === 'customers' ? db.schema('core').from('customers').select('id, name, display_name') : db.schema('core').from('departments').select('id, name');
  const { data } = await q.in('id', list);
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const label = table === 'jobs' ? [r.job_number, r.name].filter(Boolean).join(' · ') : table === 'customers' ? String(r.display_name ?? r.name ?? '') : String(r.name ?? '');
    out.set(String(r.id), label || 'Unnamed');
  }
  return out;
}

async function engine(p: Prepared, req: Parameters<typeof runReport>[1]): Promise<{ result: ReportResult | null; error: string | null }> {
  try {
    return { result: await runReport({ supabase: p.ctx.supabase, orgId: p.ctx.orgId, userId: p.ctx.userId, service: p.ctx.service ?? null }, req), error: null };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : 'The statement could not be computed.' };
  }
}

async function covenants(p: Prepared, companyIds: string[], end: MonthKey): Promise<{ statuses: CovenantStatus[] | null; withheld: string | null }> {
  const g = await governRouteMonths(
    { supabase: p.ctx.supabase, orgId: p.ctx.orgId, userId: p.ctx.userId, deps: p.deps },
    { months: trailing(end, 12), locationIds: companyIds, cumulative: true },
  );
  if (!g.finance && g.deniedMonths.length) return { statuses: null, withheld: `Covenant tests for ${longMonth(end)} are shown once the months behind them are released.` };
  const { data, error } = await p.ctx.supabase
    .from('loan_covenants')
    .select('id, location_id, loan_name, facility, lender_name, covenant_type, threshold, direction, test_frequency, warn_headroom_pct, measurement, status, effective_date, maturity_date, notes, created_at, updated_at')
    .eq('status', 'ACTIVE')
    .limit(24);
  if (error) return { statuses: null, withheld: null };
  const rows = ((data ?? []) as CovenantRow[]).filter((r) => r.location_id === null || companyIds.includes(r.location_id));
  const statuses: CovenantStatus[] = [];
  for (const r of rows.slice(0, 12)) {
    try {
      statuses.push(await buildCovenantStatus(p.ctx.supabase, r, monthEndIso(end)));
    } catch {
      /* one bad covenant never hides the others */
    }
  }
  return { statuses, withheld: null };
}

async function dimensionRows(p: Prepared, ds: MetricDataset, companyIds: string[], dim: DimKey, months: MonthKey[]) {
  const rows = await loadBalances(p.ctx.supabase, p.ctx.orgId, { companyIds, from: monthStartIso(months[0]), to: monthEndIso(months[months.length - 1]), dims: [dim], opening: false }, p.ctx.service ?? null);
  const g = await governRouteMonths({ supabase: p.ctx.supabase, orgId: p.ctx.orgId, userId: p.ctx.userId, deps: p.deps }, { months, locationIds: companyIds });
  return g.finance ? rows : rows.filter((r) => r.period !== null && g.isShown(r.period.slice(0, 7), r.companyId));
}

export interface ViewOptions {
  /** Effective dashboard for the dashboard tab (already resolved by the caller when known). */
  dashboard?: EffectiveDashboardSummary;
  role?: string | null;
  skipCache?: boolean;
}

export async function buildView(p: Prepared, q: ViewQuery, opts: ViewOptions = {}): Promise<ViewResponse> {
  const end0 = q.period ?? addMonths(p.currentMonth, -1);
  const period: WsPeriod = workspacePeriod({ end: end0, basis: q.basis ?? 'ytd', compare: q.compare ?? 'prior_year' }, p.fyStartMonth, p.currentMonth);
  const end = period.end;

  let dashboard: EffectiveDashboardSummary | undefined = opts.dashboard;
  if (q.tab === 'dashboard' && !dashboard) {
    const lists = await listDashboards(p.ctx, p.ctx.userId);
    dashboard = resolveEffectiveDashboard({ role: opts.role ?? null, personal: lists.personal, tenant: lists.tenant, requested: q.dashboard ?? null });
  }
  // Edit preview: the cards being edited replace the saved ones (a locked default is never previewed as changed).
  if (q.tab === 'dashboard' && dashboard && q.cards && dashboard.canPersonalize) dashboard = { ...dashboard, cards: q.cards };
  if (q.tab === 'dashboard' && dashboard && q.spark) dashboard = { ...dashboard, settings: { ...dashboard.settings, sparkline: Number(q.spark) as 12 | 24 } };

  const epoch = await ledgerEpoch(p.ctx.supabase);
  const key = viewKey({
    org: p.ctx.orgId, user: p.ctx.userId ?? 'none', tab: q.tab, end, basis: period.basis, cmp: period.comparison, companies: [...q.companies].sort().join(','), w: q.weighting,
    range: q.range, by: q.by, from: q.from, ma: q.mat_amount, mp: q.mat_pct, dash: dashboard ? `${dashboard.ref}@${dashboard.version}:${JSON.stringify(dashboard.cards)}:${JSON.stringify(dashboard.settings)}` : '', epoch,
  });
  if (!opts.skipCache) {
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };
  }

  const base = (ds: MetricDataset, ids: string[], tab: ViewQuery['tab']): WsEnvelope => ({
    tab,
    period,
    scope: { companies: companiesOf(ds, ids), weighting: q.weighting, requested: q.companies },
    governance: governanceOf(p, ds, ids, end),
    generatedAt: new Date().toISOString(),
    cached: false,
    epoch,
  });
  const scopeIds = (ds: MetricDataset) => (q.companies.length ? q.companies.filter((id) => ds.companies.some((c) => c.id === id)) : ds.companies.map((c) => c.id));

  let out: ViewResponse;
  switch (q.tab) {
    case 'dashboard': {
      const d = dashboard as EffectiveDashboardSummary;
      // the dashboard's own basis + comparison apply unless the reader overrides them in the picker
      const settings = { ...d.settings, ...(q.basis ? { basis: period.basis } : {}), ...(q.compare ? { comparison: period.comparison } : {}) };
      const p2 = workspacePeriod({ end: end0, basis: q.basis ?? settings.basis, compare: q.compare ?? settings.comparison }, p.fyStartMonth, p.currentMonth);
      const ds = await loadDataset(p, { companyIds: q.companies, requests: dashboardPlan(d.cards, p2.end, settings) });
      const ids = scopeIds(ds);
      const cards = dashboardCards(evalCtx(ds, ids, q.weighting), d.cards, p2.end, { ...settings, basis: p2.basis, comparison: p2.comparison });
      const r: DashboardViewResponse = { ...base(ds, ids, 'dashboard'), period: p2, tab: 'dashboard', dashboard: d, cards };
      out = r;
      break;
    }
    case 'performance': {
      const ds = await loadDataset(p, { companyIds: q.companies, requests: performancePlan(end, q.range) });
      const ids = scopeIds(ds);
      out = { ...base(ds, ids, q.tab), blocks: performanceBlocks(evalCtx(ds, ids, q.weighting), end, q.range), notices: [] } satisfies BlocksViewResponse;
      break;
    }
    case 'budget': {
      const ds = await loadDataset(p, { companyIds: q.companies, requests: budgetPlan(end, p.fyStartMonth) });
      const ids = scopeIds(ds);
      const ctx = evalCtx(ds, ids, q.weighting);
      const eng = await engine(p, { statement: 'income_statement', scope: { companyIds: ids }, period: { preset: PRESET[period.basis], asOf: monthEndIso(end) }, columns: 'single', compare: ['budget'], basis: 'ACCRUAL', rounding: 'cents', layout: { kind: 'standard' } });
      const rule = { amountCents: q.mat_amount ?? DEFAULT_MATERIALITY.amountCents, pct: q.mat_pct ?? DEFAULT_MATERIALITY.pct, mode: 'or' as const };
      const cov = budgetCoverage(ctx, end);
      const notices: BlocksViewResponse['notices'] = [];
      if (cov.missing.length) notices.push({ tone: 'info', title: `No approved budget for FY ${cov.fy} at ${cov.missing.length} compan${cov.missing.length === 1 ? 'y' : 'ies'}`, body: `${cov.missing.slice(0, 6).join(', ')}${cov.missing.length > 6 ? '…' : ''}. Only approved versions are ever compared.`, href: '/budgets', hrefLabel: 'Open budgets' });
      if (eng.error) notices.push({ tone: 'warn', title: 'The variance-by-line statement could not be computed.', body: eng.error });
      notices.push({ tone: 'info', title: 'Department budgets', body: 'Each department owner’s plan against actual, with explanations, lives in Budgets.', href: '/budgets?tab=departments', hrefLabel: 'Department budget vs actual' });
      out = { ...base(ds, ids, q.tab), blocks: budgetBlocks(ctx, end, eng.result, rule, period.label), notices } satisfies BlocksViewResponse;
      break;
    }
    case 'bridges': {
      const mode = period.comparison === 'budget' ? 'budget' : 'periods';
      const from = q.from ?? (period.comparison === 'prior_period' ? addMonths(end, -priorPeriodShift(period.basis)) : addMonths(end, -12));
      if (compareMonths(from, end) >= 0) throw new WorkspaceInputError('The bridge must start before it ends — pick an earlier "from" month.');
      const ds = await loadDataset(p, { companyIds: q.companies, requests: bridgesPlan(from, end, period.basis) });
      const ids = scopeIds(ds);
      out = { ...base(ds, ids, q.tab), blocks: bridgeBlocks(evalCtx(ds, ids, q.weighting), { from, to: end, basis: period.basis, mode }), notices: [] } satisfies BlocksViewResponse;
      break;
    }
    case 'working-capital': {
      const months = monthRange(period.from, period.to);
      const ds = await loadDataset(p, { companyIds: q.companies, requests: workingCapitalPlan(end, q.range), customerRevenue: true });
      const ids = scopeIds(ds);
      const ctx = evalCtx(ds, ids, q.weighting);
      const top = [...customerTotals(ctx, months).entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([id]) => id);
      const cn = await names(p, 'customers', top);
      out = { ...base(ds, ids, q.tab), blocks: workingCapitalBlocks(ctx, end, q.range, months, cn, period.label), notices: [] } satisfies BlocksViewResponse;
      break;
    }
    case 'profitability': {
      const windowMonths = monthRange(period.from, period.to);
      const spark = trailing(end, 12);
      const ds = await loadDataset(p, { companyIds: q.companies, requests: profitabilityPlan(end, period.basis), customerRevenue: q.by === 'customer' });
      const ids = scopeIds(ds);
      const ctx = evalCtx(ds, ids, q.weighting);
      const blocks: WsBlock[] = [];
      if (q.by === 'company') blocks.push(companyLeague(ctx, end, period.basis, period.label));
      else if (q.by === 'customer') {
        const totals = [...customerTotals(ctx, windowMonths).entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([id]) => id);
        blocks.push(customerLeague(ctx, windowMonths, spark, await names(p, 'customers', totals), period.label));
      } else {
        const months = [...new Set([...windowMonths, ...spark])].sort();
        const rows = await dimensionRows(p, ds, ids, q.by, monthRange(months[0], months[months.length - 1]));
        const dimIds = [...new Set(rows.map((r) => (q.by === 'department' ? r.departmentId : q.by === 'class' ? r.classId : r.jobId)).filter((x): x is string => !!x))];
        const n = await names(p, q.by === 'department' ? 'departments' : q.by === 'class' ? 'classes' : 'jobs', dimIds);
        const st = new Map(chartPeriods(ctx, spark).map((x) => [x.key, x.status]));
        blocks.push(dimensionLeague(rows, classSets(ds), q.by, windowMonths, spark, n, period.label, (m) => st.get(m) ?? 'closed'));
      }
      out = { ...base(ds, ids, q.tab), blocks, notices: [] } satisfies BlocksViewResponse;
      break;
    }
    case 'group': {
      const ds = await loadDataset(p, { companyIds: q.companies, requests: groupPlan(end, period.basis) });
      const ids = scopeIds(ds);
      const notices: BlocksViewResponse['notices'] = [];
      let consolidated: ReportResult | null = null;
      if (ids.length >= 2) {
        const eng = await engine(p, { statement: 'income_statement', scope: { companyIds: ids, consolidate: true }, period: { preset: PRESET[period.basis], asOf: monthEndIso(end) }, columns: 'company', compare: [], basis: 'ACCRUAL', rounding: 'cents', layout: { kind: 'ebitda' } });
        consolidated = eng.result;
        if (eng.error) notices.push({ tone: 'warn', title: 'Consolidated figures could not be computed.', body: eng.error });
      }
      out = { ...base(ds, ids, q.tab), blocks: groupBlocks(evalCtx(ds, ids, q.weighting), end, period.basis, consolidated, period.label), notices } satisfies BlocksViewResponse;
      break;
    }
    case 'leverage': {
      const ds = await loadDataset(p, { companyIds: q.companies, requests: leveragePlan(end, q.range) });
      const ids = scopeIds(ds);
      const cov = await covenants(p, ids, end);
      out = { ...base(ds, ids, q.tab), blocks: leverageBlocks(evalCtx(ds, ids, q.weighting), end, q.range, cov.statuses, cov.withheld), notices: [] } satisfies BlocksViewResponse;
      break;
    }
    default: {
      const never: never = q.tab;
      throw new Error(`Unknown tab ${String(never)}`);
    }
  }
  cache.set(key, out);
  return out;
}

export class WorkspaceInputError extends Error {
  readonly status = 422;
}
