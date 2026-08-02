/**
 * resolveTenantOrgId / bindClerkOrgOnLogin — the app-layer mirror of get_org_id()
 * (identity gate #9). Pure/stubbed: no live DB.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTenantOrgId, bindClerkOrgOnLogin } from './resolve-tenant';

const ORG_UUID = '11111111-1111-1111-1111-111111111111';

/** Stub admin client whose organizations lookup returns a fixed maybeSingle() result. */
function lookupDb(result: { data: unknown; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    update: () => chain,
    maybeSingle: async () => result,
  };
  return { schema: () => ({ from: () => chain }) } as unknown as SupabaseClient;
}

describe('resolveTenantOrgId', () => {
  it('passes a uuid-shaped claim through without querying', async () => {
    // Exploding db proves no query happens for the uuid passthrough path.
    const exploding = { schema: () => { throw new Error('must not query'); } } as unknown as SupabaseClient;
    expect(await resolveTenantOrgId(ORG_UUID, exploding)).toBe(ORG_UUID);
  });

  it('maps a Clerk org id to the bound tenant', async () => {
    const db = lookupDb({ data: { id: ORG_UUID }, error: null });
    expect(await resolveTenantOrgId('org_abc', db)).toBe(ORG_UUID);
  });

  it('fails closed (null) for an unmapped Clerk org id', async () => {
    const db = lookupDb({ data: null, error: null });
    expect(await resolveTenantOrgId('org_unbound', db)).toBeNull();
  });

  it('fails closed (null) for empty / null claims', async () => {
    const db = lookupDb({ data: null, error: null });
    expect(await resolveTenantOrgId('', db)).toBeNull();
    expect(await resolveTenantOrgId(null, db)).toBeNull();
    expect(await resolveTenantOrgId(undefined, db)).toBeNull();
  });

  it('fails closed (null) on a lookup error', async () => {
    const db = lookupDb({ data: null, error: { message: 'boom' } });
    expect(await resolveTenantOrgId('org_abc', db)).toBeNull();
  });
});

/**
 * Build a query-builder stub whose select().eq().maybeSingle() returns sequential
 * read results, and whose update().eq().is() resolves (the chain is thenable) so the
 * awaited terminal yields { error: null }. `update` is a spy for assertions.
 */
function bindDb(reads: Array<{ data: unknown; error: unknown }>) {
  const updateSpy = vi.fn(() => chain);
  let readIdx = 0;
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    update: updateSpy,
    maybeSingle: async () => reads[readIdx++] ?? { data: null, error: null },
    then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
  };
  const admin = { schema: () => ({ from: () => chain }) } as unknown as SupabaseClient;
  return { admin, updateSpy };
}

describe('bindClerkOrgOnLogin', () => {
  it('binds an unbound Clerk org to the tenant (update while clerk_org_id is null)', async () => {
    // read 1: clerk id not bound anywhere; read 2: tenant has no clerk id yet.
    const { admin, updateSpy } = bindDb([
      { data: null, error: null },
      { data: { id: ORG_UUID, clerk_org_id: null }, error: null },
    ]);
    await bindClerkOrgOnLogin({ clerkOrgId: 'org_new', booksOrgId: ORG_UUID, admin });
    expect(updateSpy).toHaveBeenCalledWith({ clerk_org_id: 'org_new' });
  });

  it('does nothing when the Clerk org is already bound', async () => {
    const { admin, updateSpy } = bindDb([{ data: { id: ORG_UUID }, error: null }]);
    await bindClerkOrgOnLogin({ clerkOrgId: 'org_existing', booksOrgId: ORG_UUID, admin });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('does nothing (no throw) when no Clerk org context is present', async () => {
    const admin = { schema: () => { throw new Error('must not query'); } } as unknown as SupabaseClient;
    await expect(
      bindClerkOrgOnLogin({ clerkOrgId: null, booksOrgId: ORG_UUID, admin }),
    ).resolves.toBeUndefined();
  });
});
