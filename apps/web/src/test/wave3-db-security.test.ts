/**
 * Wave 3 security review — database guarantees (migrations 185 / 186), replayed in PGlite WITH
 * hosted Supabase's default grants so privilege assertions are not vacuous:
 *
 *   H2  the read RPCs report_balances / report_drill_lines / period_balances_tieout are
 *       service-role only; core.is_finance_member() follows the governance audience rule;
 *       RESTRICTIVE governance_release_gate on period_balances / snapshots / restatements shows a
 *       non-finance member only (company, month)s released IN ORDER; finance sees everything.
 *   H3  releases go in order (RELEASE_ORDER trigger on report_releases).
 *   LOW the restatement log is append-only (acknowledgement only) and its company FK RESTRICTs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';
import { asClaims, errorOf, seedEmployee } from './wave3-db-helpers';

const ORG = '11111111-1111-1111-1111-1111111e3186';
const ORG_X = '22222222-2222-2222-2222-2222222e3186';
const LOC = 'aaaaaaaa-0000-0000-0000-00000000e186';
const LOC2 = 'aaaaaaaa-0000-0000-0000-00000000e187';
const LOC_X = 'bbbbbbbb-0000-0000-0000-00000000e186';
const ACCT = crypto.randomUUID();

let db: PGlite;

const as = <T>(sub: string, fn: () => Promise<T>, org = ORG) => asClaims(db, 'authenticated', { sub, org_id: org }, fn);
const err = (sql: string, params: unknown[] = []) => errorOf(db, sql, params);

async function release(loc: string, month: number): Promise<string | null> {
  return err(
    `insert into public.report_releases (org_id, location_id, period_year, period_month, status, release_mode, released_at, released_by)
     values ($1, $2, 2026, $3, 'RELEASED', 'MANUAL', now(), 'user_cfo')
     on conflict (org_id, location_id, period_year, period_month)
     do update set status = 'RELEASED', released_at = now(), withdrawn_at = null, withdraw_reason = null`,
    [ORG, loc, month],
  );
}

async function withdraw(loc: string, month: number): Promise<string | null> {
  return err(
    `update public.report_releases set status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_by = 'user_cfo', withdraw_reason = 'reopened for a fix'
      where org_id = $1 and location_id = $2 and period_year = 2026 and period_month = $3`,
    [ORG, loc, month],
  );
}

const monthsSeen = async (sub: string, table = 'period_balances'): Promise<string[]> =>
  as(sub, async () => {
    const col = table === 'period_balances' ? `to_char(period_start, 'YYYY-MM')` : `period_year || '-' || lpad(period_month::text, 2, '0')`;
    const r = await db.query<{ m: string }>(`select distinct ${col} m from public.${table} where location_id = $1 order by 1`, [LOC]);
    return r.rows.map((x) => x.m);
  });

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug) values ('${ORG}', 'Gov Org', 'gov-org-e3'), ('${ORG_X}', 'Other Org', 'other-org-e3');
    insert into core.locations (id, org_id, name, short_code) values
      ('${LOC}', '${ORG}', 'Company One', 'C1'), ('${LOC2}', '${ORG}', 'Company Two', 'C2'), ('${LOC_X}', '${ORG_X}', 'Other Co', 'OX');
    insert into public.fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status) values
      ('${ORG}', '${LOC}', 2026, 1, '2026-01-01', '2026-01-31', 'HARD_CLOSE'),
      ('${ORG}', '${LOC}', 2026, 2, '2026-02-01', '2026-02-28', 'HARD_CLOSE'),
      ('${ORG}', '${LOC}', 2026, 3, '2026-03-01', '2026-03-31', 'HARD_CLOSE'),
      ('${ORG}', '${LOC2}', 2026, 1, '2026-01-01', '2026-01-31', 'HARD_CLOSE');
  `);
  for (const m of [1, 2, 3]) {
    await db.query(
      `insert into public.period_balances (org_id, location_id, account_id, period_start, debit_cents, credit_cents, line_count)
       values ($1, $2, $3, make_date(2026, $4, 1), 1000 * $4, 0, 1)`,
      [ORG, LOC, ACCT, m],
    );
    await db.query(
      `insert into public.report_release_snapshots (org_id, location_id, period_year, period_month, statement_hash)
       values ($1, $2, 2026, $3, $4)`,
      [ORG, LOC, m, 'f'.repeat(64)],
    );
    await db.query(
      `insert into public.report_restatements (org_id, location_id, period_year, period_month, net_income_delta_cents)
       values ($1, $2, 2026, $3, 100)`,
      [ORG, LOC, m],
    );
  }
  await seedEmployee(db, ORG, 'user_cfo', 'cfo');
  await seedEmployee(db, ORG, 'user_spec', 'accounting_specialist');
  await seedEmployee(db, ORG, 'user_owner', 'business_user');
  await seedEmployee(db, ORG, 'user_custom', 'cfo');
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('H2 — the report RPCs are service-role only', () => {
  const SIGS = [
    'public.report_balances(jsonb, date, date, jsonb, boolean, uuid)',
    'public.report_drill_lines(jsonb, jsonb, date, date, jsonb, jsonb, integer, integer, uuid)',
    'public.period_balances_tieout(uuid)',
  ];
  it('authenticated / anon hold no EXECUTE; service_role does', async () => {
    for (const sig of SIGS) {
      const r = await db.query<{ a: boolean; n: boolean; s: boolean }>(
        `select has_function_privilege('authenticated', $1, 'EXECUTE') a, has_function_privilege('anon', $1, 'EXECUTE') n,
                has_function_privilege('service_role', $1, 'EXECUTE') s`,
        [sig],
      );
      expect(r.rows[0], sig).toEqual({ a: false, n: false, s: true });
    }
  });

  it('a member calling report_balances directly is refused', async () => {
    const e = await as('user_cfo', () => err(`select public.report_balances(null, '2026-01-01', '2026-03-31', '[]'::jsonb, false, null)`));
    expect(e).toMatch(/permission denied/);
  });
});

describe('H2 — core.is_finance_member()', () => {
  const fin = (sub: string, org = ORG) => as(sub, async () => (await db.query<{ f: boolean }>(`select core.is_finance_member() f`)).rows[0].f, org);

  it('finance roles (close_mgmt:manage or journal_entries:create) are finance; others are not', async () => {
    expect(await fin('user_cfo')).toBe(true);
    expect(await fin('user_spec')).toBe(true);
    expect(await fin('user_owner')).toBe(false);
    expect(await fin('nobody')).toBe(false);
    // a seat in another org is not finance here
    expect(await fin('user_cfo', ORG_X)).toBe(false);
  });

  it('no JWT → false', async () => {
    const r = await asClaims(db, 'authenticated', {}, async () => (await db.query<{ f: boolean }>(`select core.is_finance_member() f`)).rows[0].f);
    expect(r).toBe(false);
  });

  it('honours the tenant\'s mig-130 overrides (revoking close_mgmt:manage from a role)', async () => {
    await db.query(
      `insert into core.custom_roles (org_id, key, name, base_role) values ($1, 'cfo_lite', 'CFO lite', 'cfo')`, [ORG],
    ).catch(() => undefined);
    await db.query(`update core.employees set role = 'cfo_lite' where clerk_user_id = 'user_custom'`);
    expect(await fin('user_custom')).toBe(true);
    await db.query(
      `insert into core.role_permission_overrides (org_id, role_key, feature, action, allowed) values ($1, 'cfo_lite', 'close_mgmt', 'manage', false)`, [ORG],
    );
    expect(await fin('user_custom')).toBe(false);
  });
});

describe('H2 / H3 — release gate (in order) on period_balances, snapshots, restatements', () => {
  it('nothing released: non-finance reads no month; finance reads all', async () => {
    expect(await monthsSeen('user_owner')).toEqual([]);
    expect(await monthsSeen('user_owner', 'report_release_snapshots')).toEqual([]);
    expect(await monthsSeen('user_owner', 'report_restatements')).toEqual([]);
    expect(await monthsSeen('user_cfo')).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(await monthsSeen('user_cfo', 'report_restatements')).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('releases go in order: March is refused while February is unreleased', async () => {
    expect(await release(LOC, 3)).toMatch(/RELEASE_ORDER/);
    expect(await release(LOC, 1)).toBeNull();
    expect(await release(LOC, 3)).toMatch(/RELEASE_ORDER: release 2026-02 first/);
    expect(await monthsSeen('user_owner')).toEqual(['2026-01']);
    expect(await monthsSeen('user_owner', 'report_release_snapshots')).toEqual(['2026-01']);
    expect(await monthsSeen('user_owner', 'report_restatements')).toEqual(['2026-01']);
    expect(await release(LOC, 2)).toBeNull();
    expect(await monthsSeen('user_owner')).toEqual(['2026-01', '2026-02']);
  });

  it('the auto rule releases March, and a withdrawn February holds it back again', async () => {
    await db.query(
      `insert into public.report_governance_settings (org_id, location_id, auto_release_enabled, auto_release_days, auto_release_min_status)
       values ($1, null, true, 0, 'HARD_CLOSE')`, [ORG],
    );
    expect(await monthsSeen('user_owner')).toEqual(['2026-01', '2026-02', '2026-03']);
    // a company row overrides the tenant rule
    await db.query(
      `insert into public.report_governance_settings (org_id, location_id, auto_release_enabled) values ($1, $2, false)`, [ORG, LOC],
    );
    expect(await monthsSeen('user_owner')).toEqual(['2026-01', '2026-02']);
    await db.query(`delete from public.report_governance_settings where location_id = $1`, [LOC]);
    expect(await withdraw(LOC, 2)).toBeNull();
    expect(await monthsSeen('user_owner')).toEqual(['2026-01']); // March is held by February
    expect(await release(LOC, 2)).toBeNull();
  });

  it('a month can\'t be withdrawn while the next month is explicitly released', async () => {
    expect(await release(LOC, 3)).toBeNull();
    expect(await withdraw(LOC, 2)).toMatch(/RELEASE_ORDER: withdraw 2026-03 first/);
    expect(await withdraw(LOC, 3)).toBeNull();
    expect(await withdraw(LOC, 2)).toBeNull();
  });

  it('members never read another org\'s released months', async () => {
    const r = await as('user_owner', async () => (await db.query(`select * from public.report_released_months()`)).rows.length, ORG_X);
    expect(r).toBe(0);
  });
});

describe('LOW — the restatement log is append-only', () => {
  let id = '';
  beforeAll(async () => {
    id = (await db.query<{ id: string }>(`select id from public.report_restatements where location_id = $1 limit 1`, [LOC])).rows[0].id;
  });

  it('only the acknowledgement can change', async () => {
    expect(await err(`update public.report_restatements set net_income_delta_cents = 0 where id = $1`, [id])).toMatch(/RESTATEMENT_APPEND_ONLY/);
    expect(await err(`update public.report_restatements set changed_accounts = '[{"x":1}]'::jsonb where id = $1`, [id])).toMatch(/RESTATEMENT_APPEND_ONLY/);
    expect(await err(
      `update public.report_restatements set acknowledged_at = now(), acknowledged_by = 'user_cfo', acknowledgement = 'Reviewed the reclass' where id = $1`, [id],
    )).toBeNull();
  });

  it('a delete is refused, except inside a server-side purge', async () => {
    expect(await err(`delete from public.report_restatements where id = $1`, [id])).toMatch(/RESTATEMENT_APPEND_ONLY/);
    await db.exec(`begin; set local meritbooks.allow_audit_purge = 'on'; delete from public.report_restatements where id = '${id}'; commit;`);
    expect((await db.query(`select 1 from public.report_restatements where id = $1`, [id])).rows).toHaveLength(0);
  });

  it('a company with a restatement history can\'t be deleted (FK RESTRICT)', async () => {
    const r = await db.query<{ t: string }>(
      `select con.confdeltype::text t from pg_constraint con
        where con.conrelid = 'public.report_restatements'::regclass and con.contype = 'f' and con.confrelid = 'core.locations'::regclass`,
    );
    expect(r.rows.map((x) => x.t)).toEqual(['r']);
  });
});
