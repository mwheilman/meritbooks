/**
 * Report engine end-to-end (FPB-financial-reports §4 A-3A): migration 185 store → adapter
 * (report_balances / report_drill_lines RPCs, run AS A MEMBER under RLS) → pure core.
 * Every figure is checked against an independent SQL sum over POSTED gl_entry_lines.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { seedReportTenant, postEntry, asMember, monthRange, serviceClient, type ReportTenant } from './report-engine-fixture';
import { runReport, runDrill, runTieOut, loadBalances, EngineScopeError, type EngineContext } from '@/lib/reports/engine/adapter';
import { tieViolations } from '@/lib/reports/engine/build';
import { registerDrillGovernance, registerGovernance, registerMembership } from '@/lib/reports/engine/governance-hook';
import { setEngineServiceClientForTests } from '@/lib/reports/engine/service-client';
import { governDrillRequest } from '@/lib/reports/governance/engine-adapter';
import { GovernanceDeniedError } from '@/lib/reports/governance/filter';
import { isStoreUnavailable } from '@/lib/reports/engine/adapter';
import { periodBalanceFluxSource } from '@/lib/close/flux/period-balance-source';
import { createMetricSource } from '@/lib/metrics/server-source';
import type { ReportRequest, ReportResult, ReportRow } from '@/lib/reports/engine/types';

let db: PGlite;
let t: ReportTenant;
let A: string, B: string, C: string;
const SUB = 'user_engine_ctl';

function req(over: Partial<ReportRequest>): ReportRequest {
  return {
    statement: 'income_statement',
    scope: { companyIds: [] },
    period: { preset: 'year', asOf: '2026-06-30' },
    columns: 'single',
    compare: [],
    basis: 'ACCRUAL',
    rounding: 'cents',
    ...over,
  };
}

function ctx(): EngineContext {
  // RLS reads as the member; the governed RPCs on the service role (EXECUTE is revoked from members).
  return { supabase: pgSupabase(db), orgId: t.org, userId: SUB, service: serviceClient(db) };
}

async function run(r: ReportRequest, sub = SUB): Promise<ReportResult> {
  return asMember(db, t.org, sub, () => runReport({ ...ctx(), userId: sub }, r));
}

/** Independent check: Σ(debit − credit) of POSTED lines (non-closing unless asked). */
async function glNet(opts: { accounts: string[]; companies?: string[]; from?: string | null; to: string; kinds?: string[] }): Promise<number> {
  const r = await db.query<{ n: string | null }>(
    `select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint as n
       from public.gl_entry_lines l join public.gl_entries e on e.id = l.gl_entry_id
      where e.status = 'POSTED' and l.org_id = $1 and l.account_id = any($2::uuid[])
        and ($3::uuid[] is null or l.location_id = any($3::uuid[]))
        and ($4::date is null or e.entry_date >= $4::date) and e.entry_date <= $5::date
        and public.pb_entry_kind(e.entry_type::text) = any($6::text[])`,
    [t.org, opts.accounts, opts.companies ?? null, opts.from ?? null, opts.to, opts.kinds ?? ['STANDARD', 'ADJUSTING']],
  );
  return Number(r.rows[0].n ?? 0);
}

const col = (r: ReportResult, id: string) => r.columns.findIndex((c) => c.id === id);
const row = (r: ReportResult, id: string): ReportRow => {
  const x = r.rows.find((y) => y.id === id);
  if (!x) throw new Error(`row ${id} not found in ${r.rows.map((y) => y.id).join(',')}`);
  return x;
};
const acctRow = (r: ReportResult, accountId: string): ReportRow => {
  const x = r.rows.find((y) => y.accountId === accountId && y.kind === 'account');
  if (!x) throw new Error(`account row ${accountId} not found`);
  return x;
};

beforeAll(async () => {
  // The adapter installs 3D governance (Clerk-backed audience probe). These suites test the
  // engine itself; the in-group window path is exercised with an explicit stub below.
  registerGovernance(null);
  registerMembership(null);
  registerDrillGovernance(null);
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  // consumers that build their own engine context (3E flux, 3B metrics) reach the service role here
  setEngineServiceClientForTests(() => serviceClient(db));
  t = await seedReportTenant(db, { slug: 'eng', companies: 3, months: monthRange('2025-01', 24) });
  [A, B, C] = t.companies;
  await db.query(`select core.rbac_provision_tenant($1)`, [t.org]);
  // controller with all-clients access + a bookkeeper scoped to company A only
  const role = await db.query<{ id: string }>(
    `select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and max_assignment_days is null
       and audience = 'internal_staff' and status = 'active' order by key limit 1`, [t.org]);
  for (const [sub, scope] of [[SUB, 'all'], ['user_engine_bk', 'A']] as const) {
    const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [sub]);
    const m = await db.query<{ id: string }>(`insert into core.memberships (user_id, org_id, role) values ($1, $2, $3) returning id`, [u.rows[0].id, t.org, scope === 'all' ? 'owner' : 'accounting_specialist']);
    await db.query(
      `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, effective_from)
       values ($1, $2, 'role', $3, $4, $5, now() - interval '30 days')`,
      [t.org, m.rows[0].id, role.rows[0].id, scope === 'all' ? 'all_clients' : 'client', scope === 'all' ? null : A],
    );
  }

  const a = t.acct;
  // opening capital + equipment + loan
  await postEntry(db, t, { location: A, date: '2025-01-02', lines: [{ account: a.cash, debit: 10_000_000 }, { account: a.capital, credit: 10_000_000 }] });
  await postEntry(db, t, { location: B, date: '2025-01-02', lines: [{ account: a.cash, debit: 5_000_000 }, { account: a.capital, credit: 5_000_000 }] });
  await postEntry(db, t, { location: C, date: '2025-01-02', lines: [{ account: a.cash, debit: 2_000_000 }, { account: a.capital, credit: 2_000_000 }] });
  await postEntry(db, t, { location: A, date: '2025-01-05', lines: [{ account: a.fixed, debit: 2_400_000 }, { account: a.cash, credit: 2_400_000 }] });
  await postEntry(db, t, { location: B, date: '2025-02-01', lines: [{ account: a.cash, debit: 3_000_000 }, { account: a.loan, credit: 3_000_000 }] });
  // monthly operations for 24 months
  for (const ym of monthRange('2025-01', 24)) {
    for (const [i, loc] of [A, B, C].entries()) {
      const rev = 1_000_000 + i * 250_000;
      await postEntry(db, t, {
        location: loc, date: `${ym}-10`,
        lines: [
          { account: a.ar, debit: rev },
          { account: a.revenue, credit: Math.round(rev * 0.6), department: t.depts[0], classId: t.classes[0] },
          { account: a.revenue, credit: rev - Math.round(rev * 0.6), department: t.depts[1], classId: t.classes[1] },
        ],
      });
      await postEntry(db, t, { location: loc, date: `${ym}-20`, lines: [{ account: a.cash, debit: rev - 100_000 }, { account: a.ar, credit: rev - 100_000 }] });
      await postEntry(db, t, {
        location: loc, date: `${ym}-25`,
        lines: [
          { account: a.cogs, debit: 400_000, department: t.depts[0] },
          { account: a.rent, debit: 150_000 },
          { account: a.wages, debit: 250_000, department: t.depts[1] },
          { account: a.cash, credit: 700_000 },
          { account: a.ap, credit: 100_000 },
        ],
      });
    }
    await postEntry(db, t, { location: A, date: `${ym}-28`, lines: [{ account: a.depExp, debit: 40_000 }, { account: a.accDep, credit: 40_000 }] });
    await postEntry(db, t, { location: B, date: `${ym}-28`, lines: [{ account: a.interest, debit: 15_000 }, { account: a.loan, debit: 50_000 }, { account: a.cash, credit: 65_000 }] });
    // interdepartment service inside A (eliminating pair)
    await postEntry(db, t, { location: A, date: `${ym}-15`, lines: [{ account: a.interdeptCost, debit: 30_000, department: t.depts[1] }, { account: a.interdeptRev, credit: 30_000, department: t.depts[0] }] });
  }
  // intercompany funding A → B (both legs carry the counterparty)
  await postEntry(db, t, {
    location: A, date: '2026-02-03',
    lines: [
      { account: a.icAr, debit: 750_000, location: A, counterparty: B },
      { account: a.cash, credit: 750_000, location: A },
      { account: a.cash, debit: 750_000, location: B },
      { account: a.icAp, credit: 750_000, location: B, counterparty: A },
    ],
  });
  // an ADJUSTING accrual and an MTD-split pair in March 2026
  await postEntry(db, t, { location: A, date: '2026-03-31', entryType: 'ADJUSTING', lines: [{ account: a.rent, debit: 20_000 }, { account: a.ap, credit: 20_000 }] });
  await postEntry(db, t, { location: A, date: '2026-03-12', lines: [{ account: a.cash, debit: 7_777 }, { account: a.otherInc, credit: 7_777 }] });
  await postEntry(db, t, { location: A, date: '2026-03-22', lines: [{ account: a.cash, debit: 3_333 }, { account: a.otherInc, credit: 3_333 }] });
  // year-end close of 2025 for company A: zero A's 2025 P&L into retained earnings
  const pnl = [a.revenue, a.interdeptRev, a.cogs, a.interdeptCost, a.rent, a.wages, a.depExp, a.interest, a.otherInc];
  const closeLines: Array<{ account: string; debit?: number; credit?: number }> = [];
  let netDr = 0;
  for (const acct of pnl) {
    const n = await glNet({ accounts: [acct], companies: [A], from: '2025-01-01', to: '2025-12-31' });
    if (n === 0) continue;
    closeLines.push(n > 0 ? { account: acct, credit: n } : { account: acct, debit: -n });
    netDr += n;
  }
  closeLines.push(netDr > 0 ? { account: a.re, debit: netDr } : { account: a.re, credit: -netDr });
  await postEntry(db, t, { location: A, date: '2025-12-31', entryType: 'CLOSING', lines: closeLines });
  // 2025 hard-closed for every company (after posting)
  await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where org_id = $1 and period_year = 2025`, [t.org]);
  // 2026 budget for A revenue (natural, credit-positive): 1,100,000 per month
  for (let m = 1; m <= 12; m++) {
    await db.query(
      `insert into public.budgets (org_id, location_id, account_id, fiscal_year, period_number, amount_cents) values ($1, $2, $3, 2026, $4, 1100000)`,
      [t.org, A, a.revenue, m],
    );
  }
}, 300_000);

afterAll(async () => {
  setEngineServiceClientForTests(null);
  await db?.close();
});

describe('report engine — statements tie to the ledger', () => {
  it('income statement (one company, FY2026 H1) = independent GL sums; subtotals tie', async () => {
    const r = await run(req({ scope: { companyIds: [A] }, period: { preset: 'custom', asOf: '2026-06-30', start: '2026-01-01', end: '2026-06-30' } }));
    const i = col(r, 'cur');
    const rev = -(await glNet({ accounts: [t.acct.revenue, t.acct.interdeptRev], companies: [A], from: '2026-01-01', to: '2026-06-30' }));
    expect(row(r, 'rev').values[i]).toBe(rev);
    const allPnl = Object.entries(t.acct).filter(([k]) => ['revenue', 'interdeptRev', 'cogs', 'interdeptCost', 'rent', 'wages', 'depExp', 'interest', 'otherInc'].includes(k)).map(([, v]) => v);
    const ni = -(await glNet({ accounts: allPnl, companies: [A], from: '2026-01-01', to: '2026-06-30' }));
    expect(row(r, 'ni').values[i]).toBe(ni);
    expect(row(r, 'gp').values[i]).toBe((row(r, 'rev').values[i] ?? 0) - (row(r, 'cogs').values[i] ?? 0));
    expect(tieViolations(r.columns, r.rows)).toEqual([]);
    expect(r.warnings.filter((w) => w.code === 'OUT_OF_BALANCE')).toEqual([]);
  });

  it('closing entries are excluded from P&L activity (a closed year is not zeroed)', async () => {
    const r = await run(req({ scope: { companyIds: [A] }, period: { preset: 'year', asOf: '2025-06-30' } }));
    const rev = -(await glNet({ accounts: [t.acct.revenue, t.acct.interdeptRev], companies: [A], from: '2025-01-01', to: '2025-12-31' }));
    expect(rev).toBeGreaterThan(0);
    expect(row(r, 'rev').values[col(r, 'cur')]).toBe(rev);
    expect(r.columns[col(r, 'cur')].status).toBe('final');
  });

  it('balance sheet balances (A = L + E incl. earnings not yet closed) for every company and combined', async () => {
    const r = await run(req({ statement: 'balance_sheet', period: { preset: 'month', asOf: '2026-06-30' }, columns: 'company' }));
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    const total = col(r, 'total');
    const cashBs = await glNet({ accounts: [t.acct.cash], to: '2026-06-30', kinds: ['STANDARD', 'ADJUSTING', 'CLOSING'] });
    expect(acctRow(r, t.acct.cash).values[total]).toBe(cashBs);
    // A closed 2025: its prior unclosed earnings are 0 and retained earnings carry them
    const aIdx = col(r, `co:${A}`);
    const reRow = r.rows.find((x) => x.id.endsWith(':a:__re_prior'))!;
    expect(reRow.values[aIdx]).toBe(0);
    expect(reRow.values[col(r, `co:${B}`)]).toBeGreaterThan(0);
  });

  it('cash flow (indirect) for MANY companies ties ending cash to the balance sheet', async () => {
    const r = await run(req({ statement: 'cash_flow', period: { preset: 'quarter', asOf: '2026-03-31' }, columns: 'month' }));
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    const i = col(r, 'b2'); // March 2026
    expect(r.columns.map((c) => c.id)).toEqual(['b0', 'b1', 'b2', 'total']);
    const end = row(r, 'end').values[i];
    expect(end).toBe(await glNet({ accounts: [t.acct.cash], to: r.columns[i].range.end, kinds: ['STANDARD', 'ADJUSTING', 'CLOSING'] }));
    const net = row(r, 'net').values[i];
    const before = await glNet({ accounts: [t.acct.cash], to: '2026-02-28', kinds: ['STANDARD', 'ADJUSTING', 'CLOSING'] });
    expect(net).toBe((end ?? 0) - before);
    const q = col(r, 'total');
    expect(row(r, 'net').values[q]).toBe((end ?? 0) - (await glNet({ accounts: [t.acct.cash], to: '2025-12-31', kinds: ['STANDARD', 'ADJUSTING', 'CLOSING'] })));
    // depreciation is an add-back (non-cash), the loan is financing
    expect(r.rows.some((x) => x.id === `adj:${t.acct.accDep}`)).toBe(true);
    expect(r.rows.some((x) => x.id === `fin:${t.acct.loan}`)).toBe(true);
    expect(tieViolations(r.columns, r.rows)).toEqual([]);
  });

  it('consolidation: companies → Combined → Eliminations → Consolidated; eliminations are explicit and the BS still balances', async () => {
    const bs = await run(req({ statement: 'balance_sheet', period: { preset: 'month', asOf: '2026-03-31' }, columns: 'company', scope: { companyIds: [], consolidate: true } }));
    const elim = col(bs, 'elim');
    const consol = col(bs, 'consol');
    expect(elim).toBeGreaterThan(0);
    expect(acctRow(bs, t.acct.icAr).values[elim]).toBe(-750_000);
    expect(r0(acctRow(bs, t.acct.icAr).values[consol])).toBe(0);
    expect(r0(acctRow(bs, t.acct.icAp).values[consol])).toBe(0);
    expect(bs.checks.every((c) => c.ok)).toBe(true);
    const pl = await run(req({ period: { preset: 'year', asOf: '2026-03-31' }, columns: 'company', scope: { companyIds: [], consolidate: true } }));
    const pc = col(pl, 'consol');
    expect(r0(acctRow(pl, t.acct.interdeptRev).values[pc])).toBe(0);
    expect(r0(acctRow(pl, t.acct.interdeptCost).values[pc])).toBe(0);
    // eliminations do not change consolidated net income (the interdept pair matches)
    expect(row(pl, 'ni').values[pc]).toBe(row(pl, 'ni').values[col(pl, 'combined')]);
    expect(tieViolations(pl.columns, pl.rows)).toEqual([]);
  });

  it('comparisons: prior year, budget, $ / % variance with F/U by account type', async () => {
    const r = await run(req({ scope: { companyIds: [A] }, period: { preset: 'quarter', asOf: '2026-03-31' }, compare: ['prior_year', 'budget'] }));
    const cur = col(r, 'cur');
    const py = col(r, 'cur~prior_year');
    const bud = col(r, 'cur~budget');
    const dVar = col(r, 'cur~budget~d');
    const pVar = col(r, 'cur~budget~p');
    const rev = row(r, 'rev');
    expect(rev.values[py]).toBe(-(await glNet({ accounts: [t.acct.revenue, t.acct.interdeptRev], companies: [A], from: '2025-01-01', to: '2025-03-31' })));
    expect(rev.values[bud]).toBe(3_300_000);
    expect(rev.values[dVar]).toBe((rev.values[cur] ?? 0) - 3_300_000);
    expect(rev.values[pVar]).toBe(Math.round((((rev.values[cur] ?? 0) - 3_300_000) / 3_300_000) * 1000) / 10);
    expect(rev.fu?.[dVar]).toBe((rev.values[dVar] ?? 0) > 0 ? 'F' : 'U');
    // margins compare in points
    const gm = row(r, 'gm');
    expect(gm.percent).toBe(true);
    expect(gm.values[col(r, 'cur~prior_year~p')]).toBeNull();
  });

  it('P&L by month: 24 columns + Total + TTM; Total = Σ months and TTM = last 12, to the cent', async () => {
    const r = await run(req({ period: { preset: 'custom', asOf: '2026-12-31', start: '2025-01-01', end: '2026-12-31' }, columns: 'month', ttmColumn: true }));
    const months = r.columns.filter((c) => c.id.startsWith('b'));
    expect(months).toHaveLength(24);
    for (const id of ['rev', 'cogs', 'opex', 'ni']) {
      const x = row(r, id);
      const sum = months.reduce((s, c) => s + (x.values[col(r, c.id)] ?? 0), 0);
      expect(x.values[col(r, 'total')]).toBe(sum);
      const last12 = months.slice(-12).reduce((s, c) => s + (x.values[col(r, c.id)] ?? 0), 0);
      expect(x.values[col(r, 'ttm')]).toBe(last12);
    }
    expect(r.chartSeries.find((s) => s.rowId === 'rev')?.points).toHaveLength(24);
  });

  it('P&L by department / class: real dimension columns; Σ columns + Unassigned = Total', async () => {
    for (const mode of ['department', 'class'] as const) {
      const r = await run(req({ period: { preset: 'year', asOf: '2026-06-30' }, columns: mode }));
      const dimCols = r.columns.filter((c) => c.id.startsWith('dim:'));
      expect(dimCols.length).toBe(3);
      for (const id of ['rev', 'cogs', 'opex', 'ni']) {
        const x = row(r, id);
        expect(dimCols.reduce((s, c) => s + (x.values[col(r, c.id)] ?? 0), 0)).toBe(x.values[col(r, 'total')]);
      }
      const ops = row(r, 'rev').values[col(r, `dim:${t.depts[0]}`)] ?? 0;
      const sales = row(r, 'rev').values[col(r, `dim:${t.depts[1]}`)] ?? 0;
      if (mode === 'department') expect(ops).toBeGreaterThan(sales);
    }
  });

  it('common-size: revenue is 100% and every line is its share of revenue', async () => {
    const r = await run(req({ scope: { companyIds: [B] }, period: { preset: 'month', asOf: '2026-04-30' }, commonSize: true }));
    const cs = col(r, 'cur~cs');
    expect(row(r, 'rev').values[cs]).toBe(100);
    const cur = col(r, 'cur');
    expect(row(r, 'ni').values[cs]).toBe(Math.round(((row(r, 'ni').values[cur] ?? 0) / (row(r, 'rev').values[cur] ?? 1)) * 1000) / 10);
  });

  it('MTD (a range that cuts a month) reads exact dates', async () => {
    const r = await run(req({ scope: { companyIds: [A] }, period: { preset: 'mtd', asOf: '2026-03-15' } }));
    expect(acctRow(r, t.acct.otherInc).values[col(r, 'cur')]).toBe(7_777);
  });

  it('trial balance worksheet: unadjusted + adjustments = adjusted; debits = credits in every pair', async () => {
    const r = await run(req({ statement: 'trial_balance', period: { preset: 'month', asOf: '2026-03-31' }, scope: { companyIds: [A] } }));
    expect(r.checks).toHaveLength(3);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    const rent = acctRow(r, t.acct.rent);
    const [, , ajDr, , adDr] = rent.values as number[];
    expect(ajDr).toBe(20_000);
    expect(adDr).toBe(await glNet({ accounts: [t.acct.rent], companies: [A], from: '2026-01-01', to: '2026-03-31', kinds: ['STANDARD', 'ADJUSTING', 'CLOSING'] }));
  });

  it('statement of changes in equity ties to balance-sheet equity', async () => {
    const eq = await run(req({ statement: 'equity_changes', period: { preset: 'year', asOf: '2025-12-31' } }));
    const bs = await run(req({ statement: 'balance_sheet', period: { preset: 'month', asOf: '2025-12-31' } }));
    expect(row(eq, 'eq_total').values[4]).toBe(row(bs, 'eq').values[col(bs, 'cur')]);
    expect(eq.warnings.filter((w) => w.code === 'OUT_OF_BALANCE')).toEqual([]);
  });

  it('GL summary: Σ debits = Σ credits; opening + net change = closing', async () => {
    const r = await run(req({ statement: 'gl_summary', period: { preset: 'month', asOf: '2026-02-28' } }));
    const total = row(r, 'gl_total');
    expect(total.values[1]).toBe(total.values[2]);
    for (const x of r.rows.filter((y) => y.kind === 'account')) expect((x.values[0] ?? 0) + (x.values[3] ?? 0)).toBe(x.values[4]);
  });
});

function r0(v: number | null | undefined): number {
  return v ?? 0;
}

describe('in-group windows (pre-acquisition exclusion, 3D membership)', () => {
  const CASH_KINDS = ['STANDARD', 'ADJUSTING', 'CLOSING'];
  const drillOf = async (x: ReportRow, r: ReportResult, i: number) => {
    const scope = x.cellDrill?.[i] ?? r.columns[i].drill!;
    const d = await asMember(db, t.org, SUB, () => runDrill(ctx(), { accountIds: x.accountIds!, companyIds: scope.companyIds, range: scope.range, dims: scope.dims, kinds: scope.kinds, windows: scope.windows, limit: 1000 }));
    return (x.drillSign ?? 1) * d.netCents;
  };
  beforeAll(() => {
    // B joins the group on 1 Feb 2026 (combined scopes only — a single company sees its own books)
    registerMembership(async (m) => (m.scopeKind === 'company' ? null : { [B]: { from: '2026-02-01', until: null } }));
  });
  afterAll(() => registerMembership(null));

  it('P&L leaves the joining company out before it joined; the drill reproduces the cell', async () => {
    const r = await run(req({ period: { preset: 'custom', asOf: '2026-06-30', start: '2026-01-01', end: '2026-06-30' } }));
    const i = col(r, 'cur');
    const rev = [t.acct.revenue, t.acct.interdeptRev];
    const expected = -((await glNet({ accounts: rev, companies: [A, C], from: '2026-01-01', to: '2026-06-30' })) + (await glNet({ accounts: rev, companies: [B], from: '2026-02-01', to: '2026-06-30' })));
    expect(row(r, 'rev').values[i]).toBe(expected);
    expect(r.groupWindowCompanyIds).toEqual([B]);
    expect(r.columns[i].drill?.windows?.[B]).toEqual({ from: '2026-02-01', to: null });
    for (const id of ['rev', 'opex', 'ni']) expect(await drillOf(row(r, id), r, i)).toBe(row(r, id).values[i]);
    expect(tieViolations(r.columns, r.rows)).toEqual([]);
    // one company alone is not windowed
    const solo = await run(req({ scope: { companyIds: [B] }, period: { preset: 'month', asOf: '2026-01-31' } }));
    expect(row(solo, 'rev').values[col(solo, 'cur')]).toBeGreaterThan(0);
  });

  it('balance sheet: out before joining, whole afterwards; balances; pre-joining earnings sit in prior equity', async () => {
    const jan = await run(req({ statement: 'balance_sheet', period: { preset: 'month', asOf: '2026-01-31' } }));
    expect(acctRow(jan, t.acct.cash).values[col(jan, 'cur')]).toBe(await glNet({ accounts: [t.acct.cash], companies: [A, C], to: '2026-01-31', kinds: CASH_KINDS }));
    expect(jan.checks.every((c) => c.ok)).toBe(true);
    const jun = await run(req({ statement: 'balance_sheet', period: { preset: 'month', asOf: '2026-06-30' } }));
    const i = col(jun, 'cur');
    expect(jun.checks.every((c) => c.ok)).toBe(true);
    expect(acctRow(jun, t.acct.cash).values[i]).toBe(await glNet({ accounts: [t.acct.cash], to: '2026-06-30', kinds: CASH_KINDS }));
    const pl = await run(req({ period: { preset: 'custom', asOf: '2026-06-30', start: '2026-01-01', end: '2026-06-30' } }));
    const ni = jun.rows.find((x) => x.id.endsWith('__ni_current'))!;
    const prior = jun.rows.find((x) => x.id.endsWith('__re_prior'))!;
    expect(ni.values[i]).toBe(row(pl, 'ni').values[col(pl, 'cur')]);
    expect(await drillOf(ni, jun, i)).toBe(ni.values[i]);
    expect(await drillOf(prior, jun, i)).toBe(prior.values[i]);
    expect(jun.notes.some((n) => n.includes('joined the group this fiscal year'))).toBe(true);
  });

  it('cash flow shows the cash a company brought in and still ties to the balance sheet', async () => {
    const r = await run(req({ statement: 'cash_flow', period: { preset: 'quarter', asOf: '2026-03-31' }, columns: 'month' }));
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    const g = row(r, 'inv:group_change');
    expect(g.values[col(r, 'b0')]).toBe(0);
    expect(g.values[col(r, 'b1')]).toBe(await glNet({ accounts: [t.acct.cash], companies: [B], to: '2026-01-31', kinds: CASH_KINDS }));
    expect(g.values[col(r, 'total')]).toBe(g.values[col(r, 'b1')]);
    expect(row(r, 'beg').values[col(r, 'b0')]).toBe(await glNet({ accounts: [t.acct.cash], companies: [A, C], to: '2025-12-31', kinds: CASH_KINDS }));
    expect(tieViolations(r.columns, r.rows)).toEqual([]);
  });

  it('statement of changes in equity carries a joining column and still ties per row and to the BS', async () => {
    const eq = await run(req({ statement: 'equity_changes', period: { preset: 'quarter', asOf: '2026-03-31' } }));
    expect(eq.columns.map((c) => c.id)).toEqual(['beg', 'grp', 'act', 'ni', 'cls', 'end']);
    expect(eq.warnings.filter((w) => w.code === 'OUT_OF_BALANCE')).toEqual([]);
    const bs = await run(req({ statement: 'balance_sheet', period: { preset: 'month', asOf: '2026-03-31' } }));
    expect(row(eq, 'eq_total').values[5]).toBe(row(bs, 'eq').values[col(bs, 'cur')]);
    expect(row(eq, 'eq_total').values[1]).not.toBe(0);
  });

  it('trial balance and GL summary are ledger tools and stay unwindowed', async () => {
    const tb = await run(req({ statement: 'trial_balance', period: { preset: 'month', asOf: '2026-01-31' } }));
    expect(tb.groupWindowCompanyIds).toEqual([]);
    expect(tb.checks.every((c) => c.ok)).toBe(true);
  });
});

describe('Wave 3 consumers read the balances store', () => {
  it('3E flux: ending balances per company → account equal the ledger', async () => {
    const src = periodBalanceFluxSource(pgSupabase(db), t.org);
    const m = await asMember(db, t.org, SUB, () => src.balances({ locationIds: [A, B], asOfDate: '2026-03-31' }));
    for (const [loc, acct] of [[A, t.acct.cash], [B, t.acct.loan], [A, t.acct.revenue]] as const) {
      expect(m.get(loc)?.get(acct) ?? 0).toBe(await glNet({ accounts: [acct], companies: [loc], to: '2026-03-31', kinds: ['STANDARD', 'ADJUSTING', 'CLOSING'] }));
    }
  });

  it('3B metrics: the engine-fed source produces the revenue series the ledger has', async () => {
    // finance reader (metrics are governed: a non-finance reader only sees released months)
    const source = createMetricSource(ctx(), { today: '2026-10-24', governance: { probe: { has: async () => true } } });
    const ds = await asMember(db, t.org, SUB, () => source.load({ companyIds: [A], from: '2026-01', to: '2026-03', needsBudget: false, operational: [], customerRevenue: false, vendorSpend: false }));
    expect(ds.source).toBe('period-balances-3a');
    expect(ds.companies).toHaveLength(1);
    const feb = ds.companies[0].gl.revenue?.months['2026-02'] ?? 0;
    expect(feb).toBe(-(await glNet({ accounts: [t.acct.revenue, t.acct.interdeptRev], companies: [A], from: '2026-02-01', to: '2026-02-28' })));
  });

  it('store-unavailable detection only matches a missing store RPC', () => {
    expect(isStoreUnavailable(new Error('report_balances: function public.report_balances(jsonb) does not exist'))).toBe(true);
    expect(isStoreUnavailable(new Error('report_balances: Could not find the function public.report_balances in the schema cache'))).toBe(true);
    expect(isStoreUnavailable(new Error('report_balances: permission denied'))).toBe(false);
    expect(isStoreUnavailable(new Error('relation "foo" does not exist'))).toBe(false);
  });
});

describe('drill reproduces the cell exactly', () => {
  it('account, group and section cells (P&L) and a balance-sheet cell', async () => {
    const r = await run(req({ period: { preset: 'quarter', asOf: '2026-06-30' }, columns: 'company' }));
    const ci = col(r, `co:${B}`);
    const c = r.columns[ci];
    for (const x of [acctRow(r, t.acct.wages), row(r, 'opex'), row(r, 'rev'), row(r, 'gp'), row(r, 'op'), row(r, 'ni'), r.rows.find((y) => y.kind === 'group')!]) {
      expect(x.accountIds?.length ?? 0).toBeGreaterThan(0); // subtotals drill too (same debit-sign terms)
      const scope = x.cellDrill?.[ci] ?? c.drill!;
      const d = await asMember(db, t.org, SUB, () => runDrill(ctx(), { accountIds: x.accountIds!, companyIds: scope.companyIds, range: scope.range, dims: scope.dims, kinds: scope.kinds, limit: 1000 }));
      expect((x.drillSign ?? 1) * d.netCents).toBe(x.values[ci]);
    }
    const bs = await run(req({ statement: 'balance_sheet', period: { preset: 'month', asOf: '2026-05-31' }, scope: { companyIds: [C] } }));
    const cash = acctRow(bs, t.acct.cash);
    const bc = bs.columns[col(bs, 'cur')].drill!;
    const d = await asMember(db, t.org, SUB, () => runDrill(ctx(), { accountIds: cash.accountIds!, companyIds: bc.companyIds, range: bc.range, kinds: bc.kinds }));
    expect(d.netCents).toBe(cash.values[col(bs, 'cur')]);
    const ta = row(bs, 'ta');
    const dt = await asMember(db, t.org, SUB, () => runDrill(ctx(), { accountIds: ta.accountIds!, companyIds: bc.companyIds, range: bc.range, kinds: bc.kinds, limit: 1000 }));
    expect((ta.drillSign ?? 1) * dt.netCents).toBe(ta.values[col(bs, 'cur')]);
  });

  it('department column drill uses the dimension filter (Unassigned = IS NULL)', async () => {
    const r = await run(req({ period: { preset: 'month', asOf: '2026-05-31' }, columns: 'department' }));
    for (const id of [`dim:${t.depts[1]}`, 'dim:none']) {
      const ci = col(r, id);
      const sc = r.columns[ci].drill!;
      const x = row(r, 'opex');
      const d = await asMember(db, t.org, SUB, () => runDrill(ctx(), { accountIds: x.accountIds!, companyIds: sc.companyIds, range: sc.range, dims: sc.dims, kinds: sc.kinds }));
      expect(d.netCents).toBe(x.values[ci]);
    }
  });

  it('paginates without losing lines (totals cover the whole set; running balance is continuous)', async () => {
    const all = await asMember(db, t.org, SUB, () => runDrill(ctx(), { accountIds: [t.acct.cash], companyIds: [A], range: { start: null, end: '2026-12-31' }, limit: 1000 }));
    const p1 = await asMember(db, t.org, SUB, () => runDrill(ctx(), { accountIds: [t.acct.cash], companyIds: [A], range: { start: null, end: '2026-12-31' }, limit: 10, offset: 0 }));
    const p2 = await asMember(db, t.org, SUB, () => runDrill(ctx(), { accountIds: [t.acct.cash], companyIds: [A], range: { start: null, end: '2026-12-31' }, limit: 10, offset: 10 }));
    expect(p1.totalCount).toBe(all.totalCount);
    expect(p1.netCents).toBe(all.netCents);
    expect(all.totalCount).toBeGreaterThan(20);
    expect(p2.lines[0].runningNetCents).toBe(p1.lines[9].runningNetCents + p2.lines[0].debitCents - p2.lines[0].creditCents);
    expect(all.lines[all.lines.length - 1].runningNetCents).toBe(all.netCents);
    expect(all.lines[0].entryHref).toMatch(/^\/journal-entries\?id=/);
  });
});

describe('store tie-out + client scope', () => {
  it('period-balance tie-out is clean after every post / void in the fixture', async () => {
    const res = await asMember(db, t.org, SUB, () => runTieOut(ctx()));
    expect(res.tied).toBe(true);
  });

  it('a client-scoped user cannot include an out-of-scope company (enforce)', async () => {
    await db.query(`update core.organizations set client_scope_rls_mode = 'enforce' where id = $1`, [t.org]);
    try {
      await expect(run(req({ scope: { companyIds: [B] } }), 'user_engine_bk')).rejects.toBeInstanceOf(EngineScopeError);
      await expect(run(req({ scope: { companyIds: [A, B] } }), 'user_engine_bk')).rejects.toBeInstanceOf(EngineScopeError);
      // "all companies" resolves to the user's scope only — and the figures match company A alone
      const mine = await run(req({ period: { preset: 'year', asOf: '2026-06-30' } }), 'user_engine_bk');
      expect(mine.companies.map((c) => c.id)).toEqual([A]);
      const onlyA = await run(req({ scope: { companyIds: [A] }, period: { preset: 'year', asOf: '2026-06-30' } }));
      expect(row(mine, 'ni').values[0]).toBe(row(onlyA, 'ni').values[0]);
      await expect(asMember(db, t.org, 'user_engine_bk', () => runDrill({ ...ctx(), userId: 'user_engine_bk' }, { accountIds: [t.acct.cash], companyIds: [B], range: { start: null, end: '2026-12-31' } }))).rejects.toBeInstanceOf(EngineScopeError);
      // the service-role balance read is scope-checked first: an out-of-scope company is refused,
      // and "all" (empty) resolves to the caller's scope — never to every company in the org
      await expect(asMember(db, t.org, 'user_engine_bk', () => loadBalances(pgSupabase(db), t.org, { companyIds: [B], from: null, to: '2026-03-31' }))).rejects.toBeInstanceOf(EngineScopeError);
      const rows = await asMember(db, t.org, 'user_engine_bk', () => loadBalances(pgSupabase(db), t.org, { companyIds: [], from: null, to: '2026-03-31' }));
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.companyId))).toEqual(new Set([A]));
      // the tie-out (service role over the whole org) only reports companies in the caller's scope
      await db.query(`update public.period_balances set debit_cents = debit_cents + 1 where org_id = $1 and location_id = $2 and account_id = $3`, [t.org, B, t.acct.cash]);
      try {
        const bk = await asMember(db, t.org, 'user_engine_bk', () => runTieOut({ ...ctx(), userId: 'user_engine_bk' }));
        expect(bk.mismatches.some((m) => m.companyId === B)).toBe(false);
        const ctl = await asMember(db, t.org, SUB, () => runTieOut(ctx()));
        expect(ctl.mismatches.some((m) => m.companyId === B)).toBe(true);
      } finally {
        await db.query(`select public.rebuild_period_balances($1)`, [t.org]);
      }
    } finally {
      await db.query(`update core.organizations set client_scope_rls_mode = 'off' where id = $1`, [t.org]);
    }
  });
});

describe('custom row designer layout', () => {
  it('a saved tenant layout renders with subtotals, formulas, sign and an unmapped-accounts warning', async () => {
    const rows = [
      { id: 'sales', kind: 'accounts', label: 'Sales', select: { types: ['REVENUE'], excludeAccountIds: [t.acct.interdeptRev] }, sign: -1, expand: 'none' },
      { id: 'direct', kind: 'accounts', label: 'Direct costs', select: { ranges: [{ from: '5000', to: '5999' }] }, sign: 1, expand: 'accounts' },
      { id: 'contrib', kind: 'subtotal', label: 'Contribution', of: [{ id: 'sales', sign: 1 }, { id: 'direct', sign: -1 }] },
      { id: 'cm', kind: 'formula', label: 'Contribution margin', expr: '{contrib} / {sales} * 100', format: 'percent' },
      { id: 'people', kind: 'accounts', label: 'People', select: { roles: ['WAGES_EXPENSE'] }, sign: 1, expand: 'none' },
    ];
    const ins = await db.query<{ id: string }>(
      `insert into public.report_layouts (org_id, name, statement, rows) values ($1, 'Contribution view', 'PNL', $2::jsonb) returning id`,
      [t.org, JSON.stringify(rows)],
    );
    const r = await run(req({ scope: { companyIds: [A] }, period: { preset: 'month', asOf: '2026-05-31' }, layout: { kind: 'custom', layoutId: ins.rows[0].id } }));
    const i = col(r, 'cur');
    const sales = row(r, 'sales').values[i] ?? 0;
    const direct = row(r, 'direct').values[i] ?? 0;
    expect(sales).toBe(-(await glNet({ accounts: [t.acct.revenue], companies: [A], from: '2026-05-01', to: '2026-05-31' })));
    expect(row(r, 'contrib').values[i]).toBe(sales - direct);
    expect(row(r, 'cm').values[i]).toBe(Math.round(((sales - direct) / sales) * 1000) / 10);
    expect(r.title).toBe('Contribution view');
    expect(r.warnings.some((w) => w.code === 'UNMAPPED_ACCOUNTS')).toBe(true); // interdept revenue, rent, depreciation…
  });
});

describe('performance (AC3A.16)', () => {
  it('24 months × 10 companies: P&L by month and BS by company each compute in < 3 s', async () => {
    const big = await seedReportTenant(db, { slug: 'eng-perf', companies: 10, months: monthRange('2025-01', 24) });
    const a = big.acct;
    for (const ym of monthRange('2025-01', 24)) {
      for (const loc of big.companies) {
        await postEntry(db, big, { location: loc, date: `${ym}-10`, lines: [{ account: a.cash, debit: 900_000 }, { account: a.revenue, credit: 600_000, department: big.depts[0] }, { account: a.revenue, credit: 300_000, department: big.depts[1] }] });
        await postEntry(db, big, { location: loc, date: `${ym}-20`, lines: [{ account: a.cogs, debit: 300_000 }, { account: a.rent, debit: 100_000 }, { account: a.wages, debit: 200_000 }, { account: a.cash, credit: 600_000 }] });
      }
    }
    const perfCtx: EngineContext = { supabase: pgSupabase(db), orgId: big.org, userId: 'perf' };
    const asBig = <T>(fn: () => Promise<T>) => asMember(db, big.org, 'perf', fn);
    let t0 = performance.now();
    const pnl = await asBig(() => runReport(perfCtx, req({ period: { preset: 'custom', asOf: '2026-12-31', start: '2025-01-01', end: '2026-12-31' }, columns: 'month', ttmColumn: true })));
    const pnlMs = performance.now() - t0;
    t0 = performance.now();
    const bs = await asBig(() => runReport(perfCtx, req({ statement: 'balance_sheet', period: { preset: 'month', asOf: '2026-12-31' }, columns: 'company', compare: ['prior_year'] })));
    const bsMs = performance.now() - t0;
    expect(pnl.columns.filter((c) => c.id.startsWith('b'))).toHaveLength(24);
    expect(row(pnl, 'rev').values[col(pnl, 'total')]).toBe(24 * 10 * 900_000);
    expect(bs.checks.every((c) => c.ok)).toBe(true);
    expect(pnlMs).toBeLessThan(3000);
    expect(bsMs).toBeLessThan(3000);
  }, 120_000);
});

describe('drill governance (3D gate over every month of the range, server-side windows)', () => {
  const partner = { has: async () => false };
  const finance = { has: async (f: string) => f === 'close_mgmt' };
  let audience: { has: (f: 'journal_entries' | 'close_mgmt', a: 'create' | 'manage') => Promise<boolean> } = partner;
  const drillA = (range: { start: string | null; end: string }, windows?: Record<string, { from: string | null; to: string | null }>, companyIds = [A]) =>
    asMember(db, t.org, SUB, () => runDrill(ctx(), { accountIds: [t.acct.cash, t.acct.revenue], companyIds, range, windows, limit: 1000 }));

  beforeAll(async () => {
    registerDrillGovernance((r, c) => governDrillRequest(r, c, { probe: audience }));
  });
  afterAll(async () => {
    registerDrillGovernance(null);
    await db.query(`delete from public.report_releases where org_id = $1`, [t.org]);
    await db.query(`delete from public.report_company_coverage where org_id = $1`, [t.org]);
  });

  it('non-finance: a drill into an unreleased month is refused (403 NOT_RELEASED); finance previews', async () => {
    audience = partner;
    await expect(drillA({ start: '2026-02-01', end: '2026-02-28' })).rejects.toBeInstanceOf(GovernanceDeniedError);
    audience = finance;
    const d = await drillA({ start: '2026-02-01', end: '2026-02-28' });
    expect(d.totalCount).toBeGreaterThan(0);
  });

  it('non-finance: released IN ORDER through the month → allowed; a balance-sheet drill needs the whole history', async () => {
    audience = partner;
    // release A from its first period through Feb 2026, in order
    for (const k of monthRange('2025-01', 14)) {
      const [y, m] = k.split('-').map(Number);
      await db.query(
        `insert into public.report_releases (org_id, location_id, period_year, period_month, status, release_mode, released_at, released_by)
         values ($1, $2, $3, $4, 'RELEASED', 'MANUAL', now(), 'test')`, [t.org, A, y, m]);
    }
    const flow = await drillA({ start: '2026-02-01', end: '2026-02-28' });
    expect(flow.totalCount).toBeGreaterThan(0);
    const bs = await drillA({ start: null, end: '2026-02-28' });
    expect(bs.totalCount).toBeGreaterThan(0);
    // March is not released → refused, and so is an inception drill through March
    await expect(drillA({ start: '2026-03-01', end: '2026-03-31' })).rejects.toBeInstanceOf(GovernanceDeniedError);
    await expect(drillA({ start: null, end: '2026-03-31' })).rejects.toBeInstanceOf(GovernanceDeniedError);
  });

  it('non-finance: in-group windows are applied server-side even when the client sends none', async () => {
    audience = partner;
    for (const k of monthRange('2025-01', 14)) {
      const [y, m] = k.split('-').map(Number);
      await db.query(
        `insert into public.report_releases (org_id, location_id, period_year, period_month, status, release_mode, released_at, released_by)
         values ($1, $2, $3, $4, 'RELEASED', 'MANUAL', now(), 'test') on conflict do nothing`, [t.org, B, y, m]);
    }
    await db.query(`insert into public.report_company_coverage (org_id, location_id, in_group_from) values ($1, $2, '2026-02-01')`, [t.org, B]);
    const range = { start: '2026-01-01', end: '2026-02-28' };
    const d = await drillA(range, undefined, [A, B]);
    expect(d.lines.every((l) => l.companyId !== B || l.entryDate >= '2026-02-01')).toBe(true);
    // a client window can only narrow further, never widen
    const widened = await drillA(range, { [B]: { from: '2025-01-01', to: null } }, [A, B]);
    expect(widened.lines.every((l) => l.companyId !== B || l.entryDate >= '2026-02-01')).toBe(true);
    const narrowed = await drillA(range, { [A]: { from: '2026-02-15', to: null } }, [A, B]);
    expect(narrowed.lines.every((l) => l.companyId !== A || l.entryDate >= '2026-02-15')).toBe(true);
  });
});
