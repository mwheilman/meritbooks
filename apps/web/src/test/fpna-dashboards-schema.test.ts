/**
 * Migration 191 — FP&A dashboards (FPB-reports-fpna §4.13 AC-W3 / AC-W4).
 *
 *  - members cannot insert / update / delete fpna_dashboards (any row, own or not);
 *  - a member reads the org's tenant defaults and ONLY their own personal dashboards;
 *  - anon reads nothing; another org's rows are invisible;
 *  - one current tenant default per role and one current personal dashboard per person × name;
 *  - CHECKs: owner shape, lock / publish vocab, cards array 1–48, tenant rows carry a publication;
 *  - report_packs.fpna_items exists (array, ≤ 12);
 *  - the 1110 Projects-only seat deny lands on the new table (contract installed like wave3-seat-deny);
 *  - re-running 191 is a no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFile, createTestDb, listMigrationFiles } from './pg';
import { asClaims, errorOf } from './wave3-db-helpers';

const ORG = '11111111-1111-1111-1111-11111111f191';
const OTHER = '22222222-2222-2222-2222-22222222f191';
const ALICE = 'user_fpna_alice';
const BOB = 'user_fpna_bob';

let db: PGlite;

const CARDS = JSON.stringify([{ metric: 'revenue', size: 'm' }, { metric: 'ebitda_margin', size: 'm' }]);

async function insertTenant(org: string, role: string | null, version = 1, current = true): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.fpna_dashboards (org_id, scope_kind, role_key, name, pack_key, cards, lock_level, version, is_current, published_by, published_at)
     values ($1, 'tenant', $2, 'Role default', 'cfo', $3::jsonb, 'add_move', $4, $5, 'user_admin', now()) returning id`,
    [org, role, CARDS, version, current],
  );
  return r.rows[0].id;
}

async function insertUser(org: string, user: string, name = 'Mine'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards) values ($1, 'user', $2, $3, $4::jsonb) returning id`,
    [org, user, name, CARDS],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  for (const [id, slug] of [[ORG, 'fpna-a'], [OTHER, 'fpna-b']] as const) {
    await db.query(`insert into core.organizations (id, name, slug) values ($1, $2, $2) on conflict do nothing`, [id, slug]);
  }
  await insertTenant(ORG, 'cfo');
  await insertTenant(ORG, null);
  await insertUser(ORG, ALICE);
  await insertUser(ORG, BOB);
  await insertUser(OTHER, ALICE);
}, 170_000);

afterAll(async () => {
  await db?.close();
});

describe('191 fpna_dashboards — RLS and the write lock', () => {
  it('a member reads the tenant defaults and only their own personal dashboards (own org only)', async () => {
    const rows = await asClaims(db, 'authenticated', { sub: ALICE, org_id: ORG }, async () =>
      (await db.query<{ scope_kind: string; user_id: string | null; org_id: string }>(`select scope_kind, user_id, org_id from public.fpna_dashboards order by scope_kind, user_id`)).rows,
    );
    expect(rows.filter((r) => r.scope_kind === 'tenant')).toHaveLength(2);
    expect(rows.filter((r) => r.scope_kind === 'user').map((r) => r.user_id)).toEqual([ALICE]);
    expect(rows.every((r) => r.org_id === ORG)).toBe(true);
  });

  it('members cannot insert, update or delete — not even their own rows', async () => {
    await asClaims(db, 'authenticated', { sub: ALICE, org_id: ORG }, async () => {
      expect(await errorOf(db, `insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards) values ($1, 'user', $2, 'x', $3::jsonb)`, [ORG, ALICE, CARDS])).toMatch(/permission denied/);
      expect(await errorOf(db, `update public.fpna_dashboards set name = 'hacked' where user_id = $1`, [ALICE])).toMatch(/permission denied/);
      expect(await errorOf(db, `update public.fpna_dashboards set lock_level = 'unlocked' where scope_kind = 'tenant'`)).toMatch(/permission denied/);
      expect(await errorOf(db, `delete from public.fpna_dashboards where user_id = $1`, [ALICE])).toMatch(/permission denied/);
    });
  });

  it('anon reads nothing', async () => {
    const res = await asClaims(db, 'anon', {}, () => errorOf(db, `select count(*) from public.fpna_dashboards`));
    expect(res).toMatch(/permission denied/);
  });
});

describe('191 fpna_dashboards — integrity', () => {
  it('one current default per role (and per "every role"), one current personal dashboard per person × name', async () => {
    expect(await errorOf(db, `insert into public.fpna_dashboards (org_id, scope_kind, role_key, name, cards, version, published_by, published_at) values ($1, 'tenant', 'cfo', 'v2', $2::jsonb, 2, 'u', now())`, [ORG, CARDS])).toMatch(/duplicate key|unique/);
    expect(await errorOf(db, `insert into public.fpna_dashboards (org_id, scope_kind, role_key, name, cards, version, published_by, published_at) values ($1, 'tenant', null, 'v2', $2::jsonb, 2, 'u', now())`, [ORG, CARDS])).toMatch(/duplicate key|unique/);
    expect(await errorOf(db, `insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards) values ($1, 'user', $2, 'MINE', $3::jsonb)`, [ORG, ALICE, CARDS])).toMatch(/duplicate key|unique/);
    // a superseded version may coexist
    await insertTenant(ORG, 'cfo', 0 + 2, false);
    // another name is a second dashboard
    await insertUser(ORG, ALICE, 'Board view');
  });

  it('CHECKs refuse malformed rows', async () => {
    const bad: Array<[string, unknown[]]> = [
      [`insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards) values ($1, 'team', 'u', 'x', $2::jsonb)`, [ORG, CARDS]],
      [`insert into public.fpna_dashboards (org_id, scope_kind, user_id, role_key, name, cards) values ($1, 'user', 'u', 'cfo', 'x', $2::jsonb)`, [ORG, CARDS]],
      [`insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards, published_by, published_at) values ($1, 'tenant', 'u', 'x', $2::jsonb, 'a', now())`, [ORG, CARDS]],
      [`insert into public.fpna_dashboards (org_id, scope_kind, role_key, name, cards) values ($1, 'tenant', 'owner', 'x', $2::jsonb)`, [ORG, CARDS]],
      [`insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards) values ($1, 'user', 'u2', 'x', '[]'::jsonb)`, [ORG]],
      [`insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards) values ($1, 'user', 'u3', 'x', '{}'::jsonb)`, [ORG]],
      [`insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards, lock_level) values ($1, 'user', 'u4', 'x', $2::jsonb, 'frozen')`, [ORG, CARDS]],
      [`insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards, publish_mode) values ($1, 'user', 'u5', 'x', $2::jsonb, 'always')`, [ORG, CARDS]],
      [`insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards, pack_key) values ($1, 'user', 'u6', 'x', $2::jsonb, 'portfolio')`, [ORG, CARDS]],
      [`insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards) values ($1, 'user', 'u7', '   ', $2::jsonb)`, [ORG, CARDS]],
      [`insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards, version) values ($1, 'user', 'u8', 'x', $2::jsonb, 0)`, [ORG, CARDS]],
    ];
    for (const [sql, params] of bad) expect(await errorOf(db, sql, params), sql).toMatch(/violates check constraint/);
    const many = JSON.stringify(Array.from({ length: 49 }, () => ({ metric: 'revenue', size: 's' })));
    expect(await errorOf(db, `insert into public.fpna_dashboards (org_id, scope_kind, user_id, name, cards) values ($1, 'user', 'u9', 'x', $2::jsonb)`, [ORG, many])).toMatch(/violates check constraint/);
  });

  it('report_packs.fpna_items is an array of at most 12 items', async () => {
    const col = await db.query<{ data_type: string }>(`select data_type from information_schema.columns where table_schema = 'public' and table_name = 'report_packs' and column_name = 'fpna_items'`);
    expect(col.rows[0]?.data_type).toBe('jsonb');
    const pack = await db.query<{ id: string }>(`insert into public.report_packs (org_id, name, specs) values ($1, 'Monthly', '[]'::jsonb) returning id`, [ORG]);
    expect(await errorOf(db, `update public.report_packs set fpna_items = '{}'::jsonb where id = $1`, [pack.rows[0].id])).toMatch(/violates check constraint/);
    const thirteen = JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ dashboardId: String(i) })));
    expect(await errorOf(db, `update public.report_packs set fpna_items = $2::jsonb where id = $1`, [pack.rows[0].id, thirteen])).toMatch(/violates check constraint/);
  });

  it('RLS is enabled with exactly member_read + service_all (before the seat deny)', async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where oid = 'public.fpna_dashboards'::regclass`);
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const pols = await db.query<{ policyname: string }>(`select policyname from pg_policies where schemaname = 'public' and tablename = 'fpna_dashboards' order by policyname`);
    expect(pols.rows.map((p) => p.policyname)).toEqual(['member_read', 'service_all']);
  });

  it('the Projects-only seat deny lands on fpna_dashboards when the 1110 contract exists; re-running 191 is idempotent', async () => {
    await db.exec(`
      create or replace function core.is_projects_only_seat() returns boolean
      language sql stable security definer set search_path = core, public, pg_temp as $$
        select coalesce(current_setting('test.projects_only_seat', true), '') = 'on'
      $$;
      grant execute on function core.is_projects_only_seat() to authenticated, service_role;
      create or replace function core.apply_projects_only_seat_deny(p_table regclass) returns void
      language plpgsql set search_path = core, public, pg_temp as $$
      begin
        execute format('drop policy if exists projects_only_seat_deny on %s', p_table);
        execute format('create policy projects_only_seat_deny on %s as restrictive for all to authenticated '
                       'using (not (select core.is_projects_only_seat())) with check (not (select core.is_projects_only_seat()))', p_table);
      end $$;
    `);
    const file = listMigrationFiles().find((f) => f.startsWith('191_'));
    expect(file).toBeTruthy();
    await applyMigrationFile(db, file as string);
    await applyMigrationFile(db, file as string);
    const pols = await db.query<{ policyname: string; permissive: string }>(`select policyname, permissive from pg_policies where schemaname = 'public' and tablename = 'fpna_dashboards' order by policyname`);
    expect(pols.rows.map((p) => p.policyname)).toEqual(['member_read', 'projects_only_seat_deny', 'service_all']);
    expect(pols.rows.find((p) => p.policyname === 'projects_only_seat_deny')?.permissive).toBe('RESTRICTIVE');
    // a Projects-only seat reads nothing
    await db.query(`select set_config('test.projects_only_seat', 'on', false)`);
    const n = await asClaims(db, 'authenticated', { sub: ALICE, org_id: ORG }, async () => (await db.query<{ n: number }>(`select count(*)::int as n from public.fpna_dashboards`)).rows[0].n);
    await db.query(`select set_config('test.projects_only_seat', '', false)`);
    expect(n).toBe(0);
  });
});
