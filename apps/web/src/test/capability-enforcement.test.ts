/**
 * Wave 2A — capability enforcement + dual-run (migration 164, 05-RBAC-SPEC R-11).
 *
 * Replays every migration into PGlite (hosted-Supabase default grants on), seeds two
 * tenants with one member per legacy system role, provisions the wave-1 access model,
 * and proves:
 *   1. core.has_capability / actor_has_capability / membership_has_capability: role
 *      grant, permission set, client-scoped assignment in / out of scope, expired
 *      assignment, suspended membership, read-only + mute narrowing, other tenant;
 *   2. SQL == TS: membership_has_capability agrees with the app resolver
 *      (effective-access.ts via authorize's v2AccessFromSnapshot) for every capability
 *      × action × client context × member;
 *   3. the approvals guard trigger refuses money approve / release in v2 and is inert
 *      in dual / legacy;
 *   4. set_access_enforcement_mode refuses v2 before 7 days / with open disagreements;
 *      explain + summary work; privileges are service-role only;
 *   5. DUAL MODE IS BEHAVIOR-PRESERVING: for every system role (+ a mig-130 override and
 *      a custom role) and every (feature, action) any requirePermission /
 *      requirePagePermission / requireMoneyMovement call site checks, authorize() in dual
 *      mode returns exactly the legacy answer; every disagreement it would log is one of
 *      the expected (explained) kinds.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFile, createTestDb, listMigrationFiles } from './pg';
import type { Action } from '@/lib/rbac/capabilities';
import { MONEY_APPROVE_CELLS, applyCellOverrides, expandLegacyCells, legacyCell, legacyRoleCells } from '@/lib/rbac/legacy-map';
import { ALL_ROLES, type UserRole } from '@/lib/rbac/permissions';
import {
  loadAccessSnapshot,
  type AccessDataSource,
  type AccessSnapshot,
  type AssignmentRow,
  type EnvelopeRow,
  type MembershipRow,
  type SourceRow,
} from '@/lib/rbac/effective-access';
import {
  MONEY_APPROVE_REFS,
  MONEY_KIND_CAPABILITY,
  authorizeAny,
  authorizeLegacyCell,
  flushDualRunLogs,
  resetDualRunDedupe,
  v2AccessFromSnapshot,
  type DualRunLogEntry,
} from '@/lib/rbac/authorize';

const ORG_A = 'aaaaaaaa-0000-0000-0000-0000000000c1';
const ORG_B = 'bbbbbbbb-0000-0000-0000-0000000000c1';
const OWN = 'aaaaaaaa-2222-0000-0000-000000000000';
const L1 = 'aaaaaaaa-2222-0000-0000-000000000001';
const L2 = 'aaaaaaaa-2222-0000-0000-000000000002';
const L3 = 'aaaaaaaa-2222-0000-0000-000000000003';
const LB1 = 'bbbbbbbb-2222-0000-0000-000000000001';

const ROLE_MEMBERS: ReadonlyArray<{ role: UserRole; membershipRole: string; locations: string[] }> = [
  { role: 'company_admin', membershipRole: 'owner', locations: [] },
  { role: 'cfo', membershipRole: 'cfo', locations: [] },
  { role: 'merit_controller', membershipRole: 'merit_controller', locations: [] },
  { role: 'assistant_cfo', membershipRole: 'assistant_cfo', locations: [] },
  { role: 'accounting_manager', membershipRole: 'accounting_manager', locations: [] },
  { role: 'accounting_specialist', membershipRole: 'accounting_specialist', locations: [L1, L2] },
  { role: 'check_processor', membershipRole: 'check_processor', locations: [L3] },
  { role: 'general_admin', membershipRole: 'general_admin', locations: [L1] },
  { role: 'business_user', membershipRole: 'business_user', locations: [L2] },
];
const CFO_OVERRIDES: Record<string, boolean> = { 'bills::approve': true, 'reports::export': false };
const CUSTOM_KEY = 'ap_lead';
const CUSTOM_OVERRIDES: Record<string, boolean> = { 'bills::approve': true, 'journal_entries::create': false };

let db: PGlite;
const memberIds = new Map<string, string>();
const clerkOf = (label: string) => `user2a_${label}`;

// ── fixture helpers (same approach as access-foundations.test.ts) ─────────────────

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

async function addMember(label: string, orgId: string, membershipRole: string, employeeRole: string | null, locations: string[]): Promise<string> {
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [clerkOf(label)]);
  const m = await db.query<{ id: string }>(
    `insert into core.memberships (user_id, org_id, role) values ($1, $2, $3) returning id`,
    [u.rows[0].id, orgId, membershipRole],
  );
  memberIds.set(label, m.rows[0].id);
  if (employeeRole) {
    const empId = crypto.randomUUID();
    await insertRow('core', 'employees', { id: empId, org_id: orgId, clerk_user_id: clerkOf(label), role: employeeRole, first_name: 'T', last_name: label, is_active: true });
    for (const loc of locations) await insertRow('public', 'employee_locations', { org_id: orgId, employee_id: empId, location_id: loc });
  }
  return m.rows[0].id;
}

function pgSource(): AccessDataSource {
  const sources = async (kind: 'role' | 'set', ids: string[]): Promise<SourceRow[]> => {
    const sql = kind === 'role'
      ? `select d.id, d.key, d.name, d.owner_level, d.location_id, d.audience, d.current_version,
                core.rbac_role_current_grants(d.id) as grants
           from core.role_definitions d where d.id = any($1::uuid[])`
      : `select d.id, d.key, d.name, d.owner_level, d.location_id, d.audience, d.current_version,
                core.rbac_set_current_grants(d.id) as grants
           from core.permission_sets d where d.id = any($1::uuid[])`;
    return (await db.query<SourceRow>(sql, [ids])).rows;
  };
  return {
    membership: async (id) =>
      (await db.query<MembershipRow>(
        `select id, org_id, user_id, role, status, audience, access_epoch::int as access_epoch from core.memberships where id = $1`, [id],
      )).rows[0] ?? null,
    assignments: async (id) =>
      (await db.query<AssignmentRow>(
        `select id, org_id, membership_id, grant_type, role_id, permission_set_id, scope_type, location_id,
                client_set_id, group_id, read_only, muted, constraint_overrides,
                effective_from::text as effective_from, effective_to::text as effective_to, status
           from core.access_assignments where membership_id = $1`, [id],
      )).rows,
    roles: (ids) => sources('role', ids),
    permissionSets: (ids) => sources('set', ids),
    clientSetMembers: async (ids) =>
      (await db.query<{ set_id: string; location_id: string }>(
        `select set_id, location_id from core.client_set_members where set_id = any($1::uuid[])`, [ids],
      )).rows,
    envelopes: async (orgId, locs) =>
      (await db.query<EnvelopeRow>(
        `select p.location_id, core.rbac_set_current_grants(p.envelope_permission_set_id) as grants
           from core.client_access_policies p
          where p.org_id = $1 and p.location_id = any($2::uuid[]) and p.envelope_permission_set_id is not null`,
        [orgId, locs],
      )).rows,
  };
}

async function snapshotOf(label: string): Promise<AccessSnapshot> {
  const snap = await loadAccessSnapshot(pgSource(), memberIds.get(label)!);
  if (!snap) throw new Error(`no snapshot for ${label}`);
  return snap;
}

async function sqlBool(sql: string, params: unknown[] = []): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(sql, params);
  return r.rows[0]?.ok === true;
}
const has = (label: string, cap: string, action: string, loc: string | null = null) =>
  sqlBool(`select core.membership_has_capability($1, $2, $3, $4) as ok`, [memberIds.get(label), cap, action, loc]);
const actorHas = (org: string, label: string, cap: string, action: string, loc: string | null = null) =>
  sqlBool(`select core.actor_has_capability($1, $2, $3, $4, $5) as ok`, [org, clerkOf(label), cap, action, loc]);

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Run as a PostgREST caller (SET ROLE + JWT claims), always resetting. */
async function asCaller<T>(role: 'authenticated' | 'anon', claims: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function tenantRoleId(org: string, legacyKey: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and legacy_role_key = $2`, [org, legacyKey]);
  return r.rows[0].id;
}

// ── setup ─────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug, tenant_type) values
      ('${ORG_A}', 'Firm 2A', 'firm-2a', 'firm'),
      ('${ORG_B}', 'Company 2B', 'company-2b', 'company');
  `);
  await insertRow('core', 'locations', { id: OWN, org_id: ORG_A, name: 'Firm 2A LLC', short_code: 'OWN', is_management_company: true });
  await insertRow('core', 'locations', { id: L1, org_id: ORG_A, name: 'Client One', short_code: 'C1' });
  await insertRow('core', 'locations', { id: L2, org_id: ORG_A, name: 'Client Two', short_code: 'C2' });
  await insertRow('core', 'locations', { id: L3, org_id: ORG_A, name: 'Client Three', short_code: 'C3' });
  await insertRow('core', 'locations', { id: LB1, org_id: ORG_B, name: 'B Main', short_code: 'BM' });

  for (const rm of ROLE_MEMBERS) await addMember(rm.role, ORG_A, rm.membershipRole, rm.role, rm.locations);
  for (const [cell, allowed] of Object.entries(CFO_OVERRIDES)) {
    const [feature, action] = cell.split('::');
    await db.query(`insert into core.role_permission_overrides (org_id, role_key, feature, action, allowed) values ($1, 'cfo', $2, $3, $4)`, [ORG_A, feature, action, allowed]);
  }
  await db.query(`insert into core.custom_roles (org_id, key, name, base_role) values ($1, $2, 'AP lead', 'accounting_specialist')`, [ORG_A, CUSTOM_KEY]);
  for (const [cell, allowed] of Object.entries(CUSTOM_OVERRIDES)) {
    const [feature, action] = cell.split('::');
    await db.query(`insert into core.role_permission_overrides (org_id, role_key, feature, action, allowed) values ($1, $2, $3, $4, $5)`, [ORG_A, CUSTOM_KEY, feature, action, allowed]);
  }
  await addMember('custom', ORG_A, CUSTOM_KEY, CUSTOM_KEY, [L1]);
  await addMember('b_admin', ORG_B, 'owner', 'company_admin', []);
  // scenario members (specialists, assigned to L1)
  await addMember('expired', ORG_A, 'accounting_specialist', 'accounting_specialist', [L1]);
  await addMember('suspended', ORG_A, 'accounting_specialist', 'accounting_specialist', [L1]);
  await addMember('narrowed', ORG_A, 'accounting_specialist', 'accounting_specialist', [L1]);
  await addMember('set_holder', ORG_A, 'accounting_specialist', 'accounting_specialist', [L1]);

  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_A]);
  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_B]);

  // expired: push the backfilled assignment into the past
  await db.query(
    `update core.access_assignments set effective_from = now() - interval '30 days', effective_to = now() - interval '1 day'
      where membership_id = $1`, [memberIds.get('expired')]);
  // suspended: membership suspended AFTER backfill (assignments stay active)
  await db.query(`update core.memberships set status = 'suspended' where id = $1`, [memberIds.get('suspended')]);
  // narrowed: read-only + a mute on ap.bills:approve is irrelevant; mute bank.transactions:edit
  await db.query(
    `update core.access_assignments set muted = '{"bank.transactions": ["edit"]}'::jsonb where membership_id = $1`,
    [memberIds.get('narrowed')]);
  // set_holder: a tenant permission set granting refund approve, on all clients
  const ps = await db.query<{ id: string }>(
    `insert into core.permission_sets (owner_level, org_id, key, name, kind, audience)
     values ('tenant', $1, 'refund_approver', 'Refund approver', 'custom', 'internal_staff') returning id`, [ORG_A]);
  await db.query(`select core.rbac_publish_set_grants($1, $2::jsonb, 'test')`,
    [ps.rows[0].id, JSON.stringify([{ capability: 'pay.refunds', actions: ['view', 'approve'] }])]);
  await db.query(
    `insert into core.access_assignments (org_id, membership_id, grant_type, permission_set_id, scope_type, source)
     values ($1, $2, 'permission_set', $3, 'all_clients', 'manual')`,
    [ORG_A, memberIds.get('set_holder'), ps.rows[0].id]);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

// ── 1. has_capability scenarios ───────────────────────────────────────────────────

describe('membership_has_capability / actor_has_capability', () => {
  it('role grant on an assigned client: in scope yes, out of scope no, org-level = any client', async () => {
    expect(await has('accounting_specialist', 'ap.bills', 'create', L1)).toBe(true);
    expect(await has('accounting_specialist', 'ap.bills', 'create', L2)).toBe(true);
    expect(await has('accounting_specialist', 'ap.bills', 'create', L3)).toBe(false);
    expect(await has('accounting_specialist', 'ap.bills', 'create', OWN)).toBe(false);
    expect(await has('accounting_specialist', 'ap.bills', 'create', null)).toBe(true);
    expect(await has('accounting_specialist', 'gl.journal_entries', 'post', null)).toBe(false);
  });

  it('all-clients roles reach every client of their tenant, never another tenant', async () => {
    expect(await has('merit_controller', 'gl.journal_entries', 'post', L3)).toBe(true);
    expect(await has('merit_controller', 'gl.journal_entries', 'post', OWN)).toBe(true);
    expect(await has('merit_controller', 'gl.journal_entries', 'post', LB1)).toBe(false);
    expect(await actorHas(ORG_B, 'merit_controller', 'gl.journal_entries', 'post')).toBe(false);
    expect(await actorHas(ORG_A, 'b_admin', 'gl.journal_entries', 'post')).toBe(false);
    expect(await actorHas(ORG_B, 'b_admin', 'gl.journal_entries', 'post', LB1)).toBe(true);
  });

  it('permission sets add grants on top of roles', async () => {
    expect(await has('set_holder', 'pay.refunds', 'approve', L3)).toBe(true);
    expect(await has('accounting_specialist', 'pay.refunds', 'approve', null)).toBe(false);
  });

  it('expired assignments and suspended memberships grant nothing', async () => {
    expect(await has('expired', 'ap.bills', 'create', L1)).toBe(false);
    expect(await has('expired', 'ap.bills', 'view', null)).toBe(false);
    expect(await has('suspended', 'ap.bills', 'create', L1)).toBe(false);
    expect(await actorHas(ORG_A, 'suspended', 'ap.bills', 'view')).toBe(false);
  });

  it('mutes narrow only the muted action; every held action implies view', async () => {
    expect(await has('narrowed', 'bank.transactions', 'edit', L1)).toBe(false);
    expect(await has('narrowed', 'bank.transactions', 'view', L1)).toBe(true);
    await db.query(`update core.access_assignments set read_only = true where membership_id = $1`, [memberIds.get('narrowed')]);
    expect(await has('narrowed', 'ap.bills', 'create', L1)).toBe(false);
    expect(await has('narrowed', 'ap.bills', 'view', L1)).toBe(true);
    await db.query(`update core.access_assignments set read_only = false where membership_id = $1`, [memberIds.get('narrowed')]);
  });

  it('unknown capabilities and actions outside the catalog deny', async () => {
    expect(await has('company_admin', 'nope.nothing', 'view')).toBe(false);
    expect(await has('company_admin', 'cash.position', 'post')).toBe(false);
    expect(await actorHas(ORG_A, 'nobody', 'cash.position', 'view')).toBe(false);
  });

  it('caller form reads the JWT: allowed for the caller, false without a session, anon cannot call it', async () => {
    const claims = { sub: clerkOf('accounting_specialist'), org_id: ORG_A, role: 'authenticated' };
    const r = await asCaller('authenticated', claims, async () => ({
      inScope: await sqlBool(`select core.has_capability('ap.bills', 'create', $1) as ok`, [L1]),
      outOfScope: await sqlBool(`select core.has_capability('ap.bills', 'create', $1) as ok`, [L3]),
      orgLevel: await sqlBool(`select core.has_capability('ap.bills', 'create') as ok`),
      otherTenantLoc: await sqlBool(`select core.has_capability('ap.bills', 'view', $1) as ok`, [LB1]),
    }));
    expect(r).toEqual({ inScope: true, outOfScope: false, orgLevel: true, otherTenantLoc: false });
    const wrongOrg = await asCaller('authenticated', { ...claims, org_id: ORG_B }, () =>
      sqlBool(`select core.has_capability('ap.bills', 'create') as ok`));
    expect(wrongOrg).toBe(false);
    const noSession = await asCaller('authenticated', {}, () => sqlBool(`select core.has_capability('ap.bills', 'create') as ok`));
    expect(noSession).toBe(false);
    const anonErr = await asCaller('anon', {}, () => errorOf(`select core.has_capability('ap.bills', 'view')`));
    expect(anonErr).toMatch(/permission denied/);
  });

  it('members cannot call the service-only functions or read the dual-run log', async () => {
    const claims = { sub: clerkOf('company_admin'), org_id: ORG_A, role: 'authenticated' };
    const errs = await asCaller('authenticated', claims, async () => [
      await errorOf(`select core.membership_has_capability($1, 'gl.journal_entries', 'post')`, [memberIds.get('company_admin')]),
      await errorOf(`select core.actor_has_capability($1, 'x', 'gl.journal_entries', 'post')`, [ORG_A]),
      await errorOf(`select core.assert_actor_capability($1, 'x', 'gl.journal_entries', 'post')`, [ORG_A]),
      await errorOf(`select core.set_access_enforcement_mode($1, 'v2', 'x', true)`, [ORG_A]),
      await errorOf(`select core.explain_access_dualrun($1, 'a', 'b', 'c', 'note note note', 'x')`, [ORG_A]),
      await errorOf(`select * from core.access_dualrun_summary($1, now() - interval '7 days')`, [ORG_A]),
      await errorOf(`select count(*) from core.access_dualrun_log`),
      await errorOf(`insert into core.access_dualrun_log (org_id, capability, action) values ($1, 'a', 'b')`, [ORG_A]),
      await errorOf(`update core.organizations set access_enforcement_mode = 'legacy' where id = $1`, [ORG_A]),
    ]);
    for (const e of errs) expect(e).toMatch(/permission denied/);
  });
});

// ── 2. SQL == TS parity ───────────────────────────────────────────────────────────

describe('SQL decision == TS resolver (one model, two runtimes)', () => {
  it('agrees for every capability × action × context × member', async () => {
    const labels = [...ROLE_MEMBERS.map((r) => r.role as string), 'custom', 'expired', 'suspended', 'narrowed', 'set_holder'];
    const mismatches: string[] = [];
    for (const label of labels) {
      const snap = await snapshotOf(label);
      for (const loc of [null, OWN, L1, L2, L3]) {
        const v2 = v2AccessFromSnapshot(snap, loc);
        const rows = await db.query<{ key: string; act: string; ok: boolean }>(
          `select c.key, a.act, core.membership_has_capability($1, c.key, a.act, $2) as ok
             from core.capabilities c cross join unnest(c.actions) as a(act)
            where c.status = 'active'`,
          [memberIds.get(label), loc],
        );
        expect(rows.rows.length).toBeGreaterThan(300);
        for (const r of rows.rows) {
          const ts = v2.decide({ capability: r.key, action: r.act as Action }).allow;
          if (ts !== r.ok) mismatches.push(`${label} @${loc ?? 'any'} ${r.key}:${r.act} sql=${r.ok} ts=${ts}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it('money approval (canApprove) per kind: dual returns legacy; every difference is the per-kind narrowing', async () => {
    const kinds = ['AP_DISBURSEMENT', 'AP_BATCH', 'PAYROLL_RUN', 'AR_REFUND'] as const;
    const notLegacy: string[] = [];
    const unexplained: string[] = [];
    const moneyKind: string[] = [];
    const v2Approvers: Record<string, string[]> = {};
    for (const rm of ROLE_MEMBERS) {
      const cells = applyCellOverrides(legacyRoleCells(rm.role), rm.role === 'cfo' ? CFO_OVERRIDES : {});
      const legacy = MONEY_APPROVE_CELLS.some((c) => cells.has(c));
      const snap = await snapshotOf(rm.role);
      for (const kind of kinds) {
        const logs: DualRunLogEntry[] = [];
        resetDualRunDedupe();
        const d = await authorizeAny({ userId: clerkOf(rm.role), orgId: ORG_A },
          [{ capability: MONEY_KIND_CAPABILITY[kind], action: 'approve' }],
          { legacy: async () => legacy, equivalentRefs: MONEY_APPROVE_REFS, route: `money:approve:${kind}` },
          {
            mode: async () => 'dual',
            v2: async (_ctx, loc) => v2AccessFromSnapshot(snap, loc),
            legacyGrants: async () => expandLegacyCells(cells),
            log: async (e) => { logs.push(e); },
          });
        await flushDualRunLogs();
        if (d.allow !== legacy) notLegacy.push(`${rm.role} ${kind}`);
        if (d.v2) (v2Approvers[kind] ??= []).push(rm.role);
        for (const e of logs) {
          const line = `${rm.role} ${kind} legacy=${e.legacyDecision} v2=${e.v2Decision} [${e.kind}]`;
          if (e.kind === 'money_kind') moneyKind.push(line);
          else if (!e.explained) unexplained.push(line);
        }
      }
    }
    console.log(`[2A] v2 money approvers by kind: ${JSON.stringify(v2Approvers)}`);
    console.log(`[2A] money_kind narrowings (need acknowledgement before v2):\n${moneyKind.join('\n')}`);
    expect(notLegacy).toEqual([]);
    expect(unexplained).toEqual([]);
    // The legacy money approvers still approve AP and payroll in v2 through the kind capability.
    expect(v2Approvers.AP_DISBURSEMENT).toContain('company_admin');
    expect(v2Approvers.PAYROLL_RUN).toContain('company_admin');
  }, 120_000);
});

// ── 3. approvals guard trigger ────────────────────────────────────────────────────

describe('money approve / release guard (public.approvals)', () => {
  const setMode = (mode: string) => db.query(`update core.organizations set access_enforcement_mode = $2 where id = $1`, [ORG_A, mode]);
  const newApproval = async (kind: string, preparer: string): Promise<string> => {
    const r = await db.query<{ id: string }>(
      `insert into public.approvals (org_id, kind, subject_table, subject_id, amount_cents, status, prepared_by)
       values ($1, $2, 'bills', gen_random_uuid(), 1000, 'PENDING_APPROVAL', $3) returning id`,
      [ORG_A, kind, clerkOf(preparer)]);
    return r.rows[0].id;
  };
  const approveAs = (id: string, label: string) =>
    errorOf(`update public.approvals set status = 'APPROVED', approved_by = $2 where id = $1`, [id, clerkOf(label)]);
  /** A system-role member holding cap:action (org-level), optionally not `except`. */
  const firstHolder = async (cap: string, action: string, except?: string): Promise<string> => {
    for (const rm of ROLE_MEMBERS) {
      if (rm.role !== except && (await has(rm.role, cap, action))) return rm.role;
    }
    throw new Error(`no system role holds ${cap}:${action}`);
  };
  const releaseAs = (id: string, label: string) =>
    errorOf(`update public.approvals set status = 'RELEASED', released_by = $2 where id = $1`, [id, clerkOf(label)]);

  it('is inert in dual and legacy modes', async () => {
    for (const mode of ['dual', 'legacy']) {
      await setMode(mode);
      const id = await newApproval('AP_DISBURSEMENT', 'accounting_specialist');
      expect(await approveAs(id, 'business_user')).toBeNull();
    }
    await setMode('dual');
  });

  it('in v2, approve needs <kind>:approve and release needs <kind>:release', async () => {
    await setMode('v2');
    try {
      const approver = await firstHolder('pay.batches', 'approve');
      const releaser = await firstHolder('pay.batches', 'release', approver);
      const a = await newApproval('AP_DISBURSEMENT', 'accounting_specialist');
      expect(await approveAs(a, 'business_user')).toMatch(/R-11/);
      expect(await approveAs(a, approver)).toBeNull();
      expect(await releaseAs(a, 'business_user')).toMatch(/R-11/);
      expect(await releaseAs(a, releaser)).toBeNull();

      const p = await newApproval('PAYROLL_RUN', 'accounting_specialist');
      expect(await approveAs(p, 'check_processor')).toMatch(/R-11/);

      // reject / revert paths are not authority-bearing
      const r = await newApproval('AR_REFUND', 'accounting_specialist');
      expect(await errorOf(`update public.approvals set status = 'REJECTED' where id = $1`, [r])).toBeNull();
    } finally {
      await setMode('dual');
    }
  });

  it('assert_actor_capability raises only in v2', async () => {
    expect(await sqlBool(`select core.assert_actor_capability($1, $2, 'gl.journal_entries', 'post') as ok`, [ORG_A, clerkOf('business_user')])).toBe(false);
    await setMode('v2');
    try {
      expect(await errorOf(`select core.assert_actor_capability($1, $2, 'gl.journal_entries', 'post')`, [ORG_A, clerkOf('business_user')])).toMatch(/R-11/);
      expect(await sqlBool(`select core.assert_actor_capability($1, $2, 'gl.journal_entries', 'post') as ok`, [ORG_A, clerkOf('merit_controller')])).toBe(true);
    } finally {
      await setMode('dual');
    }
  });
});

// ── 4. mode switch + dual-run admin ───────────────────────────────────────────────

describe('set_access_enforcement_mode / dual-run admin', () => {
  it('new tenants start in dual with a running window', async () => {
    const r = await db.query<{ access_enforcement_mode: string; dual_run_started_at: string | null }>(
      `select access_enforcement_mode, dual_run_started_at from core.organizations where id = $1`, [ORG_B]);
    expect(r.rows[0].access_enforcement_mode).toBe('dual');
    expect(r.rows[0].dual_run_started_at).not.toBeNull();
  });

  it('refuses v2 before 7 days and while disagreements are unexplained; allows it after', async () => {
    await db.query(`select core.set_access_enforcement_mode($1, 'legacy', 'tester')`, [ORG_B]);
    await db.query(`select core.set_access_enforcement_mode($1, 'dual', 'tester')`, [ORG_B]);
    expect(await errorOf(`select core.set_access_enforcement_mode($1, 'v2', 'tester')`, [ORG_B])).toMatch(/7 days/);

    await db.query(`update core.organizations set dual_run_started_at = now() - interval '8 days' where id = $1`, [ORG_B]);
    await db.query(
      `insert into core.access_dualrun_log (org_id, clerk_user_id, capability, action, legacy_decision, v2_decision, route, kind, explained)
       values ($1, 'u', 'ap.bills', 'approve', true, false, '/api/bills/approve', 'disagree', false),
              ($1, 'u', 'ap.bills', 'approve', true, false, '/api/bills/approve', 'disagree', false),
              ($1, 'u', 'pay.vendor_bank_details', 'edit', true, false, '/api/vendors', 'tighten', true)`, [ORG_B]);
    expect(await errorOf(`select core.set_access_enforcement_mode($1, 'v2', 'tester')`, [ORG_B])).toMatch(/2 open/);

    const summary = await db.query<{ capability: string; explained: boolean; total: string; legacy_decision: boolean }>(
      `select * from core.access_dualrun_summary($1, now() - interval '30 days')`, [ORG_B]);
    expect(summary.rows.map((r) => [r.capability, r.explained, Number(r.total)])).toEqual([
      ['ap.bills', false, 2],
      ['pay.vendor_bank_details', true, 1],
    ]);

    expect(await errorOf(`select core.explain_access_dualrun($1, 'ap.bills', 'approve', '/api/bills/approve', '  ', 'tester')`, [ORG_B])).toMatch(/explanation/);
    const n = await db.query<{ n: number }>(
      `select core.explain_access_dualrun($1, 'ap.bills', 'approve', '/api/bills/approve', 'AP lead approvals move to the AP lead role', 'tester') as n`, [ORG_B]);
    expect(n.rows[0].n).toBe(2);

    const res = await db.query<{ r: { mode: string; previous_mode: string } }>(
      `select core.set_access_enforcement_mode($1, 'v2', 'tester') as r`, [ORG_B]);
    expect(res.rows[0].r).toMatchObject({ mode: 'v2', previous_mode: 'dual' });
    const o = await db.query<{ access_mode_changed_by: string }>(`select access_mode_changed_by from core.organizations where id = $1`, [ORG_B]);
    expect(o.rows[0].access_mode_changed_by).toBe('tester');

    // back to dual restarts the window
    await db.query(`select core.set_access_enforcement_mode($1, 'dual', 'tester')`, [ORG_B]);
    const w = await db.query<{ fresh: boolean }>(
      `select dual_run_started_at > now() - interval '1 minute' as fresh from core.organizations where id = $1`, [ORG_B]);
    expect(w.rows[0].fresh).toBe(true);
    expect(await errorOf(`select core.set_access_enforcement_mode($1, 'v3', 'tester')`, [ORG_B])).toMatch(/unknown/);
  });
});

describe('migration 164 is idempotent', () => {
  it('re-applies cleanly and keeps every tenant\'s mode', async () => {
    const before = await db.query<{ id: string; access_enforcement_mode: string }>(
      `select id, access_enforcement_mode from core.organizations order by id`);
    const file = listMigrationFiles().find((f) => f.startsWith('164_'));
    expect(file).toBeTruthy();
    await applyMigrationFile(db, file!);
    const after = await db.query<{ id: string; access_enforcement_mode: string }>(
      `select id, access_enforcement_mode from core.organizations order by id`);
    expect(after.rows).toEqual(before.rows);
    expect(await has('accounting_specialist', 'ap.bills', 'create', L1)).toBe(true);
  });
});

// ── 5. dual mode is behavior-preserving at every call site ────────────────────────

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Every literal (feature, action) a guard call site checks today. */
function callSiteCells(): Array<{ feature: string; action: string }> {
  const cells = new Set<string>();
  const patterns = [
    /requirePermission\(\s*[^,()]+,\s*'([a-z_]+)',\s*'([a-z]+)'/g,
    /requirePagePermission\(\s*'([a-z_]+)',\s*'([a-z]+)'/g,
    /feature:\s*'([a-z_]+)',\s*action:\s*'([a-z]+)'/g, // requireMoneyMovement legacy fallbacks
  ];
  for (const f of walk(SRC_ROOT)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of patterns) for (const m of src.matchAll(re)) cells.add(`${m[1]}::${m[2]}`);
  }
  // requireMoneyMovement's granular + coarse money keys (passed as constants, not literals)
  for (const f of ['payments', 'payments_execute', 'check_run', 'ap_disbursement_release', 'payroll_release']) {
    cells.add(`${f}::view`);
    cells.add(`${f}::run`);
  }
  return [...cells].sort().map((c) => {
    const [feature, action] = c.split('::');
    return { feature, action };
  });
}

describe('dual mode returns the legacy answer at every call site (system roles + overrides + custom role)', () => {
  it('scans a realistic number of call-site cells', () => {
    expect(callSiteCells().length).toBeGreaterThan(40);
  });

  it('every decision == legacy; every disagreement is an explained kind', async () => {
    const cells = callSiteCells();
    const subjects: Array<{ label: string; legacyCells: Set<string> }> = [
      ...ALL_ROLES.map((r) => ({
        label: r as string,
        legacyCells: applyCellOverrides(legacyRoleCells(r), r === 'cfo' ? CFO_OVERRIDES : {}),
      })),
      { label: 'custom', legacyCells: applyCellOverrides(legacyRoleCells('accounting_specialist'), CUSTOM_OVERRIDES) },
    ];
    const notLegacy: string[] = [];
    const unexplained: string[] = [];
    const expected = new Map<string, number>();
    for (const s of subjects) {
      const snap = await snapshotOf(s.label);
      const logs: DualRunLogEntry[] = [];
      resetDualRunDedupe();
      for (const { feature, action } of cells) {
        const legacy = s.legacyCells.has(legacyCell(feature, action));
        const d = await authorizeLegacyCell({ userId: clerkOf(s.label), orgId: ORG_A }, feature, action,
          { legacy: async () => legacy, route: `${feature}:${action}` },
          {
            mode: async () => 'dual',
            v2: async (_ctx, loc) => v2AccessFromSnapshot(snap, loc),
            legacyGrants: async () => expandLegacyCells(s.legacyCells),
            log: async (e) => { logs.push(e); },
            route: async () => null,
          });
        if (d.allow !== legacy) notLegacy.push(`${s.label} ${feature}:${action}`);
      }
      await flushDualRunLogs();
      for (const e of logs) {
        const line = `${s.label} ${String(e.detail.legacy_cell)} → ${e.capability}:${e.action} legacy=${e.legacyDecision} v2=${e.v2Decision} [${e.kind}]`;
        if (!e.explained) unexplained.push(line);
        else expected.set(e.kind, (expected.get(e.kind) ?? 0) + 1);
      }
    }
    expect(notLegacy).toEqual([]);
    // Printed for the dual-run pre-explanation list (see the wave-2A report).
    if (unexplained.length > 0) console.log(`[2A] unexplained dual-run disagreements:\n${unexplained.join('\n')}`);
    console.log(`[2A] expected (explained) disagreements by kind: ${JSON.stringify(Object.fromEntries(expected))}`);
    expect(unexplained).toEqual([]);
  }, 120_000);

});
