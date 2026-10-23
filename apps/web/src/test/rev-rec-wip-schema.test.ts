/**
 * Migration 179 (rev-rec policy + WIP run ledger) — real-Postgres guarantees, replayed in
 * PGlite WITH hosted Supabase's default grants (so "members can't write" is not vacuous):
 *
 *   1. members (authenticated) and anon cannot INSERT / UPDATE / DELETE the four new tables;
 *   2. members read ONLY their own org's rows; the service role writes;
 *   3. a DISMISSED run must carry a reason (≥ 4 chars) — the DB refuses otherwise;
 *   4. at most one PROPOSED run per company + period;
 *   5. the CHECK vocabularies hold (cadence, posting mode, status);
 *   6. the two loss-provision role keys are registered.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestDb } from './pg';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const LOC_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const LOC_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const JOB_A = 'aaaaaaaa-1111-0000-0000-00000000000a';

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug) values
      ('${ORG_A}', 'Tenant A', 'tenant-a'), ('${ORG_B}', 'Tenant B', 'tenant-b');
    insert into core.locations (id, org_id, name, short_code) values
      ('${LOC_A}', '${ORG_A}', 'Company A', 'CA'), ('${LOC_B}', '${ORG_B}', 'Company B', 'CB');
    insert into core.jobs (id, org_id, location_id, job_number, name) values
      ('${JOB_A}', '${ORG_A}', '${LOC_A}', 'J-1', 'Job one');
    insert into public.rev_rec_policies (org_id, location_id) values ('${ORG_A}', '${LOC_A}'), ('${ORG_B}', '${LOC_B}');
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

async function errorOf(sql: string): Promise<string | null> {
  try {
    await db.query(sql);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('migration 179 — write locks', () => {
  for (const role of ['authenticated', 'anon'] as const) {
    it(`${role} cannot write rev-rec policy / override / run tables`, async () => {
      const errs = await asRole(role, async () => [
        await errorOf(`insert into public.rev_rec_policies (org_id, location_id) values ('${ORG_A}', '${LOC_A}')`),
        await errorOf(`update public.rev_rec_policies set accrue_underbillings = false`),
        await errorOf(`delete from public.rev_rec_policies`),
        await errorOf(`insert into public.rev_rec_job_overrides (org_id, location_id, job_id) values ('${ORG_A}', '${LOC_A}', '${JOB_A}')`),
        await errorOf(`insert into public.rev_rec_wip_runs (org_id, location_id, period_key, as_of_date) values ('${ORG_A}', '${LOC_A}', '2026-10', '2026-10-31')`),
        await errorOf(`update public.rev_rec_wip_runs set status = 'POSTED'`),
        await errorOf(`delete from public.rev_rec_wip_run_lines`),
      ]);
      for (const e of errs) expect(e).toMatch(/permission denied/i);
    });
  }

  it('members read only their own org; the service role writes', async () => {
    const rows = await asRole('authenticated', async () =>
      (await db.query<{ org_id: string }>(`select org_id from public.rev_rec_policies`)).rows);
    expect(rows.map((r) => r.org_id)).toEqual([ORG_A]);
    const err = await asRole('service_role', () =>
      errorOf(`update public.rev_rec_policies set materiality_cents = 50000 where org_id = '${ORG_A}'`));
    expect(err).toBeNull();
  });
});

describe('migration 179 — run ledger rules', () => {
  it('refuses a DISMISSED run without a reason, accepts one with a reason', async () => {
    expect(await errorOf(
      `insert into public.rev_rec_wip_runs (org_id, location_id, period_key, as_of_date, status, revision) values ('${ORG_A}', '${LOC_A}', '2026-08', '2026-08-31', 'DISMISSED', 1)`,
    )).toMatch(/rev_rec_wip_runs_dismiss_reason_chk/);
    expect(await errorOf(
      `insert into public.rev_rec_wip_runs (org_id, location_id, period_key, as_of_date, status, revision, dismiss_reason) values ('${ORG_A}', '${LOC_A}', '2026-08', '2026-08-31', 'DISMISSED', 1, '  ok ')`,
    )).toMatch(/rev_rec_wip_runs_dismiss_reason_chk/);
    expect(await errorOf(
      `insert into public.rev_rec_wip_runs (org_id, location_id, period_key, as_of_date, status, revision, dismiss_reason) values ('${ORG_A}', '${LOC_A}', '2026-08', '2026-08-31', 'DISMISSED', 1, 'No jobs moved this month')`,
    )).toBeNull();
  });

  it('allows at most one PROPOSED run per company + period', async () => {
    expect(await errorOf(
      `insert into public.rev_rec_wip_runs (org_id, location_id, period_key, as_of_date, revision) values ('${ORG_A}', '${LOC_A}', '2026-09', '2026-09-30', 1)`,
    )).toBeNull();
    expect(await errorOf(
      `insert into public.rev_rec_wip_runs (org_id, location_id, period_key, as_of_date, revision) values ('${ORG_A}', '${LOC_A}', '2026-09', '2026-09-30', 2)`,
    )).toMatch(/uq_rev_rec_wip_runs_one_proposed/);
  });

  it('enforces the vocabularies', async () => {
    expect(await errorOf(`update public.rev_rec_policies set run_cadence = 'WEEKLY'`)).toMatch(/rev_rec_policies_cadence_chk/);
    expect(await errorOf(`update public.rev_rec_policies set posting_mode = 'YOLO'`)).toMatch(/rev_rec_policies_posting_chk/);
    expect(await errorOf(`update public.rev_rec_policies set materiality_cents = -1`)).toMatch(/rev_rec_policies_materiality_chk/);
    expect(await errorOf(
      `insert into public.rev_rec_wip_runs (org_id, location_id, period_key, as_of_date, status) values ('${ORG_A}', '${LOC_A}', '2026-13', '2026-12-31', 'PROPOSED')`,
    )).toMatch(/rev_rec_wip_runs_period_chk/);
  });

  it('registers the loss-provision account roles', async () => {
    const { rows } = await db.query<{ role_key: string; default_account_number: string }>(
      `select role_key, default_account_number from core.account_role_keys where role_key like 'CONTRACT_LOSS_%' order by 1`,
    );
    expect(rows).toEqual([
      { role_key: 'CONTRACT_LOSS_EXPENSE', default_account_number: '5250' },
      { role_key: 'CONTRACT_LOSS_PROVISION', default_account_number: '2450' },
    ]);
  });

  it('accepts the POSTING claim status (approve race guard)', async () => {
    expect(await errorOf(
      `insert into public.rev_rec_wip_runs (org_id, location_id, period_key, as_of_date, revision, status) values ('${ORG_B}', '${LOC_B}', '2026-08', '2026-08-31', 1, 'POSTING')`,
    )).toBeNull();
    expect(await errorOf(
      `insert into public.rev_rec_wip_runs (org_id, location_id, period_key, as_of_date, revision, status) values ('${ORG_B}', '${LOC_B}', '2026-08', '2026-08-31', 2, 'CLAIMED')`,
    )).toMatch(/rev_rec_wip_runs_status_chk/);
  });
});

describe('migration 179 §4 — every tenant gets the loss-provision accounts', () => {
  const ORG_C = '33333333-3333-3333-3333-333333333333';

  /** The §4 placement block, re-run now that the test tenants exist (it ran at replay time with none). */
  async function runPlacement(): Promise<void> {
    const sql = readFileSync(resolve(__dirname, '../../../../packages/supabase/migrations/179_rev_rec_policy_and_wip_runs.sql'), 'utf8');
    const start = sql.indexOf('-- EVERY tenant gets both accounts');
    const end = sql.indexOf('end $$;', start) + 'end $$;'.length;
    expect(start).toBeGreaterThan(0);
    await db.exec(sql.slice(start, end));
  }

  async function lossAccounts(org: string) {
    return (await db.query<{ account_number: string; account_type: string; account_sub_type: string; group_name: string }>(
      `select a.account_number, a.account_type::text, a.account_sub_type::text, g.name as group_name
         from public.accounts a join public.account_groups g on g.id = a.account_group_id
        where a.org_id = $1 and a.account_number in ('2450', '5250') order by 1`, [org])).rows;
  }

  it('a tenant with no chart at all gets both, in the standard template groups; re-running changes nothing', async () => {
    await runPlacement();
    expect(await lossAccounts(ORG_A)).toEqual([
      { account_number: '2450', account_type: 'LIABILITY', account_sub_type: 'CURRENT_LIABILITY', group_name: 'Other Current Liabilities' },
      { account_number: '5250', account_type: 'COGS', account_sub_type: 'COST_OF_GOODS_SOLD', group_name: 'Other COGS' },
    ]);
    await runPlacement();
    expect(await lossAccounts(ORG_A)).toHaveLength(2);
  });

  it('a tenant without the anchors but with a same-type account uses that account\'s group', async () => {
    await db.exec(`insert into core.organizations (id, name, slug) values ('${ORG_C}', 'Tenant C', 'tenant-c')`);
    const t = (await db.query<{ id: string }>(
      `insert into public.account_types (org_id, name, code, display_order, normal_balance) values ('${ORG_C}', 'Liab', 'LIABILITY', 2, 'CREDIT') returning id`)).rows[0];
    const st = (await db.query<{ id: string }>(
      `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order) values ('${ORG_C}', $1, 'CL', 'CURRENT_LIABILITY', 1) returning id`, [t.id])).rows[0];
    const g = (await db.query<{ id: string }>(
      `insert into public.account_groups (org_id, account_sub_type_id, name, display_order) values ('${ORG_C}', $1, 'My Payables', 1) returning id`, [st.id])).rows[0];
    await db.query(
      `insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
       values ('${ORG_C}', $1, '2100', 'Accrued stuff', 'LIABILITY', 'CURRENT_LIABILITY', true, 'APPROVED')`, [g.id]);
    await runPlacement();
    const rows = await lossAccounts(ORG_C);
    expect(rows.find((r) => r.account_number === '2450')?.group_name).toBe('My Payables');
    expect(rows.find((r) => r.account_number === '5250')?.group_name).toBe('Other COGS');
  });
});
