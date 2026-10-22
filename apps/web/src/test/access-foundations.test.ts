/**
 * Wave 1 "access foundations" (migrations 155–161, 05-RBAC-SPEC R-1…R-5).
 *
 * Replays every migration into PGlite (with hosted Supabase's default grants so the
 * privilege assertions are real), seeds a two-tenant fixture with one member per legacy
 * system role, runs core.rbac_provision_tenant(), and proves:
 *   1. the code registries (capabilities, templates, legacy map) == their DB mirrors;
 *   2. the SQL legacy expansion == the TS expansion (one mapping, two runtimes);
 *   3. the backfill preserves effective access for every system role, per client
 *      (incl. a mig-130 override and a custom role) — only 05 §2.3 explained deltas;
 *   4. a person can be Bookkeeper on client A and Reviewer on client B;
 *   5. client-defined roles cannot exceed the client envelope (DB + resolver);
 *   6. members can't write any new table / call any provisioning function; reads are
 *      tenant-scoped; versions are immutable; H1 / H3 hold in the DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';
import { CAPABILITIES, G22_MODULE_COVERAGE, riskTier, isPlatformOnly, type Action } from '@/lib/rbac/capabilities';
import { ROLE_TEMPLATES, PERMISSION_SET_TEMPLATES, ROLE_TEMPLATE_BY_KEY, templateGrantMap } from '@/lib/rbac/access-templates';
import {
  LEGACY_PRIMARY,
  applyCellOverrides,
  expandLegacyCells,
  grantMapToRows,
  legacyRoleCells,
  legacyRuleRows,
  legacyScopeKind,
  legacyCell,
  type GrantMap,
} from '@/lib/rbac/legacy-map';
import { FEATURE_CATALOG, ALL_ROLES, type UserRole } from '@/lib/rbac/permissions';
import {
  can,
  capabilityMap,
  compareDecision,
  loadAccessSnapshot,
  resolveEffectiveAccess,
  type AccessDataSource,
  type AccessSnapshot,
  type AssignmentRow,
  type ComparisonKind,
  type EnvelopeRow,
  type MembershipRow,
  type SourceRow,
} from '@/lib/rbac/effective-access';

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000001';
const OWN = 'aaaaaaaa-1111-0000-0000-000000000000';
const L1 = 'aaaaaaaa-1111-0000-0000-000000000001';
const L2 = 'aaaaaaaa-1111-0000-0000-000000000002';
const L3 = 'aaaaaaaa-1111-0000-0000-000000000003';
const LB1 = 'bbbbbbbb-1111-0000-0000-000000000001';
const A_LOCATIONS = [OWN, L1, L2, L3];

/** One member per legacy system role. membership.role uses Clerk vocabulary for the admin. */
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

/** mig-130 override on a SYSTEM key in tenant A (folds into the tenant cfo role v2). */
const CFO_OVERRIDES: Record<string, boolean> = { 'bills::approve': true, 'reports::export': false };
/** mig-130 custom role in tenant A. */
const CUSTOM_KEY = 'ap_lead';
const CUSTOM_OVERRIDES: Record<string, boolean> = { 'bills::approve': true, 'journal_entries::create': false };

let db: PGlite;
const memberIds = new Map<string, string>(); // label → membership id
const userIds = new Map<string, string>(); // label → core.users id

// ── fixture helpers ───────────────────────────────────────────────────────────────

/** Insert a row, filling any NOT NULL column without a default this schema still has. */
async function insertRow(schema: string, table: string, values: Record<string, unknown>): Promise<void> {
  const cols = await db.query<{ column_name: string; udt_name: string; data_type: string }>(
    `select column_name, udt_name, data_type from information_schema.columns
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

async function addMember(label: string, orgId: string, membershipRole: string, employeeRole: string | null, locations: string[], viaMembershipLocations = false): Promise<string> {
  const clerk = `user_${label}`;
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [clerk]);
  userIds.set(label, u.rows[0].id);
  const m = await db.query<{ id: string }>(
    `insert into core.memberships (user_id, org_id, role) values ($1, $2, $3) returning id`,
    [u.rows[0].id, orgId, membershipRole],
  );
  memberIds.set(label, m.rows[0].id);
  if (employeeRole) {
    const empId = crypto.randomUUID();
    await insertRow('core', 'employees', { id: empId, org_id: orgId, clerk_user_id: clerk, role: employeeRole, first_name: 'T', last_name: label, is_active: true });
    if (!viaMembershipLocations) {
      for (const loc of locations) await insertRow('public', 'employee_locations', { org_id: orgId, employee_id: empId, location_id: loc });
    }
  }
  if (viaMembershipLocations) {
    for (const loc of locations) await db.query(`insert into core.membership_locations (membership_id, location_id) values ($1, $2)`, [m.rows[0].id, loc]);
  }
  return m.rows[0].id;
}

/** AccessDataSource over raw SQL (the same reads supabaseAccessSource performs). */
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

const asMap = (rows: Array<{ capability: string; actions: readonly string[] }>): Record<string, string[]> =>
  Object.fromEntries(rows.map((r) => [r.capability, [...r.actions]]));
const grantMapObj = (m: GrantMap): Record<string, string[]> => asMap(grantMapToRows(m));

/** Run fn as a PostgREST caller (SET ROLE + JWT claims), always resetting. */
async function asRole<T>(role: 'authenticated' | 'anon', fn: () => Promise<T>, orgId = ORG_A): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    role === 'anon' ? '{}' : JSON.stringify({ sub: 'user_cfo', org_id: orgId, role: 'authenticated' }),
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

// ── setup ─────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));

  await db.exec(`
    insert into core.organizations (id, name, slug, tenant_type) values
      ('${ORG_A}', 'Firm A', 'firm-a', 'firm'),
      ('${ORG_B}', 'Company B', 'company-b', 'company');
  `);
  await insertRow('core', 'locations', { id: OWN, org_id: ORG_A, name: 'Firm A LLC', short_code: 'OWN', is_management_company: true });
  await insertRow('core', 'locations', { id: L1, org_id: ORG_A, name: 'Client One', short_code: 'C1', tags: ['hvac'] });
  await insertRow('core', 'locations', { id: L2, org_id: ORG_A, name: 'Client Two', short_code: 'C2', tags: ['hvac', 'cabinets'] });
  await insertRow('core', 'locations', { id: L3, org_id: ORG_A, name: 'Client Three', short_code: 'C3' });
  await insertRow('core', 'locations', { id: LB1, org_id: ORG_B, name: 'B Main', short_code: 'BM' });

  for (const rm of ROLE_MEMBERS) {
    // Client access comes from employee_locations (the live authority). membership_locations is a
    // write-only mirror and is deliberately NOT a backfill source (security review M3).
    await addMember(rm.role, ORG_A, rm.membershipRole, rm.role, rm.locations, false);
  }

  // mig-130 customizations in tenant A
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
  // mig-145 external auditor (custom role on business_user)
  await db.query(`insert into core.custom_roles (org_id, key, name, base_role) values ($1, 'external_auditor', 'External auditor', 'business_user')`, [ORG_A]);
  await addMember('auditor', ORG_A, 'external_auditor', 'external_auditor', [L1]);
  // unmapped Clerk role + a C4 mismatch (membership says cfo, employee says specialist)
  await addMember('member', ORG_A, 'member', null, []);
  await addMember('mismatch', ORG_A, 'cfo', 'accounting_specialist', []);
  // tenant B admin
  await addMember('b_admin', ORG_B, 'owner', 'company_admin', []);
  // security review M3: a membership_locations row alone (no employee_locations) grants nothing
  await addMember('ml_only', ORG_A, 'accounting_specialist', 'accounting_specialist', [L3], true);
  // security review M2: a non-active membership is not backfilled at all
  const suspendedId = await addMember('suspended', ORG_A, 'cfo', 'cfo', [L1]);
  await db.query(`update core.memberships set status = 'suspended' where id = $1`, [suspendedId]);

  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_A]);
  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_B]);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

// ── 1. registries == DB mirrors ───────────────────────────────────────────────────

describe('R-1 capability registry guard (code == core.capabilities)', () => {
  it('every code capability is mirrored exactly, and nothing else is active', async () => {
    // Scoped to the modules Books owns: projects.* (module 'projects', mirrored by migration 1110
    // from packages/projects-access) has its own guard test in that package.
    const r = await db.query<{
      key: string; module: string; domain: string; actions: string[]; label: string; tags: string[];
      risk_tier: string; platform_only: boolean; field_classes: string[]; supports_constraints: string[]; status: string;
    }>(`select * from core.capabilities where status = 'active' and module in ('books', 'core', 'platform') order by key`);
    const db_ = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(Object.keys(db_).sort()).toEqual(CAPABILITIES.map((c) => c.key).sort());
    for (const c of CAPABILITIES) {
      const row = db_[c.key];
      expect({ module: row.module, domain: row.domain, actions: row.actions, label: row.label, tags: row.tags, risk: row.risk_tier, platform: row.platform_only, fields: row.field_classes, constraints: row.supports_constraints }, c.key)
        .toEqual({ module: c.module, domain: c.domain, actions: [...c.actions], label: c.label, tags: [...c.tags], risk: riskTier(c), platform: isPlatformOnly(c), fields: [...c.fieldClasses], constraints: [...c.supportsConstraints] });
    }
  });

  it('covers ~110+ resources, incl. every module key IA 04 G22 found missing', () => {
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(110);
    for (const [module, prefix] of Object.entries(G22_MODULE_COVERAGE)) {
      expect(CAPABILITIES.some((c) => c.key.startsWith(prefix)), module).toBe(true);
    }
  });

  it('capability keys are unique and well-formed', () => {
    const keys = CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
  });
});

describe('R-2 / R-3 template guard (code == DB)', () => {
  it('every platform role template publishes exactly its code grants', async () => {
    for (const t of ROLE_TEMPLATES) {
      const r = await db.query<{ grants: Array<{ capability: string; actions: string[]; constraints: Record<string, unknown> }>; audience: string; current_version: number }>(
        `select core.rbac_role_current_grants(id) as grants, audience, current_version from core.role_definitions where owner_level = 'platform' and key = $1`, [t.key],
      );
      expect(r.rows[0], t.key).toBeTruthy();
      expect(r.rows[0].current_version).toBe(1);
      expect(r.rows[0].audience).toBe(t.audience);
      expect(r.rows[0].grants, t.key).toEqual(t.grants.map((g) => ({ capability: g.capability, actions: g.actions, constraints: g.constraints })));
      expect(t.cloneToTenants).toBe(t.audience !== 'platform');
    }
  });

  it('every platform permission set publishes exactly its code grants', async () => {
    for (const s of PERMISSION_SET_TEMPLATES) {
      const r = await db.query<{ grants: unknown[] }>(
        `select core.rbac_set_current_grants(id) as grants from core.permission_sets where owner_level = 'platform' and key = $1`, [s.key],
      );
      expect(r.rows[0]?.grants, s.key).toEqual(s.grants.map((g) => ({ capability: g.capability, actions: g.actions, constraints: g.constraints })));
    }
  });

  it('includes the IA A-1 templates (employee, lender_viewer) and the 05 §7 set', () => {
    const keys = ROLE_TEMPLATES.map((t) => t.key);
    for (const k of ['tenant_admin', 'owner', 'cfo', 'controller', 'finance_director', 'accounting_manager', 'bookkeeper', 'ap_clerk', 'ar_clerk', 'payments_clerk', 'data_entry', 'hr_payroll', 'department_head', 'external_auditor', 'view_only', 'client_admin', 'client_contact', 'employee', 'lender_viewer', 'platform_admin', 'platform_support']) {
      expect(keys, k).toContain(k);
    }
  });

  it('legacy reference tables mirror lib/rbac/legacy-map.ts', async () => {
    const rules = await db.query<{ rule_no: number; cell: string; capability: string; actions: string[]; requires_all: string[]; requires_any: string[] }>(
      `select * from core.legacy_cell_rules order by rule_no, capability`,
    );
    const code = legacyRuleRows().sort((a, b) => a.ruleNo - b.ruleNo || a.capability.localeCompare(b.capability));
    expect(rules.rows.map((r) => [r.rule_no, r.cell, r.capability, r.actions, r.requires_all, r.requires_any]))
      .toEqual(code.map((r) => [r.ruleNo, r.cell, r.capability, r.actions, r.requiresAll, r.requiresAny]));
    for (const role of ALL_ROLES) {
      const cells = await db.query<{ cell: string }>(`select cell from core.legacy_role_cells where role_key = $1 order by cell`, [role]);
      expect(cells.rows.map((c) => c.cell), role).toEqual([...legacyRoleCells(role)].sort());
    }
  });

  it('every legacy cell has a registered primary capability (or is the retired payments key)', () => {
    for (const f of FEATURE_CATALOG) {
      for (const a of f.actions) {
        const cell = legacyCell(f.id, a);
        const p = LEGACY_PRIMARY[cell];
        if (f.id === 'payments') {
          expect(p, cell).toBeUndefined();
          continue;
        }
        expect(p, cell).toBeTruthy();
        const [k, act] = [p.slice(0, p.lastIndexOf(':')), p.slice(p.lastIndexOf(':') + 1)];
        expect(CAPABILITIES.find((c) => c.key === k)?.actions, cell).toContain(act);
      }
    }
  });
});

// ── 2. one mapping, two runtimes ──────────────────────────────────────────────────

describe('legacy expansion: SQL == TS', () => {
  for (const role of ALL_ROLES) {
    it(`${role}`, async () => {
      const cells = [...legacyRoleCells(role)];
      const r = await db.query<{ g: Array<{ capability: string; actions: string[] }> }>(`select core.rbac_legacy_grants($1::text[]) as g`, [cells]);
      expect(asMap(r.rows[0].g)).toEqual(grantMapObj(expandLegacyCells(new Set(cells))));
    });
  }
});

// ── 3. backfill preserves effective access ────────────────────────────────────────

function legacyCellsFor(role: UserRole): Set<string> {
  return role === 'cfo' ? applyCellOverrides(legacyRoleCells(role), CFO_OVERRIDES) : legacyRoleCells(role);
}

describe('R-2/R-4 backfill preserves effective access for every system role', () => {
  const tally = new Map<ComparisonKind, number>();

  for (const rm of ROLE_MEMBERS) {
    it(`${rm.role}: every legacy cell on every client agrees (or is an explained 05 §2.3 delta)`, async () => {
      const snap = await snapshotOf(rm.role);
      const cells = legacyCellsFor(rm.role);
      const ownBooks = [OWN];
      const scope = { kind: legacyScopeKind(rm.role), assignedLocationIds: rm.locations, ownBooksLocationIds: ownBooks };
      const unexplained: string[] = [];
      for (const loc of A_LOCATIONS) {
        const eff = resolveEffectiveAccess(snap, { kind: 'client', locationId: loc });
        for (const f of FEATURE_CATALOG) {
          for (const a of f.actions) {
            const c = compareDecision({
              feature: f.id, action: a, legacyCells: cells, legacyAllowed: cells.has(legacyCell(f.id, a)),
              legacyScope: scope, locationId: loc, effective: eff,
            });
            tally.set(c.kind, (tally.get(c.kind) ?? 0) + 1);
            if (!c.explained) unexplained.push(`${loc.slice(-1)} ${f.id}:${a} legacy=${c.legacyAllowed} new=${c.newAllowed}`);
          }
        }
      }
      expect(unexplained).toEqual([]);
    });
  }

  it('non-admin roles: the union of grants on an in-scope client EQUALS the legacy expansion exactly', async () => {
    for (const rm of ROLE_MEMBERS) {
      if (rm.role === 'company_admin') continue;
      const loc = rm.locations[0] ?? L1;
      const eff = resolveEffectiveAccess(await snapshotOf(rm.role), { kind: 'client', locationId: loc });
      expect(capabilityMap(eff), rm.role).toEqual(grantMapObj(expandLegacyCells(legacyCellsFor(rm.role))));
    }
  });

  it('company_admin: Tenant admin + "Legacy full books" == legacy ∪ Tenant admin template', async () => {
    const eff = resolveEffectiveAccess(await snapshotOf('company_admin'), { kind: 'client', locationId: L1 });
    const want = expandLegacyCells(legacyRoleCells('company_admin'));
    for (const [k, acts] of templateGrantMap(ROLE_TEMPLATE_BY_KEY.get('tenant_admin')!.grants)) {
      if (k.startsWith('consol.')) continue; // consol.* only in a group context
      if (!want.has(k)) want.set(k, new Set());
      acts.forEach((a) => want.get(k)!.add(a));
    }
    expect(capabilityMap(eff)).toEqual(grantMapObj(want));
  });

  it('a mig-130 override on a system key became version 2 of the tenant role', async () => {
    const r = await db.query<{ current_version: number; reason: string }>(
      `select d.current_version, v.reason from core.role_definitions d
         join core.role_versions v on v.role_id = d.id and v.state = 'published'
        where d.owner_level = 'tenant' and d.org_id = $1 and d.key = 'cfo'`, [ORG_A],
    );
    expect(r.rows[0]).toEqual({ current_version: 2, reason: 'imported override (mig 130)' });
    const eff = resolveEffectiveAccess(await snapshotOf('cfo'), { kind: 'client', locationId: L2 });
    expect(can(eff, 'ap.bills', 'approve').allow).toBe(true);
    expect(can(eff, 'reports.financial', 'export').allow).toBe(false);
  });

  it('a mig-130 custom role keeps exactly base ⊕ overrides on its assigned client only', async () => {
    const snap = await snapshotOf('custom');
    const eff = resolveEffectiveAccess(snap, { kind: 'client', locationId: L1 });
    const want = expandLegacyCells(applyCellOverrides(legacyRoleCells('accounting_specialist'), CUSTOM_OVERRIDES));
    expect(capabilityMap(eff)).toEqual(grantMapObj(want));
    expect(can(eff, 'ap.bills', 'approve').allow).toBe(true);
    expect(can(eff, 'gl.journal_entries', 'create').allow).toBe(false);
    expect(capabilityMap(resolveEffectiveAccess(snap, { kind: 'client', locationId: L2 }))).toEqual({});
  });

  it('scopes: all → every client; portcos_and_3rdparty → all but own books; assigned → listed clients only', async () => {
    const view = async (label: string, loc: string) =>
      can(resolveEffectiveAccess(await snapshotOf(label), { kind: 'client', locationId: loc }), 'home.workspace', 'view').allow
      || can(resolveEffectiveAccess(await snapshotOf(label), { kind: 'client', locationId: loc }), 'home.client', 'view').allow;
    for (const loc of A_LOCATIONS) expect(await view('cfo', loc), `cfo ${loc}`).toBe(true);
    expect(await view('assistant_cfo', OWN)).toBe(false);
    for (const loc of [L1, L2, L3]) expect(await view('assistant_cfo', loc)).toBe(true);
    expect(await view('accounting_specialist', L1)).toBe(true);
    expect(await view('accounting_specialist', L2)).toBe(true);
    expect(await view('accounting_specialist', L3)).toBe(false);
    expect(await view('ml_only', L3), 'M3: membership_locations is not an access source').toBe(false);
    const susp = await db.query<{ n: number }>(
      `select count(*)::int as n from core.access_assignments where membership_id = $1`, [memberIds.get('suspended')],
    );
    expect(susp.rows[0].n, 'M2: suspended membership gets no assignments').toBe(0);
    expect(await view('general_admin', L1)).toBe(true); // via employee_locations
    expect(await view('general_admin', L2)).toBe(false);
  });

  it('the "all except own books" set follows client changes (new client joins, own-books flag leaves)', async () => {
    const setId = (await db.query<{ id: string }>(`select id from core.client_sets where org_id = $1 and key = 'all_except_own_books'`, [ORG_A])).rows[0].id;
    const members = async () => (await db.query<{ location_id: string }>(`select location_id from core.client_set_members where set_id = $1 order by location_id`, [setId])).rows.map((r) => r.location_id);
    expect(await members()).toEqual([L1, L2, L3]);
    const L4 = 'aaaaaaaa-1111-0000-0000-000000000004';
    await insertRow('core', 'locations', { id: L4, org_id: ORG_A, name: 'Client Four', short_code: 'C4' });
    expect(await members()).toContain(L4);
    const policy = await db.query(`select 1 from core.client_access_policies where org_id = $1 and location_id = $2`, [ORG_A, L4]);
    expect(policy.rows).toHaveLength(1); // a new client gets its access policy by trigger
    await db.query(`delete from core.locations where id = $1`, [L4]);
    expect(await members()).toEqual([L1, L2, L3]);
  });

  it('external auditor: folded into the standard External auditor role, time-boxed ≤ 120 days, never writes', async () => {
    const r = await db.query<{ key: string; days: number }>(
      `select d.key, extract(day from a.effective_to - a.effective_from)::int as days
         from core.access_assignments a join core.role_definitions d on d.id = a.role_id
        where a.membership_id = $1`, [memberIds.get('auditor')],
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.key).toBe('external_auditor');
      expect(row.days).toBeLessThanOrEqual(120);
    }
    const eff = resolveEffectiveAccess(await snapshotOf('auditor'), { kind: 'client', locationId: L1 });
    for (const [cap, acts] of Object.entries(capabilityMap(eff))) {
      for (const a of acts) {
        const ok = a === 'view' || a === 'export' || (cap === 'ctl.pbc' && ['create', 'edit', 'approve'].includes(a));
        expect(ok, `${cap}:${a}`).toBe(true);
      }
    }
  });

  it('backfill report flags the unmapped role, the C4 mismatch and the tighten row', async () => {
    const r = await db.query<{ clerk_user_id: string; issues: string[] }>(`select clerk_user_id, issues from core.v_access_backfill_report where org_id = $1`, [ORG_A]);
    const by = Object.fromEntries(r.rows.map((x) => [x.clerk_user_id, x.issues.join(' | ')]));
    expect(by.user_member).toMatch(/no_access_backfilled/);
    expect(by.user_mismatch).toMatch(/C4/);
    expect(by.user_accounting_specialist).toMatch(/tighten: vendor bank-detail/);
    expect(by.user_cfo ?? '').not.toMatch(/C4/);
    expect(by.user_company_admin ?? '').not.toMatch(/C4/); // 'owner' membership ≡ company_admin employee
  });

  it('provisioning is idempotent', async () => {
    const before = await db.query<{ n: number }>(`select count(*)::int n from core.access_assignments`);
    const roles = await db.query<{ n: number }>(`select count(*)::int n from core.role_definitions`);
    const out = await db.query<{ r: { assignments_created: number } }>(`select core.rbac_provision_tenant($1) as r`, [ORG_A]);
    expect(out.rows[0].r.assignments_created).toBe(0);
    expect((await db.query<{ n: number }>(`select count(*)::int n from core.access_assignments`)).rows[0].n).toBe(before.rows[0].n);
    expect((await db.query<{ n: number }>(`select count(*)::int n from core.role_definitions`)).rows[0].n).toBe(roles.rows[0].n);
  });

  afterAll(() => {
    // Visible in the test log: how the explained deltas break down.
    console.info('[access dual-run tally]', Object.fromEntries(tally));
  });
});

// ── 4. different roles on different clients ───────────────────────────────────────

describe('one person: Bookkeeper on client A, Reviewer on client B', () => {
  let personId: string;
  let bookkeeperAssignment: string;

  beforeAll(async () => {
    personId = await addMember('dana', ORG_A, 'bookkeeper', null, []);
    const roleId = (await db.query<{ id: string }>(
      `insert into core.role_definitions (owner_level, org_id, key, name, kind) values ('tenant', $1, 'reviewer', 'Reviewer', 'custom') returning id`, [ORG_A],
    )).rows[0].id;
    await db.query(`select core.rbac_publish_role_grants($1, $2::jsonb, 'new role')`, [roleId, JSON.stringify([
      { capability: 'gl.journal_entries', actions: ['view', 'approve'] },
      { capability: 'bank.reconciliations', actions: ['view', 'approve'] },
      { capability: 'close.checklist', actions: ['view', 'approve'] },
      { capability: 'home.client', actions: ['view'] },
    ])]);
    const bookkeeper = (await db.query<{ id: string }>(`select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and key = 'bookkeeper'`, [ORG_A])).rows[0].id;
    bookkeeperAssignment = (await db.query<{ id: string }>(
      `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, granted_by)
       values ($1, $2, 'role', $3, 'client', $4, $5) returning id`, [ORG_A, personId, bookkeeper, L1, userIds.get('company_admin')],
    )).rows[0].id;
    await db.query(
      `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, granted_by)
       values ($1, $2, 'role', $3, 'client', $4, $5)`, [ORG_A, personId, roleId, L2, userIds.get('company_admin')],
    );
  });

  it('resolves per client', async () => {
    const snap = await snapshotOf('dana');
    const a = resolveEffectiveAccess(snap, { kind: 'client', locationId: L1 });
    const b = resolveEffectiveAccess(snap, { kind: 'client', locationId: L2 });
    const c = resolveEffectiveAccess(snap, { kind: 'client', locationId: L3 });
    expect(can(a, 'gl.journal_entries', 'create').allow).toBe(true);
    expect(can(a, 'gl.journal_entries', 'approve').allow).toBe(false);
    expect(can(a, 'ap.bills', 'create').allow).toBe(true);
    expect(can(b, 'gl.journal_entries', 'approve').allow).toBe(true);
    expect(can(b, 'gl.journal_entries', 'create').allow).toBe(false);
    expect(can(b, 'ap.bills', 'create').allow).toBe(false);
    expect(capabilityMap(c)).toEqual({});
    const trace = can(b, 'gl.journal_entries', 'approve').trace[0];
    expect(trace.sourceKey).toBe('reviewer');
  });

  it('a mute and read-only narrow only their own assignment, and bump the access epoch', async () => {
    const epoch0 = (await db.query<{ e: number }>(`select access_epoch::int e from core.memberships where id = $1`, [personId])).rows[0].e;
    await db.query(`update core.access_assignments set muted = '{"ap.bills": ["create"]}'::jsonb where id = $1`, [bookkeeperAssignment]);
    let snap = await snapshotOf('dana');
    expect(can(resolveEffectiveAccess(snap, { kind: 'client', locationId: L1 }), 'ap.bills', 'create').allow).toBe(false);
    expect(can(resolveEffectiveAccess(snap, { kind: 'client', locationId: L1 }), 'ap.bills', 'edit').allow).toBe(true);
    await db.query(`update core.access_assignments set muted = '{}'::jsonb, read_only = true where id = $1`, [bookkeeperAssignment]);
    snap = await snapshotOf('dana');
    const a = resolveEffectiveAccess(snap, { kind: 'client', locationId: L1 });
    expect(can(a, 'ap.bills', 'view').allow).toBe(true);
    expect(can(a, 'ap.bills', 'create').allow).toBe(false);
    expect(can(resolveEffectiveAccess(snap, { kind: 'client', locationId: L2 }), 'gl.journal_entries', 'approve').allow).toBe(true);
    const epoch1 = (await db.query<{ e: number }>(`select access_epoch::int e from core.memberships where id = $1`, [personId])).rows[0].e;
    expect(epoch1).toBeGreaterThan(epoch0);
    await db.query(`update core.access_assignments set read_only = false where id = $1`, [bookkeeperAssignment]);
  });

  it('an expired assignment grants nothing; amount limits route over-limit approvals', async () => {
    const snap = await snapshotOf('dana');
    const past = { ...snap, assignments: snap.assignments.map((a) => ({ ...a, effectiveTo: '2000-01-01T00:00:00Z' })) };
    expect(capabilityMap(resolveEffectiveAccess(past, { kind: 'client', locationId: L1 }))).toEqual({});
    const limited = {
      ...snap,
      assignments: snap.assignments.map((a) => ({ ...a, constraintOverrides: { amount_limit: { max_per_item_cents: 2_500_000 } } })),
    };
    const b = resolveEffectiveAccess(limited, { kind: 'client', locationId: L2 });
    expect(can(b, 'gl.journal_entries', 'approve', { amountCents: 2_000_000 }).allow).toBe(true);
    const over = can(b, 'gl.journal_entries', 'approve', { amountCents: 3_140_000 });
    expect(over).toMatchObject({ allow: false, reason: 'constraint:limit' });
  });
});

// ── 5. client-defined roles stay inside the envelope ──────────────────────────────

describe('R-5 client-defined roles cannot exceed the client envelope', () => {
  let clientRoleId: string;

  it('firm tenant: client roles are OFF by default — creating one is refused', async () => {
    const p = await db.query<{ client_roles_enabled: boolean }>(`select client_roles_enabled from core.client_access_policies where org_id = $1 and location_id = $2`, [ORG_A, L1]);
    expect(p.rows[0].client_roles_enabled).toBe(false);
    const err = await errorOf(`insert into core.role_definitions (owner_level, org_id, location_id, key, name, audience) values ('client', $1, $2, 'office_manager', 'Office manager', 'client_staff')`, [ORG_A, L1]);
    expect(err).toMatch(/not enabled/);
    const b = await db.query<{ client_roles_enabled: boolean }>(`select client_roles_enabled from core.client_access_policies where org_id = $1 and location_id = $2`, [ORG_B, LB1]);
    expect(b.rows[0].client_roles_enabled).toBe(true); // company tenant default: on
  });

  it('once enabled: in-envelope grants are accepted, out-of-envelope grants are refused by the DB', async () => {
    await db.query(`update core.client_access_policies set client_roles_enabled = true where org_id = $1 and location_id = $2`, [ORG_A, L1]);
    clientRoleId = (await db.query<{ id: string }>(
      `insert into core.role_definitions (owner_level, org_id, location_id, key, name, audience) values ('client', $1, $2, 'office_manager', 'Office manager', 'client_staff') returning id`, [ORG_A, L1],
    )).rows[0].id;
    const v = (await db.query<{ id: string }>(`insert into core.role_versions (role_id, version) values ($1, 1) returning id`, [clientRoleId])).rows[0].id;
    await db.query(`insert into core.role_grants (role_version_id, capability, actions) values ($1, 'ap.bills', array['view','create','approve'])`, [v]);
    await db.query(`insert into core.role_grants (role_version_id, capability, actions) values ($1, 'home.client', array['view'])`, [v]);
    expect(await errorOf(`insert into core.role_grants (role_version_id, capability, actions) values ($1, 'gl.journal_entries', array['view','post'])`, [v]))
      .toMatch(/outside the client envelope/);
    expect(await errorOf(`insert into core.role_grants (role_version_id, capability, actions) values ($1, 'pay.batches', array['release'])`, [v]))
      .toMatch(/outside the client envelope/);
    // approve is a firm-approval action → publishing needs the firm's sign-off
    expect(await errorOf(`select core.rbac_publish_role_version($1)`, [v])).toMatch(/needs approval by the firm/);
    await db.query(`update core.role_versions set second_approval_by = $2, second_approval_at = now() where id = $1`, [v, userIds.get('company_admin')]);
    await db.query(`select core.rbac_publish_role_version($1)`, [v]);
  });

  it('a client role is assignable only on its own client, and the resolver re-checks the envelope', async () => {
    const staff = await addMember('client_staff', ORG_A, 'client_staff', null, []);
    await db.query(`update core.memberships set audience = 'client_staff' where id = $1`, [staff]);
    expect(await errorOf(
      `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id) values ($1, $2, 'role', $3, 'client', $4)`,
      [ORG_A, staff, clientRoleId, L2],
    )).toMatch(/only on its own client/);
    await db.query(
      `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id) values ($1, $2, 'role', $3, 'client', $4)`,
      [ORG_A, staff, clientRoleId, L1],
    );
    // client staff never get a second client
    const bookkeeper = (await db.query<{ id: string }>(`select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and key = 'bookkeeper'`, [ORG_A])).rows[0].id;
    expect(await errorOf(
      `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id) values ($1, $2, 'role', $3, 'client', $4)`,
      [ORG_A, staff, bookkeeper, L2],
    )).toMatch(/exactly one client/);

    const snap = await snapshotOf('client_staff');
    expect(can(resolveEffectiveAccess(snap, { kind: 'client', locationId: L1 }), 'ap.bills', 'approve').allow).toBe(true);
    // Defense in depth: if the envelope later shrinks, the resolver drops what fell outside.
    const shrunk: AccessSnapshot = { ...snap, envelopes: { [L1]: snap.envelopes[L1].filter((g) => g.capability !== 'ap.bills') } };
    expect(can(resolveEffectiveAccess(shrunk, { kind: 'client', locationId: L1 }), 'ap.bills', 'approve').allow).toBe(false);
    const noEnvelope: AccessSnapshot = { ...snap, envelopes: {} };
    expect(capabilityMap(resolveEffectiveAccess(noEnvelope, { kind: 'client', locationId: L1 }))).toEqual({});
  });
});

// ── 6. DB guardrails and RLS ──────────────────────────────────────────────────────

const NEW_TABLES: ReadonlyArray<readonly [string, string]> = [
  ['core', 'capabilities'], ['core', 'capability_migrations'],
  ['core', 'role_definitions'], ['core', 'role_versions'], ['core', 'role_grants'],
  ['core', 'legacy_roles'], ['core', 'legacy_feature_catalog'], ['core', 'legacy_role_cells'], ['core', 'legacy_cell_rules'],
  ['core', 'permission_sets'], ['core', 'permission_set_versions'], ['core', 'permission_set_grants'],
  ['core', 'client_sets'], ['core', 'client_set_members'], ['core', 'access_assignments'],
  ['core', 'client_access_policies'],
];

describe('RLS: members cannot write any new access table', () => {
  for (const [schema, table] of NEW_TABLES) {
    for (const role of ['authenticated', 'anon'] as const) {
      it(`${role} cannot INSERT / UPDATE / DELETE / TRUNCATE ${schema}.${table}`, async () => {
        const col = (await db.query<{ column_name: string }>(
          `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position limit 1`, [schema, table],
        )).rows[0].column_name;
        const q = `${schema}.${table}`;
        const errs = await asRole(role, async () => ({
          insert: await errorOf(`insert into ${q} default values`),
          update: await errorOf(`update ${q} set "${col}" = "${col}" where false`),
          del: await errorOf(`delete from ${q} where false`),
          truncate: await errorOf(`truncate ${q}`),
        }));
        for (const [op, e] of Object.entries(errs)) expect(e, `${op} ${q}`).toMatch(/permission denied/i);
      });
    }
  }

  it('every new table has RLS enabled and no member-facing write policy', async () => {
    for (const [schema, table] of NEW_TABLES) {
      const rls = await db.query<{ on: boolean }>(
        `select c.relrowsecurity as on from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2`, [schema, table],
      );
      expect(rls.rows[0].on, `${table} RLS`).toBe(true);
      const writes = await db.query(
        `select policyname from pg_policies where schemaname = $1 and tablename = $2 and cmd <> 'SELECT' and roles::text <> '{service_role}' and permissive = 'PERMISSIVE'`, [schema, table], // restrictive (mig 163) only narrows
      );
      expect(writes.rows, `${table} write policies`).toEqual([]);
    }
  });

  it('members read their own tenant only (plus the platform library)', async () => {
    const roles = await asRole('authenticated', () =>
      db.query<{ owner_level: string; org_id: string | null }>(`select distinct owner_level, org_id from core.role_definitions`),
    );
    expect(roles.rows.every((r) => r.owner_level === 'platform' || r.org_id === ORG_A)).toBe(true);
    expect(roles.rows.some((r) => r.owner_level === 'platform')).toBe(true);
    const asg = await asRole('authenticated', () => db.query<{ org_id: string }>(`select distinct org_id from core.access_assignments`));
    expect(asg.rows.map((r) => r.org_id)).toEqual([ORG_A]);
    const caps = await asRole('authenticated', () => db.query<{ n: number }>(`select count(*)::int n from core.capabilities`));
    expect(caps.rows[0].n).toBeGreaterThanOrEqual(110);
    const anonCaps = await asRole('anon', () => db.query<{ n: number }>(`select count(*)::int n from core.capabilities`));
    expect(anonCaps.rows[0].n).toBe(0);
  });

  it('members cannot call the provisioning / publishing functions or read the backfill report', async () => {
    for (const sql of [
      `select core.rbac_provision_tenant('${ORG_A}')`,
      `select core.rbac_backfill_assignments('${ORG_A}')`,
      `select core.rbac_import_tenant_roles('${ORG_A}')`,
      `select core.rbac_publish_role_grants(gen_random_uuid(), '[]'::jsonb, 'x')`,
      `select core.rbac_refresh_client_set(gen_random_uuid())`,
      `select core.rbac_mirror_capabilities('[]'::jsonb)`,
      `select * from core.v_access_backfill_report`,
    ]) {
      expect(await asRole('authenticated', () => errorOf(sql)), sql).toMatch(/permission denied/i);
    }
  });
});

describe('DB guardrails', () => {
  it('published versions and their grants are immutable; one draft per role', async () => {
    const r = (await db.query<{ role_id: string; vid: string; gid: string }>(
      `select d.id role_id, v.id vid, g.id gid from core.role_definitions d
         join core.role_versions v on v.role_id = d.id and v.state = 'published'
         join core.role_grants g on g.role_version_id = v.id
        where d.owner_level = 'tenant' and d.org_id = $1 and d.key = 'bookkeeper' limit 1`, [ORG_A],
    )).rows[0];
    expect(await errorOf(`update core.role_grants set actions = array['view'] where id = $1`, [r.gid])).toMatch(/immutable/);
    expect(await errorOf(`delete from core.role_grants where id = $1`, [r.gid])).toMatch(/immutable/);
    expect(await errorOf(`delete from core.role_versions where id = $1`, [r.vid])).toMatch(/cannot be deleted/);
    expect(await errorOf(`update core.role_versions set reason = 'rewrite' where id = $1`, [r.vid])).toMatch(/immutable/);
    await db.query(`insert into core.role_versions (role_id, version) values ($1, 99)`, [r.role_id]);
    expect(await errorOf(`insert into core.role_versions (role_id, version) values ($1, 100)`, [r.role_id])).toMatch(/duplicate|unique/i);
    await db.query(`delete from core.role_versions where role_id = $1 and version = 99`, [r.role_id]); // drafts may be discarded
  });

  it('H1: nobody grants access to themselves', async () => {
    const role = (await db.query<{ id: string }>(`select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and key = 'view_only'`, [ORG_A])).rows[0].id;
    expect(await errorOf(
      `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, granted_by) values ($1, $2, 'role', $3, 'client', $4, $5)`,
      [ORG_A, memberIds.get('cfo'), role, L1, userIds.get('cfo')],
    )).toMatch(/H1/);
  });

  it('H3 / H5: external roles never post / release / administer; platform capabilities stay in platform roles', async () => {
    const ext = (await db.query<{ id: string }>(
      `insert into core.role_definitions (owner_level, org_id, key, name, audience) values ('tenant', $1, 'ext_test', 'Ext', 'external') returning id`, [ORG_A],
    )).rows[0].id;
    const v = (await db.query<{ id: string }>(`insert into core.role_versions (role_id, version) values ($1, 1) returning id`, [ext])).rows[0].id;
    expect(await errorOf(`insert into core.role_grants (role_version_id, capability, actions) values ($1, 'gl.journal_entries', array['post'])`, [v])).toMatch(/H3/);
    expect(await errorOf(`insert into core.role_grants (role_version_id, capability, actions) values ($1, 'pay.batches', array['approve'])`, [v])).toMatch(/H3/);
    expect(await errorOf(`insert into core.role_grants (role_version_id, capability, actions) values ($1, 'core.access.members', array['view'])`, [v])).toMatch(/H3/);
    expect(await errorOf(`insert into core.role_grants (role_version_id, capability, actions) values ($1, 'platform.tenants', array['view'])`, [v])).toMatch(/H5/);
    expect(await errorOf(`insert into core.role_grants (role_version_id, capability, actions) values ($1, 'ap.bills', array['release'])`, [v])).toMatch(/does not support/);
    await db.query(`insert into core.role_grants (role_version_id, capability, actions) values ($1, 'reports.financial', array['view','export'])`, [v]);
  });

  it('platform templates are never assigned directly', async () => {
    const tpl = (await db.query<{ id: string }>(`select id from core.role_definitions where owner_level = 'platform' and key = 'cfo'`)).rows[0].id;
    expect(await errorOf(
      `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type) values ($1, $2, 'role', $3, 'all_clients')`,
      [ORG_A, memberIds.get('member'), tpl],
    )).toMatch(/platform templates/);
  });

  it('tenant B is provisioned independently and sees none of tenant A', async () => {
    const eff = resolveEffectiveAccess(await snapshotOf('b_admin'), { kind: 'client', locationId: LB1 });
    expect(can(eff, 'gl.journal_entries', 'post').allow).toBe(true);
    const leak = await db.query(`select 1 from core.access_assignments a join core.memberships m on m.id = a.membership_id where m.org_id = $1 and a.org_id <> $1`, [ORG_B]);
    expect(leak.rows).toEqual([]);
  });
});

describe('pure comparator classifications', () => {
  it('classifies the retired payments key as unmapped and flags a real disagreement', () => {
    const empty = { membershipId: 'm', context: { kind: 'any' as const }, denied: null, capabilities: new Map<string, Map<Action, never[]>>() };
    expect(compareDecision({ feature: 'payments', action: 'run', legacyCells: new Set(), legacyAllowed: true, effective: empty }).kind).toBe('unmapped_cell');
    const c = compareDecision({ feature: 'bills', action: 'approve', legacyCells: new Set(['bills::approve']), legacyAllowed: true, effective: empty });
    expect(c).toMatchObject({ kind: 'disagree', explained: false, capability: 'ap.bills:approve' });
  });
});
