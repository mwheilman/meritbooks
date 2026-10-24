/**
 * Migration 185 — the report engine's maintained balances store (FPB-financial-reports
 * §4 AC3A.1–AC3A.5, AC3A.21). Replays every migration into PGlite and drives the GL the
 * way the app does, asserting the store equals the GL after every mutation the ledger
 * guards allow, that the rebuild reproduces it, and that members can read but not write.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';
import { seedReportTenant, postEntry, asMember, type ReportTenant } from './report-engine-fixture';
import { seedEmployee } from './wave3-db-helpers';

let db: PGlite;
let t: ReportTenant;
let other: ReportTenant;

async function tieout(org: string): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from public.period_balances_tieout($1)`, [org]);
  return r.rows[0].n;
}

async function storeNet(org: string, account: string, periodStart?: string): Promise<number> {
  const r = await db.query<{ n: string | null }>(
    `select coalesce(sum(debit_cents - credit_cents), 0)::bigint as n from public.period_balances
      where org_id = $1 and account_id = $2 and ($3::date is null or period_start = $3::date)`,
    [org, account, periodStart ?? null],
  );
  return Number(r.rows[0].n ?? 0);
}

/** Run as the service role (BYPASSRLS like hosted Supabase) — how the engine calls the read RPCs. */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('alter role service_role bypassrls');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await db.exec('set role service_role');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  t = await seedReportTenant(db, { slug: 'pb', companies: 2, months: ['2026-01', '2026-02', '2026-03', '2026-04'] });
  other = await seedReportTenant(db, { slug: 'pb-other', companies: 1, months: ['2026-01'] });
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('185 period_balances — maintained in the posting transaction', () => {
  it('a posted entry adds exactly its lines to the right company × account × month × dimension', async () => {
    const [A] = t.companies;
    await postEntry(db, t, {
      location: A, date: '2026-01-15',
      lines: [
        { account: t.acct.cash, debit: 10_000 },
        { account: t.acct.revenue, credit: 6_000, department: t.depts[0] },
        { account: t.acct.revenue, credit: 4_000, department: t.depts[1] },
      ],
    });
    expect(await storeNet(t.org, t.acct.cash, '2026-01-01')).toBe(10_000);
    expect(await storeNet(t.org, t.acct.revenue, '2026-01-01')).toBe(-10_000);
    const byDept = await db.query<{ department_id: string; credit_cents: string }>(
      `select department_id, credit_cents from public.period_balances where org_id = $1 and account_id = $2 order by credit_cents`,
      [t.org, t.acct.revenue],
    );
    expect(byDept.rows.map((r) => Number(r.credit_cents))).toEqual([4_000, 6_000]);
    expect(await tieout(t.org)).toBe(0);
  });

  it('a PENDING entry contributes nothing until it is posted (status flip adds all lines)', async () => {
    const [A] = t.companies;
    const id = await postEntry(db, t, {
      location: A, date: '2026-02-10', status: 'PENDING',
      lines: [{ account: t.acct.rent, debit: 2_500 }, { account: t.acct.cash, credit: 2_500 }],
    });
    expect(await storeNet(t.org, t.acct.rent)).toBe(0);
    await db.query(`update public.gl_entries set status = 'POSTED', posted_at = now() where id = $1`, [id]);
    expect(await storeNet(t.org, t.acct.rent, '2026-02-01')).toBe(2_500);
    expect(await tieout(t.org)).toBe(0);
  });

  it('voiding removes the contribution; the bucket disappears when it empties', async () => {
    const [A] = t.companies;
    const id = await postEntry(db, t, {
      location: A, date: '2026-03-05',
      lines: [{ account: t.acct.wages, debit: 7_000 }, { account: t.acct.cash, credit: 7_000 }],
    });
    expect(await storeNet(t.org, t.acct.wages, '2026-03-01')).toBe(7_000);
    await db.query(`update public.gl_entries set status = 'VOIDED', voided_at = now() where id = $1`, [id]);
    expect(await storeNet(t.org, t.acct.wages)).toBe(0);
    const left = await db.query<{ n: number }>(
      `select count(*)::int as n from public.period_balances where org_id = $1 and account_id = $2`, [t.org, t.acct.wages]);
    expect(left.rows[0].n).toBe(0);
    expect(await tieout(t.org)).toBe(0);
  });

  it('re-dating a POSTED entry (open period) moves it between months', async () => {
    const [A] = t.companies;
    const id = await postEntry(db, t, {
      location: A, date: '2026-03-20',
      lines: [{ account: t.acct.cogs, debit: 900 }, { account: t.acct.ap, credit: 900 }],
    });
    const apr = await db.query<{ id: string }>(
      `select id from public.fiscal_periods where org_id = $1 and location_id = $2 and start_date = '2026-04-01'`, [t.org, A]);
    await db.query(`update public.gl_entries set entry_date = '2026-04-02', fiscal_period_id = $2 where id = $1`, [id, apr.rows[0].id]);
    expect(await storeNet(t.org, t.acct.cogs, '2026-03-01')).toBe(0);
    expect(await storeNet(t.org, t.acct.cogs, '2026-04-01')).toBe(900);
    expect(await tieout(t.org)).toBe(0);
  });

  it('a line re-tag (job/department on a posted line) moves the delta between dimension buckets', async () => {
    const [, B] = t.companies;
    const id = await postEntry(db, t, {
      location: B, date: '2026-01-20',
      lines: [{ account: t.acct.rent, debit: 1_200, classId: t.classes[0] }, { account: t.acct.cash, credit: 1_200 }],
    });
    await db.query(`update public.gl_entry_lines set class_id = $2 where gl_entry_id = $1 and line_number = 1`, [id, t.classes[1]]);
    const r = await db.query<{ class_id: string; debit_cents: string }>(
      `select class_id, debit_cents from public.period_balances where org_id = $1 and location_id = $2 and account_id = $3`,
      [t.org, B, t.acct.rent],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].class_id).toBe(t.classes[1]);
    expect(Number(r.rows[0].debit_cents)).toBe(1_200);
    expect(await tieout(t.org)).toBe(0);
  });

  it('intercompany legs land on each leg’s own company with the counterparty dimension', async () => {
    const [A, B] = t.companies;
    await postEntry(db, t, {
      location: A, date: '2026-02-01',
      lines: [
        { account: t.acct.icAr, debit: 3_000, location: A, counterparty: B },
        { account: t.acct.cash, credit: 3_000, location: A },
        { account: t.acct.cash, debit: 3_000, location: B },
        { account: t.acct.icAp, credit: 3_000, location: B, counterparty: A },
      ],
    });
    const r = await db.query<{ location_id: string; counterparty_location_id: string }>(
      `select location_id, counterparty_location_id from public.period_balances where org_id = $1 and account_id in ($2, $3) order by account_id = $2 desc`,
      [t.org, t.acct.icAr, t.acct.icAp],
    );
    expect(r.rows[0]).toEqual({ location_id: A, counterparty_location_id: B });
    expect(r.rows[1]).toEqual({ location_id: B, counterparty_location_id: A });
    expect(await tieout(t.org)).toBe(0);
  });

  it('CLOSING and ADJUSTING entries are kept apart by entry_kind', async () => {
    const [A] = t.companies;
    await postEntry(db, t, {
      location: A, date: '2026-04-30', entryType: 'ADJUSTING',
      lines: [{ account: t.acct.depExp, debit: 400 }, { account: t.acct.accDep, credit: 400 }],
    });
    await postEntry(db, t, {
      location: A, date: '2026-04-30', entryType: 'CLOSING',
      lines: [{ account: t.acct.revenue, debit: 100 }, { account: t.acct.re, credit: 100 }],
    });
    const kinds = await db.query<{ entry_kind: string }>(
      `select distinct entry_kind from public.period_balances where org_id = $1 order by 1`, [t.org]);
    expect(kinds.rows.map((r) => r.entry_kind)).toEqual(['ADJUSTING', 'CLOSING', 'STANDARD']);
  });

  it('a failed-post rollback / purge (header delete) removes the contribution exactly once', async () => {
    const [A] = t.companies;
    const id = await postEntry(db, t, {
      location: A, date: '2026-01-25',
      lines: [{ account: t.acct.otherInc, credit: 50 }, { account: t.acct.cash, debit: 50 }],
    });
    expect(await storeNet(t.org, t.acct.otherInc)).toBe(-50);
    await db.exec(`begin; set local meritbooks.allow_ledger_purge = 'on';`);
    await db.query(`delete from public.gl_entries where id = $1`, [id]);
    await db.exec('commit');
    expect(await storeNet(t.org, t.acct.otherInc)).toBe(0);
    expect(await tieout(t.org)).toBe(0);
  });

  it('a hard-closed period rejects the post and the store is untouched (same transaction)', async () => {
    const h = await seedReportTenant(db, { slug: 'pb-hard', companies: 1, months: ['2026-01'], hardClose: ['2026-01'] });
    await expect(
      postEntry(db, h, { location: h.companies[0], date: '2026-01-10', lines: [{ account: h.acct.cash, debit: 1 }, { account: h.acct.revenue, credit: 1 }] }),
    ).rejects.toThrow();
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.period_balances where org_id = $1`, [h.org]);
    expect(n.rows[0].n).toBe(0);
  });

  it('rebuild_period_balances reproduces the incremental store exactly (and backfill = rebuild)', async () => {
    const before = await db.query<{ k: string; dr: string; cr: string }>(
      `select location_id::text || account_id::text || period_start::text || entry_kind || dim_key as k, debit_cents as dr, credit_cents as cr
         from public.period_balances where org_id = $1 order by 1`, [t.org]);
    const n = await db.query<{ n: number }>(`select public.rebuild_period_balances($1) as n`, [t.org]);
    expect(n.rows[0].n).toBe(before.rows.length);
    const after = await db.query<{ k: string; dr: string; cr: string }>(
      `select location_id::text || account_id::text || period_start::text || entry_kind || dim_key as k, debit_cents as dr, credit_cents as cr
         from public.period_balances where org_id = $1 order by 1`, [t.org]);
    expect(after.rows).toEqual(before.rows);
    expect(await tieout(t.org)).toBe(0);
  });

  it('the tie-out detects drift (a tampered bucket is reported)', async () => {
    await db.query(`update public.period_balances set debit_cents = debit_cents + 1 where org_id = $1 and account_id = $2`, [t.org, t.acct.cash]);
    expect(await tieout(t.org)).toBeGreaterThan(0);
    await db.query(`select public.rebuild_period_balances($1)`, [t.org]);
    expect(await tieout(t.org)).toBe(0);
  });

  it('members read their own org only, and cannot write the store', async () => {
    await postEntry(db, other, { location: other.companies[0], date: '2026-01-02', lines: [{ account: other.acct.cash, debit: 5 }, { account: other.acct.capital, credit: 5 }] });
    // Mig 186 governance_release_gate: only finance members read unreleased months of the store.
    await seedEmployee(db, t.org, 'user_pb', 'cfo');
    const seen = await asMember(db, t.org, 'user_pb', async () =>
      (await db.query<{ org_id: string }>(`select distinct org_id from public.period_balances`)).rows.map((r) => r.org_id));
    expect(seen).toEqual([t.org]);
    const err = await asMember(db, t.org, 'user_pb', async () => {
      try {
        await db.query(`update public.period_balances set debit_cents = 0 where org_id = $1`, [t.org]);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toMatch(/permission denied/);
    const errFn = await asMember(db, t.org, 'user_pb', async () => {
      try {
        await db.query(`select public.rebuild_period_balances($1)`, [t.org]);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(errFn).toMatch(/permission denied/);
  });

  it('report_balances aggregates by requested dimensions only, with an opening bucket (service role, p_org named)', async () => {
    const [A, B] = t.companies;
    const r = await asService(async () =>
      (await db.query<{ j: { rows: unknown[][]; count: number } }>(
        `select public.report_balances($1::jsonb, '2026-02-01', '2026-04-30', '[]'::jsonb, true, $2::uuid) as j`,
        [JSON.stringify([A]), t.org],
      )).rows[0].j);
    // opening bucket (period null) for January cash on A
    const openingCash = r.rows.find((row) => row[1] === t.acct.cash && row[2] === null);
    expect(openingCash).toBeTruthy();
    expect(r.rows.every((row) => row[0] === A)).toBe(true);
    // no dimension columns populated when none requested
    expect(r.rows.every((row) => row[4] === null && row[5] === null)).toBe(true);
    const withDept = await asService(async () =>
      (await db.query<{ j: { rows: unknown[][] } }>(
        `select public.report_balances($1::jsonb, '2026-01-01', '2026-01-31', '["department"]'::jsonb, false, $2::uuid) as j`,
        [JSON.stringify([A, B]), t.org],
      )).rows[0].j);
    const revDepts = withDept.rows.filter((row) => row[1] === t.acct.revenue).map((row) => row[4]).sort();
    expect(revDepts).toEqual([...t.depts].sort());
    // p_org pins the tenant: another org's id returns nothing of this org
    const foreign = await asService(async () =>
      (await db.query<{ j: { rows: unknown[][] } }>(
        `select public.report_balances($1::jsonb, '2026-01-01', '2026-04-30', '[]'::jsonb, true, $2::uuid) as j`,
        [JSON.stringify([A]), other.org],
      )).rows[0].j);
    expect(foreign.rows).toEqual([]);
  });

  it('members cannot EXECUTE the governed read RPCs (number governance is enforced in the app)', async () => {
    const privs = await db.query<{ f: string; auth: boolean; svc: boolean }>(
      `select p.proname as f, has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('report_balances', 'report_drill_lines', 'period_balances_tieout')
        order by 1`);
    expect(privs.rows.map((r) => r.f)).toEqual(['period_balances_tieout', 'report_balances', 'report_drill_lines']);
    for (const r of privs.rows) {
      expect({ f: r.f, auth: r.auth }).toEqual({ f: r.f, auth: false });
      expect({ f: r.f, svc: r.svc }).toEqual({ f: r.f, svc: true });
    }
    const err = await asMember(db, t.org, 'user_pb', async () => {
      try {
        await db.query(`select public.report_balances(null, '2026-01-01', '2026-01-31', '[]'::jsonb, false, $1::uuid)`, [t.org]);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toMatch(/permission denied/);
  });

  it('RLS covers the store with the 163 client-scope restrictive policy', async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = 'period_balances' and policyname = 'client_scope_rls'`);
    expect(r.rows[0].n).toBe(1);
  });

  it('is idempotent: re-running 185 keeps the store tied', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/supabase/migrations');
    const f = fs.readdirSync(dir).find((x) => x.startsWith('185_'))!;
    await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    expect(await tieout(t.org)).toBe(0);
  });
});
