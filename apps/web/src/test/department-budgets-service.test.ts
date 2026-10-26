/**
 * Department budgets (Wave 4B) — the service layer end-to-end against the real schema (PGlite
 * replay incl. migration 189), driven through the supabase-js stand-in:
 *
 *   AC-B13  "start from last year's actuals + x%" ties to the cent and keeps the month shape
 *   AC-B16  department BvA ties to a manual sum of POSTED gl_entry_lines per department × account
 *   AC-B15  all three department bridges tie (start + Σ steps = end)
 *   AC-B17  a department owner sees / changes only their departments
 *   AC-B9…11 submit → approve (never the submitter) → locked; a copy (v2) supersedes on approval
 *   AC-B18  an import lands in a draft version, cents equal to the file; an approved target is refused
 *   AC-B14  a system template applies; a tenant template saves as v1 then v2
 *
 * Security review fixes:
 *   H5      a new version is never published (only approval publishes); closed months are read-only
 *   MEDIUM  approve needs the approve right, only from SUBMITTED / IN_REVIEW, never the maker; lock and
 *           owner assignment are budget-admin acts; owner emails only reach admins
 *   MEDIUM  every id a write references is pinned to the org and the company (service/refs.ts)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { monthRange, postEntry, seedReportTenant, type ReportTenant } from './report-engine-fixture';
import { seedEmployee } from './wave3-db-helpers';
import { decideBudgetAccess } from '@/lib/budgets/scope';
import { loadOwnerEmails, loadOwners, type BudgetCtx } from '@/lib/budgets/service/data';
import { createVersion, transitionVersion, compareVersions } from '@/lib/budgets/service/versions';
import { getGrid, saveCells, applyDriver, writeCells } from '@/lib/budgets/service/lines';
import { getBoard, transitionPlan, setOwner } from '@/lib/budgets/service/plans';
import { getDepartmentView, getDrill } from '@/lib/budgets/service/department-view';
import { applyTemplate, saveTenantTemplate, startFromPriorYear, listTemplates } from '@/lib/budgets/service/templates';
import { addComment, actOnComment } from '@/lib/budgets/service/comments';
import { bridgeTies } from '@/lib/budgets/bridges';
import { ensureDraftTarget } from '@/lib/budgets/route-support';
import { BudgetError, budgetErrorFromDb } from '@/lib/budgets/lifecycle';
import { isWriteScopeError } from '@/lib/db/scoped-writer';
import { parseCsv } from '@/lib/import/csv';
import { foldToPeriods, parseBudgetGrid } from '@/lib/budgets/import';
import type { BudgetVersion } from '@/lib/budgets/types';

let db: PGlite;
let sb: SupabaseClient;
let t: ReportTenant;
let other: ReportTenant;
let A = '';
let B = '';
let OPS = '';
let SALES = '';
let B_ONLY = '';

const CONTROLLER = 'user_controller';
const CFO = 'user_cfo';
const HEAD = 'user_sales_head';
const EDITOR = 'user_fin_editor';

type Kind = 'controller' | 'cfo' | 'head' | 'editor';

/** controller / cfo: finance + approve. editor: finance edit, NO approve. head: owns Sales. */
function ctxFor(userId: string, kind: Kind): BudgetCtx {
  const access = decideBudgetAccess({
    userId,
    viewAllowed: true,
    editAllowed: true,
    approveAllowed: kind === 'cfo' || kind === 'controller',
    financeStaff: kind !== 'head',
    ownedDepartmentIds: kind === 'head' ? [SALES] : [],
  });
  return { orgId: t.org, userId, userName: userId, reader: sb, writer: sb, access };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof BudgetError) return e.code;
    if (isWriteScopeError(e)) return `REFS: ${e.message}`;
    return `other: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Manual GL sum (natural sign) for one department × account × date range — the AC-B16 oracle. */
async function glNatural(account: string, dept: string | null, from: string, to: string, income: boolean): Promise<number> {
  const r = await db.query<{ n: string }>(
    `select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text n
       from public.gl_entry_lines l join public.gl_entries e on e.id = l.gl_entry_id
      where e.status = 'POSTED' and e.location_id = $1 and e.entry_date between $2 and $3
        and l.account_id = $4 and l.department_id is not distinct from $5`,
    [A, from, to, account, dept],
  );
  const net = Number(r.rows[0].n);
  return income ? -net : net;
}

async function lineSum(versionId: string, where = ''): Promise<number> {
  const r = await db.query<{ n: string }>(`select coalesce(sum(amount_cents), 0)::text n from public.budget_version_lines where version_id = $1 ${where}`, [versionId]);
  return Number(r.rows[0].n);
}

async function publishedSum(where = ''): Promise<number> {
  const r = await db.query<{ n: string }>(`select coalesce(sum(amount_cents), 0)::text n from public.budgets where location_id = $1 and fiscal_year = 2026 ${where}`, [A]);
  return Number(r.rows[0].n);
}

/** Owner submits Sales; the CFO submits Operations; the controller approves both (maker ≠ checker). */
async function approveDepartments(versionId: string): Promise<void> {
  const ctl = ctxFor(CONTROLLER, 'controller');
  await transitionPlan(ctxFor(HEAD, 'head'), versionId, SALES, 'submit');
  await transitionPlan(ctl, versionId, SALES, 'approve');
  await transitionPlan(ctxFor(CFO, 'cfo'), versionId, OPS, 'submit');
  await transitionPlan(ctl, versionId, OPS, 'approve');
}

let v1: BudgetVersion;
let v2: BudgetVersion;

beforeAll(async () => {
  ({ db } = await createTestDb());
  sb = pgSupabase(db);
  t = await seedReportTenant(db, { slug: 'bud4b', companies: 2, months: monthRange('2025-01', 24) });
  other = await seedReportTenant(db, { slug: 'bud4b-other', companies: 1, months: ['2026-01'] });
  [A, B] = t.companies;
  [OPS, SALES] = t.depts;
  B_ONLY = (await db.query<{ id: string }>(
    `insert into core.departments (org_id, name, code, location_id) values ($1, 'Company B only', 'BONLY', $2) returning id`, [t.org, B],
  )).rows[0].id;
  await seedEmployee(db, t.org, HEAD, 'manager');
  // FY2025 actuals: Sales sells (revenue) and spends wages + rent; Ops buys materials. Seasonal revenue.
  for (let m = 1; m <= 12; m++) {
    const d = `2025-${String(m).padStart(2, '0')}-15`;
    const rev = 1_000_000 + m * 50_000;
    await postEntry(db, t, { location: A, date: d, lines: [{ account: t.acct.cash, debit: rev }, { account: t.acct.revenue, credit: rev, department: SALES }] });
    await postEntry(db, t, { location: A, date: d, lines: [{ account: t.acct.wages, debit: 400_000, department: SALES }, { account: t.acct.rent, debit: 120_000, department: SALES }, { account: t.acct.cash, credit: 520_000 }] });
    await postEntry(db, t, { location: A, date: d, lines: [{ account: t.acct.cogs, debit: 300_000 + m * 1_000, department: OPS }, { account: t.acct.cash, credit: 300_000 + m * 1_000 }] });
  }
  // FY2026 actuals Jan–Mar (and a DRAFT entry that must not count).
  for (let m = 1; m <= 3; m++) {
    const d = `2026-${String(m).padStart(2, '0')}-10`;
    await postEntry(db, t, { location: A, date: d, lines: [{ account: t.acct.cash, debit: 1_200_000 }, { account: t.acct.revenue, credit: 1_200_000, department: SALES }] });
    await postEntry(db, t, { location: A, date: d, lines: [{ account: t.acct.wages, debit: 450_000, department: SALES }, { account: t.acct.cash, credit: 450_000 }] });
  }
  await postEntry(db, t, { location: A, date: '2026-02-11', status: 'PENDING', lines: [{ account: t.acct.wages, debit: 999_999, department: SALES }, { account: t.acct.cash, credit: 999_999 }] });
  // Jan / Feb 2026 are closed later, once v1 / v2 exist — see "closed months".
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('versions + "last year + x%" (AC-B9 / AC-B13; H5: a new version is never published)', () => {
  it('creates FY2026 v1 from FY2025 actuals + 10%: a draft, not current, nothing published; every row ties', async () => {
    const c = ctxFor(CONTROLLER, 'controller');
    v1 = await createVersion(c, { locationId: A, fiscalYear: 2026, kind: 'BUDGET', start: 'PRIOR_YEAR_ACTUALS', growthBps: 1000 });
    expect(v1.isCurrent).toBe(false);
    expect(v1.status).toBe('DRAFT');
    expect(v1.label).toBe('FY2026 Budget v1');
    const grid = await getGrid(c, v1.id, SALES);
    expect(grid.closedPeriods).toEqual([]);
    const rev = grid.rows.find((r) => r.accountId === t.acct.revenue)!;
    expect(rev.pyActualCents).toBe(12_000_000 + 50_000 * 78);
    expect(rev.totalCents).toBe(Math.round(rev.pyActualCents * 1.1));
    rev.months.forEach((m, i) => expect(Math.abs(m - rev.pyMonths[i] * 1.1)).toBeLessThanOrEqual(1));
    expect(await publishedSum()).toBe(0); // a draft publishes nothing
    const board = await getBoard(c, v1.id, new Date('2026-01-05'));
    expect(board.rows.map((r) => r.departmentName).sort()).toEqual(['Operations', 'Sales']);
    expect(board.rows.find((r) => r.departmentId === SALES)!.status).toBe('DRAFT');
  });

  it('a driver row: headcount × rate from April, previewed then applied, ties', async () => {
    const c = ctxFor(CONTROLLER, 'controller');
    const pre = await applyDriver(c, { versionId: v1.id, departmentId: SALES, accountId: t.acct.wages, method: 'HEADCOUNT_RATE', params: { headcount: 2, monthlyRateCents: 250_000, burdenBps: 2000, startMonth: 4 }, dryRun: true });
    expect(pre.annualCents).toBe(2 * 250_000 * 1.2 * 9);
    const before = (await getGrid(c, v1.id, SALES)).rows.find((r) => r.accountId === t.acct.wages)!.totalCents;
    expect(before).toBe(Math.round(4_800_000 * 1.1));
    await applyDriver(c, { versionId: v1.id, departmentId: SALES, accountId: t.acct.wages, method: 'HEADCOUNT_RATE', params: { headcount: 2, monthlyRateCents: 250_000, burdenBps: 2000, startMonth: 4 } });
    const row = (await getGrid(c, v1.id, SALES)).rows.find((r) => r.accountId === t.acct.wages)!;
    expect(row.totalCents).toBe(5_400_000);
    expect(row.months.slice(0, 3)).toEqual([0, 0, 0]);
    expect(row.driver?.method).toBe('HEADCOUNT_RATE');
  });
});

describe('department-owner scope (AC-B17) and owner assignment (MEDIUM)', () => {
  it('the Sales owner sees only Sales; Operations and company-level lines are refused', async () => {
    const h = ctxFor(HEAD, 'head');
    const board = await getBoard(h, v1.id);
    expect(board.rows.map((r) => r.departmentId)).toEqual([SALES]);
    expect(board.companyLevel).toBeNull();
    expect(await code(getGrid(h, v1.id, OPS))).toBe('SCOPE');
    expect(await code(getGrid(h, v1.id, null))).toBe('SCOPE');
    expect(await code(saveCells(h, v1.id, OPS, [{ accountId: t.acct.cogs, periodNumber: 1, amountCents: 1 }], 'MANUAL'))).toBe('SCOPE');
    expect(await code(getDepartmentView(h, { locationId: A, fiscalYear: 2026, month: 3, window: 'YTD', departmentId: OPS }))).toBe('SCOPE');
    expect(await code(createVersion(h, { locationId: A, fiscalYear: 2026, kind: 'BUDGET', start: 'BLANK' }))).toBe('SCOPE');
    expect(await code(saveCells(h, v1.id, SALES, [{ accountId: t.acct.rent, periodNumber: 1, amountCents: 130_000 }], 'MANUAL'))).toBe('ok');
  });

  it('only a budget admin assigns owners, only an active org member, only this company’s departments', async () => {
    const ctl = ctxFor(CONTROLLER, 'controller');
    expect(await code(setOwner(ctxFor(EDITOR, 'editor'), SALES, A, { userId: HEAD, name: 'Sam Sales' }))).toBe('SCOPE');
    expect(await code(setOwner(ctxFor(HEAD, 'head'), SALES, A, { userId: HEAD, name: 'Sam Sales' }))).toBe('SCOPE');
    expect(await code(setOwner(ctl, SALES, A, { userId: 'user_not_a_member', name: 'Ghost' }))).toBe('VALIDATION');
    expect(await code(setOwner(ctl, other.depts[0], A, { userId: HEAD }))).toMatch(/^REFS: .*not part of this organization/);
    expect(await code(setOwner(ctl, B_ONLY, A, { userId: HEAD }))).toMatch(/^REFS: .*different company/);
    await setOwner(ctl, SALES, A, { userId: HEAD, name: 'Sam Sales', email: 'sam@example.test' });
    const board = await getBoard(ctxFor(HEAD, 'head'), v1.id);
    expect(board.rows[0].ownerName).toBe('Sam Sales');
  });

  it('owner emails: never in the member read, only to budget admins (service read)', async () => {
    const owners = await loadOwners(sb, t.org);
    expect(owners).toHaveLength(1);
    expect(Object.keys(owners[0]).sort()).toEqual(['departmentId', 'ownerName', 'ownerUserId']);
    expect((await loadOwnerEmails(ctxFor(CONTROLLER, 'controller'), [SALES])).get(SALES)).toBe('sam@example.test');
    expect((await loadOwnerEmails(ctxFor(EDITOR, 'editor'), [SALES])).size).toBe(0);
    expect((await loadOwnerEmails(ctxFor(HEAD, 'head'), [SALES])).size).toBe(0);
  });
});

describe('workflow, locks and SoD (AC-B9 / AC-B10 / AC-B11; MEDIUM approval rules)', () => {
  it('department plans: approve needs the approve right, only once submitted, never by the submitter', async () => {
    const h = ctxFor(HEAD, 'head');
    const ctl = ctxFor(CONTROLLER, 'controller');
    const ed = ctxFor(EDITOR, 'editor');
    expect(await code(transitionPlan(ctl, v1.id, SALES, 'approve'))).toBe('LOCKED'); // a draft is not approvable
    await transitionPlan(h, v1.id, SALES, 'submit', { note: 'Ready' });
    expect(await code(saveCells(h, v1.id, SALES, [{ accountId: t.acct.rent, periodNumber: 2, amountCents: 1 }], 'MANUAL'))).toBe('LOCKED');
    expect(await code(transitionPlan(h, v1.id, SALES, 'approve'))).toBe('SCOPE');
    expect(await code(transitionPlan(ed, v1.id, SALES, 'approve'))).toBe('SCOPE'); // finance edit ≠ approve
    expect(await code(transitionPlan(ctl, v1.id, SALES, 'return'))).toBe('VALIDATION');
    await transitionPlan(ed, v1.id, SALES, 'return', { note: 'Trim rent' }); // finance may return
    await transitionPlan(h, v1.id, SALES, 'submit');
    await transitionPlan(ctl, v1.id, SALES, 'approve');
    await transitionPlan(ctxFor(CFO, 'cfo'), v1.id, OPS, 'submit');
    expect(await code(transitionPlan(ctxFor(CFO, 'cfo'), v1.id, OPS, 'approve'))).toBe('SOD');
    await transitionPlan(ctl, v1.id, OPS, 'approve');
  });

  it('version: lock / approve are the approver’s; never the submitter; approval publishes', async () => {
    const ctl = ctxFor(CONTROLLER, 'controller');
    const ed = ctxFor(EDITOR, 'editor');
    await transitionVersion(ctl, v1.id, 'submit');
    expect(await code(transitionVersion(ctl, v1.id, 'approve'))).toBe('SOD');
    expect(await code(transitionVersion(ed, v1.id, 'approve'))).toBe('SCOPE');
    expect(await publishedSum()).toBe(0); // still nothing published while in review
    const ok = await transitionVersion(ctxFor(CFO, 'cfo'), v1.id, 'approve');
    expect(ok?.status).toBe('APPROVED');
    expect(ok?.isCurrent).toBe(true);
    expect(await publishedSum()).toBe(await lineSum(v1.id));
    const pubV = await db.query<{ v: string }>(`select distinct version_id::text v from public.budgets where location_id = $1 and fiscal_year = 2026`, [A]);
    expect(pubV.rows).toEqual([{ v: v1.id }]);
    expect(await code(transitionVersion(ed, v1.id, 'lock'))).toBe('SCOPE'); // locking needs approve
    expect(await code(saveCells(ctl, v1.id, null, [{ accountId: t.acct.rent, periodNumber: 1, amountCents: 5 }], 'MANUAL'))).toBe('LOCKED');
    expect(await code(transitionVersion(ctl, v1.id, 'delete'))).toBe('LOCKED');
  });
});

describe('legacy writes land in a draft; closed months are read-only (H5)', () => {
  it('ensureDraftTarget: an approved target is refused; otherwise a NEW draft copied from the published budget', async () => {
    const ctl = ctxFor(CONTROLLER, 'controller');
    expect(await code(ensureDraftTarget(ctl, A, 2026, v1.id))).toBe('LOCKED');
    v2 = await ensureDraftTarget(ctl, A, 2026);
    expect(v2).toMatchObject({ status: 'DRAFT', isCurrent: false, versionNumber: 2, basis: 'COPY', parentVersionId: v1.id });
    expect(await lineSum(v2.id)).toBe(await lineSum(v1.id));
    expect((await ensureDraftTarget(ctl, A, 2026)).id).toBe(v2.id); // the newest draft is reused
    expect(await publishedSum()).toBe(await lineSum(v1.id)); // the published budget did not move
  });

  it('a month whose fiscal period is closed can’t change — service pre-check and the 189 trigger', async () => {
    await db.query(`update public.fiscal_periods set status = 'SOFT_CLOSE' where location_id = $1 and period_year = 2026 and period_month = 1`, [A]);
    await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where location_id = $1 and period_year = 2026 and period_month = 2`, [A]);
    const ctl = ctxFor(CONTROLLER, 'controller');
    const grid = await getGrid(ctl, v2.id, SALES);
    expect(grid.closedPeriods).toEqual([1, 2]);
    expect(grid.editable).toBe(true);
    const err = await errorOf(saveCells(ctl, v2.id, SALES, [{ accountId: t.acct.rent, periodNumber: 1, amountCents: 1 }], 'MANUAL'));
    expect(err).toMatch(/Jan 2026 is closed/);
    expect(await code(saveCells(ctl, v2.id, SALES, [{ accountId: t.acct.rent, periodNumber: 2, amountCents: 0 }], 'MANUAL'))).toBe('PERIOD_CLOSED');
    // Re-saving a closed month's existing value is not a change.
    const jan = grid.rows.find((r) => r.accountId === t.acct.rent)!.months[0];
    expect(await code(saveCells(ctl, v2.id, SALES, [{ accountId: t.acct.rent, periodNumber: 1, amountCents: jan }], 'MANUAL'))).toBe('ok');
    // Open months and period 13 (adjustments, no fiscal period) still save.
    expect(await code(saveCells(ctl, v2.id, SALES, [{ accountId: t.acct.rent, periodNumber: 3, amountCents: 125_000 }, { accountId: t.acct.rent, periodNumber: 13, amountCents: 7 }], 'MANUAL'))).toBe('ok');
    // The database refuses on its own (BUDGET_PERIOD_CLOSED → PERIOD_CLOSED / 409).
    const raw = await sb.from('budget_version_lines').insert({ org_id: t.org, version_id: v2.id, location_id: A, fiscal_year: 2026, account_id: t.acct.depExp, department_id: OPS, period_number: 2, amount_cents: 99, source: 'MANUAL', updated_by: CONTROLLER });
    expect(raw.error).toBeTruthy();
    const mapped = budgetErrorFromDb(raw.error?.message);
    expect(mapped?.code).toBe('PERIOD_CLOSED');
    expect(mapped?.status).toBe(409);
  });

  it('a driver regenerates the open months and keeps the closed ones as budgeted', async () => {
    const ctl = ctxFor(CONTROLLER, 'controller');
    const before = (await getGrid(ctl, v2.id, SALES)).rows.find((r) => r.accountId === t.acct.rent)!.months;
    await applyDriver(ctl, { versionId: v2.id, departmentId: SALES, accountId: t.acct.rent, method: 'FIXED_MONTHLY', params: { monthlyCents: 150_000 } });
    const after = (await getGrid(ctl, v2.id, SALES)).rows.find((r) => r.accountId === t.acct.rent)!.months;
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after.slice(2)).toEqual(Array(10).fill(150_000));
  });

  it('approving v2 supersedes v1 and republishes — the closed months’ budget does not move', async () => {
    const closedBefore = await publishedSum('and period_number in (1, 2)');
    await approveDepartments(v2.id);
    await transitionVersion(ctxFor(CONTROLLER, 'controller'), v2.id, 'submit');
    await transitionVersion(ctxFor(CFO, 'cfo'), v2.id, 'approve');
    const vs = await db.query<{ version_number: number; status: string; is_current: boolean }>(
      `select version_number, status, is_current from public.budget_plan_versions where location_id = $1 and fiscal_year = 2026 and kind = 'BUDGET' order by 1`, [A]);
    expect(vs.rows).toEqual([
      { version_number: 1, status: 'SUPERSEDED', is_current: false },
      { version_number: 2, status: 'APPROVED', is_current: true },
    ]);
    const pubV = await db.query<{ v: string }>(`select distinct version_id::text v from public.budgets where location_id = $1 and fiscal_year = 2026`, [A]);
    expect(pubV.rows).toEqual([{ v: v2.id }]);
    expect(await publishedSum('and period_number in (1, 2)')).toBe(closedBefore);
    const cmp = await compareVersions(ctxFor(CONTROLLER, 'controller'), v1.id, v2.id);
    expect(cmp.rows[0]).toMatchObject({ accountId: t.acct.rent, departmentId: SALES });
  });

  it('a new version of a year with closed months carries the PUBLISHED budget there (or the DB refuses)', async () => {
    const ctl = ctxFor(CONTROLLER, 'controller');
    // Last year + 25% would change Jan / Feb; the service seeds those months from the published v2
    // instead. While 189's line trigger refuses every closed-month insert (even an equal-to-published
    // seed) the version is refused as a whole — fail closed. Either way BvA for a closed month can't move.
    const holder: { v: BudgetVersion | null } = { v: null };
    const r = await code(createVersion(ctl, { locationId: A, fiscalYear: 2026, kind: 'BUDGET', start: 'PRIOR_YEAR_ACTUALS', growthBps: 2500 }).then((v) => { holder.v = v; }));
    expect(['ok', 'PERIOD_CLOSED']).toContain(r);
    if (holder.v) {
      expect(await lineSum(holder.v.id, 'and period_number in (1, 2)')).toBe(await lineSum(v2.id, 'and period_number in (1, 2)'));
      await transitionVersion(ctl, holder.v.id, 'delete');
    }
    expect(await publishedSum('and period_number in (1, 2)')).toBe(await lineSum(v2.id, 'and period_number in (1, 2)'));
  });
});

describe('department BvA ties to the GL; bridges tie (AC-B16 / AC-B15)', () => {
  it('YTD through March, Sales: actual = manual GL sum, budget = the published version’s lines, PY = same window last year', async () => {
    const c = ctxFor(CONTROLLER, 'controller');
    const v = await getDepartmentView(c, { locationId: A, fiscalYear: 2026, month: 3, window: 'YTD', departmentId: SALES });
    const rev = v.lines.find((l) => l.accountId === t.acct.revenue)!;
    expect(rev.actualCents).toBe(await glNatural(t.acct.revenue, SALES, '2026-01-01', '2026-03-31', true));
    expect(rev.actualCents).toBe(3_600_000);
    expect(rev.pyCents).toBe(await glNatural(t.acct.revenue, SALES, '2025-01-01', '2025-03-31', true));
    expect(rev.budgetCents).toBe(await lineSum(v2.id, `and department_id = '${SALES}' and account_id = '${t.acct.revenue}' and period_number between 1 and 3`));
    const wages = v.lines.find((l) => l.accountId === t.acct.wages)!;
    expect(wages.actualCents).toBe(1_350_000); // the DRAFT entry is excluded
    expect(wages.verdict).toBe('no_budget'); // budget is 0 Jan–Mar (hire starts April): no F/U call, shown as "—"
    expect(v.totals.measure).toBe('contribution');
    expect(v.closedThrough).toBe('Feb 2026');
    for (const b of Object.values(v.bridges)) expect(bridgeTies(b)).toBe(true);
    expect(v.bridges.pyToBudget.steps.map((s) => s.key)).toEqual(expect.arrayContaining(['headcount']));
    expect(v.forecastLabel).toMatch(/Latest estimate \(actuals through Feb 2026/);
  });

  it('Operations is a cost-only department: spend measure, prior-year bridge from its lines', async () => {
    const c = ctxFor(CONTROLLER, 'controller');
    const v = await getDepartmentView(c, { locationId: A, fiscalYear: 2026, month: 12, window: 'TTM', departmentId: OPS });
    expect(v.totals.measure).toBe('spend');
    expect(v.bridges.pyToBudget.start.cents).toBe(await glNatural(t.acct.cogs, OPS, '2025-01-01', '2025-12-31', false));
    expect(bridgeTies(v.bridges.pyToBudget)).toBe(true);
  });

  it('the drill returns the GL lines behind a variance, and they sum to the actual', async () => {
    const c = ctxFor(CONTROLLER, 'controller');
    const d = await getDrill(c, { locationId: A, fiscalYear: 2026, month: 3, window: 'YTD', departmentId: SALES, accountId: t.acct.revenue, which: 'actual' });
    expect(d.lines).toHaveLength(3);
    expect(d.totalCents).toBe(3_600_000);
  });
});

describe('import, templates, commentary (AC-B18 / AC-B14 / FP-21)', () => {
  it('an import lands in a draft version with cents equal to the file', async () => {
    const ctl = ctxFor(CONTROLLER, 'controller');
    const draft = await ensureDraftTarget(ctl, A, 2027); // no FY2027 yet → a blank draft
    expect(draft).toMatchObject({ status: 'DRAFT', isCurrent: false, basis: 'BLANK' });
    const csv = 'Account,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec\n6100,"1,000.10",1000,1000,1000,1000,1000,1000,1000,1000,1000,1000,1000.01\n4000,5000,5000,5000,5000,5000,5000,5000,5000,5000,5000,5000,5000\n';
    const parsed = parseBudgetGrid(parseCsv(csv), {});
    expect(parsed.errors).toEqual([]);
    const folded = foldToPeriods(parsed.rows);
    const byNum = new Map([['6100', t.acct.rent], ['4000', t.acct.revenue]]);
    const cells = [...folded.entries()].flatMap(([ref, periods]) => Object.entries(periods).map(([p, c]) => ({ accountId: byNum.get(ref)!, periodNumber: Number(p), amountCents: c })));
    await writeCells(ctl, draft, SALES, cells, 'IMPORT');
    expect(await lineSum(draft.id)).toBe(parsed.totalCents);
    expect(parsed.totalCents).toBe(100_010 + 1_000_00 * 10 + 100_001 + 500_000 * 12);
  });

  it('applies the Sales system template to a draft department; tenant templates version; patterns are capped', async () => {
    const ctl = ctxFor(CONTROLLER, 'controller');
    const draft = (await db.query<{ id: string }>(`select id from public.budget_plan_versions where location_id = $1 and fiscal_year = 2027`, [A])).rows[0].id;
    const r = await applyTemplate(ctl, draft, OPS, 'system:sales', 500);
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.missing.length).toBeGreaterThan(0);
    for (const l of r.lines) expect(l.months.reduce((a, b) => a + b, 0)).toBe(l.annualCents);
    const plan = await db.query<{ template_key: string }>(`select template_key from public.budget_department_plans where version_id = $1 and department_id = $2`, [draft, OPS]);
    expect(plan.rows[0].template_key).toBe('sales');
    const sales = (await listTemplates(ctl)).system.find((x) => x.key === 'sales')!;
    const t1 = await saveTenantTemplate(ctl, { basedOn: 'system:sales', name: 'Our sales team', departmentKind: 'SALES', lines: sales.lines }, A);
    const t2 = await saveTenantTemplate(ctl, { key: t1.key, basedOn: 'system:sales', name: 'Our sales team', departmentKind: 'SALES', lines: sales.lines.slice(0, 3) }, A);
    expect([t1.version, t2.version]).toEqual([1, 2]);
    const list = await listTemplates(ctl);
    expect(list.history[t1.key]).toEqual([1, 2]);
    expect(list.tenant.find((x) => x.key === t1.key)!.lines).toHaveLength(3);
    expect(await code(saveTenantTemplate(ctxFor(HEAD, 'head'), { name: 'x', departmentKind: 'SALES', lines: sales.lines }, A))).toBe('SCOPE');
    const long = { ...sales.lines[0], selector: { ...sales.lines[0].selector, name: 'a'.repeat(101) } };
    expect(await code(saveTenantTemplate(ctl, { name: 'Too long', departmentKind: 'SALES', lines: [long] }, A))).toBe('VALIDATION');
    // "Start from last year + 5%" on Sales FY2027 = FY2026 Sales actuals (Jan–Mar) × 1.05.
    const s = await startFromPriorYear(ctl, draft, SALES, 500);
    expect(s.annualCents).toBe(Math.round((3_600_000 + 1_350_000) * 1.05));
    const g = await getGrid(ctl, draft, SALES);
    expect(g.rows.find((x) => x.accountId === t.acct.revenue)!.totalCents).toBe(3_780_000);
    // Operations had no FY2026 actuals → refused with a reason.
    expect(await code(startFromPriorYear(ctl, draft, OPS, 500))).toBe('VALIDATION');
  });

  it('variance explanations: the owner explains, can’t review their own, finance reviews', async () => {
    const h = ctxFor(HEAD, 'head');
    const c = await addComment(h, { locationId: A, departmentId: SALES, accountId: t.acct.wages, kind: 'VARIANCE_EXPLANATION', body: 'Hired early — the April hire started in January.', periodKey: '2026-03', varianceWindow: 'YTD', varianceCents: 1_350_000 });
    expect(c.status).toBe('EXPLAINED');
    expect(await code(actOnComment(h, c.id, 'review'))).toBe('SCOPE');
    expect(await code(actOnComment(ctxFor(HEAD, 'controller'), c.id, 'review'))).toBe('SOD');
    const r = await actOnComment(ctxFor(CONTROLLER, 'controller'), c.id, 'review', 'OK');
    expect(r.status).toBe('REVIEWED');
    const v = await getDepartmentView(ctxFor(CONTROLLER, 'controller'), { locationId: A, fiscalYear: 2026, month: 3, window: 'YTD', departmentId: SALES });
    expect(v.lines.find((l) => l.accountId === t.acct.wages)!.explanation?.status).toBe('REVIEWED');
  });
});

describe('every referenced id is this org’s and this company’s (MEDIUM: assertOrgRefs)', () => {
  it('writeCells refuses another org’s account / department and another company’s department / version', async () => {
    const ctl = ctxFor(CONTROLLER, 'controller');
    const draft = await ensureDraftTarget(ctl, A, 2027);
    const before = await lineSum(draft.id);
    const cell = [{ accountId: t.acct.rent, periodNumber: 5, amountCents: 1 }];
    expect(await code(writeCells(ctl, draft, SALES, [{ accountId: other.acct.rent, periodNumber: 5, amountCents: 1 }], 'MANUAL'))).toMatch(/^REFS: That account is not part of this organization/);
    expect(await code(writeCells(ctl, draft, other.depts[0], cell, 'MANUAL'))).toMatch(/^REFS: That department is not part of this organization/);
    expect(await code(writeCells(ctl, draft, B_ONLY, cell, 'MANUAL'))).toMatch(/^REFS: That department belongs to a different company/);
    const vB = await createVersion(ctl, { locationId: B, fiscalYear: 2027, kind: 'BUDGET', start: 'BLANK' });
    // A version of company B dressed up as company A's.
    expect(await code(writeCells(ctl, { ...vB, locationId: A }, SALES, cell, 'MANUAL'))).toMatch(/^REFS: That budget version belongs to a different company/);
    expect(await code(applyDriver(ctl, { versionId: draft.id, departmentId: SALES, accountId: other.acct.rent, method: 'MANUAL', params: {} }))).not.toBe('ok');
    expect(await lineSum(draft.id)).toBe(before);
    // The company's own ids still write.
    expect(await code(writeCells(ctl, draft, SALES, cell, 'MANUAL'))).toBe('ok');
  });

  it('comments refuse foreign versions, accounts, departments and parents; replies stay in their thread', async () => {
    const ctl = ctxFor(CONTROLLER, 'controller');
    const draftA = await ensureDraftTarget(ctl, A, 2027);
    const vB = (await db.query<{ id: string }>(`select id from public.budget_plan_versions where location_id = $1 and fiscal_year = 2027`, [B])).rows[0].id;
    const onB = await addComment(ctl, { locationId: B, versionId: vB, departmentId: SALES, kind: 'COMMENT', body: 'B note' });
    const base = { locationId: A, versionId: draftA.id, departmentId: SALES, kind: 'COMMENT' as const, body: 'Why so high?' };
    expect(await code(addComment(ctl, { ...base, versionId: vB }))).toMatch(/^REFS: That budget version belongs to a different company/);
    expect(await code(addComment(ctl, { ...base, accountId: other.acct.rent }))).toMatch(/^REFS: That account is not part of this organization/);
    expect(await code(addComment(ctl, { ...base, departmentId: other.depts[0] }))).toMatch(/^REFS: That department is not part of this organization/);
    expect(await code(addComment(ctl, { ...base, parentId: onB.id }))).toMatch(/^REFS: That comment belongs to a different company/);
    const root = await addComment(ctl, { ...base, accountId: t.acct.rent });
    expect(await code(addComment(ctl, { ...base, departmentId: OPS, parentId: root.id }))).toBe('VALIDATION');
    const reply = await addComment(ctl, { ...base, parentId: root.id, body: 'Rent went up.' });
    expect(reply.parentId).toBe(root.id);
  });
});
