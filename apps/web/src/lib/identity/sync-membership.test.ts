/**
 * Membership lifecycle sync — the PROPER H1 fix.
 *
 * SAFETY-CRITICAL. These helpers keep the canonical access spine
 * (core.users -> core.memberships) reconciled to the core.employees row admins
 * edit, so the spine can never drift MORE permissive than the employee record.
 * We pin the three transitions and their fail-safe / fail-closed behavior against
 * a hand-rolled fake of the admin Supabase builder (same style as approvals.test).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The helpers resolve identity on the service-role client; intercept it.
const capture: { patch: Record<string, unknown> | null } = { patch: null };

vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => makeAdmin(),
}));

type Resp = { data: unknown; error: unknown };

// Per-test configuration of what the fake returns for each core table read.
let responses: { employees?: Resp; users?: Resp; membershipUpdate?: Resp };

/**
 * Fake of the chained admin builder used by sync-membership:
 *   admin.schema('core').from('employees').select().eq().eq().maybeSingle()
 *   admin.schema('core').from('users').select().eq().maybeSingle()
 *   admin.schema('core').from('memberships').update(patch).eq().eq()   (awaited)
 */
function makeAdmin() {
  const readChain = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () =>
      (responses as Record<string, Resp | undefined>)[table] ?? { data: null, error: null };
    return chain;
  };

  const membershipsChain = () => {
    // update(patch) captures the patch, then .eq().eq() is awaited for {error}.
    const result: Resp = responses.membershipUpdate ?? { data: null, error: null };
    const filter: Record<string, unknown> = {};
    filter.eq = () => filter;
    // Thenable so `await admin...update().eq().eq()` resolves to the result.
    filter.then = (resolve: (v: Resp) => unknown) => resolve(result);
    return {
      update: (patch: Record<string, unknown>) => {
        capture.patch = patch;
        return filter;
      },
    };
  };

  return {
    schema: () => ({
      from: (table: string) => (table === 'memberships' ? membershipsChain() : readChain(table)),
    }),
  };
}

// Import AFTER the mock is registered.
import { syncMembershipActiveState, syncMembershipRole } from './sync-membership';

const ok = (data: unknown): Resp => ({ data, error: null });
const empty: Resp = { data: null, error: null };
const boom: Resp = { data: null, error: { message: 'db error' } };

// Happy-path identity resolution: employee -> clerk id -> user id.
function withIdentity(extra?: Partial<typeof responses>) {
  responses = {
    employees: ok({ clerk_user_id: 'clerk_1' }),
    users: ok({ id: 'u1' }),
    membershipUpdate: empty,
    ...extra,
  };
}

beforeEach(() => {
  capture.patch = null;
  responses = {};
});

describe('syncMembershipActiveState — deactivate/reactivate transitions', () => {
  it('deactivate (isActive=false) suspends the membership', async () => {
    withIdentity();
    await syncMembershipActiveState('org1', 'emp1', false);
    expect(capture.patch).toMatchObject({ status: 'suspended' });
    expect(capture.patch).not.toHaveProperty('role'); // status-only patch
  });

  it('reactivate (isActive=true) reactivates the membership', async () => {
    withIdentity();
    await syncMembershipActiveState('org1', 'emp1', true);
    expect(capture.patch).toMatchObject({ status: 'active' });
  });

  it('stamps updated_at on every sync', async () => {
    withIdentity();
    await syncMembershipActiveState('org1', 'emp1', false);
    expect(capture.patch).toHaveProperty('updated_at');
  });
});

describe('syncMembershipRole — role-change transition', () => {
  it('writes the raw role through when it is already a canonical Books role', async () => {
    withIdentity();
    await syncMembershipRole('org1', 'emp1', 'accounting_specialist');
    expect(capture.patch).toMatchObject({ role: 'accounting_specialist' });
  });

  it('normalizes an admin-vocabulary role onto the Books vocabulary (owner -> company_admin)', async () => {
    // Proves writer and reader share normalizeMembershipRole, so vocab can't diverge.
    withIdentity();
    await syncMembershipRole('org1', 'emp1', 'owner');
    expect(capture.patch).toMatchObject({ role: 'company_admin' });
  });

  it('FAILS CLOSED on an unrecognized role — suspends rather than leaving a stale role', async () => {
    withIdentity();
    await syncMembershipRole('org1', 'emp1', 'wizard');
    expect(capture.patch).toMatchObject({ status: 'suspended' });
    expect(capture.patch).not.toHaveProperty('role');
  });
});

describe('sync helpers — idempotency / fail-safety (never throw, never invent)', () => {
  it('no-ops (no membership write) when the user has never logged in', async () => {
    responses = { employees: ok({ clerk_user_id: 'clerk_1' }), users: empty };
    await syncMembershipActiveState('org1', 'emp1', false);
    expect(capture.patch).toBeNull(); // UPDATE-only: nothing to sync, nothing invented
  });

  it('no-ops when the employee has no Clerk identity', async () => {
    responses = { employees: ok({ clerk_user_id: null }) };
    await syncMembershipRole('org1', 'emp1', 'owner');
    expect(capture.patch).toBeNull();
  });

  it('swallows a lookup error (fail-safe: never breaks the primary employee mutation)', async () => {
    responses = { employees: boom };
    await expect(syncMembershipActiveState('org1', 'emp1', true)).resolves.toBeUndefined();
    expect(capture.patch).toBeNull();
  });

  it('swallows a membership update error without throwing', async () => {
    withIdentity({ membershipUpdate: boom });
    await expect(syncMembershipRole('org1', 'emp1', 'cfo')).resolves.toBeUndefined();
  });
});
