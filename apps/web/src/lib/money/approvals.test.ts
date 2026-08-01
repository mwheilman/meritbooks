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

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canApprove } from './approvals';
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

/**
 * Minimal fake of the chained Supabase builder used by canApprove:
 *   adminDb.schema('core').from(<table>).select(..).eq(..)....maybeSingle()
 * Returns the configured response for whichever core table is queried.
 */
function makeDb(responses: { users?: Resp; memberships?: Resp; employees?: Resp }): SupabaseClient {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () =>
      (responses as Record<string, Resp | undefined>)[table] ?? { data: null, error: null };
    return chain;
  };
  return {
    schema: () => ({ from: (table: string) => chainFor(table) }),
  } as unknown as SupabaseClient;
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
