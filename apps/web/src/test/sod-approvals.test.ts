/**
 * Wave 2C — separation of duties + approval workflows on capability (migration 165).
 *
 * Replays every migration into PGlite (with hosted Supabase's default grants) and proves:
 *   1. the SoD catalog is seeded (platform role rules S1–S9 + platform-locked H1/H6);
 *   2. core.sod_conflicts_for_membership finds a conflict when one member gets both sides
 *      on the same client — and the TS detector (lib/rbac/sod.ts) agrees with it;
 *   3. an allowed conflict covers it until it expires / is revoked; H1 and "no exception
 *      on a hard rule" hold in the DB; exceptions are immutable;
 *   4. a platform rule can't be disabled, edited or demoted by a tenant (even via the
 *      service role), but a soft rule can be promoted; tenant rules can be turned off;
 *   5. H6 in the DB: releaser ≠ preparer always, releaser ≠ approver unless sole-approver;
 *   6. approval_workflow_steps: backfill, capability validation, role-or-capability;
 *   7. members can read but never write the SoD tables or call the service functions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';
import {
  loadAccessSnapshot,
  type AccessDataSource,
  type AssignmentRow,
  type EnvelopeRow,
  type MembershipRow,
  type SourceRow,
} from '@/lib/rbac/effective-access';
import { detectConflicts, toSodRule, type SodRuleRow } from '@/lib/rbac/sod';

const ORG = 'cccccccc-0000-0000-0000-000000000001';
const ORG_FIRM = 'cccccccc-0000-0000-0000-000000000002';
const L1 = 'cccccccc-1111-0000-0000-000000000001';
const L2 = 'cccccccc-1111-0000-0000-000000000002';
const LF = 'cccccccc-1111-0000-0000-000000000003';

let db: PGlite;
const ids = new Map<string, string>();

async function insertRow(schema: string, table: string, values: Record<string, unknown>): Promise<void> {
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

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function addPerson(label: string, orgId: string): Promise<void> {
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [`user_${label}`]);
  ids.set(`user:${label}`, u.rows[0].id);
  const m = await db.query<{ id: string }>(
    `insert into core.memberships (user_id, org_id, role) values ($1, $2, 'accounting_specialist') returning id`,
    [u.rows[0].id, orgId],
  );
  ids.set(`member:${label}`, m.rows[0].id);
}

async function addRole(key: string, orgId: string, grants: Array<{ capability: string; actions: string[] }>): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into core.role_definitions (owner_level, org_id, key, name, kind) values ('tenant', $1, $2, $2, 'custom') returning id`,
    [orgId, key],
  );
  await db.query(`select core.rbac_publish_role_grants($1, $2::jsonb, 'test', null)`, [r.rows[0].id, JSON.stringify(grants)]);
  ids.set(`role:${key}`, r.rows[0].id);
  return r.rows[0].id;
}

async function assign(member: string, role: string, orgId: string, locationId: string | null): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id)
     values ($1, $2, 'role', $3, $4, $5) returning id`,
    [orgId, ids.get(`member:${member}`), ids.get(`role:${role}`), locationId ? 'client' : 'all_clients', locationId],
  );
  return r.rows[0].id;
}

interface ConflictRow { rule_key: string; location_id: string | null; enforcement: string; exception_id: string | null; matched: string[] }
async function conflictsOf(member: string): Promise<ConflictRow[]> {
  return (await db.query<ConflictRow>(
    `select rule_key, location_id, enforcement, exception_id, matched from core.sod_conflicts_for_membership($1) order by rule_key, location_id`,
    [ids.get(`member:${member}`)],
  )).rows;
}

function pgSource(): AccessDataSource {
  const sources = async (kind: 'role' | 'set', list: string[]): Promise<SourceRow[]> => {
    const sql = kind === 'role'
      ? `select d.id, d.key, d.name, d.owner_level, d.location_id, d.audience, d.current_version, core.rbac_role_current_grants(d.id) as grants
           from core.role_definitions d where d.id = any($1::uuid[])`
      : `select d.id, d.key, d.name, d.owner_level, d.location_id, d.audience, d.current_version, core.rbac_set_current_grants(d.id) as grants
           from core.permission_sets d where d.id = any($1::uuid[])`;
    return (await db.query<SourceRow>(sql, [list])).rows;
  };
  return {
    membership: async (id) =>
      (await db.query<MembershipRow>(`select id, org_id, user_id, role, status, audience, access_epoch::int as access_epoch from core.memberships where id = $1`, [id])).rows[0] ?? null,
    assignments: async (id) =>
      (await db.query<AssignmentRow>(
        `select id, org_id, membership_id, grant_type, role_id, permission_set_id, scope_type, location_id, client_set_id, group_id,
                read_only, muted, constraint_overrides, effective_from::text as effective_from, effective_to::text as effective_to, status
           from core.access_assignments where membership_id = $1`, [id])).rows,
    roles: (list) => sources('role', list),
    permissionSets: (list) => sources('set', list),
    clientSetMembers: async (list) =>
      (await db.query<{ set_id: string; location_id: string }>(`select set_id, location_id from core.client_set_members where set_id = any($1::uuid[])`, [list])).rows,
    envelopes: async () => [] as EnvelopeRow[],
  };
}

async function asMember<T>(fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: 'user_maker', org_id: ORG, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug, tenant_type) values
      ('${ORG}', 'Company C', 'company-c', 'company'),
      ('${ORG_FIRM}', 'Firm F', 'firm-f', 'firm');
  `);
  await insertRow('core', 'locations', { id: L1, org_id: ORG, name: 'Client One', short_code: 'C1' });
  await insertRow('core', 'locations', { id: L2, org_id: ORG, name: 'Client Two', short_code: 'C2' });
  await insertRow('core', 'locations', { id: LF, org_id: ORG_FIRM, name: 'Firm Client', short_code: 'F1' });

  await addPerson('maker', ORG);
  await addPerson('admin', ORG);
  await addPerson('firm_payer', ORG_FIRM);

  await addRole('vendor_maker', ORG, [{ capability: 'mdm.vendors', actions: ['view', 'create'] }]);
  await addRole('payer', ORG, [
    { capability: 'ap.bills', actions: ['view', 'approve'] },
    { capability: 'pay.batches', actions: ['view', 'release'] },
  ]);
  await addRole('bank_editor', ORG_FIRM, [{ capability: 'pay.vendor_bank_details', actions: ['view', 'edit'] }]);
  await addRole('releaser', ORG_FIRM, [{ capability: 'pay.batches', actions: ['view', 'release'] }]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('1. SoD catalog seeded', () => {
  it('has the platform role rules and the platform-locked transaction rules', async () => {
    const r = await db.query<{ key: string; rule_type: string; enforcement: string; platform_locked: boolean; description: string }>(
      `select key, rule_type, enforcement, platform_locked, description from core.sod_rules where org_id is null order by sort_order`,
    );
    const keys = r.rows.map((x) => x.key);
    for (const k of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']) expect(keys).toContain(k);
    for (const k of ['H6_PREPARER_APPROVER', 'H6_PREPARER_RELEASER', 'H6_APPROVER_RELEASER', 'H6_JE_SELF_POST', 'H6_BANK_CHANGE_RELEASE', 'H1_SELF_ADMIN']) {
      const row = r.rows.find((x) => x.key === k)!;
      expect(row).toMatchObject({ rule_type: 'transaction', enforcement: 'hard', platform_locked: true });
    }
    expect(r.rows.find((x) => x.key === 'S9')!.enforcement).toBe('txn_only');
    // UI text is plain English — no codes leak into the sentence.
    for (const row of r.rows) expect(row.description).not.toMatch(/\b(S\d|H\d)/);
    // org settings defaults (Q1/Q4)
    const o = await db.query<{ sole_approver_mode: boolean; je_self_post_threshold_cents: string }>(
      `select sole_approver_mode, je_self_post_threshold_cents::text from core.organizations where id = $1`, [ORG]);
    expect(o.rows[0]).toEqual({ sole_approver_mode: false, je_self_post_threshold_cents: '2500000' });
  });

  it('re-seeding is idempotent and rule references are validated against the catalog', async () => {
    const before = (await db.query<{ n: number }>(`select count(*)::int n from core.sod_rules`)).rows[0].n;
    await db.query(`select core.sod_seed_platform_rules('[{"key":"S7","rule_type":"role","enforcement":"soft","conflict":[["mdm.vendors:create"],["ap.bills:approve"],["pay.batches:release"]],"name":"Create a vendor and pay it","description":"Could both create vendors and release payments to them, approving the bills in between.","suggested_fix":"Remove vendor creation, or have a second person release payments.","sort_order":16}]'::jsonb)`);
    expect((await db.query<{ n: number }>(`select count(*)::int n from core.sod_rules`)).rows[0].n).toBe(before);
    expect(await errorOf(
      `insert into core.sod_rules (org_id, key, name, description, conflict) values ($1, 'T_BAD', 'x', 'x', '[["nope.thing:create"],["ap.bills:approve"]]')`, [ORG],
    )).toMatch(/unknown capability/);
    expect(await errorOf(
      `insert into core.sod_rules (org_id, key, name, description, conflict) values ($1, 'T_ONE', 'x', 'x', '[["ap.bills:approve"]]')`, [ORG],
    )).toMatch(/sod_rules_conflict_chk/);
  });
});

describe('2. conflict detection on the effective set', () => {
  it('no conflict with one side; a conflict on the shared client when both sides are held', async () => {
    await assign('maker', 'vendor_maker', ORG, L1);
    expect(await conflictsOf('maker')).toEqual([]);
    await assign('maker', 'payer', ORG, L2);
    expect(await conflictsOf('maker')).toEqual([]); // different clients
    const a = await assign('maker', 'payer', ORG, L1);
    ids.set('assign:maker_payer_l1', a);
    const c = await conflictsOf('maker');
    expect(c).toEqual([
      { rule_key: 'S7', location_id: L1, enforcement: 'soft', exception_id: null, matched: ['mdm.vendors:create', 'ap.bills:approve', 'pay.batches:release'] },
    ]);
  });

  it('the TS detector agrees with the SQL function', async () => {
    const snap = await loadAccessSnapshot(pgSource(), ids.get('member:maker')!);
    const rules = (await db.query<SodRuleRow>(`select * from core.sod_rules where org_id is null or org_id = $1`, [ORG])).rows.map(toSodRule);
    const ts = detectConflicts(snap!, {
      rules,
      policy: { tenantType: 'company', promotedRuleIds: new Set() },
      exceptions: [],
      orgLocationIds: [L1, L2],
    });
    expect(ts.map((x) => [x.ruleKey, x.locationId, x.enforcement, x.matched])).toEqual(
      (await conflictsOf('maker')).map((x) => [x.rule_key, x.location_id, x.enforcement, x.matched]),
    );
  });

  it('a mute on the assignment removes the conflict', async () => {
    const a = ids.get('assign:maker_payer_l1')!;
    await db.query(`update core.access_assignments set muted = '{"pay.batches":["release"]}' where id = $1`, [a]);
    expect(await conflictsOf('maker')).toEqual([]);
    await db.query(`update core.access_assignments set muted = '{}' where id = $1`, [a]);
    expect((await conflictsOf('maker')).map((x) => x.rule_key)).toEqual(['S7']);
  });

  it('firm tenants: S2 (bank details + release) is hard', async () => {
    await assign('firm_payer', 'bank_editor', ORG_FIRM, LF);
    await assign('firm_payer', 'releaser', ORG_FIRM, LF);
    const c = await conflictsOf('firm_payer');
    expect(c.map((x) => [x.rule_key, x.enforcement])).toEqual([['S2', 'hard']]);
  });
});

describe('3. allowed conflicts (core.sod_exceptions)', () => {
  const ruleId = async (key: string) => (await db.query<{ id: string }>(`select id from core.sod_rules where org_id is null and key = $1`, [key])).rows[0].id;

  it('H1: nobody allows their own conflict; reason required', async () => {
    const s7 = await ruleId('S7');
    expect(await errorOf(
      `insert into core.sod_exceptions (org_id, rule_id, rule_key, membership_id, location_id, justification, approved_by)
       values ($1, $2, 'S7', $3, $4, 'Owner-run company', $5)`,
      [ORG, s7, ids.get('member:maker'), L1, ids.get('user:maker')],
    )).toMatch(/H1/);
    expect(await errorOf(
      `insert into core.sod_exceptions (org_id, rule_id, rule_key, membership_id, location_id, justification, approved_by)
       values ($1, $2, 'S7', $3, $4, 'short', $5)`,
      [ORG, s7, ids.get('member:maker'), L1, ids.get('user:admin')],
    )).toMatch(/justification_chk/);
  });

  it('an active exception covers the conflict until it expires', async () => {
    const s7 = await ruleId('S7');
    // expired one first: does not cover
    await db.query(
      `insert into core.sod_exceptions (org_id, rule_id, rule_key, membership_id, location_id, justification, approved_by, approved_at, expires_at)
       values ($1, $2, 'S7', $3, $4, 'Owner-run company (old)', $5, now() - interval '60 days', now() - interval '1 day')`,
      [ORG, s7, ids.get('member:maker'), L1, ids.get('user:admin')],
    );
    expect((await conflictsOf('maker'))[0].exception_id).toBeNull();
    const ex = await db.query<{ id: string }>(
      `insert into core.sod_exceptions (org_id, rule_id, rule_key, membership_id, location_id, justification, compensating_control, approved_by)
       values ($1, $2, 'ignored', $3, $4, 'Owner-run company', 'CFO reviews the release report weekly', $5) returning id`,
      [ORG, s7, ids.get('member:maker'), L1, ids.get('user:admin')],
    );
    ids.set('ex:maker', ex.rows[0].id);
    const c = await conflictsOf('maker');
    expect(c[0].exception_id).toBe(ex.rows[0].id);
    // rule_key is stamped from the rule, not trusted from the caller
    expect((await db.query<{ rule_key: string }>(`select rule_key from core.sod_exceptions where id = $1`, [ex.rows[0].id])).rows[0].rule_key).toBe('S7');
    // the assignment may reference it; a foreign exception id is refused
    await db.query(`update core.access_assignments set sod_exception_ids = array[$1::uuid] where id = $2`, [ex.rows[0].id, ids.get('assign:maker_payer_l1')]);
    expect(await errorOf(
      `update core.access_assignments set sod_exception_ids = array[gen_random_uuid()] where id = $1`, [ids.get('assign:maker_payer_l1')],
    )).toMatch(/sod_exception_ids/);
  });

  it('exceptions are capped at one year, immutable, never deleted — only revoked once', async () => {
    const s7 = await ruleId('S7');
    expect(await errorOf(
      `insert into core.sod_exceptions (org_id, rule_id, rule_key, membership_id, justification, approved_by, expires_at)
       values ($1, $2, 'S7', $3, 'Owner-run company', $4, now() + interval '2 years')`,
      [ORG, s7, ids.get('member:maker'), ids.get('user:admin')],
    )).toMatch(/window_chk/);
    const id = ids.get('ex:maker')!;
    expect(await errorOf(`update core.sod_exceptions set expires_at = expires_at + interval '1 day' where id = $1`, [id])).toMatch(/immutable/);
    expect(await errorOf(`delete from core.sod_exceptions where id = $1`, [id])).toMatch(/never deleted/);
    await db.query(`update core.sod_exceptions set revoked_at = now(), revoked_by = $2, revoke_reason = 'role changed' where id = $1`, [id, ids.get('user:admin')]);
    expect((await conflictsOf('maker'))[0].exception_id).toBeNull();
    expect(await errorOf(`update core.sod_exceptions set revoke_reason = 'again' where id = $1`, [id])).toMatch(/final/);
  });

  it('no exception for a hard rule, a promoted rule, or a transaction rule', async () => {
    expect(await errorOf(
      `insert into core.sod_exceptions (org_id, rule_id, rule_key, membership_id, location_id, justification, approved_by)
       select $1, id, key, $2, $3, 'Small firm, one finance person', $4 from core.sod_rules where org_id is null and key = 'S2'`,
      [ORG_FIRM, ids.get('member:firm_payer'), LF, ids.get('user:admin')],
    )).toMatch(/outright/);
    expect(await errorOf(
      `insert into core.sod_exceptions (org_id, rule_id, rule_key, membership_id, justification, approved_by)
       select $1, id, key, $2, 'Please allow this one', $3 from core.sod_rules where key = 'H6_APPROVER_RELEASER'`,
      [ORG, ids.get('member:maker'), ids.get('user:admin')],
    )).toMatch(/always blocked/);
  });
});

describe('4. platform rules are locked to tenants', () => {
  it('nobody — not even the service role — can disable, edit or delete a platform rule outside the seed', async () => {
    expect(await errorOf(`update core.sod_rules set status = 'disabled' where org_id is null and key = 'S7'`)).toMatch(/only be changed by the platform/);
    expect(await errorOf(`update core.sod_rules set enforcement = 'soft' where org_id is null and key = 'H6_PREPARER_RELEASER'`)).toMatch(/only be changed by the platform/);
    expect(await errorOf(`delete from core.sod_rules where org_id is null and key = 'S1'`)).toMatch(/only be changed by the platform/);
    expect(await errorOf(`update core.sod_rules set org_id = $1 where org_id is null and key = 'S1'`, [ORG])).toMatch(/only be changed by the platform/);
  });

  it('a tenant may promote a soft platform rule to hard, never a locked / per-item rule; there is no "demote" value', async () => {
    await db.query(`insert into core.sod_rule_settings (org_id, rule_id) select $1, id from core.sod_rules where org_id is null and key = 'S7'`, [ORG]);
    expect((await conflictsOf('maker'))[0].enforcement).toBe('hard');
    expect(await errorOf(`insert into core.sod_rule_settings (org_id, rule_id, enforcement) select $1, id, 'soft' from core.sod_rules where org_id is null and key = 'S1'`, [ORG])).toMatch(/enforcement_check|check/);
    expect(await errorOf(`insert into core.sod_rule_settings (org_id, rule_id) select $1, id from core.sod_rules where key = 'S9'`, [ORG])).toMatch(/cannot be changed/);
    expect(await errorOf(`insert into core.sod_rule_settings (org_id, rule_id) select $1, id from core.sod_rules where key = 'H6_PREPARER_APPROVER'`, [ORG])).toMatch(/cannot be changed/);
    await db.query(`delete from core.sod_rule_settings where org_id = $1`, [ORG]);
    expect((await conflictsOf('maker'))[0].enforcement).toBe('soft');
  });

  it('tenant rules can be added, fire, and be turned off', async () => {
    await db.query(
      `insert into core.sod_rules (org_id, key, name, description, conflict, enforcement)
       values ($1, 'T_VENDOR_BILLS', 'Vendors and bills', 'Could both create vendors and approve their bills.', '[["mdm.vendors:create"],["ap.bills:approve"]]', 'hard')`,
      [ORG],
    );
    expect((await conflictsOf('maker')).map((x) => [x.rule_key, x.enforcement])).toEqual([['S7', 'soft'], ['T_VENDOR_BILLS', 'hard']]);
    await db.query(`update core.sod_rules set status = 'disabled' where org_id = $1 and key = 'T_VENDOR_BILLS'`, [ORG]);
    expect((await conflictsOf('maker')).map((x) => x.rule_key)).toEqual(['S7']);
    // tenant rules can't be transaction rules or platform-locked
    expect(await errorOf(
      `insert into core.sod_rules (org_id, key, name, description, rule_type, platform_locked) values ($1, 'T_X', 'x', 'x', 'transaction', true)`, [ORG],
    )).not.toBeNull();
  });
});

describe('5. H6 in the DB — release guard on public.approvals', () => {
  async function approval(prepared: string, approved: string | null): Promise<string> {
    const r = await db.query<{ id: string }>(
      `insert into public.approvals (org_id, kind, subject_table, subject_id, status, prepared_by, approved_by, amount_cents)
       values ($1, 'AP_DISBURSEMENT', 'bill_payments', gen_random_uuid(), $2, $3, $4, 100000) returning id`,
      [ORG, approved ? 'APPROVED' : 'PENDING_APPROVAL', prepared, approved],
    );
    return r.rows[0].id;
  }

  it('releaser ≠ preparer always; releaser ≠ approver unless sole-approver mode', async () => {
    const a = await approval('user_p', 'user_a');
    expect(await errorOf(`update public.approvals set status = 'RELEASED', released_by = 'user_p' where id = $1`, [a])).toMatch(/prepared this payment/);
    expect(await errorOf(`update public.approvals set status = 'RELEASED', released_by = 'user_a' where id = $1`, [a])).toMatch(/approved this payment/);
    expect(await errorOf(`update public.approvals set status = 'RELEASED', released_by = 'user_r' where id = $1`, [a])).toBeNull();

    await db.query(`update core.organizations set sole_approver_mode = true where id = $1`, [ORG]);
    const b = await approval('user_p', 'user_a');
    expect(await errorOf(`update public.approvals set status = 'RELEASED', released_by = 'user_a' where id = $1`, [b])).toBeNull();
    const c = await approval('user_p', 'user_a');
    expect(await errorOf(`update public.approvals set status = 'RELEASED', released_by = 'user_p' where id = $1`, [c])).toMatch(/prepared this payment/);
    await db.query(`update core.organizations set sole_approver_mode = false where id = $1`, [ORG]);
    // un-claiming a release (released_by → null) stays possible
    expect(await errorOf(`update public.approvals set status = 'APPROVED', released_by = null where id = $1`, [b])).toBeNull();
  });
});

describe('6. approval workflow steps on capability (R-12)', () => {
  it('capability steps validate; role-or-capability required; backfill fills legacy rows', async () => {
    const wf = await db.query<{ id: string }>(
      `insert into public.approval_workflows (org_id, name, doc_type) values ($1, 'AP', 'BILL') returning id`, [ORG]);
    const w = wf.rows[0].id;
    await db.query(
      `insert into public.approval_workflow_steps (org_id, workflow_id, step_order, approver_capability, min_approver_limit_cents) values ($1, $2, 1, 'ap.bills:approve', 5000000)`,
      [ORG, w],
    );
    expect(await errorOf(`insert into public.approval_workflow_steps (org_id, workflow_id, step_order) values ($1, $2, 2)`, [ORG, w])).toMatch(/approver_chk/);
    expect(await errorOf(
      `insert into public.approval_workflow_steps (org_id, workflow_id, step_order, approver_capability) values ($1, $2, 3, 'ap.bills:view')`, [ORG, w],
    )).toMatch(/capability_fmt/);
    expect(await errorOf(
      `insert into public.approval_workflow_steps (org_id, workflow_id, step_order, approver_capability) values ($1, $2, 4, 'nope.things:approve')`, [ORG, w],
    )).toMatch(/unknown approver capability/);
    expect(await errorOf(
      `insert into public.approval_workflow_steps (org_id, workflow_id, step_order, approver_capability, min_approver_limit_cents) values ($1, $2, 5, 'ap.bills:approve', -1)`, [ORG, w],
    )).toMatch(/floor_chk/);
    // legacy role-only step (pre-165 shape) still accepted
    await db.query(`insert into public.approval_workflow_steps (org_id, workflow_id, step_order, approver_role) values ($1, $2, 6, 'cfo')`, [ORG, w]);
    // the 165 backfill statement maps doc type → capability for role rows
    await db.query(`update public.approval_workflow_steps s set approver_capability = 'gl.journal_entries:approve' from public.approval_workflows w
                     where w.id = s.workflow_id and w.doc_type = 'JOURNAL_ENTRY' and s.approver_capability is null`);
    const rows = (await db.query<{ step_order: number; approver_role: string | null; approver_capability: string | null }>(
      `select step_order, approver_role, approver_capability from public.approval_workflow_steps where workflow_id = $1 order by step_order`, [w])).rows;
    expect(rows).toEqual([
      { step_order: 1, approver_role: null, approver_capability: 'ap.bills:approve' },
      { step_order: 6, approver_role: 'cfo', approver_capability: null },
    ]);
    // approval_requests carries the document's client
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'approval_requests' and column_name = 'location_id'`);
    expect(cols.rows).toHaveLength(1);
  });
});

describe('7. members read, never write', () => {
  it('reads are tenant-scoped; writes and service functions are refused', async () => {
    const visible = await asMember(() => db.query<{ key: string; org_id: string | null }>(`select key, org_id from core.sod_rules`));
    expect(visible.rows.some((r) => r.org_id === null)).toBe(true);
    expect(visible.rows.every((r) => r.org_id === null || r.org_id === ORG)).toBe(true);
    const ex = await asMember(() => db.query<{ org_id: string }>(`select org_id from core.sod_exceptions`));
    expect(ex.rows.every((r) => r.org_id === ORG)).toBe(true);
    for (const sql of [
      `insert into core.sod_rules (org_id, key, name, description, conflict) values ('${ORG}', 'T_M', 'x', 'x', '[["mdm.vendors:create"],["ap.bills:approve"]]')`,
      `update core.sod_exceptions set revoked_at = now()`,
      `insert into core.sod_rule_settings (org_id, rule_id) select '${ORG}', id from core.sod_rules where key = 'S1'`,
      `update core.organizations set sole_approver_mode = true`,
      `select * from core.sod_conflicts_for_membership('${ids.get('member:maker')}')`,
      `select core.sod_seed_platform_rules('[]'::jsonb)`,
    ]) {
      expect(await asMember(() => errorOf(sql)), sql).not.toBeNull();
    }
  });
});
