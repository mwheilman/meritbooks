/**
 * Outbound send quotas against the real schema (migration 178 §10): per-user hourly and
 * per-org daily windows, atomic bumps, members can't touch the counters, fails closed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from '@/test/pg';
import { pgSupabase } from '@/test/pg-supabase';
import { consumeSendQuota } from './send-quota';

const ORG = '11111111-1111-1111-1111-111111111111';
const ORG_2 = '22222222-2222-2222-2222-222222222222';
let db: PGlite;
let sb: SupabaseClient;
const limits = { perUserPerHour: 5, perOrgPerDay: 8 };
const at = (iso: string) => () => new Date(iso);
// Windows are anchored to the real UTC day: core.bump_send_quota GCs rows older than
// now() − 2 days by the WALL clock, so a hard-coded past date silently resets the counter.
const DAY = new Date().toISOString().slice(0, 10);
const NEXT_DAY = new Date(Date.parse(`${DAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  sb = pgSupabase(db);
  await db.exec(`insert into core.organizations (id, name, slug) values ('${ORG}', 'A', 'a'), ('${ORG_2}', 'B', 'b')`);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('consumeSendQuota', () => {
  it('counts recipients per user per hour and refuses past the limit', async () => {
    const now = at(`${DAY}T10:15:00Z`);
    expect(await consumeSendQuota(ORG, 'user_1', 3, 'invoice_send', { writer: sb, now, limits })).toMatchObject({ ok: true, userCount: 3 });
    expect(await consumeSendQuota(ORG, 'user_1', 2, 'invoice_send', { writer: sb, now, limits })).toMatchObject({ ok: true, userCount: 5 });
    const over = await consumeSendQuota(ORG, 'user_1', 1, 'invoice_remind', { writer: sb, now, limits });
    expect(over).toMatchObject({ ok: false, status: 429, code: 'SEND_QUOTA_USER' });
    if (!over.ok) expect(over.retryAfterSec).toBe(45 * 60);
    // Next hour: a fresh user window (the org day keeps counting: 3 + 2 + 1 refused + 1).
    expect(await consumeSendQuota(ORG, 'user_1', 1, 'request', { writer: sb, now: at(`${DAY}T11:00:01Z`), limits })).toMatchObject({ ok: true, userCount: 1, orgCount: 7 });
  });

  it('the org-wide day window caps every member together; other tenants are unaffected', async () => {
    const now = at(`${DAY}T12:00:00Z`);
    expect(await consumeSendQuota(ORG, 'user_2', 1, 'request', { writer: sb, now, limits })).toMatchObject({ ok: true, userCount: 1, orgCount: 8 });
    const r = await consumeSendQuota(ORG, 'user_2', 1, 'request', { writer: sb, now, limits });
    expect(r).toMatchObject({ ok: false, status: 429, code: 'SEND_QUOTA_ORG' });
    expect(await consumeSendQuota(ORG_2, 'user_2', 1, 'request', { writer: sb, now, limits })).toMatchObject({ ok: true, orgCount: 1 });
    // A new UTC day resets the org window.
    expect(await consumeSendQuota(ORG, 'user_2', 1, 'request', { writer: sb, now: at(`${NEXT_DAY}T00:00:05Z`), limits })).toMatchObject({ ok: true });
  });

  it('members cannot read or write the counters, or call the bump function', async () => {
    const r = (await db.query<{ sel: boolean; ins: boolean; fn: boolean }>(
      `select has_table_privilege('authenticated', 'core.outbound_send_counters', 'select') as sel,
              has_table_privilege('authenticated', 'core.outbound_send_counters', 'insert') as ins,
              has_function_privilege('authenticated', 'core.bump_send_quota(uuid, text, text, timestamptz, integer)', 'execute') as fn`)).rows[0];
    expect(r).toEqual({ sel: false, ins: false, fn: false });
  });

  it('fails closed when the counter cannot be read', async () => {
    const broken = { schema: () => ({ rpc: async () => ({ data: null, error: { message: 'down' } }) }) } as unknown as SupabaseClient;
    expect(await consumeSendQuota(ORG, 'user_9', 1, 'request', { writer: broken, limits })).toMatchObject({ ok: false, status: 503, code: 'SEND_QUOTA_UNAVAILABLE' });
  });
});
