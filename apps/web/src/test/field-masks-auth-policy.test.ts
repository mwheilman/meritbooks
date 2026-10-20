/**
 * Migration 167 — security findings M4 / M5 / L9 + field masks (R-6) + auth-policy
 * storage (R-7), proven against a real Postgres (PGlite migration replay WITH hosted
 * Supabase's default grants, so the attack surface is real — same harness as
 * identity-write-lock.test.ts).
 *
 *   M4  core.locations / core.customers: members are SELECT-only; the service role
 *       (the app server, after its own permission check) still writes; a reference to
 *       another tenant's row is rejected by the DB.
 *   M5  core.claim_pending_events hands a pending event to exactly one claimer.
 *   L9  ai_* SECURITY DEFINER functions: no anon EXECUTE; members only for their org.
 *   R-6 tin / comp columns are not member-selectable; everything else still is.
 *   R-7 security_policy + ip_allowlists exist and are member read-only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';
import { VENDOR_READ_COLUMNS } from '@/lib/vendors/columns';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const MEMBER = 'user_member_a';
const LOC_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const LOC_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const CUST_A = 'cccccccc-0000-0000-0000-00000000000a';
const VEND_A = 'dddddddd-0000-0000-0000-00000000000a';
const EMP_A = 'eeeeeeee-0000-0000-0000-00000000000a';
const USER_B = 'ffffffff-0000-0000-0000-00000000000b';
const MEMB_B = '99999999-0000-0000-0000-00000000000b';

let db: PGlite;

/** Insert a row filling any NOT NULL, default-less column this schema still has. */
async function insertRow(table: string, values: Record<string, string | number | boolean | null>): Promise<void> {
  const [schema, name] = table.split('.');
  const cols = await db.query<{ column_name: string; udt_name: string; data_type: string }>(
    `select column_name, udt_name, data_type from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_nullable = 'NO' and column_default is null
        and is_generated = 'NEVER'`,
    [schema, name],
  );
  const names = Object.keys(values);
  const params: unknown[] = names.map((n) => values[n]);
  const exprs = names.map((_, i) => `$${i + 1}`);
  for (const c of cols.rows) {
    if (names.includes(c.column_name)) continue;
    const label = await db.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder limit 1`,
      [c.udt_name],
    );
    names.push(c.column_name);
    if (label.rows[0]) { params.push(label.rows[0].enumlabel); exprs.push(`$${params.length}::${c.udt_name}`); }
    else if (/int|numeric/.test(c.udt_name)) { params.push(1); exprs.push(`$${params.length}`); }
    else if (c.udt_name === 'bool') { params.push(false); exprs.push(`$${params.length}`); }
    else if (c.udt_name === 'uuid') { params.push(crypto.randomUUID()); exprs.push(`$${params.length}`); }
    else if (c.udt_name === 'date') { params.push('2026-01-01'); exprs.push(`$${params.length}`); }
    else { params.push(`x-${Math.random().toString(36).slice(2, 8)}`); exprs.push(`$${params.length}`); }
  }
  await db.query(`insert into ${table} (${names.map((n) => `"${n}"`).join(', ')}) values (${exprs.join(', ')})`, params);
}

async function asRole<T>(
  role: 'authenticated' | 'anon' | 'service_role',
  fn: () => Promise<T>,
  claims: Record<string, string> = { sub: MEMBER, org_id: ORG_A, role: 'authenticated' },
): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    role === 'anon' ? JSON.stringify({ role: 'anon' }) : role === 'service_role' ? JSON.stringify({ role: 'service_role' }) : JSON.stringify(claims),
  ]);
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

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  // Hosted Supabase's service_role has BYPASSRLS (the app server's admin client).
  await db.exec('alter role service_role bypassrls');
  await db.exec(`
    insert into core.organizations (id, name, slug) values
      ('${ORG_A}', 'Tenant A', 'tenant-a'), ('${ORG_B}', 'Tenant B', 'tenant-b');
  `);
  await insertRow('core.locations', { id: LOC_A, org_id: ORG_A, name: 'Client A', short_code: 'CLA' });
  await insertRow('core.locations', { id: LOC_B, org_id: ORG_B, name: 'Client B', short_code: 'CLB' });
  await insertRow('core.customers', { id: CUST_A, org_id: ORG_A, name: 'Customer A' });
  await insertRow('core.vendors', { id: VEND_A, org_id: ORG_A, name: 'Vendor A', tin_encrypted: '12-3456789' });
  await insertRow('core.employees', {
    id: EMP_A, org_id: ORG_A, clerk_user_id: MEMBER, role: 'business_user', first_name: 'T', last_name: 'U',
    hourly_rate_cents: 5000, annual_salary_cents: null,
  });
  await insertRow('core.users', { id: USER_B, clerk_user_id: 'user_b' });
  await insertRow('core.memberships', { id: MEMB_B, org_id: ORG_B, user_id: USER_B });
}, 300_000);

afterAll(async () => {
  await db?.close();
});

// ── M4 ──────────────────────────────────────────────────────────────────────────
describe('M4 — core.locations / core.customers are member read-only', () => {
  for (const table of ['core.locations', 'core.customers']) {
    for (const role of ['authenticated', 'anon'] as const) {
      it(`${role} cannot INSERT / UPDATE / DELETE / TRUNCATE ${table}`, async () => {
        const errs = await asRole(role, async () => ({
          insert: await errorOf(`insert into ${table} default values`),
          update: await errorOf(`update ${table} set name = name where true`),
          del: await errorOf(`delete from ${table} where true`),
          truncate: await errorOf(`truncate ${table}`),
        }));
        for (const [k, v] of Object.entries(errs)) expect(v, `${table} ${k}`).toMatch(/permission denied/i);
      });
    }
  }

  it('members still read their own tenant’s clients and customers (and only those)', async () => {
    const locs = await asRole('authenticated', () => db.query<{ id: string }>(`select id from core.locations order by id`));
    expect(locs.rows.map((r) => r.id)).toEqual([LOC_A]);
    const custs = await asRole('authenticated', () => db.query<{ id: string }>(`select id from core.customers`));
    expect(custs.rows.map((r) => r.id)).toEqual([CUST_A]);
  });

  it('the app path (service role, after its own permission check) still writes', async () => {
    const res = await asRole('service_role', () =>
      db.query(`update core.locations set tags = array['HVAC'] where id = $1 and org_id = $2 returning id`, [LOC_A, ORG_A]));
    expect(res.rows).toHaveLength(1);
    const c = await asRole('service_role', () =>
      db.query(`update core.customers set name = 'Customer A2' where id = $1 and org_id = $2 returning id`, [CUST_A, ORG_A]));
    expect(c.rows).toHaveLength(1);
  });

  it('catalog: no member write policy and no member write grant on either table', async () => {
    for (const [schema, table] of [['core', 'locations'], ['core', 'customers']]) {
      const pols = await db.query<{ policyname: string }>(
        `select policyname from pg_policies where schemaname = $1 and tablename = $2 and permissive = 'PERMISSIVE'
           and cmd <> 'SELECT' and roles::text <> '{service_role}'`, [schema, table]);
      expect(pols.rows, `${schema}.${table}`).toEqual([]);
      for (const role of ['authenticated', 'anon']) {
        for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          const g = await db.query<{ ok: boolean }>(`select has_table_privilege($1, $2, $3) ok`, [role, `${schema}.${table}`, priv]);
          expect(g.rows[0].ok, `${role} ${priv} ${schema}.${table}`).toBe(false);
        }
      }
    }
  });

  it('a customer cannot reference another tenant’s client (location_id / related_location_id)', async () => {
    const e1 = await errorOf(`update core.customers set location_id = $1 where id = $2`, [LOC_B, CUST_A]);
    expect(e1).toMatch(/not a client of tenant/);
    const e2 = await errorOf(`update core.customers set related_location_id = $1 where id = $2`, [LOC_B, CUST_A]);
    expect(e2).toMatch(/not a client of tenant/);
    expect(await errorOf(`update core.customers set location_id = $1 where id = $2`, [LOC_A, CUST_A])).toBeNull();
  });

  it('a client’s primary contact cannot be another tenant’s membership', async () => {
    const e = await errorOf(`update core.locations set primary_contact_membership_id = $1 where id = $2`, [MEMB_B, LOC_A]);
    expect(e).toMatch(/not a seat in tenant/);
  });
});

// ── M5 ──────────────────────────────────────────────────────────────────────────
describe('M5 — atomic event claim', () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      await db.query(
        `insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, created_at)
         values ($1, gen_random_uuid(), 'JOB_BILLING', 'projects', '{"lines":[{"amount_cents":100}]}', '2026-06-01', now() + make_interval(secs => $2))`,
        [ORG_A, i],
      );
    }
  });

  it('two interleaved claimers never receive the same event', async () => {
    const claim = (token: string, limit: number) => asRole('service_role', () => db.query<{ id: string }>(
      `select id from core.claim_pending_events('JOB_BILLING', $1, null, $2, $3, 900)`, [ORG_A, limit, token]));
    const a = await claim('drain:a', 2);
    const b = await claim('drain:b', 10);
    const c = await claim('drain:c', 10);
    expect(a.rows).toHaveLength(2);
    expect(b.rows).toHaveLength(1);
    expect(c.rows).toHaveLength(0);
    const overlap = a.rows.filter((r) => b.rows.some((x) => x.id === r.id));
    expect(overlap).toEqual([]);
  });

  it('a released claim, or an expired lease, becomes claimable again; a processed row never is', async () => {
    const released = await asRole('service_role', () => db.query<{ n: number }>(`select core.release_event_claims('drain:b') n`));
    expect(Number(released.rows[0].n)).toBe(1);
    const again = await asRole('service_role', () => db.query<{ id: string }>(
      `select id from core.claim_pending_events('JOB_BILLING', $1, null, 10, 'drain:d', 900)`, [ORG_A]));
    expect(again.rows).toHaveLength(1);

    // drain:a crashed — age its lease past 900 s; drain:e reclaims it.
    await db.query(`update core.events set claimed_at = now() - interval '20 minutes' where claimed_by = 'drain:a'`);
    await db.query(`update core.events set status = 'processed' where claimed_by = 'drain:d'`);
    const reclaimed = await asRole('service_role', () => db.query<{ id: string; claimed_by: string }>(
      `select id, claimed_by from core.claim_pending_events('JOB_BILLING', $1, null, 10, 'drain:e', 900)`, [ORG_A]));
    expect(reclaimed.rows).toHaveLength(2);
    expect(reclaimed.rows.every((r) => r.claimed_by === 'drain:e')).toBe(true);
  });

  it('members and anon cannot call the claim functions', async () => {
    for (const role of ['authenticated', 'anon'] as const) {
      const e = await asRole(role, () => errorOf(`select * from core.claim_pending_events('JOB_BILLING', null, null, 1, 't', 900)`));
      expect(e, role).toMatch(/permission denied/i);
    }
  });
});

// ── L9 ──────────────────────────────────────────────────────────────────────────
describe('L9 — ai_* SECURITY DEFINER functions', () => {
  const fns = [
    'core.ai_bump_rate(uuid, text, text)',
    'core.ai_increment_counter(uuid, date, text, text, bigint)',
    'core.ai_concurrency_acquire(uuid, integer, integer, uuid)',
    'core.ai_concurrency_release(uuid)',
  ];

  it('anon and PUBLIC cannot execute any of them; authenticated + service_role can', async () => {
    for (const f of fns) {
      const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') anon,
                has_function_privilege('authenticated', $1, 'execute') auth,
                has_function_privilege('service_role', $1, 'execute') svc`, [f]);
      expect(r.rows[0], f).toEqual({ anon: false, auth: true, svc: true });
    }
  });

  it('a member can meter their OWN tenant but not another tenant', async () => {
    const own = await asRole('authenticated', () => errorOf(`select core.ai_bump_rate($1, 'TENANT', 'k')`, [ORG_A]));
    expect(own).toBeNull();
    const other = await asRole('authenticated', () => errorOf(`select core.ai_bump_rate($1, 'TENANT', 'k')`, [ORG_B]));
    expect(other).toMatch(/not the caller's tenant/);
    const inc = await asRole('authenticated', () =>
      errorOf(`select core.ai_increment_counter($1, '2026-10-01', 'TENANT', '', 999999)`, [ORG_B]));
    expect(inc).toMatch(/not the caller's tenant/);
    const svc = await asRole('service_role', () => errorOf(`select core.ai_bump_rate($1, 'TENANT', 'k')`, [ORG_B]));
    expect(svc).toBeNull();
  });

  it('a member cannot reset the AI budget by writing the metering tables directly', async () => {
    for (const t of ['core.ai_usage_counters', 'core.ai_rate_buckets', 'core.ai_inflight']) {
      const e = await asRole('authenticated', () => errorOf(`delete from ${t} where true`));
      expect(e, t).toMatch(/permission denied/i);
    }
    const upd = await asRole('authenticated', () => errorOf(`update core.ai_usage_log set cost_cents = 0 where true`));
    expect(upd).toMatch(/permission denied/i);
  });
});

// ── R-6 ─────────────────────────────────────────────────────────────────────────
describe('R-6 — sensitive columns are not member-selectable', () => {
  it('authenticated cannot select the TIN or pay-rate columns (nor select *)', async () => {
    for (const sql of [
      `select tin_encrypted from core.vendors`,
      `select * from core.vendors`,
      `select hourly_rate_cents from core.employees`,
      `select annual_salary_cents from core.employees`,
    ]) {
      const e = await asRole('authenticated', () => errorOf(sql));
      expect(e, sql).toMatch(/permission denied/i);
    }
  });

  it('every app-listed vendor column and every unmasked column stays readable', async () => {
    const vend = await asRole('authenticated', () =>
      db.query<{ id: string }>(`select ${VENDOR_READ_COLUMNS.map((c) => `"${c}"`).join(', ')} from core.vendors`));
    expect(vend.rows.map((r) => r.id)).toEqual([VEND_A]);
    // Drift guard: any column on a masked table that is NOT registered as masked must
    // be selectable by members (else a later migration added a column without
    // re-running core.apply_field_column_masks()).
    const cols = await db.query<{ table_schema: string; table_name: string; column_name: string }>(
      `select c.table_schema, c.table_name, c.column_name from information_schema.columns c
        where (c.table_schema, c.table_name) in (select distinct schema_name, table_name from core.field_class_columns where enforcement = 'column_revoke')
          and not exists (select 1 from core.field_class_columns f where f.schema_name = c.table_schema
                            and f.table_name = c.table_name and f.column_name = c.column_name and f.enforcement = 'column_revoke')`);
    expect(cols.rows.length).toBeGreaterThan(10);
    for (const c of cols.rows) {
      const ok = await db.query<{ ok: boolean }>(
        `select has_column_privilege('authenticated', $1, $2, 'SELECT') ok`, [`${c.table_schema}.${c.table_name}`, c.column_name]);
      expect(ok.rows[0].ok, `${c.table_name}.${c.column_name}`).toBe(true);
    }
  });

  it('the server (service role) still reads them; re-applying the masks is idempotent', async () => {
    const r = await asRole('service_role', () => db.query<{ tin_encrypted: string }>(`select tin_encrypted from core.vendors`));
    expect(r.rows[0].tin_encrypted).toBe('12-3456789');
    await db.query(`select core.apply_field_column_masks()`);
    const e = await asRole('authenticated', () => errorOf(`select tin_encrypted from core.vendors`));
    expect(e).toMatch(/permission denied/i);
  });

  it('field reveals are append-only and member read-only', async () => {
    await asRole('service_role', () => db.query(
      `insert into core.field_reveals (org_id, clerk_user_id, field_class, subject_table, subject_id, reason)
       values ($1, $2, 'tin', 'vendors', $3, 'W-9 check')`, [ORG_A, MEMBER, VEND_A]));
    const upd = await errorOf(`update core.field_reveals set reason = 'x' where true`);
    expect(upd).toMatch(/append-only/);
    const ins = await asRole('authenticated', () => errorOf(
      `insert into core.field_reveals (org_id, clerk_user_id, field_class, subject_table, subject_id, reason) values ($1,'u','tin','vendors','v','because')`, [ORG_A]));
    expect(ins).toMatch(/permission denied/i);
    const seen = await asRole('authenticated', () => db.query(`select id from core.field_reveals`));
    expect(seen.rows).toHaveLength(1);
  });
});

// ── R-7 ─────────────────────────────────────────────────────────────────────────
describe('R-7 — tenant security policy storage', () => {
  it('organizations.security_policy defaults to {} (every policy off) and must be an object', async () => {
    const r = await db.query<{ p: unknown }>(`select security_policy p from core.organizations where id = $1`, [ORG_A]);
    expect(r.rows[0].p).toEqual({});
    expect(await errorOf(`update core.organizations set security_policy = '[]' where id = $1`, [ORG_A])).toMatch(/security_policy_obj_chk/);
  });

  it('ip_allowlists: members read their own, cannot write', async () => {
    await asRole('service_role', () => db.query(
      `insert into core.ip_allowlists (org_id, name, cidrs) values ($1, 'Office', array['203.0.113.0/24']::cidr[])`, [ORG_A]));
    const read = await asRole('authenticated', () => db.query<{ name: string }>(`select name from core.ip_allowlists`));
    expect(read.rows.map((r) => r.name)).toEqual(['Office']);
    const w = await asRole('authenticated', () => errorOf(`delete from core.ip_allowlists where true`));
    expect(w).toMatch(/permission denied/i);
    // organizations stays write-locked (154): a member cannot switch the policy off.
    const off = await asRole('authenticated', () => errorOf(`update core.organizations set security_policy = '{}' where true`));
    expect(off).toMatch(/permission denied/i);
  });
});
