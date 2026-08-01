/**
 * resolveOrgId — operational-org source (gate #9, security HIGH-2).
 *
 * The whole point of the fix: on an authenticated money/write path the
 * operational org MUST come from the caller's VERIFIED Clerk `org_id` claim (the
 * same value RLS enforces via get_org_id()), never from `select id from
 * organizations limit 1`. These assertions lock that: a supplied claim wins and
 * short-circuits the db entirely; the first-org lookup survives only as a
 * transitional fallback for claimless/internal callers.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveOrgId } from './lifecycle';
import { PostingError } from './account-roles';

type OrgLookup = { data: { id: string } | null; error: { message: string } | null };

/** Minimal db stub whose organizations lookup returns a fixed first-org row. */
function firstOrgDb(result: OrgLookup) {
  const calls = { schemaCalled: false };
  const chain = {
    from: () => chain,
    select: () => chain,
    limit: () => chain,
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

/** db stub that EXPLODES if any property is touched — proves the claim path never queries. */
function explodingDb(): SupabaseClient {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('db must not be queried when a preferred (claim) org is supplied');
      },
    },
  ) as unknown as SupabaseClient;
}

describe('resolveOrgId', () => {
  it('returns the preferred (verified claim) org and never touches the db', async () => {
    const orgId = await resolveOrgId(explodingDb(), 'org-claim-123');
    expect(orgId).toBe('org-claim-123');
  });

  it('ignores an empty-string claim and falls back to the first org', async () => {
    const db = firstOrgDb({ data: { id: 'first-org' }, error: null });
    const orgId = await resolveOrgId(db, '');
    expect(orgId).toBe('first-org');
    expect((db as unknown as { __calls: { schemaCalled: boolean } }).__calls.schemaCalled).toBe(true);
  });

  it('falls back to the first org when no claim is supplied (backward compatible)', async () => {
    const db = firstOrgDb({ data: { id: 'first-org' }, error: null });
    expect(await resolveOrgId(db)).toBe('first-org');
  });

  it('falls back to the first org when the claim is null', async () => {
    const db = firstOrgDb({ data: { id: 'first-org' }, error: null });
    expect(await resolveOrgId(db, null)).toBe('first-org');
  });

  it('fails closed when no claim and no organization exists', async () => {
    const db = firstOrgDb({ data: null, error: null });
    await expect(resolveOrgId(db)).rejects.toBeInstanceOf(PostingError);
  });

  it('fails closed on a db error during fallback', async () => {
    const db = firstOrgDb({ data: null, error: { message: 'boom' } });
    await expect(resolveOrgId(db)).rejects.toBeInstanceOf(PostingError);
  });
});
