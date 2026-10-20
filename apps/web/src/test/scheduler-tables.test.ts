/**
 * Migration 162 (scheduler) — real-Postgres guarantees, replayed in PGlite WITH
 * hosted Supabase's default grants (so "members can't write" is not vacuous):
 *
 *   1. members (authenticated) and anon cannot INSERT/UPDATE/DELETE/TRUNCATE
 *      core.scheduled_jobs or core.job_runs, nor call core.scheduler_try_lock;
 *   2. members read ONLY their own org's rows (platform rows are invisible);
 *   3. service_role writes;
 *   4. scheduler_try_lock is single-flight with expiry;
 *   5. the idempotency key is unique among non-failed runs (a failed run frees it).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const SLOT = '2026-10-20T08:10:00Z';

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug) values
      ('${ORG_A}', 'Tenant A', 'tenant-a'),
      ('${ORG_B}', 'Tenant B', 'tenant-b');
    insert into core.scheduled_jobs (job_key, org_id) values
      ('controls.nightly', '${ORG_A}'), ('controls.nightly', '${ORG_B}'), ('controls.nightly', null);
    insert into core.job_runs (job_key, org_id, slot_at, idempotency_key, status) values
      ('controls.nightly', '${ORG_A}', '${SLOT}', 'controls.nightly:${ORG_A}:${SLOT}', 'ok'),
      ('controls.nightly', '${ORG_B}', '${SLOT}', 'controls.nightly:${ORG_B}:${SLOT}', 'ok'),
      ('scheduler.prune_runs', null, '${SLOT}', 'scheduler.prune_runs:platform:${SLOT}', 'ok');
  `);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

async function asRole<T>(role: 'authenticated' | 'anon' | 'service_role', fn: () => Promise<T>): Promise<T> {
  const claims = role === 'authenticated' ? { sub: 'user_a', org_id: ORG_A, role } : role === 'service_role' ? { role } : {};
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('migration 162 — members cannot write scheduler tables', () => {
  for (const table of ['core.scheduled_jobs', 'core.job_runs']) {
    for (const role of ['authenticated', 'anon'] as const) {
      it(`${role} cannot INSERT / UPDATE / DELETE / TRUNCATE ${table}`, async () => {
        const errs = await asRole(role, async () => ({
          insert: await errorOf(
            table === 'core.job_runs'
              ? `insert into core.job_runs (job_key, org_id, slot_at, idempotency_key, status) values ('controls.nightly', '${ORG_A}', now(), 'forged', 'ok')`
              : `insert into core.scheduled_jobs (job_key, org_id, enabled) values ('reports.packs', '${ORG_A}', true)`,
          ),
          update: await errorOf(
            table === 'core.job_runs'
              ? `update core.job_runs set status = 'ok' where org_id = '${ORG_A}'`
              : `update core.scheduled_jobs set enabled = false, lock_owner = 'me' where org_id = '${ORG_A}'`,
          ),
          del: await errorOf(`delete from ${table} where org_id = '${ORG_A}'`),
          truncate: await errorOf(`truncate ${table}`),
        }));
        for (const [op, err] of Object.entries(errs)) expect(err, op).toMatch(/permission denied/i);
      });
    }
  }

  it('members cannot call the lock function (steal or hold a job)', async () => {
    const err = await asRole('authenticated', () =>
      errorOf(`select core.scheduler_try_lock('controls.nightly', '${ORG_A}', 'attacker', 3600)`),
    );
    expect(err).toMatch(/permission denied/i);
  });

  it('nothing was changed by the attempts', async () => {
    const r = await db.query<{ n: number }>(`select count(*)::int n from core.job_runs`);
    expect(r.rows[0].n).toBe(3);
    const s = await db.query<{ lock_owner: string | null }>(`select lock_owner from core.scheduled_jobs where org_id = '${ORG_A}'`);
    expect(s.rows[0].lock_owner).toBeNull();
  });
});

describe('migration 162 — member reads are tenant-scoped', () => {
  it('a member sees only their own org runs and state (no platform rows, no other tenant)', async () => {
    const runs = await asRole('authenticated', () => db.query<{ org_id: string | null }>(`select org_id from core.job_runs`));
    expect(runs.rows.map((r) => r.org_id)).toEqual([ORG_A]);
    const jobs = await asRole('authenticated', () => db.query<{ org_id: string | null }>(`select org_id from core.scheduled_jobs`));
    expect(jobs.rows.map((r) => r.org_id)).toEqual([ORG_A]);
  });

  it('anon sees nothing', async () => {
    const runs = await asRole('anon', async () => {
      try {
        return (await db.query(`select 1 from core.job_runs`)).rows.length;
      } catch {
        return 0;
      }
    });
    expect(runs).toBe(0);
  });

  it('RLS is enabled on both tables', async () => {
    const r = await db.query<{ relname: string; on: boolean }>(
      `select c.relname, c.relrowsecurity as on from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'core' and c.relname in ('scheduled_jobs', 'job_runs') order by 1`,
    );
    expect(r.rows).toEqual([{ relname: 'job_runs', on: true }, { relname: 'scheduled_jobs', on: true }]);
  });
});

describe('migration 162 — service role: lock + idempotency semantics', () => {
  const lock = (owner: string, ttl = 60) =>
    asRole('service_role', () =>
      db.query<{ ok: boolean }>(`select core.scheduler_try_lock('reports.packs', $1, $2, $3) as ok`, [ORG_A, owner, ttl]),
    ).then((r) => r.rows[0].ok);

  it('creates the state row on first claim and is single-flight', async () => {
    expect(await lock('tick-1')).toBe(true);
    expect(await lock('tick-2')).toBe(false);
    const r = await db.query<{ lock_owner: string }>(
      `select lock_owner from core.scheduled_jobs where job_key = 'reports.packs' and org_id = $1`,
      [ORG_A],
    );
    expect(r.rows).toEqual([{ lock_owner: 'tick-1' }]);
  });

  it('an expired lock can be reclaimed; an owner-filtered release clears only its own lock', async () => {
    await db.query(
      `update core.scheduled_jobs set lock_expires_at = now() - interval '1 second' where job_key = 'reports.packs' and org_id = $1`,
      [ORG_A],
    );
    expect(await lock('tick-3')).toBe(true);
    const wrong = await asRole('service_role', () =>
      db.query(`update core.scheduled_jobs set lock_owner = null where job_key = 'reports.packs' and org_id = $1 and lock_owner = 'tick-1' returning id`, [ORG_A]),
    );
    expect(wrong.rows).toHaveLength(0);
    const right = await asRole('service_role', () =>
      db.query(`update core.scheduled_jobs set lock_owner = null, lock_expires_at = null where job_key = 'reports.packs' and org_id = $1 and lock_owner = 'tick-3' returning id`, [ORG_A]),
    );
    expect(right.rows).toHaveLength(1);
    expect(await lock('tick-4')).toBe(true);
  });

  it('platform (org NULL) rows lock independently and stay unique', async () => {
    const plat = () =>
      asRole('service_role', () =>
        db.query<{ ok: boolean }>(`select core.scheduler_try_lock('scheduler.prune_runs', null, $1, 60) as ok`, [`p-${Math.random()}`]),
      ).then((r) => r.rows[0].ok);
    expect(await plat()).toBe(true);
    expect(await plat()).toBe(false);
    const n = await db.query<{ n: number }>(`select count(*)::int n from core.scheduled_jobs where job_key = 'scheduler.prune_runs'`);
    expect(n.rows[0].n).toBe(1);
  });

  it('rejects a bad TTL or empty owner', async () => {
    expect(await asRole('service_role', () => errorOf(`select core.scheduler_try_lock('reports.packs', null, '', 60)`))).toMatch(/owner required/);
    expect(await asRole('service_role', () => errorOf(`select core.scheduler_try_lock('reports.packs', null, 'x', 0)`))).toMatch(/ttl/);
  });

  it('idempotency key: unique among live/finished runs; a FAILED attempt frees it for a retry', async () => {
    const key = `revrec.monthly:${ORG_B}:2026-11-01T07:00:00Z`;
    const ins = (attempt: number) =>
      asRole('service_role', () =>
        errorOf(
          `insert into core.job_runs (job_key, org_id, slot_at, attempt, idempotency_key, status) values ('revrec.monthly', $1, '2026-11-01T07:00:00Z', $2, $3, 'running')`,
          [ORG_B, attempt, key],
        ),
      );
    expect(await ins(1)).toBeNull();
    expect(await ins(2)).toMatch(/duplicate key|unique/i);
    await db.query(`update core.job_runs set status = 'failed' where idempotency_key = $1`, [key]);
    expect(await ins(2)).toBeNull();
    await db.query(`update core.job_runs set status = 'ok' where idempotency_key = $1 and attempt = 2`, [key]);
    expect(await ins(3)).toMatch(/duplicate key|unique/i);
  });

  it('CHECKs reject an unknown status and a malformed job key', async () => {
    expect(
      await errorOf(`insert into core.job_runs (job_key, slot_at, idempotency_key, status) values ('a.b', now(), 'k1', 'done')`),
    ).toMatch(/check/i);
    expect(await errorOf(`insert into core.scheduled_jobs (job_key) values ('Not A Key')`)).toMatch(/check/i);
  });
});
