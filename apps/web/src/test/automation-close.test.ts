/**
 * Wave 2E — the close / AP automation jobs + "Run now" against a REAL Postgres (PGlite):
 *
 *   close.depreciation  proposes by default (no GL), posts under the AUTO cap through the
 *                       real engine, never touches a HARD_CLOSE month, idempotent per period
 *   close.period_end    opens the prior month's checklist once per company (idempotent),
 *                       leaves hard-closed periods alone, never posts
 *   ap.pay_run_propose  a paused PAY_RUN proposal (due + early-pay discount), one at a time
 *   run now / switch    manual run is logged as trigger 'manual' with the person, under the
 *                       same lock, without touching the cron slot; stubs / platform jobs refuse;
 *                       the tenant switch writes the override the runner honours
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { seedTenant, count, balance, type Tenant } from './seam-fixture';

const holder = vi.hoisted(() => ({ svc: null as unknown as SupabaseClient }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => holder.svc }));
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabase: () => holder.svc, createServerSupabase: () => holder.svc }));

const { runDepreciationJob } = await import('@/lib/scheduler/jobs/depreciation');
const { runPeriodEndJob } = await import('@/lib/scheduler/jobs/period-end');
const { runPayRunProposeJob } = await import('@/lib/scheduler/jobs/pay-run');
const { runJobNow, setTenantJobEnabled, ManualRunError } = await import('@/lib/scheduler/manual');
const { CLOSE_TASK_GRAPH } = await import('@/lib/close/orchestration');
const { resolveEffectiveConfig } = await import('@/lib/scheduler/run');
const { getJob } = await import('@/lib/scheduler/registry');
type JobContext = import('@/lib/scheduler/types').JobContext;

let db: PGlite;
let svc: SupabaseClient;
let T: Tenant;
let ASSET = '';
let ACCUM = '';
let DEPR = '';

function ctx(at: string, slot?: string): JobContext {
  return { orgId: T.org, now: new Date(at), slotAt: new Date(slot ?? at), signal: new AbortController().signal, admin: svc, scopedClient: () => svc };
}

async function account(number: string, name: string, type: string, subType: string): Promise<string> {
  const t = await db.query<{ id: string }>(
    `insert into public.account_types (org_id, name, code, display_order, normal_balance) values ($1, $2::text, ($2::text)::account_type_enum, 1, $3)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [T.org, type, ['ASSET', 'COGS', 'OPEX', 'OTHER'].includes(type) ? 'DEBIT' : 'CREDIT'],
  );
  const st = await db.query<{ id: string }>(
    `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order) values ($1, $2, $3::text, ($3::text)::account_sub_type_enum, 1)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [T.org, t.rows[0].id, subType],
  );
  const g = await db.query<{ id: string }>(
    `insert into public.account_groups (org_id, account_sub_type_id, name, display_order) values ($1, $2, $3, 1)
     on conflict (org_id, name) do update set display_order = 1 returning id`,
    [T.org, st.rows[0].id, `G ${subType}`],
  );
  const id = crypto.randomUUID();
  await db.query(
    `insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
     values ($1, $2, $3, $4, $5, $6::account_type_enum, $7::account_sub_type_enum, true, 'APPROVED')`,
    [id, T.org, g.rows[0].id, number, name, type, subType],
  );
  return id;
}

async function dial(feature: string, mode: 'PROPOSE' | 'AUTO_UNDER_LIMIT', cap: number | null): Promise<void> {
  await db.query(
    `insert into public.autonomy_settings (org_id, feature, mode, materiality_limit_cents) values ($1, $2, $3, $4)
     on conflict (org_id, feature) do update set mode = excluded.mode, materiality_limit_cents = excluded.materiality_limit_cents`,
    [T.org, feature, mode, cap],
  );
}

async function period(year: number, month: number, status: 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE'): Promise<void> {
  await db.query(`update public.fiscal_periods set status = $4::period_status_enum where location_id = $1 and period_year = $2 and period_month = $3`, [T.loc, year, month, status]);
}

const deprEntries = () => count(db, `select count(*) as n from public.gl_entries where source_module = 'DEPRECIATION' and org_id = $1`, [T.org]);

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  svc = pgSupabase(db);
  holder.svc = svc;
  T = await seedTenant(db, { projects: false, shortCode: 'CLS' });
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id, email) values ('user_ctl', 'ctl@books.test') returning id`);
  await db.query(`insert into core.memberships (user_id, org_id, role, status) values ($1, $2, 'admin', 'active')`, [u.rows[0].id, T.org]);
  ASSET = await account('1500', 'Equipment', 'ASSET', 'FIXED_ASSET');
  ACCUM = await account('1590', 'Accumulated Depreciation', 'ASSET', 'FIXED_ASSET');
  DEPR = await account('6900', 'Depreciation Expense', 'OPEX', 'OPERATING_EXPENSE');
  await db.query(
    `insert into public.fixed_assets (org_id, location_id, name, category, acquisition_date, acquisition_cost_cents, salvage_value_cents, useful_life_months,
       asset_account_id, depreciation_expense_account_id, accumulated_depreciation_account_id)
     values ($1, $2, 'Skid steer', 'EQUIPMENT', '2026-07-01', 120000, 0, 12, $3, $4, $5)`,
    [T.org, T.loc, ASSET, DEPR, ACCUM],
  );
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('close.depreciation', () => {
  it('PROPOSE (default): reports last month per company, posts nothing; a hard-closed month is excluded', async () => {
    await period(2026, 8, 'HARD_CLOSE');
    const r = await runDepreciationJob(ctx('2026-10-01T08:00:00Z'));
    expect(r.status).toBe('ok');
    expect(r.counts).toMatchObject({ mode: 'proposed', as_of: '2026-09-30', periods_due: 1, depreciation_cents: 10_000, blocked_by_hard_close: 1, companies: 1 });
    expect(r.summary).toMatch(/Proposed: 2026-09 depreciation/);
    expect(await deprEntries()).toBe(0);
    expect(await count(db, `select count(*) as n from core.notifications where org_id = $1 and kind = 'scheduler.depreciation'`, [T.org])).toBe(1);
  });

  it('AUTO under the cap posts through the engine — up to the locked month, never into it — and is idempotent', async () => {
    await dial('SCHEDULED_DEPRECIATION', 'AUTO_UNDER_LIMIT', 1_000_000);
    const r = await runDepreciationJob(ctx('2026-10-01T08:00:00Z'));
    expect(r.counts).toMatchObject({ mode: 'posted' });
    expect(await deprEntries()).toBe(1); // July only — August is hard-closed
    expect(await balance(db, DEPR)).toBe(10_000);
    const again = await runDepreciationJob(ctx('2026-10-01T09:00:00Z'));
    expect(again.status).toBe('ok');
    expect(again.counts).toMatchObject({ mode: 'nothing_due', blocked_by_hard_close: 1 });
    expect(await deprEntries()).toBe(1);
    // Reopen August → the catch-up posts August and September, once.
    await period(2026, 8, 'OPEN');
    await runDepreciationJob(ctx('2026-10-01T10:00:00Z'));
    await runDepreciationJob(ctx('2026-10-01T11:00:00Z'));
    expect(await deprEntries()).toBe(3);
    expect(await balance(db, DEPR)).toBe(30_000);
  });

  it('over the cap it proposes instead of posting', async () => {
    await dial('SCHEDULED_DEPRECIATION', 'AUTO_UNDER_LIMIT', 5_000);
    const r = await runDepreciationJob(ctx('2026-11-01T08:00:00Z'));
    expect(r.counts).toMatchObject({ mode: 'proposed', periods_due: 1 });
    expect(await deprEntries()).toBe(3);
    await dial('SCHEDULED_DEPRECIATION', 'PROPOSE', null);
  });
});

describe('close.period_end', () => {
  it('opens last month’s checklist once per company and never posts', async () => {
    const glBefore = await count(db, `select count(*) as n from public.gl_entries where org_id = $1`, [T.org]);
    const r = await runPeriodEndJob(ctx('2026-11-02T13:00:00Z'));
    expect(r.status === 'ok' || r.status === 'partial').toBe(true);
    expect(r.counts).toMatchObject({ period: '2026-10', open: 1, checklists_opened: 1 });
    const rows = await count(
      db,
      `select count(*) as n from public.close_checklists c join public.fiscal_periods p on p.id = c.fiscal_period_id where p.location_id = $1 and p.period_year = 2026 and p.period_month = 10`,
      [T.loc],
    );
    expect(rows).toBe(CLOSE_TASK_GRAPH.length);
    await runPeriodEndJob(ctx('2026-11-03T13:00:00Z'));
    expect(
      await count(db, `select count(*) as n from public.close_checklists c join public.fiscal_periods p on p.id = c.fiscal_period_id where p.location_id = $1 and p.period_year = 2026 and p.period_month = 10`, [T.loc]),
    ).toBe(CLOSE_TASK_GRAPH.length);
    expect(await count(db, `select count(*) as n from public.gl_entries where org_id = $1`, [T.org])).toBe(glBefore);
  });

  it('leaves a hard-closed month alone', async () => {
    await period(2026, 11, 'HARD_CLOSE');
    const r = await runPeriodEndJob(ctx('2026-12-02T13:00:00Z'));
    expect(r.counts).toMatchObject({ period: '2026-11', open: 0 });
    expect(
      await count(db, `select count(*) as n from public.close_checklists c join public.fiscal_periods p on p.id = c.fiscal_period_id where p.location_id = $1 and p.period_month = 11 and p.period_year = 2026`, [T.loc]),
    ).toBe(0);
  });
});

describe('ap.pay_run_propose', () => {
  it('proposes due + early-pay-discount bills, pauses at release, and does not stack proposals', async () => {
    const vendor = crypto.randomUUID();
    await db.query(`insert into core.vendors (id, org_id, name) values ($1, $2, 'Prairie Lumber')`, [vendor, T.org]);
    const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    await db.query(
      `insert into public.bills (org_id, location_id, vendor_id, bill_number, bill_date, due_date, total_cents, status, early_pay_discount_bps, early_pay_discount_date) values
        ($1, $2, $3, 'B-1', $4, $5, 40000, 'APPROVED', null, null),
        ($1, $2, $3, 'B-2', $4, $6, 100000, 'APPROVED', 200, $7),
        ($1, $2, $3, 'B-3', $4, $6, 70000, 'APPROVED', null, null),
        ($1, $2, $3, 'B-4', $4, $5, 9000, 'PENDING', null, null)`,
      [T.org, T.loc, vendor, iso(-20), iso(3), iso(25), iso(4)],
    );
    const r = await runPayRunProposeJob(ctx(new Date().toISOString()));
    expect(r.status).toBe('ok');
    expect(r.counts).toMatchObject({ mode: 'proposed', bills: 2, total_cents: 140_000, discount_bills: 1, discount_savings_cents: 2_000, run_status: 'PAUSED' });
    expect(await count(db, `select count(*) as n from public.agent_runs where org_id = $1 and recipe = 'PAY_RUN' and status = 'PAUSED'`, [T.org])).toBe(1);
    // nothing was paid or queued
    expect(await count(db, `select count(*) as n from public.approvals where subject_table = 'bills'`)).toBe(0);
    const again = await runPayRunProposeJob(ctx(new Date().toISOString()));
    expect(again.counts).toMatchObject({ mode: 'already_waiting' });
    expect(await count(db, `select count(*) as n from public.agent_runs where org_id = $1 and recipe = 'PAY_RUN'`, [T.org])).toBe(1);
  });
});

describe('Run now + the tenant switch', () => {
  it('runs a job for the tenant as a manual run, recorded with the person, leaving the cron slot alone', async () => {
    await db.query(`insert into core.scheduled_jobs (job_key, org_id, last_slot_at) values ('close.period_end', $1, '2026-11-03T13:00:00Z')`, [T.org]);
    const out = await runJobNow({ admin: svc, scopedClient: () => svc, now: () => new Date('2026-11-04T15:00:00Z') }, 'close.period_end', T.org, 'user_ctl');
    expect(['ok', 'partial']).toContain(out.status);
    const run = await db.query<{ trigger: string; actor: string; status: string }>(`select trigger, actor, status from core.job_runs where id = $1`, [out.runId]);
    expect(run.rows[0]).toMatchObject({ trigger: 'manual', actor: 'user_ctl' });
    const st = await db.query<{ last_slot_at: string; lock_owner: string | null; last_status: string }>(`select last_slot_at, lock_owner, last_status from core.scheduled_jobs where job_key = 'close.period_end' and org_id = $1`, [T.org]);
    expect(new Date(st.rows[0].last_slot_at).toISOString()).toBe('2026-11-03T13:00:00.000Z');
    expect(st.rows[0].lock_owner).toBeNull();
    expect(st.rows[0].last_status).toBe(out.status);
  });

  it('refuses while the job holds the lock, and refuses stubs and platform jobs', async () => {
    await db.query(`update core.scheduled_jobs set lock_owner = 'tick-1', lock_expires_at = now() + interval '5 minutes' where job_key = 'close.period_end' and org_id = $1`, [T.org]);
    await expect(runJobNow({ admin: svc, scopedClient: () => svc }, 'close.period_end', T.org, 'user_ctl')).rejects.toBeInstanceOf(ManualRunError);
    await db.query(`update core.scheduled_jobs set lock_owner = null, lock_expires_at = null where job_key = 'close.period_end' and org_id = $1`, [T.org]);
    await expect(runJobNow({ admin: svc }, 'lenders.prepare', T.org, 'u')).rejects.toMatchObject({ status: 409 });
    await expect(runJobNow({ admin: svc }, 'scheduler.prune_runs', T.org, 'u')).rejects.toMatchObject({ status: 403 });
    await expect(runJobNow({ admin: svc }, 'nope.nothing', T.org, 'u')).rejects.toMatchObject({ status: 404 });
  });

  it('the switch writes the tenant override the runner honours (null = back to default)', async () => {
    const def = getJob('ar.dunning')!;
    await setTenantJobEnabled(svc, 'ar.dunning', T.org, false);
    const row = async () => (await db.query<{ job_key: string; org_id: string; enabled: boolean | null; cron: string | null; last_slot_at: string | null; pending_slot_at: string | null; attempts: number; consecutive_failures: number; backoff_until: string | null; lock_owner: string | null; lock_expires_at: string | null }>(`select job_key, org_id, enabled, cron, last_slot_at, pending_slot_at, attempts, consecutive_failures, backoff_until, lock_owner, lock_expires_at from core.scheduled_jobs where job_key = 'ar.dunning' and org_id = $1`, [T.org])).rows[0];
    expect(resolveEffectiveConfig(def, await row(), undefined).enabled).toBe(false);
    await setTenantJobEnabled(svc, 'ar.dunning', T.org, null);
    expect((await row()).enabled).toBeNull();
    expect(resolveEffectiveConfig(def, await row(), undefined).enabled).toBe(true);
    await expect(setTenantJobEnabled(svc, 'lenders.prepare', T.org, true)).rejects.toBeInstanceOf(ManualRunError);
  });
});
