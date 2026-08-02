/**
 * get_org_id() tenant resolution (migration 087) — the RLS boundary of identity
 * gate #9.
 *
 * Replays every migration into a real Postgres (PGlite) and drives get_org_id()
 * through the `request.jwt.claims` GUC exactly as PostgREST/Supabase would, asserting
 * that it:
 *   - honors a Books-uuid claim ONLY when a matching tenant exists,
 *   - maps a Clerk org id ('org_XXXX') to the bound tenant via clerk_org_id,
 *   - and FAILS CLOSED (null) for an unmatched uuid, an unmapped Clerk id, or an
 *     absent claim — so RLS shows another tenant's rows to no one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';

let db: PGlite;

const ORG_UUID = '11111111-1111-1111-1111-111111111111';
const OTHER_UUID = '22222222-2222-2222-2222-222222222222';
const CLERK_ID = 'org_testClerk123';

beforeAll(async () => {
  ({ db } = await createTestDb());
  await db.query(
    `insert into core.organizations (id, name, slug, clerk_org_id) values ($1, $2, $3, $4)`,
    [ORG_UUID, 'Test Tenant', 'test-tenant', CLERK_ID],
  );
}, 120_000);

afterAll(async () => {
  await db?.close();
});

/** Set the session claims to { org_id: <claim> } (or empty when null), then call get_org_id(). */
async function getOrgIdWithClaim(claim: string | null): Promise<string | null> {
  const payload = claim === null ? '{}' : JSON.stringify({ org_id: claim });
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [payload]);
  const res = await db.query<{ get_org_id: string | null }>(`select public.get_org_id() as get_org_id`);
  return res.rows[0]?.get_org_id ?? null;
}

describe('get_org_id() tenant resolution (migration 087)', () => {
  it('honors a Books-uuid claim that maps to an existing tenant', async () => {
    expect(await getOrgIdWithClaim(ORG_UUID)).toBe(ORG_UUID);
  });

  it('maps a Clerk org id claim to the bound tenant uuid', async () => {
    expect(await getOrgIdWithClaim(CLERK_ID)).toBe(ORG_UUID);
  });

  it('fails closed (null) for a uuid claim with no matching tenant', async () => {
    expect(await getOrgIdWithClaim(OTHER_UUID)).toBeNull();
  });

  it('fails closed (null) for an unmapped Clerk org id', async () => {
    expect(await getOrgIdWithClaim('org_nope')).toBeNull();
  });

  it('fails closed (null) when the claim is absent', async () => {
    expect(await getOrgIdWithClaim(null)).toBeNull();
  });
});
