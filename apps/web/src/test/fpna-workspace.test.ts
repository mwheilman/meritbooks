/**
 * FP&A workspace end-to-end (FPB-reports-fpna §4.13) against the real schema (PGlite replay):
 * metric source (3A store) → governed dataset → tab builders, compared with the report engine.
 *
 *   AC-W5  one dataset load per view; cached per (…, ledger epoch); a new posting is a new epoch
 *   AC-W6  dashboard revenue / gross profit / net income / cash / total debt tie to the engine's
 *          income statement and balance sheet; profitability by department ties to the engine's
 *          department columns; the consolidation bridge ends at the engine's Consolidated column
 *   AC-W7  a non-finance reader sees released months only (figures after the cut-off are "not on
 *          file", never computed); the footer says so
 *   AC-W9  bridges tie on real data
 *   AC-W3  personal save / lock levels / publish versions / override through the store
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { asMember, monthRange, postEntry, seedReportTenant, serviceClient, type ReportTenant } from './report-engine-fixture';
import { company as factCompany, facts, factsLoader } from './governance-facts';
import { runReport } from '@/lib/reports/engine/adapter';
import { registerDrillGovernance, registerGovernance, registerMembership } from '@/lib/reports/engine/governance-hook';
import { setEngineServiceClientForTests } from '@/lib/reports/engine/service-client';
import type { ReportResult } from '@/lib/reports/engine/types';
import { viewQuerySchema, type ViewQueryInput } from '@/lib/fpna/workspace/query';
import { loadCounter, prepare, type WsServerCtx } from '@/lib/fpna/workspace/server/load';
import { buildView, clearViewCache } from '@/lib/fpna/workspace/server/views';
import { listDashboards, publishDefault, savePersonal, DashboardStoreError } from '@/lib/fpna/workspace/server/dashboards-store';
import { resolveEffectiveDashboard } from '@/lib/fpna/workspace/dashboard-model';
import type { BlocksViewResponse, DashboardViewResponse, EffectiveDashboardSummary, WsBridgeBlock, WsLeagueBlock } from '@/lib/fpna/workspace/types';

let db: PGlite;
let t: ReportTenant;
let A: string;
let B: string;
const SUB = 'user_fpna_cfo';
const TODAY = '2026-10-15';

const DASH: EffectiveDashboardSummary = {
  id: null, ref: 'pack:test', name: 'Test', packKey: 'cfo', source: 'pack', lock: null, canPersonalize: true, overridden: false, version: 1,
  settings: { basis: 'ytd', comparison: 'prior_year', sparkline: 12 },
  cards: ['revenue', 'gross_profit', 'net_income', 'cash', 'total_debt', 'ebitda_margin', 'dso'].map((metric) => ({ metric, size: 'm' as const })),
};

function ctx(finance = true, extra: Partial<WsServerCtx> = {}): WsServerCtx {
  return {
    supabase: pgSupabase(db),
    orgId: t.org,
    userId: SUB,
    service: serviceClient(db),
    today: TODAY,
    governance: { probe: { has: async () => finance }, ...(extra.governance ?? {}) },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'governance')),
  };
}

async function view(input: ViewQueryInput, c: WsServerCtx = ctx(), dashboard: EffectiveDashboardSummary | undefined = DASH) {
  return asMember(db, t.org, SUB, async () => {
    const p = await prepare(c);
    return buildView(p, viewQuerySchema.parse(input), { dashboard, role: 'cfo' });
  });
}

async function engine(req: Parameters<typeof runReport>[1]): Promise<ReportResult> {
  return asMember(db, t.org, SUB, () => runReport({ supabase: pgSupabase(db), orgId: t.org, userId: SUB, service: serviceClient(db) }, req));
}

const cell = (r: ReportResult, rowId: string, colId?: string): number => {
  const row = r.rows.find((x) => x.id === rowId);
  if (!row) throw new Error(`row ${rowId} missing: ${r.rows.map((x) => x.id).join(',')}`);
  const i = colId ? r.columns.findIndex((c) => c.id === colId) : r.columns.findIndex((c) => c.kind === 'amount' || c.kind === 'total');
  return Number(row.values[i] ?? 0);
};

beforeAll(async () => {
  registerGovernance(null);
  registerMembership(null);
  registerDrillGovernance(null);
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  setEngineServiceClientForTests(() => serviceClient(db));
  t = await seedReportTenant(db, { slug: 'fpna4a', companies: 2, months: monthRange('2025-01', 24) });
  [A, B] = t.companies;
  const a = t.acct;
  await postEntry(db, t, { location: A, date: '2025-01-02', lines: [{ account: a.cash, debit: 5_000_000 }, { account: a.capital, credit: 5_000_000 }] });
  await postEntry(db, t, { location: B, date: '2025-01-02', lines: [{ account: a.cash, debit: 2_000_000 }, { account: a.capital, credit: 2_000_000 }] });
  await postEntry(db, t, { location: B, date: '2025-02-01', lines: [{ account: a.cash, debit: 3_000_000 }, { account: a.loan, credit: 3_000_000 }] });
  for (const ym of monthRange('2025-01', 21)) {
    for (const [i, loc] of [A, B].entries()) {
      const rev = 1_000_000 + i * 400_000 + (ym >= '2026-01' ? 100_000 : 0);
      await postEntry(db, t, {
        location: loc, date: `${ym}-10`,
        lines: [
          { account: a.ar, debit: rev },
          { account: a.revenue, credit: Math.round(rev * 0.7), department: t.depts[0] },
          { account: a.revenue, credit: rev - Math.round(rev * 0.7), department: t.depts[1] },
        ],
      });
      await postEntry(db, t, { location: loc, date: `${ym}-20`, lines: [{ account: a.cash, debit: rev - 50_000 }, { account: a.ar, credit: rev - 50_000 }] });
      await postEntry(db, t, {
        location: loc, date: `${ym}-25`,
        lines: [
          { account: a.cogs, debit: 400_000, department: t.depts[0] },
          { account: a.rent, debit: 120_000 },
          { account: a.wages, debit: 200_000, department: t.depts[1] },
          { account: a.depExp, debit: 30_000 },
          { account: a.accDep, credit: 30_000 },
          { account: a.cash, credit: 640_000 },
          { account: a.ap, credit: 80_000 },
        ],
      });
    }
    await postEntry(db, t, { location: B, date: `${ym}-28`, lines: [{ account: a.interest, debit: 12_000 }, { account: a.loan, debit: 40_000 }, { account: a.cash, credit: 52_000 }] });
  }
  // intercompany service A → B (eliminating pair)
  await postEntry(db, t, { location: A, date: '2026-05-15', lines: [{ account: a.interdeptCost, debit: 25_000 }, { account: a.interdeptRev, credit: 25_000 }] });
  await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where org_id = $1 and (period_year = 2025 or (period_year = 2026 and period_month <= 8))`, [t.org]);
  // the reader: an active owner-level member with all-clients access
  await db.query(`select core.rbac_provision_tenant($1)`, [t.org]);
  const role = await db.query<{ id: string }>(
    `select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and max_assignment_days is null and audience = 'internal_staff' and status = 'active' order by key limit 1`,
    [t.org],
  );
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [SUB]);
  const m = await db.query<{ id: string }>(`insert into core.memberships (user_id, org_id, role) values ($1, $2, 'owner') returning id`, [u.rows[0].id, t.org]);
  await db.query(
    `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, effective_from) values ($1, $2, 'role', $3, 'all_clients', null, now() - interval '30 days')`,
    [t.org, m.rows[0].id, role.rows[0].id],
  );
}, 170_000);

afterAll(async () => {
  setEngineServiceClientForTests(null);
  await db?.close();
});

describe('AC-W6 the dashboard ties to the engine', () => {
  it('revenue, gross profit, net income (YTD) and cash, total debt (at the end) equal the statements', async () => {
    const v = (await view({ tab: 'dashboard', period: '2026-09', basis: 'ytd', compare: 'prior_year' })) as DashboardViewResponse;
    const card = (k: string) => v.cards.find((c) => c.metric === k);
    const is = await engine({ statement: 'income_statement', scope: { companyIds: [] }, period: { preset: 'ytd', asOf: '2026-09-30' }, columns: 'single', compare: [], basis: 'ACCRUAL', rounding: 'cents' });
    const bs = await engine({ statement: 'balance_sheet', scope: { companyIds: [] }, period: { preset: 'month', asOf: '2026-09-30' }, columns: 'single', compare: [], basis: 'ACCRUAL', rounding: 'cents' });
    expect(card('revenue')?.value).toBe(cell(is, 'rev'));
    expect(card('gross_profit')?.value).toBe(cell(is, 'gp'));
    expect(card('net_income')?.value).toBe(cell(is, 'ni'));
    const cashRow = bs.rows.find((r) => r.accountId === t.acct.cash);
    const loanRow = bs.rows.find((r) => r.accountId === t.acct.loan);
    expect(card('cash')?.value).toBe(Number(cashRow?.values[0]));
    expect(card('total_debt')?.value).toBe(Number(loanRow?.values[0]));
    expect(card('revenue')?.value).toBe(9 * (1_100_000 + 1_500_000) + 25_000);
    // comparison + verdict, Sep 2026 is not closed → preliminary
    expect(card('revenue')?.change?.verdict).toBe('improvement');
    expect(card('revenue')?.preliminary).toBe(true);
    expect(v.governance).toMatchObject({ audience: 'finance', closedThrough: '2026-08', preview: true });
    expect(v.governance.footnote).toMatch(/Books closed through Aug 2026/);
  });

  it('profitability by department ties to the engine department columns (Unassigned included)', async () => {
    const v = (await view({ tab: 'profitability', period: '2026-09', basis: 'ytd', by: 'department' })) as BlocksViewResponse;
    const lg = v.blocks[0] as WsLeagueBlock;
    const eng = await engine({ statement: 'income_statement', scope: { companyIds: [] }, period: { preset: 'ytd', asOf: '2026-09-30' }, columns: 'department', compare: [], basis: 'ACCRUAL', rounding: 'cents' });
    for (const d of [t.depts[0], t.depts[1]]) {
      const row = lg.rows.find((r) => r.key === d);
      expect(row, d).toBeTruthy();
      expect(row?.values[0]).toBe(cell(eng, 'rev', `dim:${d}`));
      expect(row?.values[1]).toBe(cell(eng, 'gp', `dim:${d}`));
    }
    const un = lg.rows.find((r) => r.key === 'unassigned');
    expect(un?.values[0] ?? 0).toBe(cell(eng, 'rev', 'dim:none'));
    expect(lg.total?.values[0]).toBe(cell(eng, 'rev', 'total'));
    expect(lg.rows.find((r) => r.key === t.depts[0])?.label).toBe('Operations');
  });

  it('group: the elimination bridge ends at the engine Consolidated figure; combined and weighted totals', async () => {
    const v = (await view({ tab: 'group', period: '2026-09', basis: 'ytd' })) as BlocksViewResponse;
    const elim = v.blocks.find((b) => b.id === 'group-elim-rev') as WsBridgeBlock;
    const eng = await engine({ statement: 'income_statement', scope: { companyIds: [A, B], consolidate: true }, period: { preset: 'ytd', asOf: '2026-09-30' }, columns: 'company', compare: [], basis: 'ACCRUAL', rounding: 'cents', layout: { kind: 'ebitda' } });
    expect(elim.steps[elim.steps.length - 1].value).toBe(cell(eng, 'rev', 'consol'));
    expect(elim.steps.filter((s) => s.kind === 'delta').reduce((x, s) => x + s.value, 0)).toBe(elim.steps[elim.steps.length - 1].value);
    expect(elim.ties).toBe(true);
    const league = v.blocks.find((b) => b.id === 'group-league') as WsLeagueBlock;
    expect(league.rows).toHaveLength(2);
  });
});

describe('AC-W5 one load per view, cached per epoch', () => {
  it('every tab does exactly one dataset load; a repeat is served from the cache until the ledger changes', async () => {
    clearViewCache();
    // working-capital and leverage read sub-ledger inputs through the GL-query adapter, whose
    // PostgREST embedded filters (gl_entries.status) the PGlite shim does not implement — their
    // builders are covered by lib/fpna/workspace/workspace-pure.test.ts.
    for (const tab of ['performance', 'budget', 'bridges', 'profitability', 'group', 'dashboard'] as const) {
      const before = loadCounter.loads;
      const v = await view({ tab, period: '2026-09', basis: 'ytd' });
      expect(loadCounter.loads - before, tab).toBe(1);
      expect(v.cached).toBe(false);
    }
    const before = loadCounter.loads;
    const again = await view({ tab: 'performance', period: '2026-09', basis: 'ytd' });
    expect(again.cached).toBe(true);
    expect(loadCounter.loads).toBe(before);
    // a new posting moves the epoch → recomputed
    await postEntry(db, t, { location: A, date: '2026-09-29', lines: [{ account: t.acct.ar, debit: 7_700 }, { account: t.acct.revenue, credit: 7_700 }] });
    const after = (await view({ tab: 'performance', period: '2026-09', basis: 'ytd' })) as BlocksViewResponse;
    expect(after.cached).toBe(false);
    expect(after.epoch).not.toBe(again.epoch);
  });
});

describe('AC-W9 bridges tie on real data', () => {
  it('EBITDA, working capital and cash: start + Σ steps = end', async () => {
    const v = (await view({ tab: 'bridges', period: '2026-09', basis: 'ytd', compare: 'prior_year' })) as BlocksViewResponse;
    for (const b of v.blocks as WsBridgeBlock[]) {
      expect(b.state, b.id).toBeUndefined();
      const start = b.steps.find((s) => s.kind === 'start')?.value ?? 0;
      const end = b.steps.find((s) => s.kind === 'end')?.value ?? 0;
      expect(start + b.steps.filter((s) => s.kind === 'delta').reduce((x, s) => x + s.value, 0), b.id).toBe(end);
    }
  });
});

describe('AC-W7 governance', () => {
  it('a non-finance reader: months after the release cut-off are never computed', async () => {
    clearViewCache();
    const loader = factsLoader(() => facts(factCompany(A, [1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6]), factCompany(B, [1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6])));
    const nf = ctx(false, { governance: { probe: { has: async () => false }, loadFacts: loader } });
    const sep = (await view({ tab: 'dashboard', period: '2026-09', basis: 'ytd', compare: 'none' }, nf)) as DashboardViewResponse;
    expect(sep.governance.audience).toBe('non_finance');
    expect(sep.cards.find((c) => c.metric === 'revenue')?.value).toBeNull();
    expect(sep.cards.find((c) => c.metric === 'revenue')?.unavailable?.reason).toBe('not_on_file');
    const jun = (await view({ tab: 'dashboard', period: '2026-06', basis: 'ytd', compare: 'none' }, nf)) as DashboardViewResponse;
    expect(jun.cards.find((c) => c.metric === 'revenue')?.value).toBe(6 * 2_600_000 + 25_000);
    expect(jun.governance.releasedThrough).toBe('2026-06');
    expect(jun.governance.footnote).toMatch(/released months only/);
    // the sparkline stops at the cut-off: later points are gaps, not zeros
    const spark = (await view({ tab: 'dashboard', period: '2026-09', basis: 'month', compare: 'none' }, nf)) as DashboardViewResponse;
    const pts = spark.cards.find((c) => c.metric === 'revenue')?.sparkline ?? [];
    expect(pts.find((p) => p.month === '2026-07')?.value).toBeNull();
    expect(pts.find((p) => p.month === '2026-06')?.value).toBe(2_600_000);
  });

  it('dimension balances are governed too (profitability by department for a non-finance reader)', async () => {
    clearViewCache();
    const loader = factsLoader(() => facts(factCompany(A, [1, 2, 3], [1, 2, 3]), factCompany(B, [1, 2, 3], [1, 2, 3])));
    const nf = ctx(false, { governance: { probe: { has: async () => false }, loadFacts: loader } });
    const v = (await view({ tab: 'profitability', period: '2026-06', basis: 'ytd', by: 'department' }, nf)) as BlocksViewResponse;
    const lg = v.blocks[0] as WsLeagueBlock;
    // only Jan–Mar 2026 are released: Σ revenue = 3 months × both companies
    expect(lg.total?.values[0]).toBe(3 * 2_600_000);
  });
});

describe('AC-W3 dashboards through the store', () => {
  it('save, version, lock, add_move, override', async () => {
    const store = { supabase: pgSupabase(db), orgId: t.org, service: pgSupabase(db) };
    const cards = [{ metric: 'revenue', size: 'm' as const }, { metric: 'cash', size: 's' as const }];
    const settings = { basis: 'ytd' as const, comparison: 'prior_year' as const, sparkline: 12 as const };
    const mine = await savePersonal(store, SUB, 'cfo', { name: 'My view', packKey: 'custom', cards, settings });
    expect(mine.version).toBe(1);
    const again = await savePersonal(store, SUB, 'cfo', { id: mine.id, name: 'My view', packKey: 'custom', cards: [...cards, { metric: 'dso', size: 's' }], settings });
    expect(again.version).toBe(2);
    expect(again.cards.map((c) => c.metric)).toEqual(['revenue', 'cash', 'dso']);
    await expect(savePersonal(store, 'someone_else', 'cfo', { id: mine.id, name: 'x', packKey: 'custom', cards, settings })).rejects.toMatchObject({ status: 404 });

    const v1 = await publishDefault(store, 'admin_1', { roleKey: 'cfo', name: 'CFO default', packKey: 'cfo', cards: [{ metric: 'ebitda', size: 'm' }], settings, lockLevel: 'add_move', publishMode: 'new_users' });
    expect(v1.version).toBe(1);
    expect(v1.requiredMetrics).toEqual(['ebitda']);
    await expect(savePersonal(store, SUB, 'cfo', { id: mine.id, name: 'My view', packKey: 'custom', cards, settings })).rejects.toMatchObject({ status: 409, code: 'REQUIRED_METRIC_REMOVED' });
    const ok = await savePersonal(store, SUB, 'cfo', { id: mine.id, name: 'My view', packKey: 'custom', cards: [{ metric: 'ebitda', size: 'm' }, ...cards], settings });
    expect(ok.version).toBe(3);

    const v2 = await publishDefault(store, 'admin_1', { roleKey: 'cfo', name: 'CFO default', packKey: 'cfo', cards: [{ metric: 'ebitda', size: 'm' }, { metric: 'cash', size: 's' }], settings, lockLevel: 'locked', publishMode: 'override' });
    expect(v2.version).toBe(2);
    expect(v2.basedOnId).toBe(v1.id);
    const all = await db.query<{ version: number; is_current: boolean }>(`select version, is_current from public.fpna_dashboards where org_id = $1 and scope_kind = 'tenant' order by version`, [t.org]);
    expect(all.rows).toEqual([{ version: 1, is_current: false }, { version: 2, is_current: true }]);
    await expect(savePersonal(store, SUB, 'cfo', { id: mine.id, name: 'My view', packKey: 'custom', cards, settings })).rejects.toBeInstanceOf(DashboardStoreError);

    const lists = await asMember(db, t.org, SUB, () => listDashboards({ supabase: pgSupabase(db), orgId: t.org }, SUB));
    const eff = resolveEffectiveDashboard({ role: 'cfo', personal: lists.personal, tenant: lists.tenant });
    expect(eff.source).toBe('role_default');
    expect(eff.canPersonalize).toBe(false);
    expect(eff.cards.map((c) => c.metric)).toEqual(['ebitda', 'cash']);
  });
});
