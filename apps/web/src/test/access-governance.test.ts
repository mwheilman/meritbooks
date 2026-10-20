/**
 * Wave 2D — access governance (migration 166): the access log, access reviews, access
 * requests (delegation ceiling), template-update suggestions and the time-box sweeper.
 *
 * Replays every migration into PGlite (src/test/pg.ts), provisions two tenants through the
 * wave-1 entry point (core.rbac_provision_tenant), then drives the 166 definer functions the
 * API routes call. Nothing here touches a live database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';

const ORG_A = 'aaaaaaaa-0000-0000-0000-00000000d001';
const ORG_B = 'bbbbbbbb-0000-0000-0000-00000000d001';
const L1 = 'aaaaaaaa-2222-0000-0000-000000000001';
const L2 = 'aaaaaaaa-2222-0000-0000-000000000002';
const LB = 'bbbbbbbb-2222-0000-0000-000000000001';

let db: PGlite;
const member = new Map<string, string>(); // label → membership id
const user = new Map<string, string>(); // label → core.users id
let tenantRole: (org: string, key: string) => Promise<string>;
let freeCap = ''; // a books capability with 'edit' that a bookkeeper does not hold

type Row = Record<string, unknown>;

async function one<T extends Row>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  if (!r.rows[0]) throw new Error(`no row: ${sql}`);
  return r.rows[0];
}
async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
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

/** A seat with an unmapped Clerk role, so the backfill grants nothing and tests assign explicitly. */
async function addMember(label: string, org: string): Promise<string> {
  const u = await one<{ id: string }>(`insert into core.users (clerk_user_id, first_name, last_name) values ($1, 'T', $2) returning id`, [`user_${label}`, label]);
  user.set(label, u.id);
  const m = await one<{ id: string }>(`insert into core.memberships (user_id, org_id, role) values ($1, $2, 'member') returning id`, [u.id, org]);
  member.set(label, m.id);
  return m.id;
}
async function assign(label: string, org: string, roleId: string, scope: 'all_clients' | 'client', location: string | null, extra: Row = {}): Promise<string> {
  const cols = ['org_id', 'membership_id', 'grant_type', 'role_id', 'scope_type', 'location_id', ...Object.keys(extra)];
  const vals = [org, member.get(label), 'role', roleId, scope, location, ...Object.values(extra)];
  const r = await one<{ id: string }>(
    `insert into core.access_assignments (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    vals,
  );
  return r.id;
}
async function holds(label: string, location: string | null, cap: string, action: string): Promise<boolean> {
  const r = await one<{ h: { allowed: boolean } }>(`select core.access_holds($1, $2, $3, $4) as h`, [member.get(label), location, cap, action]);
  return r.h.allowed;
}
async function logFor(subjectId: string): Promise<Array<{ event: string; source: string; actor_user_id: string | null; reason: string | null; before: Row | null; after: Row | null }>> {
  return (await db.query<{ event: string; source: string; actor_user_id: string | null; reason: string | null; before: Row | null; after: Row | null }>(
    `select event, source, actor_user_id, reason, before, after from core.access_change_log where subject_id = $1 order by seq`, [subjectId],
  )).rows;
}
async function asAuthenticated<T>(clerkSub: string, org: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: clerkSub, org_id: org, role: 'authenticated' })]);
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
      ('${ORG_A}', 'Firm A', 'firm-a-2d', 'firm'), ('${ORG_B}', 'Company B', 'company-b-2d', 'company');
  `);
  await insertRow('core', 'locations', { id: L1, org_id: ORG_A, name: 'Client One', short_code: 'C1' });
  await insertRow('core', 'locations', { id: L2, org_id: ORG_A, name: 'Client Two', short_code: 'C2' });
  await insertRow('core', 'locations', { id: LB, org_id: ORG_B, name: 'B Main', short_code: 'BM' });
  for (const l of ['admin', 'admin2', 'grantor', 'bk1', 'bk2', 'nobody']) await addMember(l, ORG_A);
  await addMember('b_admin', ORG_B);
  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_A]);
  await db.query(`select core.rbac_provision_tenant($1)`, [ORG_B]);

  tenantRole = async (org, key) =>
    (await one<{ id: string }>(`select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and key = $2`, [org, key])).id;

  const bookkeeper = await tenantRole(ORG_A, 'bookkeeper');
  freeCap = (await one<{ key: string }>(
    `select c.key from core.capabilities c
      where c.module = 'books' and c.status = 'active' and 'edit' = any (c.actions) and c.tags = '{}'
        and not exists (select 1 from jsonb_array_elements(core.rbac_role_current_grants($1)) e where e->>'capability' = c.key)
      order by c.key limit 1`, [bookkeeper],
  )).key;

  // A custom "grantor" role: may grant access and holds freeCap — but nothing else.
  const grantorRole = (await one<{ id: string }>(
    `insert into core.role_definitions (owner_level, org_id, key, name, kind, audience, default_scope, assignable_band)
     values ('tenant', $1, 'grantor_test', 'Grantor', 'custom', 'internal_staff', 'all_clients', 'managers') returning id`, [ORG_A],
  )).id;
  await db.query(`select core.rbac_publish_role_grants($1, $2::jsonb, 'test')`, [
    grantorRole,
    JSON.stringify([
      { capability: 'core.access.assignments', actions: ['view', 'create'] },
      { capability: freeCap, actions: ['view', 'edit'] },
    ]),
  ]);

  await assign('admin', ORG_A, await tenantRole(ORG_A, 'tenant_admin'), 'all_clients', null);
  await assign('admin2', ORG_A, await tenantRole(ORG_A, 'tenant_admin'), 'all_clients', null);
  await assign('grantor', ORG_A, grantorRole, 'all_clients', null);
  await assign('bk1', ORG_A, bookkeeper, 'client', L1);
  await assign('bk2', ORG_A, bookkeeper, 'client', L1);
  await assign('b_admin', ORG_B, await tenantRole(ORG_B, 'tenant_admin'), 'all_clients', null);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

// ── 1. The access log ─────────────────────────────────────────────────────────────

describe('access log: triggers capture every grant change', () => {
  it('logs grant, mute, read-only, extend, revoke and delete on an assignment, with attribution', async () => {
    const id = await assign('nobody', ORG_A, await tenantRole(ORG_A, 'view_only'), 'client', L2,
      { granted_by: user.get('admin'), reason: 'Covering month-end' });
    await db.query(`update core.access_assignments set muted = '{"reports.financial": ["export"]}', changed_by = $2, change_reason = 'no exports' where id = $1`, [id, user.get('admin')]);
    await db.query(`update core.access_assignments set read_only = true where id = $1`, [id]);
    await db.query(`update core.access_assignments set effective_to = now() + interval '30 days' where id = $1`, [id]);
    await db.query(`update core.access_assignments set effective_to = now() + interval '60 days' where id = $1`, [id]);
    await db.query(`update core.access_assignments set updated_at = now() where id = $1`, [id]); // not an access change
    await db.query(`update core.access_assignments set status = 'revoked', changed_by = $2, change_reason = 'left the team' where id = $1`, [id, user.get('admin2')]);
    await db.query(`delete from core.access_assignments where id = $1`, [id]);

    const log = await logFor(id);
    expect(log.map((l) => l.event)).toEqual([
      'assignment.grant', 'assignment.mute', 'assignment.read_only', 'assignment.time_box',
      'assignment.extend', 'assignment.revoke', 'assignment.delete',
    ]);
    expect(log[0]).toMatchObject({ actor_user_id: user.get('admin'), reason: 'Covering month-end' });
    expect(log[0].after).toMatchObject({ source_key: 'view_only', scope_type: 'client', location_name: 'Client Two' });
    expect(log[1]).toMatchObject({ actor_user_id: user.get('admin'), reason: 'no exports' });
    expect(log[5]).toMatchObject({ actor_user_id: user.get('admin2'), reason: 'left the team' });
    expect((log[5].before as Row).status).toBe('active');
    expect((log[5].after as Row).status).toBe('revoked');
    const row = await one<{ affected_membership_ids: string[]; location_ids: string[]; org_id: string }>(
      `select affected_membership_ids, location_ids, org_id from core.access_change_log where subject_id = $1 order by seq limit 1`, [id]);
    expect(row).toMatchObject({ affected_membership_ids: [member.get('nobody')], location_ids: [L2], org_id: ORG_A });
  });

  it('logs role and permission-set publishes with the grant adds / removes, and role metadata changes', async () => {
    const role = (await one<{ id: string }>(
      `insert into core.role_definitions (owner_level, org_id, key, name, kind, audience) values ('tenant', $1, 'log_role', 'Log role', 'custom', 'internal_staff') returning id`, [ORG_A],
    )).id;
    await db.query(`select core.rbac_publish_role_grants($1, $2::jsonb, 'first', $3)`, [role, JSON.stringify([{ capability: freeCap, actions: ['view'] }]), user.get('admin')]);
    await db.query(`select core.rbac_publish_role_grants($1, $2::jsonb, 'widen', $3)`, [role, JSON.stringify([{ capability: freeCap, actions: ['view', 'edit'] }]), user.get('admin')]);
    await db.query(`update core.role_definitions set status = 'deprecated' where id = $1`, [role]);
    const log = await logFor(role);
    expect(log.map((l) => l.event)).toEqual(['role.create', 'role.publish', 'role.publish', 'role.deprecate']);
    expect(log[2].after).toMatchObject({ version: 2, adds: [{ capability: freeCap, action: 'edit' }], removes: [] });
    expect(log[2]).toMatchObject({ actor_user_id: user.get('admin'), reason: 'widen' });

    const sets = await db.query<{ event: string }>(
      `select l.event from core.access_change_log l join core.permission_sets s on s.id = l.subject_id
        where s.org_id = $1 and s.key = 'payroll_comp_visibility' order by l.seq`, [ORG_A]);
    expect(sets.rows.map((r) => r.event)).toEqual(['permission_set.create', 'permission_set.publish']);
  });

  it('is append-only: no update, delete or truncate — for anyone, including the owner', async () => {
    expect(await errorOf(`update core.access_change_log set reason = 'x'`)).toMatch(/append-only/);
    expect(await errorOf(`delete from core.access_change_log`)).toMatch(/append-only/);
    expect(await errorOf(`truncate core.access_change_log`)).toMatch(/append-only/);
    await db.exec('set role service_role');
    try {
      expect(await errorOf(`insert into core.access_change_log (org_id, event, subject_type) values ($1, 'assignment.grant', 'assignment')`, [ORG_A])).toMatch(/permission denied/);
      expect(await errorOf(`select core.access_log_append($1, null, 'assignment.grant', 'assignment', null, '{}', '{}', null, 'forged')`, [ORG_A])).toMatch(/cannot be appended/);
    } finally {
      await db.exec('reset role');
    }
    await db.exec('set role authenticated');
    try {
      expect(await errorOf(`insert into core.access_change_log (org_id, event, subject_type) values ($1, 'assignment.grant', 'assignment')`, [ORG_A])).toMatch(/permission denied/);
      expect(await errorOf(`select core.access_log_write($1, 'assignment.grant', 'assignment', null, '{}', '{}', false, null, null)`, [ORG_A])).toMatch(/permission denied/);
    } finally {
      await db.exec('reset role');
    }
  });

  it('RLS: tenant admins read their own tenant only; members without audit rights read nothing', async () => {
    const adminRows = await asAuthenticated('user_admin', ORG_A, async () =>
      (await db.query<{ org_id: string }>(`select distinct org_id from core.access_change_log`)).rows);
    expect(adminRows.map((r) => r.org_id)).toEqual([ORG_A]);
    const nobody = await asAuthenticated('user_bk1', ORG_A, async () =>
      (await db.query<{ n: number }>(`select count(*)::int as n from core.access_change_log`)).rows[0].n);
    expect(nobody).toBe(0);
    const cross = await asAuthenticated('user_admin', ORG_B, async () =>
      (await db.query<{ n: number }>(`select count(*)::int as n from core.access_change_log`)).rows[0].n);
    expect(cross).toBe(0);
  });
});

// ── 2. Access reviews ─────────────────────────────────────────────────────────────

describe('access reviews', () => {
  it('a revoke decision ends the assignment immediately and is logged as a review', async () => {
    const reviewId = (await one<{ id: string }>(
      `select core.access_review_start($1, $2, 'Q4 review', 'client', $3, null, now() + interval '14 days') as id`,
      [ORG_A, user.get('admin'), L1])).id;
    const items = (await db.query<{ id: string; membership_id: string; reviewer_membership_id: string | null; subject_id: string }>(
      `select id, membership_id, reviewer_membership_id, subject_id from core.access_review_items where review_id = $1`, [reviewId])).rows;
    const bkItem = items.find((i) => i.membership_id === member.get('bk2'))!;
    expect(bkItem).toBeDefined();
    // all-clients grants cover the client, so they are in scope too
    expect(items.some((i) => i.membership_id === member.get('grantor'))).toBe(true);
    // nobody reviews themselves
    const adminItem = items.find((i) => i.membership_id === member.get('admin'))!;
    expect(adminItem.reviewer_membership_id).not.toBe(member.get('admin'));
    expect(await errorOf(`select core.access_review_decide($1, $2, 'keep', null)`, [adminItem.id, user.get('admin')])).toMatch(/H1/);
    // a bookkeeper cannot decide someone else's item
    expect(await errorOf(`select core.access_review_decide($1, $2, 'keep', null)`, [bkItem.id, user.get('bk1')])).toMatch(/another reviewer/);

    expect(await holds('bk2', L1, 'reports.financial', 'view')).toBe(true);
    await db.query(`select core.access_review_decide($1, $2, 'revoke', 'Moved to another team')`, [bkItem.id, user.get('admin')]);
    const a = await one<{ status: string; ended: boolean }>(
      `select status, effective_to <= now() as ended from core.access_assignments where id = $1`, [bkItem.subject_id]);
    expect(a).toEqual({ status: 'revoked', ended: true });
    expect(await holds('bk2', L1, 'reports.financial', 'view')).toBe(false);
    const log = await logFor(bkItem.subject_id);
    expect(log.at(-1)).toMatchObject({ event: 'assignment.revoke', source: 'review', actor_user_id: user.get('admin'), reason: 'Moved to another team' });
    expect(await errorOf(`select core.access_review_decide($1, $2, 'keep', null)`, [bkItem.id, user.get('admin')])).toMatch(/already revoked/);

    const summary = await one<{ s: { items: number; revoked: number; undecided: number } }>(
      `select core.access_review_close($1, $2) as s`, [reviewId, user.get('admin')]);
    expect(summary.s.revoked).toBe(1);
    expect(summary.s.items).toBe(items.length);
    expect(await errorOf(`select core.access_review_decide($1, $2, 'keep', null)`, [adminItem.id, user.get('admin2')])).toMatch(/closed/);
  });

  it('auto-revoke on close ends unreviewed access; only admins / reviewers start reviews', async () => {
    expect(await errorOf(`select core.access_review_start($1, $2, 'x', 'all', null, null, now() + interval '1 day')`, [ORG_A, user.get('bk1')]))
      .toMatch(/cannot start/);
    const viewOnly = await tenantRole(ORG_A, 'view_only');
    const asg = await assign('nobody', ORG_A, viewOnly, 'client', L2);
    const reviewId = (await one<{ id: string }>(
      `select core.access_review_start($1, $2, 'View-only sweep', 'role', null, $3, now() + interval '1 day', null, true) as id`,
      [ORG_A, user.get('admin'), viewOnly])).id;
    const s = await one<{ s: { auto_revoked: number } }>(`select core.access_review_close($1, $2) as s`, [reviewId, user.get('admin')]);
    expect(s.s.auto_revoked).toBeGreaterThanOrEqual(1);
    expect((await one<{ status: string }>(`select status from core.access_assignments where id = $1`, [asg])).status).toBe('revoked');
  });
});

// ── 3. Access requests + delegation ceiling ──────────────────────────────────────

describe('access requests', () => {
  it('approval by someone who lacks the right is refused; a grantor holding it creates the assignment', async () => {
    expect(await holds('bk1', L2, freeCap, 'edit')).toBe(false);
    const reqId = (await one<{ id: string }>(
      `select core.access_request_create($1, $2, 'capability', $3, array['edit'], null, null, $4, 7, 'Need to fix entries on Client Two') as id`,
      [ORG_A, user.get('bk1'), freeCap, L2])).id;
    const req = await one<{ routed_to_membership_ids: string[]; actions: string[] }>(
      `select routed_to_membership_ids, actions from core.access_requests where id = $1`, [reqId]);
    expect(req.routed_to_membership_ids).toEqual(expect.arrayContaining([member.get('admin'), member.get('grantor')]));
    expect(req.routed_to_membership_ids).not.toContain(member.get('bk2'));
    expect(req.routed_to_membership_ids).not.toContain(member.get('bk1'));

    // duplicate request → same row
    const again = await one<{ id: string }>(
      `select core.access_request_create($1, $2, 'capability', $3, array['edit'], null, null, $4, 7, 'again') as id`, [ORG_A, user.get('bk1'), freeCap, L2]);
    expect(again.id).toBe(reqId);

    // bk2 (bookkeeper, cannot grant) is refused by the ceiling; the requester can't approve themselves
    expect(await errorOf(`select core.access_request_decide($1, $2, 'approve', null)`, [reqId, user.get('bk2')])).toMatch(/Delegation ceiling/);
    expect(await errorOf(`select core.access_request_decide($1, $2, 'approve', null)`, [reqId, user.get('bk1')])).toMatch(/H1/);

    const res = await one<{ r: { status: string; assignment_id: string; needs_second_approval: boolean } }>(
      `select core.access_request_decide($1, $2, 'approve', 'ok for a week') as r`, [reqId, user.get('grantor')]);
    expect(res.r).toMatchObject({ status: 'approved', needs_second_approval: false });
    expect(await holds('bk1', L2, freeCap, 'edit')).toBe(true);
    expect(await holds('bk1', L1, freeCap, 'edit')).toBe(false); // scoped to the requested client
    const asg = await one<{ source: string; granted_by: string; days: number }>(
      `select source, granted_by, round(extract(epoch from effective_to - now()) / 86400)::int as days from core.access_assignments where id = $1`,
      [res.r.assignment_id]);
    expect(asg).toEqual({ source: 'jit_request', granted_by: user.get('grantor'), days: 7 });
    const log = await logFor(res.r.assignment_id);
    expect(log[0]).toMatchObject({ event: 'assignment.grant', source: 'request', actor_user_id: user.get('grantor') });
    expect((await logFor(reqId)).map((l) => l.event)).toEqual(['request.create', 'request.approve']);
    expect(await errorOf(`select core.access_request_decide($1, $2, 'deny', null)`, [reqId, user.get('admin')])).toMatch(/already approved/);
  });

  it('a grantor cannot grant beyond their own grants; tenant admins are the root of trust', async () => {
    const reqId = (await one<{ id: string }>(
      `select core.access_request_create($1, $2, 'role', null, null, $3, null, $4, null, 'Need bookkeeping on Client Two') as id`,
      [ORG_A, user.get('bk1'), await tenantRole(ORG_A, 'bookkeeper'), L2])).id;
    // the grantor only holds freeCap, not the bookkeeper role's capabilities
    expect(await errorOf(`select core.access_request_decide($1, $2, 'approve', null)`, [reqId, user.get('grantor')])).toMatch(/You do not hold/);
    const res = await one<{ r: { status: string; needs_second_approval: boolean } }>(
      `select core.access_request_decide($1, $2, 'approve', null) as r`, [reqId, user.get('admin')]);
    // the bookkeeper role can send invoices (release = an irreversible external effect, 05 §2.1),
    // so it is high-risk under 05 §4.2 item 6: pending until a second grantor confirms
    expect(res.r).toMatchObject({ status: 'approved', needs_second_approval: true });
    expect(await holds('bk1', L2, 'reports.financial', 'view')).toBe(false);
    await db.query(`select core.access_request_confirm($1, $2)`, [reqId, user.get('admin2')]);
    expect(await holds('bk1', L2, 'reports.financial', 'view')).toBe(true);
  });

  it('high-risk grants are created pending and need a different second grantor', async () => {
    const reqId = (await one<{ id: string }>(
      `select core.access_request_create($1, $2, 'capability', 'core.access.members', array['view'], null, null, null, 30, 'Help with onboarding') as id`,
      [ORG_A, user.get('bk1')])).id;
    const res = await one<{ r: { assignment_id: string; needs_second_approval: boolean } }>(
      `select core.access_request_decide($1, $2, 'approve', null) as r`, [reqId, user.get('admin')]);
    expect(res.r.needs_second_approval).toBe(true);
    expect(await holds('bk1', null, 'core.access.members', 'view')).toBe(false);
    expect(await errorOf(`select core.access_request_confirm($1, $2)`, [reqId, user.get('admin')])).toMatch(/H1/);
    await db.query(`select core.access_request_confirm($1, $2)`, [reqId, user.get('admin2')]);
    expect(await holds('bk1', null, 'core.access.members', 'view')).toBe(true);
  });

  it('deny and withdraw; you cannot request what you already hold', async () => {
    expect(await errorOf(
      `select core.access_request_create($1, $2, 'capability', $3, array['edit'], null, null, $4, null, 'dup')`, [ORG_A, user.get('bk1'), freeCap, L2],
    )).toMatch(/already have/);
    const r1 = (await one<{ id: string }>(
      `select core.access_request_create($1, $2, 'client', null, null, null, null, $3, null, 'Help on client two') as id`, [ORG_A, user.get('nobody'), L2])).id;
    // no primary role → approving needs a role; deny works for an admin
    expect(await errorOf(`select core.access_request_decide($1, $2, 'approve', null)`, [r1, user.get('admin')])).toMatch(/Choose a role/);
    await db.query(`select core.access_request_decide($1, $2, 'deny', 'Not needed')`, [r1, user.get('admin')]);
    expect((await one<{ status: string }>(`select status from core.access_requests where id = $1`, [r1])).status).toBe('denied');
    const r2 = (await one<{ id: string }>(
      `select core.access_request_create($1, $2, 'client', null, null, null, null, $3, null, 'Changed my mind') as id`, [ORG_A, user.get('nobody'), L1])).id;
    expect(await errorOf(`select core.access_request_cancel($1, $2)`, [r2, user.get('admin')])).toMatch(/Only the requester/);
    await db.query(`select core.access_request_cancel($1, $2)`, [r2, user.get('nobody')]);
    expect((await one<{ status: string }>(`select status from core.access_requests where id = $1`, [r2])).status).toBe('cancelled');
  });

  it('RLS: requesters see their own requests; routed grantors see theirs; others see nothing', async () => {
    const mine = await asAuthenticated('user_nobody', ORG_A, async () =>
      (await db.query<{ n: number }>(`select count(*)::int as n from core.access_requests`)).rows[0].n);
    expect(mine).toBe(2);
    const bk2 = await asAuthenticated('user_bk2', ORG_A, async () =>
      (await db.query<{ n: number }>(`select count(*)::int as n from core.access_requests`)).rows[0].n);
    expect(bk2).toBe(0);
  });
});

// ── 4. Template-update suggestions (R-10) ────────────────────────────────────────

describe('template updates: Current / Proposed', () => {
  it('a new template version becomes suggestions; Add creates Proposed changes (a new version), Keep current leaves it', async () => {
    const template = (await one<{ id: string }>(`select id from core.role_definitions where owner_level = 'platform' and key = 'bookkeeper'`)).id;
    const derivedA = await tenantRole(ORG_A, 'bookkeeper');
    const derivedB = await tenantRole(ORG_B, 'bookkeeper');
    const tGrants = (await one<{ g: Array<{ capability: string; actions: string[]; constraints: Row }> }>(
      `select core.rbac_role_current_grants($1) as g`, [template])).g;
    const aGrants = (await one<{ g: Array<{ capability: string; actions: string[] }> }>(`select core.rbac_role_current_grants($1) as g`, [derivedA])).g;
    const shared = tGrants.find((t) => aGrants.some((a) => a.capability === t.capability))!;
    expect(shared).toBeDefined();
    const addCap = (await one<{ key: string }>(
      `select c.key from core.capabilities c
        where c.module = 'books' and c.status = 'active' and 'view' = any (c.actions) and c.tags = '{}'
          and not exists (select 1 from jsonb_array_elements(core.rbac_role_current_grants($1)) e where e->>'capability' = c.key)
          and not exists (select 1 from jsonb_array_elements(core.rbac_role_current_grants($2)) e where e->>'capability' = c.key)
          and not exists (select 1 from jsonb_array_elements(core.rbac_role_current_grants($3)) e where e->>'capability' = c.key)
        order by c.key limit 1`, [template, derivedA, derivedB])).key;
    const before = (await one<{ v: number }>(`select current_version as v from core.role_definitions where id = $1`, [derivedA])).v;

    const next = [...tGrants.filter((g) => g.capability !== shared.capability), { capability: addCap, actions: ['view'], constraints: {} }];
    await db.query(`select core.rbac_publish_role_grants($1, $2::jsonb, 'MeritBooks v2')`, [template, JSON.stringify(next)]);

    const upd = await one<{ id: string; changes: Array<{ id: string; kind: string; capability: string }>; status: string }>(
      `select id, changes, status from core.template_updates where derived_role_id = $1`, [derivedA]);
    expect(upd.status).toBe('available');
    const addId = `${addCap}:add`;
    const remId = `${shared.capability}:remove`;
    expect(upd.changes.map((c) => c.id)).toEqual(expect.arrayContaining([addId, remId]));
    // nothing changed yet — suggestions are optional
    expect((await one<{ v: number }>(`select current_version as v from core.role_definitions where id = $1`, [derivedA])).v).toBe(before);

    // tenant B: Keep current = skip everything → no new version, dismissed
    const updB = await one<{ id: string; changes: Array<{ id: string }> }>(`select id, changes from core.template_updates where derived_role_id = $1`, [derivedB]);
    const vB = (await one<{ n: number }>(`select count(*)::int as n from core.role_versions where role_id = $1`, [derivedB])).n;
    const rB = await one<{ r: { status: string } }>(`select core.template_update_decide($1, $2, '{}', $3::text[]) as r`,
      [updB.id, user.get('b_admin'), updB.changes.map((c) => c.id)]);
    expect(rB.r.status).toBe('dismissed');
    expect((await one<{ n: number }>(`select count(*)::int as n from core.role_versions where role_id = $1`, [derivedB])).n).toBe(vB);

    // a bookkeeper cannot answer suggestions
    expect(await errorOf(`select core.template_update_decide($1, $2, array[$3], '{}')`, [upd.id, user.get('bk1'), addId])).toMatch(/cannot change roles/);

    // tenant A: Add one (→ Proposed changes), then skip the rest and publish
    const r1 = await one<{ r: { status: string; draft_version: number } }>(
      `select core.template_update_decide($1, $2, array[$3], '{}') as r`, [upd.id, user.get('admin'), addId]);
    expect(r1.r.draft_version).toBe(before + 1);
    const draft = await one<{ state: string; has: boolean }>(
      `select v.state, exists (select 1 from core.role_grants g where g.role_version_id = v.id and g.capability = $2 and 'view' = any (g.actions)) as has
         from core.role_versions v where v.role_id = $1 and v.version = $3`, [derivedA, addCap, before + 1]);
    expect(draft).toEqual({ state: 'draft', has: true });
    expect(await holds('bk1', L1, addCap, 'view')).toBe(false); // Proposed is not Current

    const rest = upd.changes.map((c) => c.id).filter((x) => x !== addId);
    const r2 = await one<{ r: { status: string; published_version: number } }>(
      `select core.template_update_decide($1, $2, '{}', $3::text[], true, 'Adopt MeritBooks suggestion') as r`, [upd.id, user.get('admin'), rest]);
    expect(r2.r).toMatchObject({ status: 'partially_adopted', published_version: before + 1 });
    const cur = (await one<{ v: number; up: number }>(`select current_version as v, upstream_version as up from core.role_definitions where id = $1`, [derivedA]));
    expect(cur.v).toBe(before + 1);
    expect(await holds('bk1', L1, addCap, 'view')).toBe(true);
    expect(await holds('bk1', L1, shared.capability, shared.actions[0])).toBe(true); // the skipped removal kept it
    const logged = await db.query<{ event: string; source: string }>(
      `select event, source from core.access_change_log where subject_id in ($1, $2) order by seq`, [upd.id, derivedA]);
    expect(logged.rows).toEqual(expect.arrayContaining([
      { event: 'template_update.adopt', source: 'template_update' },
      { event: 'role.publish', source: 'template_update' },
    ]));
    expect(await errorOf(`select core.template_update_decide($1, $2, '{}', array[$3])`, [upd.id, user.get('admin'), addId])).toMatch(/already answered/);
  });
});

// ── 5. Time-boxed grants ──────────────────────────────────────────────────────────

describe('expire_access (time-box sweeper)', () => {
  it('ends grants past effective_to, logs them as the sweeper, and leaves open-ended grants alone', async () => {
    const viewOnly = await tenantRole(ORG_A, 'view_only');
    const past = await assign('nobody', ORG_A, viewOnly, 'client', L1, {
      effective_from: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      effective_to: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const future = await assign('nobody', ORG_A, viewOnly, 'client', L2, {
      effective_to: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    });
    const r = await one<{ r: { expired_assignments: number } }>(`select core.expire_access($1) as r`, [ORG_A]);
    expect(r.r.expired_assignments).toBeGreaterThanOrEqual(1);
    expect((await one<{ status: string }>(`select status from core.access_assignments where id = $1`, [past])).status).toBe('expired');
    expect((await one<{ status: string }>(`select status from core.access_assignments where id = $1`, [future])).status).toBe('active');
    const log = await logFor(past);
    expect(log.at(-1)).toMatchObject({ event: 'assignment.expire', source: 'sweeper', actor_user_id: null });
    const ctx = await one<{ actor_context: string }>(
      `select actor_context from core.access_change_log where subject_id = $1 order by seq desc limit 1`, [past]);
    expect(ctx.actor_context).toBe('system:sweeper');
    // idempotent
    const again = await one<{ r: { expired_assignments: number } }>(`select core.expire_access($1) as r`, [ORG_A]);
    expect(again.r.expired_assignments).toBe(0);
  });

  it('every new function is service-only (M1): authenticated cannot execute the mutators', async () => {
    const fns = ['core.expire_access(uuid)', 'core.access_request_decide(uuid, uuid, text, text, uuid, int, text)',
      'core.access_review_decide(uuid, uuid, text, text, text)', 'core.template_update_decide(uuid, uuid, text[], text[], boolean, text, text)'];
    for (const f of fns) {
      const r = await one<{ auth: boolean; svc: boolean }>(
        `select has_function_privilege('authenticated', $1, 'execute') as auth, has_function_privilege('service_role', $1, 'execute') as svc`, [f]);
      expect(r, f).toEqual({ auth: false, svc: true });
    }
  });
});
