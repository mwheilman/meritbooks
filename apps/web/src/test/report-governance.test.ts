/**
 * Migration 186 (number governance) + the release / restatement services, against a REAL
 * Postgres (PGlite migration replay, hosted Supabase default grants):
 *
 *   1. members and anon cannot write any governance table; members read only their org;
 *   2. the CHECKs hold (withdraw needs a reason, months 1..12, statuses);
 *   3. client-scope RLS is applied to every new table;
 *   4. release rules end to end: manual release of an ended SOFT/HARD month (+ snapshot),
 *      refusal of open / not-ended months, idempotent re-release, auto-release materialized
 *      only for hard-closed months past month end + N days;
 *   5. restatement detection: no change → nothing; a posting into a reopened released month
 *      is logged once the month is closed again, with the net-income delta and the cause;
 *   6. the audience gate end to end (facts from the DB): non-finance sees only released.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import type { LedgerSource, ActivityLine } from '@/lib/reports/governance/snapshot';
import { releasePeriod, withdrawRelease, materializeAutoReleases, saveReleaseSettings, saveCoverage, ReleaseError } from '@/lib/reports/governance/releases';
import { checkRestatements, acknowledgeRestatement } from '@/lib/reports/governance/restatements';
import { loadGovernanceFacts } from '@/lib/reports/governance/load';
import { evaluateGovernance } from '@/lib/reports/governance/policy';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const LOC_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const LOC_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const CASH = '33333333-3333-3333-3333-333333333331';
const REV = '33333333-3333-3333-3333-333333333332';
const RENT = '33333333-3333-3333-3333-333333333333';
const P = { jul: '44444444-0000-0000-0000-000000000007', aug: '44444444-0000-0000-0000-000000000008', sep: '44444444-0000-0000-0000-000000000009', oct: '44444444-0000-0000-0000-000000000010' };
const TABLES = ['report_governance_settings', 'report_company_coverage', 'report_releases', 'report_release_snapshots', 'report_restatements'];
const NOW = new Date('2026-10-24T15:00:00Z');

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug) values ('${ORG_A}', 'Tenant A', 'tenant-a'), ('${ORG_B}', 'Tenant B', 'tenant-b');
    insert into core.locations (id, org_id, name, short_code) values ('${LOC_A}', '${ORG_A}', 'Alpha Co', 'AL'), ('${LOC_B}', '${ORG_B}', 'Beta Co', 'BE');
    with t as (
      insert into public.account_types (org_id, name, code, display_order, normal_balance)
      values ('${ORG_A}', 'Asset', 'ASSET', 1, 'DEBIT') returning id
    ), st as (
      insert into public.account_sub_types (org_id, account_type_id, name, code, display_order)
      select '${ORG_A}', t.id, 'Current Asset', 'CURRENT_ASSET', 1 from t returning id
    ), g as (
      insert into public.account_groups (org_id, account_sub_type_id, name, display_order)
      select '${ORG_A}', st.id, 'General', 1 from st returning id
    )
    insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, approval_status)
    select v.id::uuid, '${ORG_A}', g.id, v.num, v.nm, v.ty::account_type_enum, v.sty::account_sub_type_enum, 'APPROVED'
      from g, (values ('${CASH}', '1000', 'Cash', 'ASSET', 'CURRENT_ASSET'),
                      ('${REV}', '4000', 'Sales', 'REVENUE', 'REVENUE'),
                      ('${RENT}', '6100', 'Rent', 'OPEX', 'OPERATING_EXPENSE')) v(id, num, nm, ty, sty);
    insert into public.fiscal_periods (id, org_id, location_id, period_year, period_month, start_date, end_date, status) values
      ('${P.jul}', '${ORG_A}', '${LOC_A}', 2026, 7,  '2026-07-01', '2026-07-31', 'OPEN'),
      ('${P.aug}', '${ORG_A}', '${LOC_A}', 2026, 8,  '2026-08-01', '2026-08-31', 'OPEN'),
      ('${P.sep}', '${ORG_A}', '${LOC_A}', 2026, 9,  '2026-09-01', '2026-09-30', 'OPEN'),
      ('${P.oct}', '${ORG_A}', '${LOC_A}', 2026, 10, '2026-10-01', '2026-10-31', 'OPEN');
  `);
  await post(P.jul, '2026-07-15', 8_000_00, 2_000_00);
  await post(P.aug, '2026-08-15', 10_000_00, 3_000_00);
  await post(P.sep, '2026-09-15', 12_000_00, 3_000_00);
  await db.exec(`
    update public.fiscal_periods set status = 'HARD_CLOSE' where id in ('${P.jul}', '${P.aug}');
    update public.fiscal_periods set status = 'SOFT_CLOSE' where id = '${P.sep}';
    insert into public.report_releases (org_id, location_id, period_year, period_month, status, release_mode, released_at)
      values ('${ORG_B}', '${LOC_B}', 2026, 8, 'RELEASED', 'MANUAL', now());
  `);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

let seq = 0;
/** A sale (DR cash / CR revenue) and rent (DR rent / CR cash), posted, in the period. */
async function post(periodId: string, date: string, saleCents: number, rentCents: number): Promise<string> {
  seq++;
  const r = await db.query<{ id: string }>(
    `insert into public.gl_entries (org_id, location_id, entry_number, entry_date, entry_type, fiscal_period_id, source_module, status, posted_at, created_by, memo)
     values ($1, $2, $3, $4, 'STANDARD', $5, 'MANUAL', 'POSTED', now(), null, $6) returning id`,
    [ORG_A, LOC_A, `G-${seq}`, date, periodId, `Entry ${seq}`],
  );
  const id = r.rows[0].id;
  const lines: Array<[string, number, number]> = [];
  if (saleCents) lines.push([CASH, saleCents, 0], [REV, 0, saleCents]);
  if (rentCents) lines.push([RENT, rentCents, 0], [CASH, 0, rentCents]);
  // One statement: the balance trigger (AFTER ROW) must see every line of the entry.
  const params: unknown[] = [ORG_A, id, LOC_A];
  const values = lines.map(([acct, dr, cr], i) => {
    params.push(acct, dr, cr);
    const b = params.length;
    return `($1, $2, ${i + 1}, $${b - 2}, $${b - 1}, $${b}, $3)`;
  });
  await db.query(
    `insert into public.gl_entry_lines (org_id, gl_entry_id, line_number, account_id, debit_cents, credit_cents, location_id) values ${values.join(', ')}`,
    params,
  );
  return id;
}

/** The ledger read the service uses, as SQL (pg-supabase does not emulate PostgREST embeds). */
const ledger: LedgerSource = {
  async periodActivity(org, loc, b) {
    const r = await db.query<{ account_id: string; d: number; c: number }>(
      `select l.account_id, l.debit_cents::float8 d, l.credit_cents::float8 c from public.gl_entry_lines l
         join public.gl_entries e on e.id = l.gl_entry_id
        where l.org_id = $1 and l.location_id = $2 and e.status = 'POSTED' and e.entry_date between $3 and $4`,
      [org, loc, b.startDate, b.endDate],
    );
    return r.rows.map((x): ActivityLine => ({ accountId: x.account_id, debitCents: x.d, creditCents: x.c }));
  },
  async linesThrough(org, loc, end) {
    const r = await db.query<{ account_id: string; d: number; c: number }>(
      `select l.account_id, l.debit_cents::float8 d, l.credit_cents::float8 c from public.gl_entry_lines l
         join public.gl_entries e on e.id = l.gl_entry_id
        where l.org_id = $1 and l.location_id = $2 and e.status = 'POSTED' and e.entry_date <= $3`,
      [org, loc, end],
    );
    return r.rows.map((x): ActivityLine => ({ accountId: x.account_id, debitCents: x.d, creditCents: x.c }));
  },
  async entryStats(org, loc, b) {
    const r = await db.query<{ n: number; last: string | null }>(
      `select count(*)::int n, max(posted_at)::text last from public.gl_entries
        where org_id = $1 and location_id = $2 and status = 'POSTED' and entry_date between $3 and $4`,
      [org, loc, b.startDate, b.endDate],
    );
    return { postedEntryCount: r.rows[0].n, lastPostedAt: r.rows[0].last };
  },
};

async function asRole<T>(role: 'authenticated' | 'anon', fn: () => Promise<T>): Promise<T> {
  const claims = role === 'authenticated' ? { sub: 'user_a', org_id: ORG_A, role } : {};
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function errorOf(sql: string): Promise<string | null> {
  try {
    await db.query(sql);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('migration 186 — locks, RLS, checks', () => {
  for (const role of ['authenticated', 'anon'] as const) {
    it(`${role} cannot write any governance table`, async () => {
      const errs = await asRole(role, async () => [
        await errorOf(`insert into public.report_releases (org_id, location_id, period_year, period_month, status, release_mode, released_at) values ('${ORG_A}', '${LOC_A}', 2026, 6, 'RELEASED', 'MANUAL', now())`),
        await errorOf(`update public.report_releases set status = 'WITHDRAWN'`),
        await errorOf(`delete from public.report_releases`),
        await errorOf(`insert into public.report_governance_settings (org_id) values ('${ORG_A}')`),
        await errorOf(`insert into public.report_company_coverage (org_id, location_id) values ('${ORG_A}', '${LOC_A}')`),
        await errorOf(`insert into public.report_release_snapshots (org_id, location_id, period_year, period_month, statement_hash) values ('${ORG_A}', '${LOC_A}', 2026, 6, '0123456789abcdef0123')`),
        await errorOf(`update public.report_restatements set acknowledgement = 'nope nope'`),
      ]);
      for (const e of errs) expect(e).toMatch(/permission denied/i);
    });
  }

  it('members read only their own org', async () => {
    const rows = await asRole('authenticated', async () => (await db.query<{ org_id: string }>(`select org_id from public.report_releases`)).rows);
    expect(rows.every((r) => r.org_id === ORG_A)).toBe(true);
    const b = await db.query(`select 1 from public.report_releases where org_id = '${ORG_B}'`);
    expect(b.rows.length).toBe(1); // the row exists; members of A just can't see it
  });

  it('CHECKs: a withdrawal needs a reason; months are 1..12; statuses are closed vocabularies', async () => {
    expect(await errorOf(`insert into public.report_releases (org_id, location_id, period_year, period_month, status, release_mode, withdrawn_at) values ('${ORG_A}', '${LOC_A}', 2026, 5, 'WITHDRAWN', 'MANUAL', now())`)).toMatch(/report_releases_chk/);
    expect(await errorOf(`insert into public.report_releases (org_id, location_id, period_year, period_month, status, release_mode, released_at) values ('${ORG_A}', '${LOC_A}', 2026, 13, 'RELEASED', 'MANUAL', now())`)).toMatch(/report_releases_chk/);
    expect(await errorOf(`insert into public.report_releases (org_id, location_id, period_year, period_month, status, release_mode, released_at) values ('${ORG_A}', '${LOC_A}', 2026, 5, 'PUBLISHED', 'MANUAL', now())`)).toMatch(/report_releases_chk/);
    expect(await errorOf(`insert into public.report_governance_settings (org_id, auto_release_days) values ('${ORG_A}', 500)`)).toMatch(/report_governance_settings_chk/);
    expect(await errorOf(`insert into public.report_company_coverage (org_id, location_id, in_group_from, in_group_until) values ('${ORG_A}', '${LOC_A}', '2026-05-01', '2026-01-01')`)).toMatch(/report_company_coverage_dates_chk/);
  });

  it('client-scope RLS covers every new table', async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public' and policyname = 'client_scope_rls' and tablename = any($1)`,
      [TABLES],
    );
    expect(r.rows.map((x) => x.tablename).sort()).toEqual([...TABLES].sort());
  });
});

describe('release services + restatements (end to end)', () => {
  const sb = () => pgSupabase(db);

  it('refuses an open or not-yet-ended month', async () => {
    await expect(releasePeriod(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 10 }, { now: NOW, ledger })).rejects.toMatchObject({ status: 409, code: 'NOT_RELEASABLE_NOT_ENDED' });
    await expect(releasePeriod(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 10 }, { now: new Date('2026-11-05T00:00:00Z'), ledger })).rejects.toMatchObject({ code: 'NOT_RELEASABLE_OPEN' });
    await expect(releasePeriod(sb(), ORG_A, 'user_ctl', { locationId: LOC_B, year: 2026, month: 8 }, { now: NOW, ledger })).rejects.toBeInstanceOf(ReleaseError);
  });

  it('releases IN ORDER: August waits for July (409 RELEASE_ORDER)', async () => {
    await expect(releasePeriod(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 8 }, { now: NOW, ledger })).rejects.toMatchObject({ status: 409, code: 'RELEASE_ORDER' });
    const jul = await releasePeriod(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 7 }, { now: NOW, ledger });
    expect(jul.alreadyReleased).toBe(false);
  });

  it('releases a hard-closed month with a baseline snapshot of the key totals', async () => {
    const r = await releasePeriod(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 8, note: 'Board pack' }, { now: NOW, ledger });
    expect(r.alreadyReleased).toBe(false);
    const snap = await db.query<{ revenue_cents: string; opex_cents: string; net_income_cents: string; assets_cents: string; posted_entry_count: number; reason: string }>(
      `select revenue_cents::text, opex_cents::text, net_income_cents::text, assets_cents::text, posted_entry_count, reason from public.report_release_snapshots where id = $1`,
      [r.snapshotId],
    );
    expect(snap.rows[0]).toEqual({ revenue_cents: '1000000', opex_cents: '300000', net_income_cents: '700000', assets_cents: '1300000', posted_entry_count: 1, reason: 'RELEASE' });
    const rel = await db.query<{ status: string; release_mode: string; baseline_snapshot_id: string; released_by: string }>(`select status, release_mode, baseline_snapshot_id, released_by from public.report_releases where id = $1`, [r.releaseId]);
    expect(rel.rows[0]).toEqual({ status: 'RELEASED', release_mode: 'MANUAL', baseline_snapshot_id: r.snapshotId, released_by: 'user_ctl' });
  });

  it('a soft-closed month can be released by hand; re-releasing unchanged numbers is a no-op', async () => {
    const sep = await releasePeriod(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 9 }, { now: NOW, ledger });
    expect(sep.alreadyReleased).toBe(false);
    const again = await releasePeriod(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 8 }, { now: NOW, ledger });
    expect(again.alreadyReleased).toBe(true);
  });

  it('no change → no restatement', async () => {
    const r = await checkRestatements(sb(), ORG_A, { detection: 'MANUAL', actor: 'user_ctl', ledger });
    expect(r).toMatchObject({ checked: 3, restated: 0 });
  });

  it('a posting into a reopened released month is logged once it is closed again', async () => {
    await db.exec(`update public.fiscal_periods set status = 'OPEN', close_override_reason = 'Missed August utility bill' where id = '${P.aug}'`);
    const lateId = await post(P.aug, '2026-08-30', 0, 450_00);
    const whileOpen = await checkRestatements(sb(), ORG_A, { detection: 'ON_READ', actor: 'user_ctl', ledger });
    expect(whileOpen).toMatchObject({ restated: 0, skippedOpen: 1 });

    await db.exec(`update public.fiscal_periods set status = 'HARD_CLOSE' where id = '${P.aug}'`);
    const r = await checkRestatements(sb(), ORG_A, { detection: 'SCHEDULED', actor: 'system:scheduler', ledger });
    expect(r.restated).toBe(1);
    const row = await db.query<{ net_income_delta_cents: string; opex_delta_cents: string; reopen_reason: string; detection: string; changed_accounts: Array<{ account_number: string; delta_cents: number }>; cause_entries: Array<{ gl_entry_id: string }> }>(
      `select net_income_delta_cents::text, opex_delta_cents::text, reopen_reason, detection, changed_accounts, cause_entries from public.report_restatements where id = $1`,
      [r.restatementIds[0]],
    );
    expect(row.rows[0]).toMatchObject({ net_income_delta_cents: '-45000', opex_delta_cents: '45000', reopen_reason: 'Missed August utility bill', detection: 'SCHEDULED' });
    expect(row.rows[0].changed_accounts.map((a) => a.account_number).sort()).toEqual(['1000', '6100']);
    expect(row.rows[0].cause_entries.map((c) => c.gl_entry_id)).toContain(lateId);

    // The baseline moved: the next check is clean.
    expect((await checkRestatements(sb(), ORG_A, { detection: 'MANUAL', actor: 'user_ctl', ledger })).restated).toBe(0);

    await expect(acknowledgeRestatement(sb(), ORG_A, 'user_ctl', r.restatementIds[0], 'no')).rejects.toThrow(/at least 4/);
    await acknowledgeRestatement(sb(), ORG_A, 'user_ctl', r.restatementIds[0], 'Utility bill accrued late; partners told.');
    const ack = await db.query<{ acknowledged_by: string }>(`select acknowledged_by from public.report_restatements where id = $1`, [r.restatementIds[0]]);
    expect(ack.rows[0].acknowledged_by).toBe('user_ctl');
  });

  it('the audience gate over DB facts: non-finance sees released months only, with "restated"', async () => {
    const facts = await loadGovernanceFacts(sb(), ORG_A, [LOC_A]);
    const view = { periods: ['2026-07', '2026-08', '2026-09', '2026-10'], locationIds: [LOC_A], scopeKind: 'company' as const };
    const owner = evaluateGovernance({ view, facts, audience: 'non_finance', today: '2026-10-24' });
    expect(owner.shownPeriodKeys).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(owner.periods.find((p) => p.key === '2026-08')?.restatedOn).toBeTruthy();
    expect(owner.closedThrough.scope).toBe('2026-08');
    const ctl = evaluateGovernance({ view, facts, audience: 'finance', today: '2026-10-24' });
    expect(ctl.periods.find((p) => p.key === '2026-10')?.visibility).toBe('preview');
  });

  it('withdrawals are in order too: August cannot be taken back while September is released', async () => {
    await expect(withdrawRelease(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 8, reason: 'Accrual review pending' }, { now: NOW })).rejects.toMatchObject({ status: 409, code: 'RELEASE_ORDER' });
  });

  it('withdrawal needs a reason and hides the month again', async () => {
    await expect(withdrawRelease(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 9, reason: ' ' }, { now: NOW })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await withdrawRelease(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 9, reason: 'Accrual review pending' }, { now: NOW });
    const facts = await loadGovernanceFacts(sb(), ORG_A, [LOC_A]);
    const owner = evaluateGovernance({ view: { periods: ['2026-09'], locationIds: [LOC_A], scopeKind: 'company' }, facts, audience: 'non_finance', today: '2026-10-24' });
    expect(owner.shownPeriodKeys).toEqual([]);
  });

  it('a withdrawn month holds back every later month, even one the auto rule would release', async () => {
    const facts = await loadGovernanceFacts(sb(), ORG_A, [LOC_A]);
    const c = facts.companies[LOC_A];
    const later = evaluateGovernance({
      view: { periods: ['2026-08', '2026-09', '2026-10'], locationIds: [LOC_A], scopeKind: 'company' },
      facts: { ...facts, companies: { [LOC_A]: { ...c, periods: c.periods.map((p) => (p.month === 10 ? { ...p, status: 'HARD_CLOSE' as const } : p)), settings: { ...c.settings, autoReleaseEnabled: true, autoReleaseDays: 1, autoReleaseMinStatus: 'SOFT_CLOSE' } } } },
      audience: 'non_finance',
      today: '2026-12-01',
    });
    expect(later.shownPeriodKeys).toEqual(['2026-08']);
    expect(later.periods.find((p) => p.key === '2026-10')?.companies[0].release.heldBy).toBe('2026-09');
  });

  it('auto-release materializes only hard-closed months past month end + N days (in order)', async () => {
    await saveReleaseSettings(sb(), ORG_A, 'user_ctl', { locationId: null, autoReleaseEnabled: true, autoReleaseDays: 20, autoReleaseMinStatus: 'HARD_CLOSE', deadlines: [] });
    await db.exec(`update public.fiscal_periods set status = 'HARD_CLOSE' where id = '${P.oct}'`);
    // September is withdrawn → October (hard-closed, past its date) is held back by the order rule.
    expect((await materializeAutoReleases(sb(), ORG_A, { now: new Date('2026-11-25T12:00:00Z'), ledger })).materialized).toBe(0);
    // Release September again (by hand); before Nov 20 nothing is due for October.
    await releasePeriod(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, year: 2026, month: 9 }, { now: new Date('2026-11-01T12:00:00Z'), ledger });
    expect((await materializeAutoReleases(sb(), ORG_A, { now: new Date('2026-11-19T12:00:00Z'), ledger })).materialized).toBe(0);
    const r = await materializeAutoReleases(sb(), ORG_A, { now: new Date('2026-11-25T12:00:00Z'), ledger });
    expect(r.materialized).toBe(1); // October (Jul / Aug / Sep released by hand)
    const oct = await db.query<{ release_mode: string; released_at: string; baseline_snapshot_id: string | null }>(
      `select release_mode, to_char(released_at at time zone 'UTC', 'YYYY-MM-DD') released_at, baseline_snapshot_id from public.report_releases where org_id = $1 and location_id = $2 and period_month = 10`,
      [ORG_A, LOC_A],
    );
    expect(oct.rows[0].release_mode).toBe('AUTO');
    expect(oct.rows[0].released_at.startsWith('2026-11-20')).toBe(true);
    expect(oct.rows[0].baseline_snapshot_id).not.toBeNull();
    // Idempotent.
    expect((await materializeAutoReleases(sb(), ORG_A, { now: new Date('2026-11-25T12:00:00Z'), ledger })).materialized).toBe(0);
  });

  it('a tampered baseline hash can neither hide nor fake a change (hash recomputed server-side)', async () => {
    const before = await checkRestatements(sb(), ORG_A, { detection: 'MANUAL', actor: 'user_ctl', ledger });
    expect(before.restated).toBe(0);
    // corrupt the stored hash of September's baseline (out of band) — the nets are unchanged
    await db.exec(`update public.report_release_snapshots set statement_hash = repeat('0', 64)
                    where id = (select baseline_snapshot_id from public.report_releases where org_id = '${ORG_A}' and location_id = '${LOC_A}' and period_month = 9)`);
    const after = await checkRestatements(sb(), ORG_A, { detection: 'MANUAL', actor: 'user_ctl', ledger });
    expect(after.restated).toBe(0);
  });

  it('in-group-from dates are saved and read back as coverage', async () => {
    await expect(saveCoverage(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, inGroupFrom: '2026-08-01', inGroupUntil: '2026-07-01', note: null })).rejects.toMatchObject({ code: 'BAD_DATES' });
    await saveCoverage(sb(), ORG_A, 'user_ctl', { locationId: LOC_A, inGroupFrom: '2026-08-10', inGroupUntil: null, note: 'Acquired Aug 2026' });
    const facts = await loadGovernanceFacts(sb(), ORG_A, [LOC_A]);
    expect(facts.companies[LOC_A].coverage).toEqual({ inGroupFrom: '2026-08-10', inGroupUntil: null });
    const d = evaluateGovernance({ view: { periods: ['2026-07', '2026-08'], locationIds: [LOC_A], scopeKind: 'consolidated' }, facts, audience: 'finance', today: '2026-10-24' });
    expect(d.locationsByPeriod['2026-07']).toEqual([]);
    expect(d.periods[0].hiddenReason).toBe('pre_acquisition');
  });
});
