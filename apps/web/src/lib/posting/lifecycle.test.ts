/**
 * resolveOrgId — operational-org source (gate #9, security HIGH-2).
 *
 * The whole point of the fix: on an authenticated money/write path the operational
 * org MUST come from the caller's VERIFIED Clerk `org_id` claim (the same value RLS
 * enforces via get_org_id()) — a Books uuid is honored directly, a Clerk org id is
 * mapped via core.organizations.clerk_org_id, and anything unresolved FAILS CLOSED.
 * The old `select id from organizations limit 1` first-org fallback is GONE: a
 * missing/empty/null or unmapped claim throws PostingError, never posts to an
 * arbitrary tenant.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveOrgId } from './lifecycle';
import { PostingError } from './account-roles';

type OrgLookup = { data: { id: string } | null; error: { message: string } | null };

/** db stub whose organizations.clerk_org_id lookup returns a fixed row/result. */
function clerkMapDb(result: OrgLookup) {
  const calls = { schemaCalled: false };
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  const db = {
    schema: (_schema: string) => {
      calls.schemaCalled = true;
      return chain;
    },
    __calls: calls,
  } as unknown as SupabaseClient & { __calls: typeof calls };
  return db;
}

/** db stub that EXPLODES if any property is touched — proves the uuid path never queries. */
function explodingDb(): SupabaseClient {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('db must not be queried when a uuid claim is supplied');
      },
    },
  ) as unknown as SupabaseClient;
}

const REAL_UUID = '11111111-1111-1111-1111-111111111111';

describe('resolveOrgId', () => {
  it('passes through a uuid-shaped claim and never touches the db', async () => {
    const orgId = await resolveOrgId(explodingDb(), REAL_UUID);
    expect(orgId).toBe(REAL_UUID);
  });

  it('maps a Clerk org id claim to the bound Books tenant', async () => {
    const db = clerkMapDb({ data: { id: REAL_UUID }, error: null });
    const orgId = await resolveOrgId(db, 'org_abc123');
    expect(orgId).toBe(REAL_UUID);
    expect((db as unknown as { __calls: { schemaCalled: boolean } }).__calls.schemaCalled).toBe(true);
  });

  it('fails closed when the Clerk org id maps to no tenant', async () => {
    const db = clerkMapDb({ data: null, error: null });
    await expect(resolveOrgId(db, 'org_unbound')).rejects.toBeInstanceOf(PostingError);
  });

  it('fails closed on an empty-string claim (no first-org fallback)', async () => {
    await expect(resolveOrgId(explodingDb(), '')).rejects.toBeInstanceOf(PostingError);
  });

  it('fails closed when no claim is supplied (no first-org fallback)', async () => {
    await expect(resolveOrgId(explodingDb())).rejects.toBeInstanceOf(PostingError);
  });

  it('fails closed when the claim is null (no first-org fallback)', async () => {
    await expect(resolveOrgId(explodingDb(), null)).rejects.toBeInstanceOf(PostingError);
  });

  it('fails closed on a db error during the Clerk mapping', async () => {
    const db = clerkMapDb({ data: null, error: { message: 'boom' } });
    await expect(resolveOrgId(db, 'org_abc123')).rejects.toBeInstanceOf(PostingError);
  });
});
