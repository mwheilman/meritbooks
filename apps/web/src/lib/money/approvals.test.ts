/**
 * canApprove — money-movement approval authorization, reconciled to Core identity.
 *
 * SAFETY-CRITICAL. This is the gate that decides whether a human MAY approve a
 * money movement (release of funds). It must:
 *   - resolve authority from the canonical spine (core.users -> core.memberships),
 *   - normalize the membership role ('owner'/'org_admin' -> full approver),
 *   - honor the membership decision when one exists (never fall back past it),
 *   - fall back to the interim core.employees.role ONLY when no active membership,
 *   - and FAIL CLOSED on every error/absence/unknown-role path.
 *
 * The membership-role normalization is asserted directly (pure), and canApprove
 * is asserted against a hand-rolled fake of the Supabase query builder so the
 * resolution order and fail-closed behavior are pinned.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Since migration 154 the engine WRITES approvals/approval_steps through the service
// client (members are SELECT-only there), regardless of the client a caller passes.
// Route that service writer to the same fake so the write path stays exercised.
const serviceWriter = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabase: () => serviceWriter.db }));
// authorize() (wave 2A) reads the org's enforcement mode through lib/supabase/admin.
// Same fake: an unconfigured organizations row → 'legacy', so these tests keep
// asserting the legacy decision exactly as before.
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => serviceWriter.db }));

import { canApprove, approve, SeparationOfDutiesError, NotAuthorizedToApproveError } from './approvals';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';

// ── normalizeMembershipRole (pure) ──────────────────────────────────────────

describe('normalizeMembershipRole', () => {
  it('maps Clerk/identity admin roles to company_admin (full approver)', () => {
    expect(normalizeMembershipRole('owner')).toBe('company_admin');
    expect(normalizeMembershipRole('org_admin')).toBe('company_admin');
    expect(normalizeMembershipRole('admin')).toBe('company_admin');
    expect(normalizeMembershipRole('company_admin')).toBe('company_admin');
  });

  it('accepts Clerk org: prefix and is case-insensitive', () => {
    expect(normalizeMembershipRole('org:owner')).toBe('company_admin');
    expect(normalizeMembershipRole('ORG:Admin')).toBe('company_admin');
    expect(normalizeMembershipRole('  Owner  ')).toBe('company_admin');
  });

  it('passes through the 9 canonical merchant roles unchanged', () => {
    expect(normalizeMembershipRole('accounting_specialist')).toBe('accounting_specialist');
    expect(normalizeMembershipRole('check_processor')).toBe('check_processor');
    expect(normalizeMembershipRole('cfo')).toBe('cfo');
  });

  it('returns null (fail closed) for unknown/empty vocabulary', () => {
    expect(normalizeMembershipRole('member')).toBeNull(); // Clerk generic member
    expect(normalizeMembershipRole('org:member')).toBeNull();
    expect(normalizeMembershipRole('wizard')).toBeNull();
    expect(normalizeMembershipRole('')).toBeNull();
    expect(normalizeMembershipRole('   ')).toBeNull();
    expect(normalizeMembershipRole(null)).toBeNull();
    expect(normalizeMembershipRole(undefined)).toBeNull();
  });
});

// ── canApprove (fake Supabase) ──────────────────────────────────────────────

type Resp = { data: unknown; error: unknown };

interface FakeTables {
  users?: Resp;
  memberships?: Resp;
  employees?: Resp;
  /** core.custom_roles (maybeSingle) — a tenant custom role definition. */
  custom_roles?: Resp;
  /** core.role_permission_overrides (awaited list) — the org's role edits. */
  role_permission_overrides?: Resp;
  /** public.approvals (single) — used by approve(). */
  approvals?: Resp;
}

/**
 * Minimal fake of the chained Supabase builder used by canApprove / approve:
 *   adminDb.schema('core').from(<table>).select(..).eq(..)....maybeSingle()
 *   adminDb.schema('core').from('role_permission_overrides').select(..).eq(..).eq(..)  (awaited)
 *   adminDb.from('approvals').select('*').eq(..).eq(..).single()
 * Returns the configured response for whichever table is queried; an unconfigured
 * list query resolves to an empty list, an unconfigured single to null.
 */
function makeDb(responses: FakeTables): SupabaseClient {
  const chainFor = (table: string) => {
    const configured = (responses as Record<string, Resp | undefined>)[table];
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.update = () => chain;
    chain.insert = async () => ({ data: null, error: null });
    chain.maybeSingle = async () => configured ?? { data: null, error: null };
    chain.single = async () => configured ?? { data: null, error: null };
    // Awaiting the chain directly (list query) — e.g. the overrides read.
    chain.then = (resolve: (r: Resp) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(configured ?? { data: [], error: null }).then(resolve, reject);
    return chain;
  };
  const fake = {
    schema: () => ({ from: (table: string) => chainFor(table) }),
    from: (table: string) => chainFor(table),
  } as unknown as SupabaseClient;
  serviceWriter.db = fake;
  return fake;
}

const ok = (data: unknown): Resp => ({ data, error: null });
const empty: Resp = { data: null, error: null };
const boom: Resp = { data: null, error: { message: 'db error' } };

describe('canApprove — canonical membership path', () => {
  it('allows an owner membership (owner -> company_admin -> full approver)', async () => {
    const db = makeDb({ users: ok({ id: 'u1' }), memberships: ok({ role: 'owner' }) });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(true);
  });

  it('allows an org_admin membership', async () => {
    const db = makeDb({ users: ok({ id: 'u1' }), memberships: ok({ role: 'org_admin' }) });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(true);
  });

  it('denies an accounting_specialist membership (no money-approve authority)', async () => {
    const db = makeDb({ users: ok({ id: 'u1' }), memberships: ok({ role: 'accounting_specialist' }) });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });

  it('fails closed when the membership role is unrecognized (does NOT fall back)', async () => {
    // employees would say yes, but the authoritative membership speaks first.
    const db = makeDb({
      users: ok({ id: 'u1' }),
      memberships: ok({ role: 'member' }),
      employees: ok({ role: 'company_admin' }),
    });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });

  it('fails closed on a users lookup error', async () => {
    const db = makeDb({ users: boom });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });

  it('fails closed on a memberships lookup error', async () => {
    const db = makeDb({ users: ok({ id: 'u1' }), memberships: boom });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });
});

describe('canApprove — transitional employees fallback', () => {
  it('falls back when the user exists but has no active membership', async () => {
    const db = makeDb({ users: ok({ id: 'u1' }), memberships: empty, employees: ok({ role: 'company_admin' }) });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(true);
  });

  it('falls back when no core.users row exists yet (pre-identity-spine)', async () => {
    const db = makeDb({ users: empty, employees: ok({ role: 'cfo' }) });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false); // cfo cannot approve money
  });

  it('normalizes the fallback employee role too (owner -> company_admin)', async () => {
    const db = makeDb({ users: empty, employees: ok({ role: 'owner' }) });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(true);
  });

  it('fails closed when neither membership nor employee resolves', async () => {
    const db = makeDb({ users: empty, employees: empty });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });

  it('fails closed on an employees lookup error in the fallback', async () => {
    const db = makeDb({ users: empty, employees: boom });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });
});

// ── R0: tenant role edits + custom roles are honored (05-RBAC C3) ───────────

/** Overrides rows that revoke (or grant) approve on all three money surfaces. */
const allMoneyApprove = (allowed: boolean): Resp =>
  ok([
    { feature: 'checks', action: 'approve', allowed },
    { feature: 'bills', action: 'approve', allowed },
    { feature: 'payroll', action: 'approve', allowed },
  ]);

describe('canApprove — honors the org\'s effective permissions (R0)', () => {
  it('denies a default approver once the tenant revokes approve on every money surface', async () => {
    // merit_controller approves checks/bills/payroll by default …
    const base = { users: ok({ id: 'u1' }), memberships: ok({ role: 'merit_controller' }) };
    expect(await canApprove(makeDb(base), 'org1', 'clerk_1')).toBe(true);
    // … until the tenant edits the role.
    const revoked = makeDb({ ...base, role_permission_overrides: allMoneyApprove(false) });
    expect(await canApprove(revoked, 'org1', 'clerk_1')).toBe(false);
  });

  it('denies CFO when the tenant has revoked approve (and allows once the tenant grants it)', async () => {
    const base = { users: ok({ id: 'u1' }), memberships: ok({ role: 'cfo' }) };
    expect(await canApprove(makeDb({ ...base, role_permission_overrides: allMoneyApprove(false) }), 'org1', 'clerk_1')).toBe(false);
    // CFO is view-only on checks/bills/payroll by default; a tenant grant now takes effect.
    expect(
      await canApprove(
        makeDb({ ...base, role_permission_overrides: ok([{ feature: 'bills', action: 'approve', allowed: true }]) }),
        'org1',
        'clerk_1',
      ),
    ).toBe(true);
  });

  it('honors the revoke on the transitional employees fallback too', async () => {
    const db = makeDb({
      users: empty,
      employees: ok({ role: 'company_admin' }),
      role_permission_overrides: allMoneyApprove(false),
    });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });

  it('allows a custom role that the tenant granted approve', async () => {
    const db = makeDb({
      users: ok({ id: 'u1' }),
      memberships: ok({ role: 'ap_lead' }),
      custom_roles: ok({ key: 'ap_lead', name: 'AP lead', description: null, base_role: 'accounting_specialist' }),
      role_permission_overrides: ok([{ feature: 'bills', action: 'approve', allowed: true }]),
    });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(true);
  });

  it('denies a custom role whose base role cannot approve and has no grant', async () => {
    const db = makeDb({
      users: ok({ id: 'u1' }),
      memberships: ok({ role: 'ap_clerk' }),
      custom_roles: ok({ key: 'ap_clerk', name: 'AP clerk', description: null, base_role: 'accounting_specialist' }),
    });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });

  it('denies a custom role that inherits approve but the tenant revoked it', async () => {
    const db = makeDb({
      users: ok({ id: 'u1' }),
      memberships: ok({ role: 'ctl_lite' }),
      custom_roles: ok({ key: 'ctl_lite', name: 'Controller lite', description: null, base_role: 'merit_controller' }),
      role_permission_overrides: allMoneyApprove(false),
    });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });

  it('fails closed when the overrides read errors (a revoke may be hidden)', async () => {
    const db = makeDb({
      users: ok({ id: 'u1' }),
      memberships: ok({ role: 'company_admin' }),
      role_permission_overrides: boom,
    });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });

  it('fails closed when the custom-role lookup errors', async () => {
    const db = makeDb({ users: ok({ id: 'u1' }), memberships: ok({ role: 'ap_lead' }), custom_roles: boom });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });

  it('still denies a deactivated employee even with a granted custom role (H1)', async () => {
    const db = makeDb({
      users: ok({ id: 'u1' }),
      memberships: ok({ role: 'ap_lead' }),
      custom_roles: ok({ key: 'ap_lead', name: 'AP lead', description: null, base_role: 'accounting_specialist' }),
      role_permission_overrides: ok([{ feature: 'bills', action: 'approve', allowed: true }]),
      employees: ok({ is_active: false }),
    });
    expect(await canApprove(db, 'org1', 'clerk_1')).toBe(false);
  });
});

// ── Separation of duties survives the effective-permission change ───────────

const pendingRow = (preparedBy: string) =>
  ok({
    id: 'a1', org_id: 'org1', kind: 'AP_BATCH', subject_table: 'bills', subject_id: 'b1',
    amount_cents: 10_000, status: 'PENDING_APPROVAL', prepared_by: preparedBy, approved_by: null,
    released_by: null, provider_correlation_id: null, reject_reason: null,
  });

describe('approve() — preparer != approver is enforced regardless of authority', () => {
  it('blocks the preparer even when their (custom) role is granted approve', async () => {
    const db = makeDb({
      approvals: pendingRow('clerk_1'),
      users: ok({ id: 'u1' }),
      memberships: ok({ role: 'ap_lead' }),
      custom_roles: ok({ key: 'ap_lead', name: 'AP lead', description: null, base_role: 'accounting_specialist' }),
      role_permission_overrides: ok([{ feature: 'bills', action: 'approve', allowed: true }]),
    });
    await expect(approve(db, 'org1', 'a1', 'clerk_1')).rejects.toBeInstanceOf(SeparationOfDutiesError);
  });

  it('blocks the preparer even for a full company_admin', async () => {
    const db = makeDb({ approvals: pendingRow('clerk_1'), users: ok({ id: 'u1' }), memberships: ok({ role: 'owner' }) });
    await expect(approve(db, 'org1', 'a1', 'clerk_1')).rejects.toBeInstanceOf(SeparationOfDutiesError);
  });

  it('a different approver whose approve was revoked is NOT authorized', async () => {
    const db = makeDb({
      approvals: pendingRow('clerk_preparer'),
      users: ok({ id: 'u2' }),
      memberships: ok({ role: 'merit_controller' }),
      role_permission_overrides: allMoneyApprove(false),
    });
    await expect(approve(db, 'org1', 'a1', 'clerk_2')).rejects.toBeInstanceOf(NotAuthorizedToApproveError);
  });

  it('a different approver with a granted custom role approves', async () => {
    const db = makeDb({
      approvals: pendingRow('clerk_preparer'),
      users: ok({ id: 'u2' }),
      memberships: ok({ role: 'ap_lead' }),
      custom_roles: ok({ key: 'ap_lead', name: 'AP lead', description: null, base_role: 'accounting_specialist' }),
      role_permission_overrides: ok([{ feature: 'bills', action: 'approve', allowed: true }]),
    });
    const res = await approve(db, 'org1', 'a1', 'clerk_2');
    expect(res.status).toBe('APPROVED');
    expect(res.approvedBy).toBe('clerk_2');
  });
});
