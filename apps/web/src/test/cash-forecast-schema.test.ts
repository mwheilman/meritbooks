/**
 * Migration 192 (cash workspace: scenarios, adjustments, manual items, settings, liquidity lines,
 * snapshots, events) — real-Postgres guarantees, replayed in PGlite WITH hosted Supabase's default
 * grants so "members can't write" is not vacuous (AC-CF9):
 *
 *   1. members (authenticated) and anon cannot INSERT / UPDATE / DELETE any 192 table;
 *   2. members read ONLY their own org; the service role writes;
 *   3. the CHECKs hold the per-kind rules (a delay needs days, a line draw needs amount + date +
 *      company, an item's category matches its direction, a transfer names the other company,
 *      a snapshot is anchored on a Monday);
 *   4. snapshots and events are append-only (even for the service role) except under the purge GUC;
 *   5. one snapshot per company × week, the combined (NULL company) row included;
 *   6. client-scope RLS is on every table; the 1110 Projects-only seat deny lands on every table
 *      when its contract is installed; re-running 192 changes nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFile, createTestDb, listMigrationFiles } from './pg';

const ORG_A = '11111111-1111-1111-1111-1111111c4192';
const ORG_B = '22222222-2222-2222-2222-2222222c4192';
const LOC_A = 'aaaaaaaa-0000-0000-0000-0000000c4192';
const LOC_A2 = 'aaaaaaaa-0000-0000-0000-0000000c4193';
const LOC_B = 'bbbbbbbb-0000-0000-0000-0000000c4192';
const TABLES = ['cash_forecast_adjustments', 'cash_forecast_events', 'cash_forecast_items', 'cash_forecast_scenarios', 'cash_forecast_snapshots', 'cash_liquidity_lines', 'cash_settings'];
const FILE_192 = listMigrationFiles().find((f) => f.startsWith('192_'))!;

let db: PGlite;
let SCEN_A = '';

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug) values
      ('${ORG_A}', 'Tenant A', 'tenant-a-192'), ('${ORG_B}', 'Tenant B', 'tenant-b-192');
    insert into core.locations (id, org_id, name, short_code) values
      ('${LOC_A}', '${ORG_A}', 'Alpha', 'AL'), ('${LOC_A2}', '${ORG_A}', 'Alpha Two', 'A2'), ('${LOC_B}', '${ORG_B}', 'Beta', 'BE');
  `);
  const r = await db.query<{ id: string }>(`insert into public.cash_forecast_scenarios (org_id, location_id, name, kind) values ('${ORG_A}', '${LOC_A}', 'Downside', 'DOWNSIDE') returning id`);
  SCEN_A = r.rows[0].id;
  await db.exec(`
    insert into public.cash_forecast_scenarios (org_id, location_id, name, kind) values ('${ORG_B}', null, 'Tenant B case', 'CUSTOM');
    insert into public.cash_settings (org_id, location_id, minimum_cash_cents) values ('${ORG_A}', '${LOC_A}', 5000000), ('${ORG_B}', '${LOC_B}', 100);
    insert into public.cash_forecast_snapshots (org_id, location_id, anchor_date, opening_cents, closing_cents, weeks, engine_version)
      values ('${ORG_A}', '${LOC_A}', '2026-10-19', 100, 200, '[]'::jsonb, 'test'), ('${ORG_A}', null, '2026-10-19', 100, 200, '[]'::jsonb, 'test');
    insert into public.cash_forecast_events (org_id, location_id, event_kind) values ('${ORG_A}', '${LOC_A}', 'SNAPSHOT_TAKEN');
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

const item = (over: Record<string, string> = {}) => {
  const v: Record<string, string> = {
    org_id: `'${ORG_A}'`,
    location_id: `'${LOC_A}'`,
    direction: `'OUT'`,
    category: `'CAPEX'`,
    label: `'Truck'`,
    expected_date: `'2026-11-10'`,
    amount_cents: '1000',
    ...over,
  };
  return `insert into public.cash_forecast_items (${Object.keys(v).join(', ')}) values (${Object.values(v).join(', ')})`;
};
const adj = (over: Record<string, string>) => {
  const v: Record<string, string> = { org_id: `'${ORG_A}'`, scenario_id: `'${SCEN_A}'`, ...over };
  return `insert into public.cash_forecast_adjustments (${Object.keys(v).join(', ')}) values (${Object.values(v).join(', ')})`;
};

describe('migration 192 — write locks and tenant isolation', () => {
  for (const role of ['authenticated', 'anon'] as const) {
    it(`${role} cannot write any cash table`, async () => {
      const errs = await asRole(role, async () => [
        await errorOf(`insert into public.cash_forecast_scenarios (org_id, location_id, name) values ('${ORG_A}', '${LOC_A}', 'x')`),
        await errorOf(`update public.cash_forecast_scenarios set name = 'y'`),
        await errorOf(`delete from public.cash_forecast_scenarios`),
        await errorOf(adj({ kind: `'DELAY_RECEIPTS'`, days: '7' })),
        await errorOf(item()),
        await errorOf(`update public.cash_settings set minimum_cash_cents = 1`),
        await errorOf(`insert into public.cash_liquidity_lines (org_id, location_id, name, commitment_cents) values ('${ORG_A}', '${LOC_A}', 'Rev', 1)`),
        await errorOf(`insert into public.cash_forecast_snapshots (org_id, location_id, anchor_date, opening_cents, closing_cents, weeks, engine_version) values ('${ORG_A}', '${LOC_A}', '2026-10-26', 0, 0, '[]', 't')`),
        await errorOf(`insert into public.cash_forecast_events (org_id, event_kind) values ('${ORG_A}', 'SNAPSHOT_TAKEN')`),
      ]);
      for (const e of errs) expect(e).toMatch(/permission denied/i);
    });
  }

  it('members read only their own org; anon reads nothing', async () => {
    const scen = await asRole('authenticated', async () => (await db.query<{ org_id: string }>(`select org_id from public.cash_forecast_scenarios`)).rows);
    expect(scen.length).toBeGreaterThan(0);
    expect(new Set(scen.map((r) => r.org_id))).toEqual(new Set([ORG_A]));
    const set = await asRole('authenticated', async () => (await db.query<{ org_id: string }>(`select org_id from public.cash_settings`)).rows);
    expect(set.map((r) => r.org_id)).toEqual([ORG_A]);
    expect(await asRole('anon', () => errorOf(`select * from public.cash_forecast_snapshots`))).toMatch(/permission denied/i);
  });

  it('the service role writes', async () => {
    expect(await asRole('service_role', () => errorOf(item({ label: `'Service write'` })))).toBeNull();
    expect(await asRole('service_role', () => errorOf(`update public.cash_settings set alerts_enabled = false where org_id = '${ORG_A}'`))).toBeNull();
  });
});

describe('migration 192 — CHECK rules', () => {
  it('adjustments carry their per-kind fields', async () => {
    expect(await errorOf(adj({ kind: `'DELAY_RECEIPTS'` }))).toMatch(/check/i);
    expect(await errorOf(adj({ kind: `'DELAY_RECEIPTS'`, days: '0' }))).toMatch(/check/i);
    expect(await errorOf(adj({ kind: `'DELAY_RECEIPTS'`, days: '14' }))).toBeNull();
    expect(await errorOf(adj({ kind: `'DELAY_RECEIPTS'`, days: '-30' }))).toBeNull();
    expect(await errorOf(adj({ kind: `'RECEIPT_HAIRCUT'`, bps: '0' }))).toMatch(/check/i);
    expect(await errorOf(adj({ kind: `'RECEIPT_HAIRCUT'`, bps: '1000' }))).toBeNull();
    expect(await errorOf(adj({ kind: `'PAYROLL_GROWTH'`, bps: '300' }))).toBeNull();
    expect(await errorOf(adj({ kind: `'REMOVE_ITEM'` }))).toMatch(/check/i);
    expect(await errorOf(adj({ kind: `'LINE_DRAW'`, amount_cents: '5000' }))).toMatch(/check/i);
    expect(await errorOf(adj({ kind: `'LINE_DRAW'`, amount_cents: '5000', effective_date: `'2026-11-01'`, location_id: `'${LOC_A}'` }))).toBeNull();
    expect(await errorOf(adj({ kind: `'TELEPORT'` }))).toMatch(/check/i);
  });

  it('items: category matches direction; transfers name the other company; recurrence end rules', async () => {
    expect(await errorOf(item({ direction: `'IN'`, category: `'CAPEX'` }))).toMatch(/check/i);
    expect(await errorOf(item({ direction: `'IN'`, category: `'DEPOSIT'` }))).toBeNull();
    expect(await errorOf(item({ category: `'TRANSFER_OUT'` }))).toMatch(/check/i);
    expect(await errorOf(item({ category: `'TRANSFER_OUT'`, counterparty_location_id: `'${LOC_A}'` }))).toMatch(/check/i);
    expect(await errorOf(item({ category: `'TRANSFER_OUT'`, counterparty_location_id: `'${LOC_A2}'` }))).toBeNull();
    expect(await errorOf(item({ amount_cents: '0' }))).toMatch(/check/i);
    expect(await errorOf(item({ recurrence_end: `'2026-12-31'` }))).toMatch(/check/i);
    expect(await errorOf(item({ recurrence: `'MONTHLY'`, recurrence_end: `'2026-01-01'` }))).toMatch(/check/i);
    expect(await errorOf(item({ recurrence: `'MONTHLY'`, recurrence_end: `'2026-12-31'` }))).toBeNull();
    expect(await errorOf(item({ probability_bps: '0' }))).toMatch(/check/i);
  });

  it('settings, lines, snapshots', async () => {
    expect(await errorOf(`insert into public.cash_settings (org_id, location_id, runrate_basis) values ('${ORG_A}', '${LOC_A2}', 'GUESS')`)).toMatch(/check/i);
    expect(await errorOf(`insert into public.cash_settings (org_id, location_id, minimum_cash_cents) values ('${ORG_A}', '${LOC_A}', 1)`)).toMatch(/duplicate|unique/i);
    expect(await errorOf(`insert into public.cash_liquidity_lines (org_id, location_id, name, commitment_cents) values ('${ORG_A}', '${LOC_A}', 'Rev', -1)`)).toMatch(/check/i);
    // Not a Monday.
    expect(await errorOf(`insert into public.cash_forecast_snapshots (org_id, location_id, anchor_date, opening_cents, closing_cents, weeks, engine_version) values ('${ORG_A}', '${LOC_A}', '2026-10-21', 0, 0, '[]', 't')`)).toMatch(/check/i);
    // One per company × week — the combined (NULL) row too.
    expect(await errorOf(`insert into public.cash_forecast_snapshots (org_id, location_id, anchor_date, opening_cents, closing_cents, weeks, engine_version) values ('${ORG_A}', '${LOC_A}', '2026-10-19', 0, 0, '[]', 't')`)).toMatch(/duplicate|unique/i);
    expect(await errorOf(`insert into public.cash_forecast_snapshots (org_id, location_id, anchor_date, opening_cents, closing_cents, weeks, engine_version) values ('${ORG_A}', null, '2026-10-19', 0, 0, '[]', 't')`)).toMatch(/duplicate|unique/i);
    // Scenario names are unique per company (case-insensitive), the all-companies NULL included.
    expect(await errorOf(`insert into public.cash_forecast_scenarios (org_id, location_id, name) values ('${ORG_A}', '${LOC_A}', 'downside')`)).toMatch(/duplicate|unique/i);
  });
});

describe('migration 192 — append-only snapshots and events', () => {
  it('UPDATE / DELETE are refused even for the service role', async () => {
    expect(await asRole('service_role', () => errorOf(`update public.cash_forecast_snapshots set closing_cents = 1`))).toMatch(/append-only/i);
    expect(await asRole('service_role', () => errorOf(`delete from public.cash_forecast_snapshots`))).toMatch(/append-only/i);
    expect(await asRole('service_role', () => errorOf(`update public.cash_forecast_events set note = 'x'`))).toMatch(/append-only/i);
    expect(await asRole('service_role', () => errorOf(`delete from public.cash_forecast_events`))).toMatch(/append-only/i);
  });

  it('the purge GUC allows a tenant purge', async () => {
    await db.exec('begin');
    await db.exec(`set local meritbooks.allow_ledger_purge = 'on'`);
    expect(await errorOf(`delete from public.cash_forecast_snapshots where org_id = '${ORG_A}' and location_id is null`)).toBeNull();
    await db.exec('rollback');
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from public.cash_forecast_snapshots where org_id = '${ORG_A}'`);
    expect(rows[0].n).toBe(2);
  });
});

describe('migration 192 — policies and idempotency', () => {
  it('client-scope RLS is on every 192 table', async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public' and policyname = 'client_scope_rls' and tablename = any($1::text[]) order by 1`,
      [TABLES],
    );
    expect(rows.map((r) => r.tablename)).toEqual(TABLES);
  });

  it('re-running 192 changes nothing; with the 1110 contract installed the seat deny lands on every table', async () => {
    await db.exec(`
      create or replace function core.is_projects_only_seat() returns boolean
      language sql stable security definer set search_path = core, public, pg_temp as $$
        select coalesce(current_setting('test.projects_only_seat', true), '') = 'on'
      $$;
      grant execute on function core.is_projects_only_seat() to authenticated, service_role;
      create or replace function core.apply_projects_only_seat_deny(p_table regclass) returns void
      language plpgsql set search_path = core, public, pg_temp as $$
      begin
        execute format('drop policy if exists projects_only_seat_deny on %s', p_table);
        execute format('create policy projects_only_seat_deny on %s as restrictive for all to authenticated '
                       'using (not (select core.is_projects_only_seat())) with check (not (select core.is_projects_only_seat()))', p_table);
      end $$;
    `);
    const before = await db.query<{ n: number }>(`select count(*)::int as n from public.cash_forecast_scenarios`);
    await applyMigrationFile(db, FILE_192);
    const after = await db.query<{ n: number }>(`select count(*)::int as n from public.cash_forecast_scenarios`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const { rows } = await db.query<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public' and policyname = 'projects_only_seat_deny' and tablename = any($1::text[]) order by 1`,
      [TABLES],
    );
    expect(rows.map((r) => r.tablename)).toEqual(TABLES);
    const member = await db.query<{ policyname: string }>(`select policyname from pg_policies where schemaname = 'public' and tablename = 'cash_settings' order by 1`);
    expect(member.rows.map((r) => r.policyname)).toEqual(['client_scope_rls', 'member_read', 'projects_only_seat_deny', 'service_all']);
  });

  it('the trigger function is not callable by members (M1)', async () => {
    const { rows } = await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', 'public.cash_forecast_append_only()', 'execute') as ok`);
    expect(rows[0].ok).toBe(false);
  });
});
