/**
 * Migration 189 (department budgets) — real-Postgres guarantees, replayed in PGlite WITH hosted
 * Supabase's default grants so "members can't write" is not vacuous:
 *
 *   AC-B12  pre-189 budget rows migrate into one "FY{yr} Budget v1 (migrated)" version per company × FY,
 *           APPROVED-MIGRATED (legacy; approved_by 'system:migration-189') and current, with identical
 *           cents, budgets.version_id set, duplicates collapsed; re-running 189 is a no-op.
 *   H5      only an APPROVED / LOCKED version can be current; lines of SOFT/HARD-closed months refused.
 *   H6      department scope in RLS (owners see their departments; finance / approvers see all);
 *           owner_email is not member-readable.
 *   AC-B9   one current BUDGET version; approving v2 supersedes v1 and public.budgets holds v2 only.
 *   AC-B10  lines of a non-DRAFT version / SUBMITTED or APPROVED department are refused; illegal
 *           transitions refused; a LOCKED budget can't be replaced; members / anon write nothing.
 *   AC-B11  approver ≠ submitter (version function + plan CHECK); variance review ≠ author.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { applyMigrationFile, createTestDb, listMigrationFiles } from './pg';
import { asClaims, seedEmployee } from './wave3-db-helpers';

const ORG_A = '11111111-1111-1111-1111-111111111189';
const ORG_B = '22222222-2222-2222-2222-222222222189';
const LOC_A = 'aaaaaaaa-0000-0000-0000-0000000001a9';
const LOC_A2 = 'aaaaaaaa-0000-0000-0000-0000000002a9';
const LOC_B = 'bbbbbbbb-0000-0000-0000-0000000001b9';
const DEPT_SALES = 'aaaaaaaa-1890-0000-0000-0000000000d1';
const DEPT_OPS = 'aaaaaaaa-1890-0000-0000-0000000000d2';
let REV = '';
let OPEX = '';
let REV_B = '';

const MIG = listMigrationFiles().find((f) => f.startsWith('189_'))!;
let db: PGlite;

async function seedAccount(org: string, type: 'REVENUE' | 'OPEX', num: string, name: string): Promise<string> {
  const sub = type === 'REVENUE' ? 'REVENUE' : 'OPERATING_EXPENSE';
  const t = await db.query<{ id: string }>(
    `insert into public.account_types (org_id, name, code, display_order, normal_balance) values ($1, $2, $3::account_type_enum, 1, $4)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [org, type, type, type === 'REVENUE' ? 'CREDIT' : 'DEBIT'],
  );
  const st = await db.query<{ id: string }>(
    `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order) values ($1, $2, $3, $4::account_sub_type_enum, 1)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [org, t.rows[0].id, sub, sub],
  );
  const g = await db.query<{ id: string }>(
    `insert into public.account_groups (org_id, account_sub_type_id, name, display_order) values ($1, $2, $3, 1)
     on conflict (org_id, name) do update set display_order = 1 returning id`,
    [org, st.rows[0].id, `G ${type}`],
  );
  const id = crypto.randomUUID();
  await db.query(
    `insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
     values ($1, $2, $3, $4, $5, $6::account_type_enum, $7::account_sub_type_enum, true, 'APPROVED')`,
    [id, org, g.rows[0].id, num, name, type, sub],
  );
  return id;
}

async function asRole<T>(role: 'authenticated' | 'anon' | 'service_role', fn: () => Promise<T>, org = ORG_A): Promise<T> {
  const claims = role === 'authenticated' ? { sub: 'user_a', org_id: org, role } : role === 'service_role' ? { role } : {};
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const budgetsOf = async (loc: string, fy: number) =>
  (await db.query<{ account_id: string; department_id: string | null; period_number: number; amount_cents: string; version_id: string | null }>(
    `select account_id, department_id, period_number, amount_cents::text, version_id from public.budgets
      where location_id = $1 and fiscal_year = $2 order by account_id, department_id nulls first, period_number`,
    [loc, fy],
  )).rows;

async function newVersion(loc: string, fy: number, n: number, label: string, kind = 'BUDGET'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.budget_plan_versions (org_id, location_id, fiscal_year, kind, version_number, label, created_by)
     values ($1, $2, $3, $4, $5, $6, 'user_controller') returning id`,
    [ORG_A, loc, fy, kind, n, label],
  );
  return r.rows[0].id;
}

async function line(version: string, loc: string, fy: number, account: string, period: number, cents: number, dept: string | null = null) {
  await db.query(
    `insert into public.budget_version_lines (org_id, version_id, location_id, fiscal_year, account_id, department_id, period_number, amount_cents)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ORG_A, version, loc, fy, account, dept, period, cents],
  );
}

beforeAll(async () => {
  // Replay everything BEFORE 189, seed legacy budget rows, then apply 189 and the rest.
  const files = listMigrationFiles();
  const before = files.filter((f) => f < MIG);
  const after = files.filter((f) => f >= MIG);
  ({ db } = await createTestDb({ supabaseDefaultGrants: true, through: before[before.length - 1].slice(0, 3) }));

  await db.exec(`
    insert into core.organizations (id, name, slug) values ('${ORG_A}', 'Tenant A', 'tenant-a-189'), ('${ORG_B}', 'Tenant B', 'tenant-b-189');
    insert into core.locations (id, org_id, name, short_code) values
      ('${LOC_A}', '${ORG_A}', 'Company A', 'CA'), ('${LOC_A2}', '${ORG_A}', 'Company A2', 'CA2'), ('${LOC_B}', '${ORG_B}', 'Company B', 'CB');
    insert into core.departments (id, org_id, name, code, location_id) values
      ('${DEPT_SALES}', '${ORG_A}', 'Sales', 'SALES', '${LOC_A}'), ('${DEPT_OPS}', '${ORG_A}', 'Operations', 'OPS', '${LOC_A}');
  `);
  REV = await seedAccount(ORG_A, 'REVENUE', '4000', 'Service revenue');
  OPEX = await seedAccount(ORG_A, 'OPEX', '6100', 'Advertising');
  REV_B = await seedAccount(ORG_B, 'REVENUE', '4000', 'Service revenue');

  // Legacy rows: company A FY2027 company-level revenue 1..12 (with a DUPLICATE period 3 the old
  // NULL-department key allowed), Sales department OPEX 1..12; company B FY2027 revenue period 1.
  for (let m = 1; m <= 12; m++) {
    await db.query(
      `insert into public.budgets (org_id, location_id, account_id, department_id, fiscal_year, period_number, amount_cents, updated_at)
       values ($1, $2, $3, null, 2027, $4, $5, now() - interval '1 day')`,
      [ORG_A, LOC_A, REV, m, 1_000_000 + m],
    );
    await db.query(
      `insert into public.budgets (org_id, location_id, account_id, department_id, fiscal_year, period_number, amount_cents)
       values ($1, $2, $3, $4, 2027, $5, $6)`,
      [ORG_A, LOC_A, OPEX, DEPT_SALES, m, 50_000],
    );
  }
  await db.query(
    `insert into public.budgets (org_id, location_id, account_id, department_id, fiscal_year, period_number, amount_cents, updated_at)
     values ($1, $2, $3, null, 2027, 3, 3_333_333, now())`,
    [ORG_A, LOC_A, REV],
  );
  await db.query(
    `insert into public.budgets (org_id, location_id, account_id, fiscal_year, period_number, amount_cents) values ($1, $2, $3, 2027, 1, 777)`,
    [ORG_B, LOC_B, REV_B],
  );

  for (const f of after) await applyMigrationFile(db, f);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('189 — migration of existing budget rows (AC-B12)', () => {
  it('creates one FY Budget v1 per company × FY, APPROVED-MIGRATED and current, and links every row', async () => {
    const v = await db.query<{ location_id: string; label: string; status: string; is_current: boolean; basis: string; version_number: number; approved_by: string }>(
      `select location_id, label, status, is_current, basis, version_number, approved_by from public.budget_plan_versions order by location_id`,
    );
    const row = { label: 'FY2027 Budget v1 (migrated)', status: 'APPROVED', is_current: true, basis: 'MIGRATED', version_number: 1, approved_by: 'system:migration-189' };
    expect(v.rows).toEqual([{ location_id: LOC_A, ...row }, { location_id: LOC_B, ...row }]);
    const unlinked = await db.query(`select 1 from public.budgets where version_id is null`);
    expect(unlinked.rows).toHaveLength(0);
  });

  it('collapses the duplicate company-level cell to the newest edit and copies cents exactly', async () => {
    const rows = await budgetsOf(LOC_A, 2027);
    expect(rows).toHaveLength(24);
    const p3 = rows.filter((r) => r.account_id === REV && r.period_number === 3);
    expect(p3).toHaveLength(1);
    expect(p3[0].amount_cents).toBe('3333333');
    const lines = await db.query<{ total: string; n: string }>(
      `select sum(amount_cents)::text total, count(*)::text n from public.budget_version_lines where location_id = $1`, [LOC_A]);
    const pub = await db.query<{ total: string }>(`select sum(amount_cents)::text total from public.budgets where location_id = $1`, [LOC_A]);
    expect(lines.rows[0]).toEqual({ total: pub.rows[0].total, n: '24' });
    const plan = await db.query<{ department_id: string; status: string }>(
      `select department_id, status from public.budget_department_plans where location_id = $1`, [LOC_A]);
    expect(plan.rows).toEqual([{ department_id: DEPT_SALES, status: 'APPROVED' }]);
  });

  it('the new key refuses a second company-level cell (NULLS NOT DISTINCT)', async () => {
    const e = await errorOf(
      `insert into public.budgets (org_id, location_id, account_id, fiscal_year, period_number, amount_cents) values ($1, $2, $3, 2027, 5, 1)`,
      [ORG_A, LOC_A, REV],
    );
    expect(e).toMatch(/duplicate key|unique/i);
  });

  it('is idempotent: re-running 189 changes no budgets, lines, versions or policies', async () => {
    const snap = async () => ({
      budgets: (await db.query(`select org_id, location_id, account_id, department_id, fiscal_year, period_number, amount_cents, version_id from public.budgets order by 1,2,3,4,5,6`)).rows,
      lines: (await db.query(`select version_id, account_id, department_id, period_number, amount_cents from public.budget_version_lines order by 1,2,3,4`)).rows,
      versions: (await db.query(`select id, status, is_current from public.budget_plan_versions order by id`)).rows,
      pol: (await db.query(`select tablename, policyname, cmd, roles::text r from pg_policies where tablename like 'budget%' order by 1, 2`)).rows,
    });
    const before = await snap();
    await applyMigrationFile(db, MIG);
    expect(await snap()).toEqual(before);
  });
});

describe('189 — RLS and grants', () => {
  const TABLES = ['budget_plan_versions', 'budget_version_lines', 'budget_line_drivers', 'budget_department_plans',
    'budget_department_owners', 'budget_templates', 'budget_comments', 'budget_events', 'budgets'];

  it('members and anon hold no write privilege on any 189 table or on budgets', async () => {
    for (const t of TABLES) {
      const r = await db.query<{ w: boolean; anon: boolean }>(
        `select (has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE')
                 or has_table_privilege('authenticated', c.oid, 'DELETE')) w,
                (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')) anon
           from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = $1`,
        [t],
      );
      expect(r.rows[0], t).toEqual({ w: false, anon: false });
    }
  });

  it('a member write is refused; a member reads only their org', async () => {
    const e = await asRole('authenticated', () =>
      errorOf(`update public.budgets set amount_cents = 1 where location_id = $1`, [LOC_A]),
    );
    expect(e).toMatch(/permission denied/);
    const e2 = await asRole('authenticated', () =>
      errorOf(`insert into public.budget_comments (org_id, location_id, body, author_user_id) values ($1, $2, 'x', 'user_a')`, [ORG_A, LOC_A]),
    );
    expect(e2).toMatch(/permission denied/);
    const seen = await asRole('authenticated', () => db.query<{ location_id: string }>(`select distinct location_id from public.budget_plan_versions`));
    expect(seen.rows.map((r) => r.location_id)).toEqual([LOC_A]);
  });

  it('the client-scope policy covers the new tables that carry location_id', async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public' and policyname = 'client_scope_rls' and tablename like 'budget%' order by 1`,
    );
    expect(r.rows.map((x) => x.tablename)).toEqual(expect.arrayContaining(TABLES.filter((t) => t !== 'budget_templates')));
  });

  it('trigger functions are not executable by members (M1)', async () => {
    const r = await db.query<{ ok: boolean }>(
      `select bool_and(not has_function_privilege('authenticated', p.oid, 'EXECUTE')) ok
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'budget\\_%'`,
    );
    expect(r.rows[0].ok).toBe(true);
  });
});

describe('189 — version lifecycle, publish and locks (AC-B9 / AC-B10 / AC-B11)', () => {
  let v1 = '';
  let v2 = '';

  beforeAll(async () => {
    v1 = (await db.query<{ id: string }>(`select id from public.budget_plan_versions where location_id = $1`, [LOC_A])).rows[0].id;
  });

  it('a version must start as a draft and can\'t skip review', async () => {
    expect(await errorOf(
      `insert into public.budget_plan_versions (org_id, location_id, fiscal_year, version_number, label, status, approved_by, approved_at)
       values ($1, $2, 2027, 9, 'x', 'APPROVED', 'u', now())`, [ORG_A, LOC_A],
    )).toMatch(/BUDGET_LOCKED: a budget version starts as a draft/);
    v2 = await newVersion(LOC_A, 2027, 2, 'FY2027 Budget v2');
    expect(await errorOf(`update public.budget_plan_versions set status = 'APPROVED', approved_by = 'u', approved_at = now() where id = $1`, [v2]))
      .toMatch(/can't move from DRAFT to APPROVED/);
    expect(await errorOf(`select public.budget_approve_version($1, 'user_cfo', null)`, [v2])).toMatch(/submit the version for approval first/);
  });

  it('a DRAFT can never be the published budget of record (H5)', async () => {
    expect(await errorOf(`update public.budget_plan_versions set is_current = true where id = $1`, [v2])).toMatch(/budget_plan_versions_chk/);
  });

  it('only one current BUDGET version per company × FY (even inside the migration bypass)', async () => {
    let err: string | null = null;
    try {
      await db.exec(`begin;
        select set_config('meritbooks.budget_migration', 'on', true);
        insert into public.budget_plan_versions (org_id, location_id, fiscal_year, version_number, label, status, approved_by, approved_at, is_current)
        values ('${ORG_B}', '${LOC_B}', 2027, 7, 'second current', 'APPROVED', 'x', now(), true);
        commit;`);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      await db.exec('rollback');
    }
    expect(err).toMatch(/duplicate key|unique/i);
  });

  it('a draft that is not current does not touch the published budget', async () => {
    for (let m = 1; m <= 12; m++) await line(v2, LOC_A, 2027, REV, m, 2_000_000);
    const rows = await budgetsOf(LOC_A, 2027);
    expect(rows.every((r) => r.version_id === v1)).toBe(true);
  });

  it('a line\'s company and fiscal year must match its version', async () => {
    expect(await errorOf(
      `insert into public.budget_version_lines (org_id, version_id, location_id, fiscal_year, account_id, period_number, amount_cents)
       values ($1, $2, $3, 2027, $4, 1, 1)`, [ORG_A, v2, LOC_A2, OPEX],
    )).toMatch(/belong to its version's company/);
    expect(await errorOf(
      `insert into public.budget_version_lines (org_id, version_id, location_id, fiscal_year, account_id, period_number, amount_cents)
       values ($1, $2, $3, 2026, $4, 1, 1)`, [ORG_A, v2, LOC_A, OPEX],
    )).toMatch(/fiscal year must match/);
  });

  it('the approved-migrated v1 is read-only — changes go into a new version', async () => {
    expect(await errorOf(
      `update public.budget_version_lines set amount_cents = 4_444_444 where version_id = $1 and account_id = $2 and department_id is null and period_number = 4`,
      [v1, REV],
    )).toMatch(/BUDGET_LOCKED: this budget version is approved/);
    const p4 = (await budgetsOf(LOC_A, 2027)).find((r) => r.account_id === REV && r.period_number === 4)!;
    expect(p4.amount_cents).toBe('1000004');
  });

  it('IN_REVIEW freezes the lines; the submitter can\'t approve (SoD)', async () => {
    await db.query(`update public.budget_plan_versions set status = 'IN_REVIEW', submitted_by = 'user_controller', submitted_at = now() where id = $1`, [v2]);
    expect(await errorOf(`update public.budget_version_lines set amount_cents = 1 where version_id = $1`, [v2])).toMatch(/BUDGET_LOCKED: this budget version is in review/);
    expect(await errorOf(`select public.budget_approve_version($1, 'user_controller', null)`, [v2])).toMatch(/BUDGET_SOD/);
    // the CHECK stands behind the function
    expect(await errorOf(`update public.budget_plan_versions set status = 'APPROVED', approved_by = 'user_controller', approved_at = now() where id = $1`, [v2]))
      .toMatch(/budget_plan_versions_chk/);
  });

  it('approving v2 supersedes v1 and public.budgets then holds exactly v2\'s lines', async () => {
    await db.query(`select public.budget_approve_version($1, 'user_cfo', null)`, [v2]);
    const vs = await db.query<{ id: string; status: string; is_current: boolean }>(
      `select id, status, is_current from public.budget_plan_versions where location_id = $1 order by version_number`, [LOC_A]);
    expect(vs.rows).toEqual([
      { id: v1, status: 'SUPERSEDED', is_current: false },
      { id: v2, status: 'APPROVED', is_current: true },
    ]);
    const rows = await budgetsOf(LOC_A, 2027);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.version_id === v2 && r.amount_cents === '2000000' && r.department_id === null)).toBe(true);
  });

  it('an approved version\'s lines and drivers are immutable, and it never returns to draft', async () => {
    expect(await errorOf(`update public.budget_version_lines set amount_cents = 1 where version_id = $1`, [v2])).toMatch(/BUDGET_LOCKED: this budget version is approved/);
    expect(await errorOf(`delete from public.budget_version_lines where version_id = $1`, [v2])).toMatch(/BUDGET_LOCKED/);
    expect(await errorOf(
      `insert into public.budget_line_drivers (org_id, version_id, location_id, account_id, method) values ($1, $2, $3, $4, 'FIXED_MONTHLY')`,
      [ORG_A, v2, LOC_A, OPEX],
    )).toMatch(/BUDGET_LOCKED/);
    expect(await errorOf(`update public.budget_plan_versions set status = 'DRAFT' where id = $1`, [v2])).toMatch(/can't move from APPROVED to DRAFT/);
    expect(await errorOf(`update public.budget_plan_versions set label = 'renamed' where id = $1`, [v2])).toMatch(/read-only/);
    expect(await errorOf(`delete from public.budget_plan_versions where id = $1`, [v2])).toMatch(/can't be deleted/);
    // superseded is terminal
    expect(await errorOf(`update public.budget_plan_versions set status = 'DRAFT' where id = $1`, [v1])).toMatch(/can't move from SUPERSEDED/);
  });

  it('a LOCKED budget can\'t be replaced by another budget version', async () => {
    await db.query(`update public.budget_plan_versions set status = 'LOCKED', locked_by = 'user_cfo', locked_at = now() where id = $1`, [v2]);
    expect(await errorOf(`update public.budget_plan_versions set is_current = false where id = $1`, [v2])).toMatch(/locked/);
    const v3 = await newVersion(LOC_A, 2027, 3, 'FY2027 Budget v3');
    await db.query(`update public.budget_plan_versions set status = 'IN_REVIEW', submitted_by = 'user_controller', submitted_at = now() where id = $1`, [v3]);
    expect(await errorOf(`select public.budget_approve_version($1, 'user_cfo', null)`, [v3])).toMatch(/locked — changes go into a reforecast/);
    // a REFORECAST version approves without touching the published budget
    const rf = await newVersion(LOC_A, 2027, 1, 'FY2027 Reforecast 9+3', 'REFORECAST');
    await line(rf, LOC_A, 2027, REV, 1, 9);
    await db.query(`update public.budget_plan_versions set status = 'IN_REVIEW', submitted_by = 'user_controller', submitted_at = now() where id = $1`, [rf]);
    await db.query(`select public.budget_approve_version($1, 'user_cfo', null)`, [rf]);
    const rows = await budgetsOf(LOC_A, 2027);
    expect(rows.every((r) => r.version_id === v2)).toBe(true);
  });

  it('a draft version can be deleted (and its lines go with it)', async () => {
    const v = await newVersion(LOC_A2, 2027, 1, 'scratch');
    await line(v, LOC_A2, 2027, REV, 1, 5);
    await db.query(`delete from public.budget_plan_versions where id = $1`, [v]);
    expect((await db.query(`select 1 from public.budget_version_lines where version_id = $1`, [v])).rows).toHaveLength(0);
  });
});

describe('189 — department plans (AC-B10 / AC-B11)', () => {
  let v = '';
  let plan = '';

  beforeAll(async () => {
    v = await newVersion(LOC_A2, 2028, 1, 'FY2028 Budget v1');
    const p = await db.query<{ id: string }>(
      `insert into public.budget_department_plans (org_id, version_id, location_id, department_id, owner_user_id) values ($1, $2, $3, $4, 'user_sales_head') returning id`,
      [ORG_A, v, LOC_A2, DEPT_SALES],
    );
    plan = p.rows[0].id;
    await line(v, LOC_A2, 2028, OPEX, 1, 100, DEPT_SALES);
  });

  it('a SUBMITTED department is frozen; company-level and other departments are not', async () => {
    await db.query(`update public.budget_department_plans set status = 'SUBMITTED', submitted_by = 'user_sales_head', submitted_at = now() where id = $1`, [plan]);
    expect(await errorOf(
      `update public.budget_version_lines set amount_cents = 5 where version_id = $1 and department_id = $2`, [v, DEPT_SALES],
    )).toMatch(/department budget is submitted/);
    await line(v, LOC_A2, 2028, OPEX, 1, 7, null);
    await line(v, LOC_A2, 2028, OPEX, 1, 8, DEPT_OPS);
    const ls = await db.query<{ amount_cents: string }>(`select amount_cents::text from public.budget_version_lines where version_id = $1`, [v]);
    expect(ls.rows.map((r) => r.amount_cents).sort()).toEqual(['100', '7', '8']);
    // a draft is never published (H5)
    expect(await budgetsOf(LOC_A2, 2028)).toHaveLength(0);
  });

  it('returning needs a note; the submitter can\'t approve their own department', async () => {
    expect(await errorOf(`update public.budget_department_plans set status = 'RETURNED', reviewed_by = 'user_controller', reviewed_at = now() where id = $1`, [plan]))
      .toMatch(/budget_department_plans_chk/);
    expect(await errorOf(`update public.budget_department_plans set status = 'APPROVED', approved_by = 'user_sales_head', approved_at = now() where id = $1`, [plan]))
      .toMatch(/budget_department_plans_chk/);
  });

  it('the version can\'t be approved while a department is not approved', async () => {
    await db.query(`update public.budget_plan_versions set status = 'IN_REVIEW', submitted_by = 'user_controller', submitted_at = now() where id = $1`, [v]);
    expect(await errorOf(`select public.budget_approve_version($1, 'user_cfo', null)`, [v])).toMatch(/1 department budget\(s\) are not approved/);
    // plans freeze with the version
    expect(await errorOf(`update public.budget_department_plans set status = 'APPROVED', approved_by = 'user_controller', approved_at = now() where id = $1`, [plan]))
      .toMatch(/can't change once the version is in review/);
    await db.query(`update public.budget_plan_versions set status = 'DRAFT' where id = $1`, [v]);
    await db.query(`update public.budget_department_plans set status = 'APPROVED', approved_by = 'user_controller', approved_at = now() where id = $1`, [plan]);
    expect(await errorOf(`update public.budget_version_lines set amount_cents = 5 where version_id = $1 and department_id = $2`, [v, DEPT_SALES]))
      .toMatch(/department budget is approved/);
    await db.query(`update public.budget_plan_versions set status = 'IN_REVIEW', submitted_by = 'user_controller', submitted_at = now() where id = $1`, [v]);
    await db.query(`select public.budget_approve_version($1, 'user_cfo', null)`, [v]);
    expect((await db.query<{ status: string }>(`select status from public.budget_plan_versions where id = $1`, [v])).rows[0].status).toBe('APPROVED');
    // approval publishes it
    expect((await budgetsOf(LOC_A2, 2028)).map((r) => r.amount_cents).sort()).toEqual(['100', '7', '8']);
  });
});

describe('189 — comments and events', () => {
  it('a variance explanation needs its context and is reviewed by someone other than its author', async () => {
    expect(await errorOf(
      `insert into public.budget_comments (org_id, location_id, kind, body, author_user_id) values ($1, $2, 'VARIANCE_EXPLANATION', 'Ad spend pulled forward', 'user_sales_head')`,
      [ORG_A, LOC_A],
    )).toMatch(/budget_comments_chk/);
    const c = await db.query<{ id: string }>(
      `insert into public.budget_comments (org_id, location_id, account_id, department_id, kind, status, body, author_user_id, period_key, variance_window, variance_cents)
       values ($1, $2, $3, $4, 'VARIANCE_EXPLANATION', 'EXPLAINED', 'Ad spend pulled forward from Q4', 'user_sales_head', '2027-03', 'MONTH', -120000) returning id`,
      [ORG_A, LOC_A, OPEX, DEPT_SALES],
    );
    expect(await errorOf(`update public.budget_comments set status = 'REVIEWED', reviewed_by = 'user_sales_head', reviewed_at = now() where id = $1`, [c.rows[0].id]))
      .toMatch(/budget_comments_chk/);
    await db.query(`update public.budget_comments set status = 'REVIEWED', reviewed_by = 'user_controller', reviewed_at = now() where id = $1`, [c.rows[0].id]);
  });

  it('budget_events is append-only', async () => {
    const e = await db.query<{ id: string }>(`select id from public.budget_events limit 1`);
    expect(e.rows.length).toBe(1);
    expect(await errorOf(`update public.budget_events set note = 'x' where id = $1`, [e.rows[0].id])).toMatch(/append-only/);
    expect(await errorOf(`delete from public.budget_events where id = $1`, [e.rows[0].id])).toMatch(/append-only/);
  });

  it('templates: one row per (key, version); a key is a slug', async () => {
    const ins = (key: string, version: number) => errorOf(
      `insert into public.budget_templates (org_id, template_key, version, name, department_kind, lines)
       values ($1, $2, $3, 'Sales', 'SALES', '[{"key":"salaries"}]'::jsonb)`, [ORG_A, key, version]);
    expect(await ins('sales-team', 1)).toBeNull();
    expect(await ins('sales-team', 2)).toBeNull();
    expect(await ins('sales-team', 2)).toMatch(/duplicate key|unique/i);
    expect(await ins('Sales Team!', 1)).toMatch(/budget_templates_chk/);
  });
});

describe('189 — closed months (H5)', () => {
  const insLine = (v: string, p: number, cents = 1) => errorOf(
    `insert into public.budget_version_lines (org_id, version_id, location_id, fiscal_year, account_id, period_number, amount_cents)
     values ($1, $2, $3, 2029, $4, $5, $6)`, [ORG_A, v, LOC_A2, OPEX, p, cents]);

  it('before anything is published, a new version may fill closed months (no budget of record moves)', async () => {
    // v1 is built while every month is still open, then published.
    const v1 = await newVersion(LOC_A2, 2029, 1, 'FY2029 Budget v1');
    for (const p of [2, 3, 4]) expect(await insLine(v1, p, 100)).toBeNull();
    await db.query(`update public.budget_plan_versions set status = 'IN_REVIEW', submitted_by = 'user_controller', submitted_at = now() where id = $1`, [v1]);
    await db.query(`select public.budget_approve_version($1, 'user_cfo', null)`, [v1]);
    await db.query(
      `insert into public.fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status) values
         ($1, $2, 2029, 2, '2029-02-01', '2029-02-28', 'HARD_CLOSE'),
         ($1, $2, 2029, 3, '2029-03-01', '2029-03-31', 'SOFT_CLOSE'),
         ($1, $2, 2029, 4, '2029-04-01', '2029-04-30', 'OPEN')`,
      [ORG_A, LOC_A2],
    );
  });

  it('once published, lines of a SOFT_CLOSE / HARD_CLOSE month are refused unless they keep the published figure', async () => {
    const v = await newVersion(LOC_A2, 2029, 2, 'FY2029 Budget v2');
    expect(await insLine(v, 2)).toMatch(/BUDGET_PERIOD_CLOSED: 2029-02/);
    expect(await insLine(v, 3)).toMatch(/BUDGET_PERIOD_CLOSED: 2029-03/);
    expect(await insLine(v, 2, 100)).toBeNull(); // the published cell, copied forward
    expect(await insLine(v, 4)).toBeNull();
    expect(await insLine(v, 13)).toBeNull();
    expect(await insLine(v, 5)).toBeNull(); // no fiscal period yet
    // moving an open line INTO a closed month is refused too
    expect(await errorOf(
      `update public.budget_version_lines set period_number = 3 where version_id = $1 and period_number = 4`, [v],
    )).toMatch(/BUDGET_PERIOD_CLOSED/);
    // a closed month's copied line can't be changed or deleted (an unchanged re-save is fine)
    expect(await errorOf(`update public.budget_version_lines set amount_cents = 9 where version_id = $1 and period_number = 2`, [v])).toMatch(/BUDGET_PERIOD_CLOSED/);
    expect(await errorOf(`update public.budget_version_lines set amount_cents = 100, notes = 'same' where version_id = $1 and period_number = 2`, [v])).toBeNull();
    expect(await errorOf(`delete from public.budget_version_lines where version_id = $1 and period_number = 2`, [v])).toMatch(/BUDGET_PERIOD_CLOSED/);
    // once a month closes, its existing line can't be changed or deleted
    await db.query(`update public.fiscal_periods set status = 'SOFT_CLOSE' where location_id = $1 and period_year = 2029 and period_month = 4`, [LOC_A2]);
    expect(await errorOf(`update public.budget_version_lines set amount_cents = 9 where version_id = $1 and period_number = 4`, [v])).toMatch(/BUDGET_PERIOD_CLOSED/);
    expect(await errorOf(`delete from public.budget_version_lines where version_id = $1 and period_number = 4`, [v])).toMatch(/BUDGET_PERIOD_CLOSED/);
  });

  it('a REFORECAST (never published) may carry closed months', async () => {
    const rf = await newVersion(LOC_A2, 2029, 1, 'FY2029 Reforecast 1', 'REFORECAST');
    expect(await insLine(rf, 2, 777)).toBeNull();
  });
});

describe('189 — department scope in RLS (H6)', () => {
  const sees = (sub: string) => asClaims(db, 'authenticated', { sub, org_id: ORG_A }, async () => ({
    lines: (await db.query<{ d: string | null }>(`select distinct department_id::text d from public.budget_version_lines order by 1 nulls first`)).rows.map((r) => r.d),
    plans: (await db.query<{ d: string }>(`select distinct department_id::text d from public.budget_department_plans order by 1`)).rows.map((r) => r.d),
    owners: (await db.query<{ d: string }>(`select department_id::text d from public.budget_department_owners order by 1`)).rows.map((r) => r.d),
  }));

  beforeAll(async () => {
    await db.query(
      `insert into public.budget_department_owners (org_id, location_id, department_id, owner_user_id, owner_name, owner_email)
       values ($1, $2, $3, 'user_sales_head', 'Sam Sales', 'sam@example.com'), ($1, $2, $4, 'user_ops_head', 'Olly Ops', 'olly@example.com')`,
      [ORG_A, LOC_A, DEPT_SALES, DEPT_OPS],
    );
    await seedEmployee(db, ORG_A, 'user_fin', 'accounting_manager');
    await seedEmployee(db, ORG_A, 'user_viewer', 'business_user');
  });

  it('a department owner reads only their own department — never company-level lines or other departments', async () => {
    const r = await sees('user_sales_head');
    expect(r.lines).toEqual([DEPT_SALES]);
    expect(r.plans).toEqual([DEPT_SALES]);
    expect(r.owners).toEqual([DEPT_SALES]);
  });

  it('finance staff read every department and the company-level lines', async () => {
    const r = await sees('user_fin');
    expect(r.lines).toEqual(expect.arrayContaining([null, DEPT_SALES, DEPT_OPS]));
    expect(r.owners.sort()).toEqual([DEPT_SALES, DEPT_OPS].sort());
  });

  it('a member who is neither finance nor an owner reads no department budget rows', async () => {
    const r = await sees('user_viewer');
    expect(r).toEqual({ lines: [], plans: [], owners: [] });
  });

  it('owner_email is not member-readable; the other owner columns are', async () => {
    const err = await asClaims(db, 'authenticated', { sub: 'user_fin', org_id: ORG_A }, async () => {
      try {
        await db.query(`select owner_email from public.budget_department_owners`);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(err).toMatch(/permission denied/);
    const ok = await asClaims(db, 'authenticated', { sub: 'user_fin', org_id: ORG_A }, () =>
      db.query<{ owner_user_id: string }>(`select owner_user_id, owner_name from public.budget_department_owners`));
    expect(ok.rows.length).toBe(2);
  });
});

describe('189 — server-side purge (tenant / sandbox reset)', () => {
  it('the 153 purge GUC lets one transaction clear approved versions, their lines and the events', async () => {
    const before = await db.query<{ n: number }>(`select count(*)::int n from public.budget_plan_versions where org_id = $1 and status <> 'DRAFT'`, [ORG_A]);
    expect(before.rows[0].n).toBeGreaterThan(0);
    expect(await errorOf(`delete from public.budget_events where org_id = $1`, [ORG_A])).toMatch(/append-only/);
    await db.exec(`begin;
      set local meritbooks.allow_ledger_purge = 'on';
      delete from public.budget_events where org_id = '${ORG_A}';
      delete from public.budget_plan_versions where org_id = '${ORG_A}';
      commit;`);
    const left = await db.query<{ v: number; l: number; e: number }>(
      `select (select count(*)::int from public.budget_plan_versions where org_id = $1) v,
              (select count(*)::int from public.budget_version_lines where org_id = $1) l,
              (select count(*)::int from public.budget_events where org_id = $1) e`, [ORG_A]);
    expect(left.rows[0]).toEqual({ v: 0, l: 0, e: 0 });
    // outside the purge transaction the guard is back
    const v = await newVersion(LOC_A, 2030, 1, 'after purge');
    await db.query(`update public.budget_plan_versions set status = 'IN_REVIEW', submitted_by = 'a', submitted_at = now() where id = $1`, [v]);
    expect(await errorOf(`delete from public.budget_plan_versions where id = $1`, [v])).toMatch(/can't be deleted/);
  });
});
