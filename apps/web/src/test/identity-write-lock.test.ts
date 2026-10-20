/**
 * Identity / RBAC / approval-control write lock (migration 154) — CRITICAL
 * privilege-escalation guard.
 *
 * PostgREST exposes public/core/proj and accepts members' Clerk tokens
 * (role=authenticated, org_id=<tenant>). Before 154, member RLS policies of the form
 * `FOR ALL USING (org_id = get_org_id())` let any signed-in member write the tables
 * that DECIDE authority — e.g. `UPDATE core.employees SET role='company_admin'` on
 * their own row, or `UPDATE core.users SET is_platform_staff=true`.
 *
 * This suite replays migrations into PGlite WITH hosted Supabase's default role
 * grants (so the attack surface is real, not vacuously closed), then:
 *   1. NEGATIVE CONTROL — at migration 153 an authenticated member CAN self-promote
 *      and self-flag as platform staff (proves the harness reproduces the hole);
 *   2. applies 154 (and every later migration) and proves authenticated + anon can
 *      no longer INSERT / UPDATE / DELETE / TRUNCATE any locked table, while
 *      member reads keep their tenant-scoped semantics and service_role still writes;
 *   3. pins the catalog: RLS on, no member-facing write policy, no write GRANT;
 *   4. statically scans every migration AFTER 154 so a future file cannot quietly
 *      re-grant writes or add a member write policy on a locked table.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, listMigrationFiles, applyMigrationFile } from './pg';

/** Every table migration 154 locks to SELECT-only for members. Keep in sync with 154. */
const LOCKED_TABLES: ReadonlyArray<readonly [schema: string, table: string]> = [
  ['core', 'employees'],
  ['core', 'custom_roles'],
  ['core', 'role_permission_overrides'],
  ['public', 'role_permission_overrides'],
  ['public', 'employee_locations'],
  ['core', 'practice_assignments'],
  ['core', 'organizations'],
  ['core', 'users'],
  ['public', 'approvals'],
  ['public', 'approval_steps'],
  ['public', 'approval_workflows'],
  ['public', 'approval_workflow_steps'],
  ['public', 'approval_requests'],
  ['public', 'approval_request_actions'],
  ['public', 'autonomy_settings'],
  ['public', 'autonomy_kill_switch'],
  ['public', 'ap_approval_policies'],
  ['public', 'cost_approval_rules'],
];

/** Service-only by policy before 154; 154 also strips their member write GRANTs. */
const GRANT_LOCKED_TABLES: ReadonlyArray<readonly [string, string]> = [
  ['core', 'memberships'],
  ['core', 'membership_locations'],
  ['core', 'platform_admin_sessions'],
  ['core', 'membership_invitations'],
];

const LOCK_MIGRATION = '154';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const MEMBER = 'user_member_a';
const MEMBER_EMP = '33333333-3333-3333-3333-333333333331';
const OTHER_EMP = '33333333-3333-3333-3333-333333333332';

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true, through: '153' }));

  // Seed as the superuser (migration runner): two tenants, a plain member in A, a
  // seat in B, and the member's identity row.
  await db.exec(`
    insert into core.organizations (id, name, slug) values
      ('${ORG_A}', 'Tenant A', 'tenant-a'),
      ('${ORG_B}', 'Tenant B', 'tenant-b');
  `);
  await insertEmployee(MEMBER_EMP, ORG_A, MEMBER, 'business_user');
  await insertEmployee(OTHER_EMP, ORG_B, 'user_other_b', 'company_admin');
  await db.query(`insert into core.users (clerk_user_id) values ($1)`, [MEMBER]);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

/** Insert an employee filling whatever NOT NULL columns this schema still has. */
async function insertEmployee(id: string, orgId: string, clerk: string, role: string): Promise<void> {
  const cols = await db.query<{ column_name: string; udt_name: string }>(
    `select column_name, udt_name from information_schema.columns
      where table_schema = 'core' and table_name = 'employees'
        and is_nullable = 'NO' and column_default is null`,
  );
  const values: Record<string, string> = {
    id, org_id: orgId, clerk_user_id: clerk, role, first_name: 'T', last_name: 'User',
  };
  const names = Object.keys(values);
  const exprs = names.map((_, i) => `$${i + 1}`);
  const params: string[] = names.map((n) => values[n]);
  for (const c of cols.rows) {
    if (names.includes(c.column_name)) continue;
    // Any remaining required column is an enum/text without a default — take the
    // first enum label, or a placeholder for text.
    const label = await db.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = $1 order by e.enumsortorder limit 1`,
      [c.udt_name],
    );
    names.push(c.column_name);
    params.push(label.rows[0]?.enumlabel ?? 'x');
    exprs.push(label.rows[0] ? `$${params.length}::${c.udt_name}` : `$${params.length}`);
  }
  await db.query(
    `insert into core.employees (${names.join(', ')}) values (${exprs.join(', ')})`,
    params,
  );
}

/**
 * Run `fn` as a PostgREST caller: SET ROLE + request.jwt.claims exactly as Supabase
 * does for a member's Clerk token. Always resets back to the superuser.
 */
async function asRole<T>(
  role: 'authenticated' | 'anon' | 'service_role',
  fn: () => Promise<T>,
  claims: Record<string, string> = { sub: MEMBER, org_id: ORG_A, role: 'authenticated' },
): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    role === 'anon' ? '{}' : JSON.stringify(claims),
  ]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

/** The error message of a statement, or null when it succeeded. */
async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('migration 154 — before (negative control: the hole is real)', () => {
  it('at 153 an authenticated member CAN self-promote to company_admin', async () => {
    const res = await asRole('authenticated', () =>
      db.query(`update core.employees set role = 'company_admin' where clerk_user_id = $1 returning id`, [MEMBER]),
    );
    expect(res.rows).toHaveLength(1);
    await db.query(`update core.employees set role = 'business_user' where id = $1`, [MEMBER_EMP]);
  });

  it('at 153 an authenticated member CAN flag themselves platform staff', async () => {
    const res = await asRole('authenticated', () =>
      db.query(`update core.users set is_platform_staff = true where clerk_user_id = $1 returning id`, [MEMBER]),
    );
    expect(res.rows).toHaveLength(1);
    await db.query(`update core.users set is_platform_staff = false where clerk_user_id = $1`, [MEMBER]);
  });
});

describe('migration 154 — after (members are SELECT-only on identity/control tables)', () => {
  beforeAll(async () => {
    const rest = listMigrationFiles().filter((f) => f.slice(0, 3) > '153');
    expect(rest[0]?.startsWith(`${LOCK_MIGRATION}_`)).toBe(true);
    for (const f of rest) await applyMigrationFile(db, f);
  }, 120_000);

  it('a member can no longer self-promote (permission denied, role unchanged)', async () => {
    const err = await asRole('authenticated', () =>
      errorOf(`update core.employees set role = 'company_admin' where clerk_user_id = $1`, [MEMBER]),
    );
    expect(err).toMatch(/permission denied for (table|relation)/i);
    const r = await db.query<{ role: string }>(`select role from core.employees where id = $1`, [MEMBER_EMP]);
    expect(r.rows[0].role).toBe('business_user');
  });

  it('a member can no longer set is_platform_staff on their own core.users row', async () => {
    const err = await asRole('authenticated', () =>
      errorOf(`update core.users set is_platform_staff = true where clerk_user_id = $1`, [MEMBER]),
    );
    expect(err).toMatch(/permission denied for (table|relation)/i);
    const r = await db.query<{ is_platform_staff: boolean }>(
      `select is_platform_staff from core.users where clerk_user_id = $1`,
      [MEMBER],
    );
    expect(r.rows[0].is_platform_staff).toBe(false);
  });

  for (const [schema, table] of [...LOCKED_TABLES, ...GRANT_LOCKED_TABLES]) {
    const qualified = `${schema}.${table}`;
    for (const role of ['authenticated', 'anon'] as const) {
      it(`${role} cannot INSERT / UPDATE / DELETE / TRUNCATE ${qualified}`, async () => {
        const exists = await db.query<{ r: string | null }>(`select to_regclass($1)::text r`, [qualified]);
        if (!exists.rows[0].r) return; // table not in this schema version
        const col = await db.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = $1 and table_name = $2 order by ordinal_position limit 1`,
          [schema, table],
        );
        const c = `"${col.rows[0].column_name}"`;
        const errs = await asRole(role, async () => ({
          insert: await errorOf(`insert into ${qualified} default values`),
          update: await errorOf(`update ${qualified} set ${c} = ${c} where false`),
          del: await errorOf(`delete from ${qualified} where false`),
          truncate: await errorOf(`truncate ${qualified}`),
        }));
        expect(errs.insert, 'insert').toMatch(/permission denied for (table|relation)/i);
        expect(errs.update, 'update').toMatch(/permission denied for (table|relation)/i);
        expect(errs.del, 'delete').toMatch(/permission denied for (table|relation)/i);
        expect(errs.truncate, 'truncate').toMatch(/permission denied for (table|relation)/i);
      });
    }
  }

  it('member reads keep tenant-scoped semantics (own org only, own users row only)', async () => {
    const emps = await asRole('authenticated', () =>
      db.query<{ id: string }>(`select id from core.employees order by id`),
    );
    expect(emps.rows.map((r) => r.id)).toEqual([MEMBER_EMP]);

    const orgs = await asRole('authenticated', () => db.query<{ id: string }>(`select id from core.organizations`));
    expect(orgs.rows.map((r) => r.id)).toEqual([ORG_A]);

    const users = await asRole('authenticated', () =>
      db.query<{ clerk_user_id: string }>(`select clerk_user_id from core.users`),
    );
    expect(users.rows.map((r) => r.clerk_user_id)).toEqual([MEMBER]);
  });

  it('service_role (the app server, after its own authz) can still write', async () => {
    const res = await asRole(
      'service_role',
      () => db.query(`update core.employees set role = 'accounting_manager' where id = $1 returning id`, [MEMBER_EMP]),
      { role: 'service_role' },
    );
    expect(res.rows).toHaveLength(1);
    await db.query(`update core.employees set role = 'business_user' where id = $1`, [MEMBER_EMP]);
  });

  it('catalog: RLS enabled, only SELECT (or service_role-only) policies, no member write GRANT', async () => {
    for (const [schema, table] of LOCKED_TABLES) {
      const qualified = `${schema}.${table}`;
      const exists = await db.query<{ r: string | null }>(`select to_regclass($1)::text r`, [qualified]);
      if (!exists.rows[0].r) continue;

      const rls = await db.query<{ on: boolean }>(
        `select c.relrowsecurity as on from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relname = $2`,
        [schema, table],
      );
      expect(rls.rows[0].on, `${qualified} RLS`).toBe(true);

      const writePolicies = await db.query<{ policyname: string; cmd: string; roles: string }>(
        `select policyname, cmd, roles::text as roles from pg_policies
          where schemaname = $1 and tablename = $2
            and cmd <> 'SELECT' and roles::text <> '{service_role}'`,
        [schema, table],
      );
      expect(writePolicies.rows, `${qualified} member write policies`).toEqual([]);

      for (const role of ['authenticated', 'anon']) {
        for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          const g = await db.query<{ ok: boolean }>(`select has_table_privilege($1, $2, $3) ok`, [role, qualified, priv]);
          expect(g.rows[0].ok, `${role} ${priv} on ${qualified}`).toBe(false);
        }
      }
    }
  });
});

describe('static guard — no later migration may re-open member writes on a locked table', () => {
  const MIGRATIONS_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/supabase/migrations',
  );

  it('migration 154 still locks every table this guard lists', () => {
    const file = listMigrationFiles().find((f) => f.startsWith(`${LOCK_MIGRATION}_`));
    expect(file).toBeTruthy();
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file!), 'utf8');
    for (const [schema, table] of LOCKED_TABLES) {
      expect(sql, `${schema}.${table} missing from 154`).toMatch(
        new RegExp(`\\('${schema}',\\s*'${table}'`),
      );
    }
  });

  it('no migration after 154 grants writes or adds a member write policy on a locked table', () => {
    const later = listMigrationFiles().filter((f) => f.slice(0, 3) > LOCK_MIGRATION);
    const offenders: string[] = [];
    for (const f of later) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').replace(/--[^\n]*/g, '');
      for (const [, table] of [...LOCKED_TABLES, ...GRANT_LOCKED_TABLES]) {
        const t = `(?:"?\\w+"?\\.)?"?${table}"?`;
        const grant = new RegExp(
          `grant\\s+[^;]*\\b(insert|update|delete|truncate|all)\\b[^;]*\\bon\\s+(?:table\\s+)?${t}\\b[^;]*\\bto\\s+[^;]*\\b(authenticated|anon|public)\\b`,
          'i',
        );
        const policy = new RegExp(`create\\s+policy\\s+[^;]*\\bon\\s+${t}\\b([^;]*)`, 'ig');
        if (grant.test(sql)) offenders.push(`${f}: write GRANT on ${table}`);
        let m: RegExpExecArray | null;
        while ((m = policy.exec(sql)) !== null) {
          const body = m[1];
          const isWrite = !/\bfor\s+select\b/i.test(body);
          const serviceOnly = /\bto\s+service_role\b/i.test(body);
          if (isWrite && !serviceOnly) offenders.push(`${f}: member write policy on ${table}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
