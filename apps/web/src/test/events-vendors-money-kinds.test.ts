/**
 * Wave 2F — migration 168.
 *
 *   1. core.events / core.vendors are SELECT-only for members: anon and authenticated
 *      cannot INSERT / UPDATE / DELETE / TRUNCATE them (a member could otherwise forge a
 *      JOB_BILLING event the drain turns into an AR invoice + GL post); members still read
 *      their own tenant; the service role still writes.
 *   2. The AR-refund gap in the R-2 backfill is closed for a tenant that was ALREADY
 *      provisioned before 168 (158–161 are live): every role that legacy-approves money
 *      gets pay.refunds:approve, every role that releases AP payments gets
 *      pay.refunds:release — as a NEW published version (published versions are never
 *      edited), idempotently, logged as a backfill.
 *
 * Replays migrations through 167, provisions a tenant (the live state), then applies 168.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFile, createTestDb, listMigrationFiles } from './pg';
import {
  MONEY_APPROVE_CELLS,
  applyCellOverrides,
  expandLegacyCells,
  grantMapToRows,
  legacyRoleCells,
  moneyReleaseGrants,
  subtractGrants,
  type GrantMap,
} from '@/lib/rbac/legacy-map';
import type { UserRole } from '@/lib/rbac/permissions';

const ORG = 'aaaaaaaa-0000-0000-0000-0000000002f1';
const ORG_B = 'bbbbbbbb-0000-0000-0000-0000000002f1';
const OWN = 'aaaaaaaa-2f2f-0000-0000-000000000000';
const L1 = 'aaaaaaaa-2f2f-0000-0000-000000000001';
const LB = 'bbbbbbbb-2f2f-0000-0000-000000000001';

const ROLES: ReadonlyArray<{ role: UserRole; membershipRole: string; locations: string[] }> = [
  { role: 'company_admin', membershipRole: 'owner', locations: [] },
  { role: 'cfo', membershipRole: 'cfo', locations: [] },
  { role: 'merit_controller', membershipRole: 'merit_controller', locations: [] },
  { role: 'assistant_cfo', membershipRole: 'assistant_cfo', locations: [] },
  { role: 'accounting_manager', membershipRole: 'accounting_manager', locations: [] },
  { role: 'accounting_specialist', membershipRole: 'accounting_specialist', locations: [L1] },
  { role: 'check_processor', membershipRole: 'check_processor', locations: [L1] },
  { role: 'general_admin', membershipRole: 'general_admin', locations: [L1] },
  { role: 'business_user', membershipRole: 'business_user', locations: [L1] },
];
/** A mig-130 override that makes cfo a money approver through bills:approve only. */
const CFO_OVERRIDES: Record<string, boolean> = { 'bills::approve': true };
const CUSTOM_KEY = 'ap_lead_2f';
const CUSTOM_OVERRIDES: Record<string, boolean> = { 'bills::approve': true };
const DRAFT_KEY = 'ap_lead_draft_2f';

let db: PGlite;
const memberIds = new Map<string, string>();
const clerkOf = (label: string) => `user2f_${label}`;

async function insertRow(schema: string, table: string, values: Record<string, unknown>): Promise<void> {
  const cols = await db.query<{ column_name: string; udt_name: string }>(
    `select column_name, udt_name from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_nullable = 'NO' and column_default is null
        and is_generated = 'NEVER'`,
    [schema, table],
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
    if (label.rows[0]) {
      params.push(label.rows[0].enumlabel);
      exprs.push(`$${params.length}::${c.udt_name}`);
    } else if (/int|numeric/.test(c.udt_name)) {
      params.push(0);
      exprs.push(`$${params.length}`);
    } else if (c.udt_name === 'bool') {
      params.push(false);
      exprs.push(`$${params.length}`);
    } else {
      params.push('x');
      exprs.push(`$${params.length}`);
    }
  }
  await db.query(`insert into ${schema}.${table} (${names.join(', ')}) values (${exprs.join(', ')})`, params);
}

async function addMember(label: string, orgId: string, membershipRole: string, employeeRole: string, locations: string[]): Promise<void> {
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [clerkOf(label)]);
  const m = await db.query<{ id: string }>(
    `insert into core.memberships (user_id, org_id, role) values ($1, $2, $3) returning id`,
    [u.rows[0].id, orgId, membershipRole],
  );
  memberIds.set(label, m.rows[0].id);
  const empId = crypto.randomUUID();
  await insertRow('core', 'employees', { id: empId, org_id: orgId, clerk_user_id: clerkOf(label), role: employeeRole, first_name: 'T', last_name: label, is_active: true });
  for (const loc of locations) await insertRow('public', 'employee_locations', { org_id: orgId, employee_id: empId, location_id: loc });
}

const has = async (label: string, cap: string, action: string, loc: string | null = null): Promise<boolean> => {
  const r = await db.query<{ ok: boolean }>(`select core.membership_has_capability($1, $2, $3, $4) as ok`, [memberIds.get(label), cap, action, loc]);
  return r.rows[0]?.ok === true;
};

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function asCaller<T>(role: 'authenticated' | 'anon', orgId: string | null, fn: () => Promise<T>): Promise<T> {
  const claims = role === 'anon' ? {} : { sub: clerkOf('accounting_specialist'), org_id: orgId, role: 'authenticated' };
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

const cellsOf = (role: UserRole): Set<string> =>
  role === 'cfo' ? applyCellOverrides(legacyRoleCells(role), CFO_OVERRIDES) : legacyRoleCells(role);
const isMoneyApprover = (role: UserRole) => MONEY_APPROVE_CELLS.some((c) => cellsOf(role).has(c));
const releasesAp = (role: UserRole) => cellsOf(role).has('ap_disbursement_release::run');

const asMap = (rows: Array<{ capability: string; actions: readonly string[] }>): Record<string, string[]> =>
  Object.fromEntries(rows.map((r) => [r.capability, [...r.actions]]));
const mapObj = (m: GrantMap) => asMap(grantMapToRows(m));

let preRefundApprove: Record<string, boolean> = {};
let versionsBefore: Record<string, number> = {};
let draftRoleId = '';

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true, through: '167' }));
  await db.exec(`
    insert into core.organizations (id, name, slug, tenant_type) values
      ('${ORG}', 'Firm 2F', 'firm-2f', 'firm'),
      ('${ORG_B}', 'Company 2F', 'company-2f', 'company');
  `);
  await insertRow('core', 'locations', { id: OWN, org_id: ORG, name: 'Firm 2F LLC', short_code: 'OWN', is_management_company: true });
  await insertRow('core', 'locations', { id: L1, org_id: ORG, name: 'Client One', short_code: 'C1' });
  await insertRow('core', 'locations', { id: LB, org_id: ORG_B, name: 'B Main', short_code: 'BM' });

  for (const r of ROLES) await addMember(r.role, ORG, r.membershipRole, r.role, r.locations);
  for (const [cell, allowed] of Object.entries(CFO_OVERRIDES)) {
    const [feature, action] = cell.split('::');
    await db.query(`insert into core.role_permission_overrides (org_id, role_key, feature, action, allowed) values ($1, 'cfo', $2, $3, $4)`, [ORG, feature, action, allowed]);
  }
  await db.query(`insert into core.custom_roles (org_id, key, name, base_role) values ($1, $2, 'AP lead', 'accounting_specialist')`, [ORG, CUSTOM_KEY]);
  for (const [cell, allowed] of Object.entries(CUSTOM_OVERRIDES)) {
    const [feature, action] = cell.split('::');
    await db.query(`insert into core.role_permission_overrides (org_id, role_key, feature, action, allowed) values ($1, $2, $3, $4, $5)`, [ORG, CUSTOM_KEY, feature, action, allowed]);
  }
  await addMember('custom', ORG, CUSTOM_KEY, CUSTOM_KEY, [L1]);
  await db.query(`insert into core.custom_roles (org_id, key, name, base_role) values ($1, $2, 'AP lead (draft)', 'accounting_specialist')`, [ORG, DRAFT_KEY]);
  await db.query(`insert into core.role_permission_overrides (org_id, role_key, feature, action, allowed) values ($1, $2, 'bills', 'approve', true)`, [ORG, DRAFT_KEY]);
  await addMember('b_admin', ORG_B, 'owner', 'company_admin', []);

  // The live state: tenants provisioned by 158–161 BEFORE 168.
  await db.query(`select core.rbac_provision_tenant($1)`, [ORG]);
  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_B]);

  for (const r of ROLES) preRefundApprove[r.role] = await has(r.role, 'pay.refunds', 'approve');
  const v = await db.query<{ legacy_role_key: string; current_version: number }>(
    `select legacy_role_key, current_version from core.role_definitions where owner_level = 'tenant' and org_id = $1 and legacy_role_key is not null`, [ORG]);
  versionsBefore = Object.fromEntries(v.rows.map((x) => [x.legacy_role_key, x.current_version]));

  // A second money-approving custom role has open Proposed changes (a draft) when 168 lands.
  const ga = await db.query<{ id: string }>(
    `select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and legacy_role_key = $2`, [ORG, DRAFT_KEY]);
  draftRoleId = ga.rows[0].id;
  await db.query(
    `insert into core.role_versions (role_id, version, state, reason) values ($1, (select max(version) + 1 from core.role_versions where role_id = $1), 'draft', 'Proposed changes')`,
    [draftRoleId]);

  // Fixtures for the write-lock checks.
  await db.query(
    `insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
     values ($1, gen_random_uuid(), 'JOB_BILLING', 'PROJECTS', '{}'::jsonb, current_date, 'processed')`, [ORG]);
  await insertRow('core', 'vendors', { org_id: ORG, name: 'Acme Supply' });

  // Apply migration 168 (and anything after it in this copy, e.g. nothing).
  const files = listMigrationFiles();
  for (const f of files.slice(files.findIndex((x) => x.startsWith('168_')))) {
    if (!f.startsWith('168_')) continue;
    await applyMigrationFile(db, f);
  }
}, 180_000);

afterAll(async () => {
  await db?.close();
});

// ── 1. write locks ───────────────────────────────────────────────────────────────

describe('core.events / core.vendors are SELECT-only for members (168)', () => {
  for (const table of ['events', 'vendors'] as const) {
    it(`authenticated cannot INSERT / UPDATE / DELETE / TRUNCATE core.${table}`, async () => {
      const insertSql = table === 'events'
        ? `insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on) values ('${ORG}', gen_random_uuid(), 'JOB_BILLING', 'PROJECTS', '{"forged":true}'::jsonb, current_date)`
        : `insert into core.vendors (org_id, name) values ('${ORG}', 'Forged vendor')`;
      const updateSql = table === 'events'
        ? `update core.events set status = 'pending' where org_id = '${ORG}'`
        : `update core.vendors set name = 'Hijacked' where org_id = '${ORG}'`;
      for (const role of ['authenticated', 'anon'] as const) {
        await asCaller(role, ORG, async () => {
          expect(await errorOf(insertSql), `${role} insert`).toMatch(/permission denied/);
          expect(await errorOf(updateSql), `${role} update`).toMatch(/permission denied/);
          expect(await errorOf(`delete from core.${table} where org_id = '${ORG}'`), `${role} delete`).toMatch(/permission denied/);
          expect(await errorOf(`truncate core.${table}`), `${role} truncate`).toMatch(/permission denied/);
        });
      }
    });
  }

  it('no member-facing write policy survives; service_all exists', async () => {
    const r = await db.query<{ tablename: string; policyname: string; cmd: string; roles: string }>(
      `select tablename, policyname, cmd, roles::text as roles from pg_policies
        where schemaname = 'core' and tablename in ('events', 'vendors') and permissive = 'PERMISSIVE'`);
    const memberWrites = r.rows.filter((p) => p.cmd !== 'SELECT' && p.roles !== '{service_role}');
    expect(memberWrites).toEqual([]);
    for (const t of ['events', 'vendors']) {
      expect(r.rows.some((p) => p.tablename === t && p.policyname === 'service_all'), t).toBe(true);
      expect(r.rows.some((p) => p.tablename === t && p.cmd === 'SELECT'), `${t} read`).toBe(true);
    }
  });

  it('members still read their own tenant (and only it)', async () => {
    await asCaller('authenticated', ORG, async () => {
      const ev = await db.query<{ n: number }>(`select count(*)::int as n from core.events`);
      expect(ev.rows[0].n).toBeGreaterThan(0);
      const v = await db.query<{ name: string }>(`select name from core.vendors`);
      expect(v.rows.map((x) => x.name)).toContain('Acme Supply');
    });
    await asCaller('authenticated', ORG_B, async () => {
      const ev = await db.query<{ n: number }>(`select count(*)::int as n from core.events`);
      expect(ev.rows[0].n).toBe(0);
      const v = await db.query<{ n: number }>(`select count(*)::int as n from core.vendors`);
      expect(v.rows[0].n).toBe(0);
    });
  });

  it('the 167 column mask on vendors.tin_encrypted still holds', async () => {
    await asCaller('authenticated', ORG, async () => {
      expect(await errorOf(`select tin_encrypted from core.vendors`)).toMatch(/permission denied/);
      expect(await errorOf(`select id, name from core.vendors`)).toBeNull();
    });
  });

  it('the service role still writes both (the emitter / vendor write path)', async () => {
    await db.exec('set role service_role');
    try {
      expect(await errorOf(
        `insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on) values ($1, gen_random_uuid(), 'JOB_COST', 'BOOKS', '{}'::jsonb, current_date)`,
        [ORG])).toBeNull();
      expect(await errorOf(`update core.events set status = 'processed' where org_id = $1 and event_type = 'JOB_COST'`, [ORG])).toBeNull();
      expect(await errorOf(`insert into core.vendors (org_id, name) values ($1, 'Service vendor')`, [ORG])).toBeNull();
      expect(await errorOf(`update core.vendors set display_name = 'Svc' where org_id = $1 and name = 'Service vendor'`, [ORG])).toBeNull();
    } finally {
      await db.exec('reset role');
    }
  });
});

// ── 2. money kinds ───────────────────────────────────────────────────────────────

describe('AR refund approval for every legacy money approver (168, existing tenant)', () => {
  it('before 168 no imported role could approve a refund (the gap)', () => {
    expect(Object.values(preRefundApprove).some(Boolean)).toBe(false);
  });

  for (const r of ROLES) {
    it(`${r.role}: pay.refunds approve == legacy money approval; release == releases AP`, async () => {
      const loc = r.locations[0] ?? null;
      expect(await has(r.role, 'pay.refunds', 'approve', loc), 'approve').toBe(isMoneyApprover(r.role));
      expect(await has(r.role, 'pay.refunds', 'release', loc), 'release').toBe(releasesAp(r.role));
    });
  }

  it('a mig-130 custom role that approves money gets refund approval too', async () => {
    expect(await has('custom', 'pay.refunds', 'approve', L1)).toBe(true);
  });

  it('every money approver had at least one other money-approve grant source (sanity)', () => {
    expect(ROLES.filter((r) => isMoneyApprover(r.role)).map((r) => r.role)).toEqual(
      ['company_admin', 'cfo', 'merit_controller', 'assistant_cfo', 'accounting_manager', 'check_processor']);
  });

  it('the change is a NEW published version; the old one is superseded, never edited', async () => {
    const r = await db.query<{ legacy_role_key: string; current_version: number; reason: string; prev_state: string }>(
      `select d.legacy_role_key, d.current_version, v.reason,
              (select pv.state from core.role_versions pv where pv.role_id = d.id and pv.version = d.current_version - 1) as prev_state
         from core.role_definitions d
         join core.role_versions v on v.role_id = d.id and v.version = d.current_version
        where d.owner_level = 'tenant' and d.org_id = $1 and d.legacy_role_key = 'accounting_manager'`, [ORG]);
    expect(r.rows[0].current_version).toBe(versionsBefore.accounting_manager + 1);
    expect(r.rows[0].reason).toMatch(/migration 168/);
    expect(r.rows[0].prev_state).toBe('superseded');
  });

  it('imported roles now equal the legacy expansion exactly (controller minus money release)', async () => {
    for (const r of ROLES) {
      if (r.role === 'company_admin') continue;
      const row = await db.query<{ g: Array<{ capability: string; actions: string[] }> }>(
        `select core.rbac_role_current_grants(id) as g from core.role_definitions where owner_level = 'tenant' and org_id = $1 and legacy_role_key = $2`,
        [ORG, r.role]);
      let want = expandLegacyCells(cellsOf(r.role));
      if (r.role === 'merit_controller') want = subtractGrants(want, moneyReleaseGrants(want));
      expect(asMap(row.rows[0].g), r.role).toEqual(mapObj(want));
    }
  });

  it('merit_controller releases refunds through "Legacy controller release"; company_admin through "Legacy full books"', async () => {
    const sets = await db.query<{ key: string; g: Array<{ capability: string; actions: string[] }> }>(
      `select key, core.rbac_set_current_grants(id) as g from core.permission_sets where owner_level = 'tenant' and org_id = $1 and key like 'legacy_%'`, [ORG]);
    const byKey = Object.fromEntries(sets.rows.map((s) => [s.key, asMap(s.g)]));
    expect(byKey.legacy_controller_release['pay.refunds']).toEqual(['release']);
    expect(byKey.legacy_full_books['pay.refunds']).toEqual(expect.arrayContaining(['approve', 'release']));
  });

  it('a role with open Proposed changes gets the grants in its draft (Current untouched)', async () => {
    const r = await db.query<{ state: string; actions: string[] | null }>(
      `select v.state, (select g.actions from core.role_grants g where g.role_version_id = v.id and g.capability = 'pay.refunds') as actions
         from core.role_versions v where v.role_id = $1 order by v.version`, [draftRoleId]);
    expect(r.rows.filter((x) => x.state === 'draft').map((x) => x.actions)).toEqual([['view', 'approve']]);
    expect(r.rows.filter((x) => x.state === 'published').map((x) => x.actions)).toEqual([null]);
    expect(versionsBefore[DRAFT_KEY]).toBeDefined();
  });

  it('platform legacy permission-set templates got a new version matching the code', async () => {
    const r = await db.query<{ key: string; current_version: number }>(
      `select key, current_version from core.permission_sets where owner_level = 'platform' and key in ('legacy_full_books', 'legacy_controller_release') order by key`);
    expect(r.rows.map((x) => [x.key, x.current_version])).toEqual([['legacy_controller_release', 2], ['legacy_full_books', 2]]);
  });

  it('logged as a backfill in the access log', async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from core.access_change_log where org_id = $1 and source = 'backfill' and reason like '%migration 168%'`, [ORG]);
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it('is idempotent: running the correction again changes nothing', async () => {
    const r = await db.query<{ n: number }>(`select core.rbac_apply_legacy_corrections($1, '168') as n`, [ORG]);
    expect(r.rows[0].n).toBe(0);
    const again = await db.query<{ n: number }>(`select core.rbac_apply_legacy_corrections($1, '168') as n`, [ORG_B]);
    expect(again.rows[0].n).toBe(0);
  });

  it('a tenant provisioned AFTER 168 gets refund approval straight from the import', async () => {
    const ORG_C = 'cccccccc-0000-0000-0000-0000000002f1';
    await db.query(`insert into core.organizations (id, name, slug, tenant_type) values ($1, 'C', 'c-2f', 'company')`, [ORG_C]);
    await addMember('c_mgr', ORG_C, 'accounting_manager', 'accounting_manager', []);
    await db.query(`select core.rbac_provision_tenant($1)`, [ORG_C]);
    expect(await has('c_mgr', 'pay.refunds', 'approve')).toBe(true);
    const v = await db.query<{ current_version: number }>(
      `select current_version from core.role_definitions where owner_level = 'tenant' and org_id = $1 and legacy_role_key = 'accounting_manager'`, [ORG_C]);
    expect(v.rows[0].current_version).toBe(1);
  });

  it('members cannot call the correction functions', async () => {
    await asCaller('authenticated', ORG, async () => {
      expect(await errorOf(`select core.rbac_apply_legacy_corrections($1, '168')`, [ORG])).toMatch(/permission denied/);
      expect(await errorOf(`select core.rbac_republish_platform_permission_sets('[]'::jsonb, 'x')`)).toMatch(/permission denied/);
    });
  });
});

// ── 3. the migration file itself ─────────────────────────────────────────────────

describe('migration 168 hygiene', () => {
  it('every revoke-all on a function is followed by a service_role grant (M1 lesson)', () => {
    const file = listMigrationFiles().find((f) => f.startsWith('168_'))!;
    const sql = fs.readFileSync(path.resolve(__dirname, '../../../../packages/supabase/migrations', file), 'utf8');
    const revoked = [...sql.matchAll(/revoke all on function ([\w.]+\([^)]*\))/g)].map((m) => m[1]);
    expect(revoked.length).toBeGreaterThan(0);
    for (const fn of revoked) {
      expect(sql, fn).toContain(`grant execute on function ${fn} to service_role`);
    }
  });
});
