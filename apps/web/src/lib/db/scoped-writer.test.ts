/**
 * lib/db/scoped-writer — which callers escalate to the service role, and the org pin for the
 * scheduler's SYSTEM tenant client (migration 172).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

const ORG = '11111111-0000-0000-0000-000000000172';
const OTHER_ORG = '22222222-0000-0000-0000-000000000172';
const LOC = '11111111-1720-0000-0000-000000000001';

/** Fake service-role client: core.locations lookups answer from `locations` (id → org). */
function fakeAdmin(locations: Record<string, string>) {
  const calls: string[] = [];
  const query = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (col: string, v: unknown) => {
        filters[col] = v;
        return chain;
      },
      in: (_col: string, ids: string[]) => {
        calls.push(table);
        const org = filters.org_id;
        return Promise.resolve({ data: ids.filter((id) => locations[id] === org).map((id) => ({ id })), error: null });
      },
    };
    return chain;
  };
  const client = { schema: () => ({ from: query }), from: query };
  return { client: client as unknown as SupabaseClient, calls };
}

const admin = fakeAdmin({ [LOC]: ORG });
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => admin.client }));

import { assertWriteScope, isWriteScopeError, scopedWriter, writerFor } from './scoped-writer';
import { markMemberClient, markSystemOrgClient, systemOrgOf } from '@/lib/supabase/member-client';

const plain = () => ({}) as unknown as SupabaseClient;

describe('writerFor', () => {
  it('returns an unknown / service-role client as-is (never silently upgraded)', () => {
    const c = plain();
    expect(writerFor(c)).toBe(c);
  });

  it('escalates a known member client to the service role', () => {
    const c = markMemberClient(plain());
    expect(writerFor(c)).toBe(admin.client);
  });

  it("escalates the scheduler's system tenant client to the service role", () => {
    const c = markSystemOrgClient(plain(), ORG);
    expect(systemOrgOf(c)).toBe(ORG);
    expect(writerFor(c)).toBe(admin.client);
  });

  it('an explicit override always wins', () => {
    const o = plain();
    expect(writerFor(markMemberClient(plain()), o)).toBe(o);
  });
});

describe('system tenant client: org pin, no client scope', () => {
  it('writes its own org (client verified in-org, no client-scope lookup)', async () => {
    const c = markSystemOrgClient(plain(), ORG);
    await expect(scopedWriter(c, ORG, [LOC])).resolves.toBe(admin.client);
  });

  it('is refused for any other org', async () => {
    const c = markSystemOrgClient(plain(), ORG);
    const e = await assertWriteScope(c, OTHER_ORG, []).catch((x: unknown) => x);
    expect(isWriteScopeError(e)).toBe(true);
  });

  it('is refused for a client (location) that is not in its org', async () => {
    const c = markSystemOrgClient(plain(), ORG);
    const e = await scopedWriter(c, ORG, ['99999999-0000-0000-0000-000000000000']).catch((x: unknown) => x);
    expect(isWriteScopeError(e)).toBe(true);
  });
});
