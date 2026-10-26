/**
 * Wave 4 security review fixes — the DATABASE half, proven on a real Postgres (PGlite replay WITH
 * hosted Supabase's default grants, so "members can't …" is not vacuous):
 *
 *   H1 (194 §99/§100)  per-employee labor cost on job_labor_hours / job_labor_allocation_lines is
 *                      column-revoked for members (comp class); hours / status stay readable;
 *                      v_books_labor_tieout still answers per job — pinned to the caller's org and
 *                      Books client scope — even though it sums the masked columns.
 *   H3 (191 §2b)       report_packs is SELECT-only for members (writes are the service role after
 *                      reports:export + the pack's client-scope check).
 *   H4 (192 §11)       a combined (location_id NULL) cash forecast snapshot / event — the whole org's
 *                      figures — is visible only with all-clients scope (or scope not enforced);
 *                      per-company rows follow 163 as before.
 *   Idempotency: re-applying 191 / 192 / 194 changes none of it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFile, createTestDb, listMigrationFiles } from './pg';

const ORG_A = 'aaaaaaaa-0000-0000-0000-0000000004a1';
const ORG_B = 'bbbbbbbb-0000-0000-0000-0000000004b1';
const C1 = 'aaaaaaaa-4444-0000-0000-000000000001';
const C2 = 'aaaaaaaa-4444-0000-0000-000000000002';
const LB = 'bbbbbbbb-4444-0000-0000-000000000001';

type Who = 'scoped' | 'all' | 'b_admin';

let db: PGlite;
const membership = new Map<Who, string>();

async function insertRow(qualified: string, values: Record<string, unknown>): Promise<string> {
  const [schema, table] = qualified.split('.');
  const cols = await db.query<{ column_name: string; udt_name: string }>(
    `select column_name, udt_name from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_nullable = 'NO' and column_default is null and is_generated = 'NEVER'`,
    [schema, table],
  );
  const names = Object.keys(values);
  const params: unknown[] = names.map((n) => values[n]);
  const exprs = names.map((_, i) => `$${i + 1}`);
  for (const c of cols.rows) {
    if (names.includes(c.column_name)) continue;
    names.push(c.column_name);
    const label = await db.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder limit 1`,
      [c.udt_name],
    );
    if (label.rows[0]) { params.push(label.rows[0].enumlabel); exprs.push(`$${params.length}::${c.udt_name}`); }
    else if (c.udt_name === 'uuid') exprs.push('gen_random_uuid()');
    else if (c.udt_name === 'date') exprs.push('current_date');
    else if (c.udt_name.startsWith('timestamp')) exprs.push('now()');
    else if (c.udt_name === 'jsonb' || c.udt_name === 'json') exprs.push(`'{}'::${c.udt_name}`);
    else if (c.udt_name.startsWith('_')) exprs.push(`'{}'::${c.udt_name}`);
    else if (/int|numeric|float/.test(c.udt_name)) exprs.push('1');
    else if (c.udt_name === 'bool') exprs.push('false');
    else { params.push(`x-${crypto.randomUUID().slice(0, 8)}`); exprs.push(`$${params.length}`); }
  }
  const r = await db.query<{ id: string }>(`insert into ${qualified} (${names.join(', ')}) values (${exprs.join(', ')}) returning id`, params);
  return r.rows[0].id;
}

async function addMember(who: Who, orgId: string, role: string): Promise<void> {
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [`user_w4_${who}`]);
  const m = await db.query<{ id: string }>(`insert into core.memberships (user_id, org_id, role) values ($1, $2, $3) returning id`, [u.rows[0].id, orgId, role]);
  membership.set(who, m.rows[0].id);
}

async function assign(who: Who, orgId: string, scope: { all: true } | { location: string }): Promise<void> {
  const role = await db.query<{ id: string }>(
    `select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and max_assignment_days is null
       and audience = 'internal_staff' and status = 'active' order by key limit 1`,
    [orgId],
  );
  await db.query(
    `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, effective_from)
     values ($1, $2, 'role', $3, $4, $5, now() - interval '30 days')`,
    [orgId, membership.get(who), role.rows[0].id, 'all' in scope ? 'all_clients' : 'client', 'location' in scope ? scope.location : null],
  );
}

async function setMode(orgId: string, mode: 'off' | 'shadow' | 'enforce'): Promise<void> {
  await db.query(`update core.organizations set client_scope_rls_mode = $2 where id = $1`, [orgId, mode]);
}

async function as<T>(who: Who, fn: () => Promise<T>): Promise<T> {
  const orgId = who === 'b_admin' ? ORG_B : ORG_A;
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: `user_w4_${who}`, org_id: orgId, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function errorOf(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec('alter role service_role bypassrls');
  await db.exec(`insert into core.organizations (id, name, slug, tenant_type) values
    ('${ORG_A}', 'Firm W4', 'firm-w4', 'firm'), ('${ORG_B}', 'Other W4', 'other-w4', 'company')`);
  await insertRow('core.locations', { id: C1, org_id: ORG_A, name: 'Client One', short_code: 'W1' });
  await insertRow('core.locations', { id: C2, org_id: ORG_A, name: 'Client Two', short_code: 'W2' });
  await insertRow('core.locations', { id: LB, org_id: ORG_B, name: 'B Main', short_code: 'WB' });
  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_A]);
  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_B]);
  await addMember('scoped', ORG_A, 'accounting_specialist');
  await addMember('all', ORG_A, 'owner');
  await addMember('b_admin', ORG_B, 'owner');
  await assign('scoped', ORG_A, { location: C1 });
  await assign('all', ORG_A, { all: true });
  await assign('b_admin', ORG_B, { all: true });

  // ── H1 fixture: one job per client, approved hours, one allocated with a per-person cost ──
  for (const [loc, org] of [[C1, ORG_A], [C2, ORG_A], [LB, ORG_B]] as const) {
    const job = await insertRow('core.jobs', { org_id: org, location_id: loc, name: `Job ${loc.slice(-1)}` });
    await db.query(
      `insert into public.job_labor_hours (org_id, location_id, job_id, employee_id, work_date, hours, standard_rate_cents, source_ref, allocated_cents, accrued_cents)
       values ($1, $2, $3, gen_random_uuid(), '2026-09-10', 8, 4500, $4, 0, 36000)`,
      [org, loc, job, `pm:time:${loc}`],
    );
  }
  // ── H4 fixture: per-company + combined snapshots and events in ORG_A ──
  for (const loc of [C1, C2, null]) {
    await db.query(
      `insert into public.cash_forecast_snapshots (org_id, location_id, anchor_date, opening_cents, closing_cents, weeks, engine_version)
       values ($1, $2, '2026-10-19', 100000, 90000, '[]'::jsonb, 'test')`,
      [ORG_A, loc],
    );
    await db.query(`insert into public.cash_forecast_events (org_id, location_id, event_kind, meta) values ($1, $2, 'SNAPSHOT_TAKEN', '{"written": 1}'::jsonb)`, [ORG_A, loc]);
  }
  await db.query(`insert into public.report_packs (org_id, name, specs, location_ids) values ($1, 'Pack C1', '[]'::jsonb, $2::jsonb)`, [ORG_A, JSON.stringify([C1])]);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('H1 — per-employee job labor cost is not member-readable', () => {
  beforeAll(async () => { await setMode(ORG_A, 'enforce'); });

  it('the comp columns are refused to members; hours / status stay readable', async () => {
    for (const col of ['employee_id', 'standard_rate_cents', 'allocated_cents', 'accrued_cents']) {
      expect(await as('all', () => errorOf(() => db.query(`select ${col} from public.job_labor_hours`))), col).toMatch(/permission denied/);
    }
    for (const col of ['employee_id', 'wages_cents', 'employer_tax_cents', 'benefits_cents', 'amount_cents', 'accrual_reversed_cents']) {
      expect(await as('all', () => errorOf(() => db.query(`select ${col} from public.job_labor_allocation_lines`))), col).toMatch(/permission denied/);
    }
    const rows = await as('all', () => db.query<{ hours: string }>(`select id, job_id, hours, status, allocation_id from public.job_labor_hours`));
    expect(rows.rows).toHaveLength(2);
  });

  it('the comp rows are catalogued as column_revoke (re-applied by core.apply_field_column_masks)', async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from core.field_class_columns
        where field_class = 'comp' and enforcement = 'column_revoke' and table_name in ('job_labor_hours', 'job_labor_allocation_lines')`,
    );
    expect(r.rows[0].n).toBe(10);
  });

  it('v_books_labor_tieout answers per job, pinned to the org and the Books client scope', async () => {
    const all = await as('all', () => db.query<{ location_id: string; accrued_open_cents: string; approved_hours_x100: string }>(
      `select location_id, accrued_open_cents, approved_hours_x100 from public.v_books_labor_tieout order by location_id`));
    expect(all.rows.map((r) => r.location_id)).toEqual([C1, C2]);
    expect(Number(all.rows[0].accrued_open_cents)).toBe(36000);
    expect(Number(all.rows[0].approved_hours_x100)).toBe(800);
    const scoped = await as('scoped', () => db.query<{ location_id: string }>(`select location_id from public.v_books_labor_tieout`));
    expect(scoped.rows.map((r) => r.location_id)).toEqual([C1]);
    const other = await as('b_admin', () => db.query<{ location_id: string }>(`select location_id from public.v_books_labor_tieout`));
    expect(other.rows.map((r) => r.location_id)).toEqual([LB]);
    // a caller-supplied predicate can't widen the pin
    const sneaky = await as('scoped', () => db.query<{ n: number }>(`select count(*)::int as n from public.v_books_labor_tieout where location_id = '${C2}' or true`));
    expect(sneaky.rows[0].n).toBe(1);
  });

  it('off mode: scope not enforced → every company of the org (still never another org)', async () => {
    await setMode(ORG_A, 'off');
    const scoped = await as('scoped', () => db.query<{ location_id: string }>(`select location_id from public.v_books_labor_tieout order by 1`));
    expect(scoped.rows.map((r) => r.location_id)).toEqual([C1, C2]);
    await setMode(ORG_A, 'enforce');
  });
});

describe('H3 — report_packs is SELECT-only for members', () => {
  it('members cannot insert / update / delete; they still read their org', async () => {
    const ins = await as('all', () => errorOf(() => db.query(`insert into public.report_packs (org_id, name, specs) values ('${ORG_A}', 'X', '[]'::jsonb)`)));
    expect(ins).toMatch(/permission denied/);
    const upd = await as('all', () => errorOf(() => db.query(`update public.report_packs set location_ids = '[]'::jsonb`)));
    expect(upd).toMatch(/permission denied/);
    const del = await as('all', () => errorOf(() => db.query(`delete from public.report_packs`)));
    expect(del).toMatch(/permission denied/);
    const read = await as('all', () => db.query(`select id from public.report_packs`));
    expect(read.rows).toHaveLength(1);
  });
});

describe('H4 — the combined cash forecast needs all-clients scope', () => {
  it('enforce: a scoped member sees only its own company rows — never the combined (NULL) row', async () => {
    await setMode(ORG_A, 'enforce');
    const snaps = await as('scoped', () => db.query<{ location_id: string | null }>(`select location_id from public.cash_forecast_snapshots`));
    expect(snaps.rows.map((r) => r.location_id)).toEqual([C1]);
    const evs = await as('scoped', () => db.query<{ location_id: string | null }>(`select location_id from public.cash_forecast_events`));
    expect(evs.rows.map((r) => r.location_id)).toEqual([C1]);
  });

  it('enforce: an all-clients member sees every row, the combined one included', async () => {
    const snaps = await as('all', () => db.query<{ location_id: string | null }>(`select location_id from public.cash_forecast_snapshots`));
    expect(snaps.rows).toHaveLength(3);
    expect(snaps.rows.some((r) => r.location_id === null)).toBe(true);
  });

  it('off: scope not enforced → the org policy alone (unchanged behaviour); another org never', async () => {
    await setMode(ORG_A, 'off');
    const snaps = await as('scoped', () => db.query(`select location_id from public.cash_forecast_snapshots`));
    expect(snaps.rows).toHaveLength(3);
    const other = await as('b_admin', () => db.query(`select location_id from public.cash_forecast_snapshots`));
    expect(other.rows).toHaveLength(0);
    await setMode(ORG_A, 'enforce');
  });
});

describe('idempotency', () => {
  it('re-applying 191, 192 and 194 keeps every fix in place', async () => {
    for (const prefix of ['191', '192', '194']) {
      await applyMigrationFile(db, listMigrationFiles().find((f) => f.startsWith(`${prefix}_`))!);
    }
    expect(await as('all', () => errorOf(() => db.query(`select accrued_cents from public.job_labor_hours`)))).toMatch(/permission denied/);
    expect(await as('all', () => errorOf(() => db.query(`update public.report_packs set name = 'x'`)))).toMatch(/permission denied/);
    const snaps = await as('scoped', () => db.query<{ location_id: string | null }>(`select location_id from public.cash_forecast_snapshots`));
    expect(snaps.rows.map((r) => r.location_id)).toEqual([C1]);
    const view = await as('scoped', () => db.query<{ location_id: string }>(`select location_id from public.v_books_labor_tieout`));
    expect(view.rows.map((r) => r.location_id)).toEqual([C1]);
  });
});
