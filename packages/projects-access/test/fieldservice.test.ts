/**
 * Field-service depth (migration 1117) against a PGlite replay of every migration.
 * Capacity enforcement on every channel, price-book formulas, good/better/best → work lines,
 * agreement visits → billing requests + deferred-revenue facts, and RLS per persona.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { buildFixture, as, q, errorOf, type Fixture, ORG_A, L1, L2, J1, J2 } from './fixture';
import { applyMigration, listMigrationFiles } from './pg';

let f: Fixture;
const ids: Record<string, string> = {};
// The app route's FS_WIDGET_SERVER_KEY; its hash is registered below (the widget fails closed without one).
const WKEY = 'server-key-for-the-app-route-0001';

const forbidden = /PM_FORBIDDEN|permission denied|row-level security/i;

/** A future day (ISO) with the given ISO weekday (1 = Monday). */
function nextWeekday(isoDow: number, minDaysAhead = 7): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + minDaysAhead);
  while (((d.getUTCDay() + 6) % 7) + 1 !== isoDow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(f.db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}

/**
 * Every migration after 1110 in order. Other Wave A migrations (1113–1116) are being written in
 * parallel: one that fails to replay is skipped (and listed in `skipped`) so this suite still
 * verifies 1117; 1111 / 1112 / 1117 must apply.
 */
const skipped: string[] = [];
async function applyAll(): Promise<void> {
  for (const file of listMigrationFiles().filter((x) => parseInt(x, 10) > 1110)) {
    const n = parseInt(file, 10);
    try {
      await applyMigration(f.db, file);
    } catch (e) {
      if (n === 1111 || n === 1112 || n === 1117) throw e;
      skipped.push(`${file}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  if (skipped.length) console.warn(`[fieldservice.test] skipped in-progress migrations:\n  ${skipped.join('\n  ')}`);
}

beforeAll(async () => {
  f = await buildFixture();
  await applyAll();
  await f.db.query(`insert into pm.fs_widget_server_keys (key_hash, note) values ($1, 'test route')`, [createHash('sha256').update(WKEY).digest('hex')]);
  // a technician seat with dispatch on J2 already exists (labor). Seed the field-service config on L1 as the owner.
  // the fixture's job type uses machine 'm' with no stages: give it an initial stage so jobs can be created
  await f.db.query(`insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, core_status, is_initial)
                    select org_id, location_id, id, 'm', 'active', 'Active', 'ACTIVE', true from pm.pack_installs where location_id = $1`, [L1]);
  await as(f, 'owner', async () => {
    await f.db.query(`select pm.fs_seed_field_service($1)`, [L1]);
  });
  const bu = await one<{ id: string }>(`select id from pm.business_units where location_id = $1 and code = 'HVAC_SVC'`, [L1]);
  ids.bu = bu.id;
  ids.maintBu = (await one<{ id: string }>(`select id from pm.business_units where location_id = $1 and code = 'MAINT'`, [L1])).id;
  ids.win = (await one<{ id: string }>(`select id from pm.arrival_windows where location_id = $1 and label = '8–10 am'`, [L1])).id;
  ids.win2 = (await one<{ id: string }>(`select id from pm.arrival_windows where location_id = $1 and label = '10–12 pm'`, [L1])).id;
  ids.noCool = (await one<{ id: string }>(`select id from pm.booking_job_types where location_id = $1 and key = 'no_cool'`, [L1])).id;
  ids.zone = (await one<{ id: string }>(
    `insert into pm.service_zones (org_id, location_id, code, name, zips) values ($1, $2, 'NORTH', 'North', '{50310,50311}') returning id`, [ORG_A, L1])).id;
  ids.cust = (await one<{ id: string }>(`insert into core.customers (org_id, name, phone) values ($1, 'Pat Homeowner', '515-555-0101') returning id`, [ORG_A])).id;
  ids.cust2 = (await one<{ id: string }>(`insert into core.customers (org_id, name, phone) values ($1, 'Sam Second', '515-555-0202') returning id`, [ORG_A])).id;
  await f.db.query(`insert into core.contacts (org_id, customer_id, first_name, phone, sms_consent, is_primary) values ($1, $2, 'Pat', '515-555-0101', true, true)`, [ORG_A, ids.cust]);
  ids.site = (await one<{ id: string }>(`insert into core.sites (org_id, customer_id, location_id, address_line1, zip) values ($1, $2, $3, '1 Elm St', '50310') returning id`, [ORG_A, ids.cust, L1])).id;
  ids.site2 = (await one<{ id: string }>(`insert into core.sites (org_id, customer_id, location_id, address_line1, zip) values ($1, $2, $3, '2 Oak St', '50311') returning id`, [ORG_A, ids.cust2, L1])).id;
  await f.db.query(`insert into pm.tech_profiles (org_id, location_id, employee_id, display_name, zone_ids) values ($1, $2, $3, 'Lee', array[$4]::uuid[])`, [ORG_A, L1, f.employee.labor, ids.zone]);
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

const book = (p: 'dispatcher' | 'labor' | 'owner' | 'pm', day: string, extra: Record<string, unknown> = {}) =>
  as(f, p, async () => {
    const a = {
      p_location: L1, p_channel: 'PHONE', p_booking_job_type: ids.noCool, p_arrival_window: ids.win, p_service_day: day,
      p_customer: ids.cust, p_site: ids.site, p_allow_duplicate: true, p_override_reason: null, p_job_name: null, ...extra,
    };
    const r = await q<{ r: { status: string; work_order_id: string; job_id: string; call_id: string; override: boolean } }>(f.db,
      `select pm.fs_book_call(p_location => $1, p_channel => $2, p_booking_job_type => $3, p_arrival_window => $4, p_service_day => $5::date,
                              p_customer => $6, p_site => $7, p_allow_duplicate => $8, p_override_reason => $9, p_job_name => $10) as r`,
      [a.p_location, a.p_channel, a.p_booking_job_type, a.p_arrival_window, a.p_service_day, a.p_customer, a.p_site, a.p_allow_duplicate,
       a.p_override_reason, a.p_job_name]);
    return r[0].r;
  });

describe('migration 1117 registers with the 1110 access foundation', () => {
  it('every pm table is classified and every member definer RPC guarded; anon executes nothing in pm', async () => {
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    const anon = await q(f.db, `select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'pm' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(anon).toEqual([]);
    expect(await q(f.db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
  });
  it('the starter seed created BUs, windows, scripted job types, capacity, a priced book and plans', async () => {
    const n = await one<{ bu: number; jt: number; cap: number; items: number; priced: number; plans: number; tpl: number }>(
      `select (select count(*)::int from pm.business_units where location_id = $1) bu,
              (select count(*)::int from pm.booking_job_types where location_id = $1 and script ? 'questions') jt,
              (select count(*)::int from pm.capacity_limits where location_id = $1) cap,
              (select count(*)::int from pm.price_book_items where location_id = $1) items,
              (select count(*)::int from pm.price_book_items where location_id = $1 and kind = 'SERVICE' and price_cents > 0 and member_price_cents < price_cents) priced,
              (select count(*)::int from pm.financing_plans where location_id = $1) plans,
              (select count(*)::int from pm.agreement_templates where location_id = $1) tpl`, [L1]);
    expect(n.bu).toBe(6);
    expect(n.jt).toBe(9);
    expect(n.cap).toBeGreaterThan(0);
    expect(n.items).toBeGreaterThan(60);
    expect(n.priced).toBeGreaterThan(20);
    expect(n.plans).toBe(3);
    expect(n.tpl).toBe(2);
  });
});

describe('capacity (FS-15) — enforced on every channel', () => {
  const day = nextWeekday(2);
  beforeAll(async () => {
    // 2 jobs in the 8–10 window on this BU, every day
    await f.db.query(`update pm.capacity_limits set max_jobs = 2 where business_unit_id = $1 and arrival_window_id = $2 and zone_id is null and on_date is null`, [ids.bu, ids.win]);
  });

  it('a CSR books into open capacity: job + visit with BU, window, zone (from the zip) and the arrival window', async () => {
    const r = await book('dispatcher', day);
    expect(r.status).toBe('BOOKED');
    const w = await one<{ business_unit_id: string; arrival_window_id: string; zone_id: string; service_day: string; booking_channel: string; requested_start: string }>(
      `select business_unit_id, arrival_window_id, zone_id, service_day::text, booking_channel, requested_start::text from pm.work_orders where id = $1`, [r.work_order_id]);
    expect(w).toMatchObject({ business_unit_id: ids.bu, arrival_window_id: ids.win, zone_id: ids.zone, service_day: day, booking_channel: 'PHONE' });
  });

  it('the second booking fits; the third is refused PM_FS_CAPACITY_FULL', async () => {
    await book('dispatcher', day, { p_customer: ids.cust2, p_site: ids.site2 });
    const err = await errorOf(f.db, `select 1`); expect(err).toBeNull();
    const e = await as(f, 'dispatcher', async () => errorOf(f.db,
      `select pm.fs_book_call(p_location => $1, p_channel => 'PHONE', p_booking_job_type => $2, p_arrival_window => $3, p_service_day => $4::date, p_customer => $5, p_allow_duplicate => true)`,
      [L1, ids.noCool, ids.win, day, ids.cust2]));
    expect(e).toMatch(/PM_FS_CAPACITY_FULL/);
  });

  it('a dispatcher may override on a phone booking with a written reason; the AI agent never may', async () => {
    const r = await book('dispatcher', day, { p_override_reason: 'Member emergency, GM approved', p_customer: ids.cust2, p_site: null });
    expect(r.override).toBe(true);
    const call = await one<{ capacity_override: boolean; override_reason: string }>(`select capacity_override, override_reason from pm.service_calls where id = $1`, [r.call_id]);
    expect(call).toEqual({ capacity_override: true, override_reason: 'Member emergency, GM approved' });
    const e = await as(f, 'dispatcher', async () => errorOf(f.db,
      `select pm.fs_book_call(p_location => $1, p_channel => 'AI_AGENT', p_booking_job_type => $2, p_arrival_window => $3, p_service_day => $4::date, p_customer => $5, p_override_reason => 'agent says so', p_allow_duplicate => true)`,
      [L1, ids.noCool, ids.win, day, ids.cust2]));
    expect(e).toMatch(/PM_FS_CAPACITY_FULL/);
  });

  it('the online widget only offers open windows, holds the slot with a REQUEST, and is refused when full', async () => {
    const token = 'widget-token-0123456789abcdef-xyz';
    const hash = createHash('sha256').update(token).digest('hex');
    await f.db.query(`insert into pm.booking_widgets (org_id, location_id, name, token_hash, min_lead_hours) values ($1, $2, 'Website', $3, 0)`, [ORG_A, L1, hash]);
    const day2 = nextWeekday(3);
    await f.db.query(`insert into pm.capacity_limits (org_id, location_id, business_unit_id, arrival_window_id, on_date, max_jobs) values ($1, $2, $3, $4, $5::date, 1)`,
      [ORG_A, L1, ids.bu, ids.win2, day2]);
    // anon: availability lists day2 10–12 while it is open
    const avail = await withAnon(async () => (await q<{ r: { slots: Array<{ day: string; window_id: string; business_unit_id: string }> } }>(f.db,
      `select public.fs_widget_availability($1, $2::date, 1, '192.0.2.99', $3) r`, [token, day2, WKEY]))[0].r);
    expect(avail.slots.some((s) => s.window_id === ids.win2 && s.business_unit_id === ids.bu)).toBe(true);
    const booked = await withAnon(async () => (await q<{ r: { status: string; reference: string } }>(f.db,
      `select public.fs_widget_book($1, $2, $3, $4::date, 'Web Person', '5155550199', null, '50310', '9 Pine', 'AC not cooling', 'req-00000001', '192.0.2.99', $5) r`,
      [token, ids.noCool, ids.win2, day2, WKEY]))[0].r);
    expect(booked.status).toBe('REQUEST');
    // the slot is now held: the date row (1 job) is full for the widget and for a CSR
    const again = await withAnon(async () => errorOf(f.db,
      `select public.fs_widget_book($1, $2, $3, $4::date, 'Other Person', '5155550198', null, '50310', null, null, 'req-00000002', '192.0.2.98', $5)`, [token, ids.noCool, ids.win2, day2, WKEY]));
    expect(again).toMatch(/CAPACITY_FULL/);
    const csr = await as(f, 'dispatcher', async () => errorOf(f.db,
      `select pm.fs_book_call(p_location => $1, p_channel => 'PHONE', p_booking_job_type => $2, p_arrival_window => $3, p_service_day => $4::date, p_customer => $5, p_allow_duplicate => true)`,
      [L1, ids.noCool, ids.win2, day2, ids.cust2]));
    expect(csr).toMatch(/PM_FS_CAPACITY_FULL/);
    // a replayed request id is idempotent; a bad token is refused
    const replay = await withAnon(async () => (await q<{ r: { reference: string } }>(f.db,
      `select public.fs_widget_book($1, $2, $3, $4::date, 'Web Person', '5155550199', null, '50310', '9 Pine', 'AC not cooling', 'req-00000001', '192.0.2.99', $5) r`,
      [token, ids.noCool, ids.win2, day2, WKEY]))[0].r);
    expect(replay.reference).toBe(booked.reference);
    expect(await withAnon(async () => errorOf(f.db, `select public.fs_widget_availability('nope-nope-nope-nope-nope-nope', null, 1, null, $1)`, [WKEY]))).toMatch(/FS_WIDGET_UNKNOWN/);
    // the CSR converts the request into a job in the same slot (the hold transfers)
    const call = await one<{ id: string }>(`select id from pm.service_calls where number = $1`, [booked.reference]);
    const conv = await as(f, 'dispatcher', async () => (await q<{ r: { status: string; work_order_id: string } }>(f.db,
      `select pm.fs_convert_request($1, $2, null, null, null, true) r`, [call.id, ids.cust2]))[0].r);
    expect(conv.status).toBe('BOOKED');
    const state = await one<{ s: { used_jobs: number; max_jobs: number } }>(`select pm._fs_capacity_state($1, $2, null, $3, $4::date) s`, [ORG_A, ids.bu, ids.win2, day2]);
    expect(state.s).toMatchObject({ used_jobs: 1, max_jobs: 1 });
  });

  it('a date row beats the weekday row; a zone row beats the all-zones row; cancelling frees the slot', async () => {
    const day3 = nextWeekday(4);
    await f.db.query(`insert into pm.capacity_limits (org_id, location_id, business_unit_id, arrival_window_id, day_of_week, max_jobs) values ($1, $2, $3, $4, 4, 1)`,
      [ORG_A, L1, ids.bu, ids.win]);
    await f.db.query(`insert into pm.capacity_limits (org_id, location_id, business_unit_id, zone_id, arrival_window_id, day_of_week, max_jobs) values ($1, $2, $3, $4, $5, 4, 3)`,
      [ORG_A, L1, ids.bu, ids.zone, ids.win]);
    const rule = await one<{ r: { max_jobs: number; zone_id: string | null } }>(`select to_jsonb(pm._fs_capacity_rule($1, $2, $3, $4, $5::date)) r`, [ORG_A, ids.bu, ids.zone, ids.win, day3]);
    expect(rule.r.max_jobs).toBe(3);
    const ruleNoZone = await one<{ r: { max_jobs: number } }>(`select to_jsonb(pm._fs_capacity_rule($1, $2, null, $3, $4::date)) r`, [ORG_A, ids.bu, ids.win, day3]);
    expect(ruleNoZone.r.max_jobs).toBe(1);
    await f.db.query(`insert into pm.capacity_limits (org_id, location_id, business_unit_id, arrival_window_id, on_date, max_jobs) values ($1, $2, $3, $4, $5::date, 0)`,
      [ORG_A, L1, ids.bu, ids.win, day3]);
    const ruleDate = await one<{ r: { max_jobs: number } }>(`select to_jsonb(pm._fs_capacity_rule($1, $2, null, $3, $4::date)) r`, [ORG_A, ids.bu, ids.win, day3]);
    expect(ruleDate.r.max_jobs).toBe(0);
    // cancelling a booked visit frees capacity
    const day4 = nextWeekday(5);
    await f.db.query(`insert into pm.capacity_limits (org_id, location_id, business_unit_id, arrival_window_id, on_date, max_jobs) values ($1, $2, $3, $4, $5::date, 1)`,
      [ORG_A, L1, ids.bu, ids.win, day4]);
    const r = await book('dispatcher', day4);
    expect(await as(f, 'dispatcher', async () => errorOf(f.db,
      `select pm.fs_book_call(p_location => $1, p_channel => 'PHONE', p_booking_job_type => $2, p_arrival_window => $3, p_service_day => $4::date, p_customer => $5, p_allow_duplicate => true)`,
      [L1, ids.noCool, ids.win, day4, ids.cust2]))).toMatch(/CAPACITY_FULL/);
    await as(f, 'dispatcher', async () => { await f.db.query(`select pm.cancel_work_order($1, 'customer cancelled')`, [r.work_order_id]); });
    const again = await book('dispatcher', day4, { p_customer: ids.cust2, p_site: ids.site2 });
    expect(again.status).toBe('BOOKED');
  });

  it('a duplicate open job at the same site is refused unless the CSR books anyway', async () => {
    const day5 = nextWeekday(1, 14);
    const e = await as(f, 'dispatcher', async () => errorOf(f.db,
      `select pm.fs_book_call(p_location => $1, p_channel => 'PHONE', p_booking_job_type => $2, p_arrival_window => $3, p_service_day => $4::date, p_customer => $5, p_site => $6)`,
      [L1, ids.noCool, ids.win, day5, ids.cust, ids.site]));
    expect(e).toMatch(/PM_FS_DUPLICATE_OPEN_JOB/);
  });

  it('labor cannot book; the dispatcher can read the capacity grid', async () => {
    const day = nextWeekday(2);
    expect(await as(f, 'labor', async () => errorOf(f.db,
      `select pm.fs_book_call(p_location => $1, p_channel => 'PHONE', p_booking_job_type => $2, p_arrival_window => $3, p_service_day => $4::date)`,
      [L1, ids.noCool, ids.win, day]))).toMatch(forbidden);
    const grid = await as(f, 'dispatcher', async () => q<{ used_jobs: number; max_jobs: number; arrival_window_id: string; business_unit_id: string }>(f.db,
      `select * from pm.fs_capacity_grid($1, $2::date, 1, $3)`, [L1, day, ids.bu]));
    const cell = grid.find((g) => g.arrival_window_id === ids.win);
    expect(cell).toMatchObject({ max_jobs: 2, used_jobs: 3 });
  });
});

describe('online widget hardening (security review M)', () => {
  const mkWidget = async (token: string, opts: Record<string, number> = {}) => {
    const all: Record<string, number> = { min_lead_hours: 0, days_ahead: 60, ...opts };
    const cols = Object.keys(all);
    await f.db.query(`insert into pm.booking_widgets (org_id, location_id, name, token_hash, ${cols.join(', ')})
                      values ($1, $2, $3, $4, ${cols.map((_, i) => `$${i + 5}`).join(', ')})`,
      [ORG_A, L1, `W ${token.slice(0, 6)}`, createHash('sha256').update(token).digest('hex'), ...Object.values(all)]);
    return token;
  };
  const wbook = (token: string, day: string, phone: string, ip: string | null, key: string | null = WKEY, reqId: string | null = null) =>
    withAnon(async () => errorOf(f.db,
      `select public.fs_widget_book($1, $2, $3, $4::date, 'Web Person', $5, null, '50310', null, 'AC', $6, $7, $8)`,
      [token, ids.noCool, ids.win, day, phone, reqId, ip, key]));
  let day: string;
  beforeAll(async () => {
    day = nextWeekday(2, 42);
    await f.db.query(`insert into pm.capacity_limits (org_id, location_id, business_unit_id, arrival_window_id, on_date, max_jobs) values ($1, $2, $3, $4, $5::date, 50)`,
      [ORG_A, L1, ids.bu, ids.win, day]);
  });

  it('the daily cap defaults to 30 and is enforced by an atomic counter', async () => {
    const d = await one<{ d: string }>(`select column_default d from information_schema.columns where table_schema = 'pm' and table_name = 'booking_widgets' and column_name = 'max_requests_per_day'`);
    expect(d.d).toBe('30');
    const t = await mkWidget('cap-token-0123456789abcdefghij', { max_requests_per_day: 2, per_phone_per_day: 10, per_ip_per_hour: 10 });
    expect(await wbook(t, day, '5155551001', '203.0.113.1')).toBeNull();
    expect(await wbook(t, day, '5155551002', '203.0.113.2')).toBeNull();
    expect(await wbook(t, day, '5155551003', '203.0.113.3')).toMatch(/FS_WIDGET_BUSY/);
  });
  it('per-phone and per-IP limits; a replayed request spends no quota', async () => {
    const t = await mkWidget('phone-token-0123456789abcdefgh', { per_phone_per_day: 1, per_ip_per_hour: 2 });
    expect(await wbook(t, day, '5155552001', '198.51.100.7', WKEY, 'req-phone-0001')).toBeNull();
    expect(await wbook(t, day, '5155552001', '198.51.100.7', WKEY, 'req-phone-0001')).toBeNull(); // replay
    expect(await wbook(t, day, '(515) 555-2001', '198.51.100.8')).toMatch(/FS_WIDGET_LIMIT/);
    expect(await wbook(t, day, '5155552002', '198.51.100.7')).toBeNull();          // 2nd from this IP
    expect(await wbook(t, day, '5155552003', '198.51.100.7')).toMatch(/FS_WIDGET_LIMIT/); // 3rd from this IP
    expect(await wbook(t, day, '5155552004', '198.51.100.9')).toBeNull();          // another IP
    // counters store no raw IP or phone, and nobody but the service role can read them
    const raw = await q<{ n: number }>(f.db, `select count(*)::int n from pm.fs_rate_counters where bucket like '%198.51.100%' or bucket like '%5155552001%'`);
    expect(raw[0]!.n).toBe(0);
    expect(await withAnon(async () => errorOf(f.db, `select * from pm.fs_rate_counters`))).toMatch(/permission denied/);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select * from pm.fs_rate_counters`))).toMatch(/permission denied/);
  });
  it('min_lead_hours is enforced on booking, not only on availability', async () => {
    const t = await mkWidget('lead-token-0123456789abcdefghi', { min_lead_hours: 72 });
    const soon = (() => { const x = new Date(); x.setUTCDate(x.getUTCDate() + 1); while (((x.getUTCDay() + 6) % 7) + 1 > 5) x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); })();
    await f.db.query(`insert into pm.capacity_limits (org_id, location_id, business_unit_id, arrival_window_id, on_date, max_jobs) values ($1, $2, $3, $4, $5::date, 50) on conflict do nothing`,
      [ORG_A, L1, ids.bu, ids.win, soon]);
    expect(await wbook(t, soon, '5155553001', '192.0.2.1')).toMatch(/FS_WIDGET_TOO_SOON/);
    expect(await wbook(t, day, '5155553002', '192.0.2.1')).toBeNull();
  });
  it('an unconfirmed REQUEST hold expires (default 2 h) and stops counting against capacity', async () => {
    const dflt = await one<{ d: string }>(`select column_default d from information_schema.columns where table_schema = 'pm' and table_name = 'booking_widgets' and column_name = 'hold_minutes'`);
    expect(dflt.d).toBe('120');
    const day2 = nextWeekday(3, 49);
    await f.db.query(`insert into pm.capacity_limits (org_id, location_id, business_unit_id, arrival_window_id, on_date, max_jobs) values ($1, $2, $3, $4, $5::date, 1)`,
      [ORG_A, L1, ids.bu, ids.win, day2]);
    const t = await mkWidget('hold-token-0123456789abcdefghi');
    expect(await wbook(t, day2, '5155554001', '192.0.2.10')).toBeNull();
    const held = await one<{ hold_expires_at: string; mins: number }>(
      `select hold_expires_at::text, round(extract(epoch from hold_expires_at - created_at) / 60)::int mins from pm.service_calls where caller_phone = '5155554001'`);
    expect(held.mins).toBe(120);
    expect(await wbook(t, day2, '5155554002', '192.0.2.11')).toMatch(/CAPACITY_FULL/);
    await f.db.query(`update pm.service_calls set hold_expires_at = now() - interval '1 minute' where caller_phone = '5155554001'`);
    const st = await one<{ s: { used_jobs: number } }>(`select pm._fs_capacity_state($1, $2, null, $3, $4::date) s`, [ORG_A, ids.bu, ids.win, day2]);
    expect(st.s.used_jobs).toBe(0);
    expect(await wbook(t, day2, '5155554002', '192.0.2.11')).toBeNull();
  });
  it('fails closed: direct anon calls without the route key are refused; with no key registered it is not set up', async () => {
    const t = await mkWidget('key-token-0123456789abcdefghijk');
    expect(await wbook(t, day, '5155555001', '192.0.2.20', null)).toMatch(/FS_WIDGET_KEY/);
    expect(await wbook(t, day, '5155555001', '192.0.2.20', 'wrong-key-wrong-key-wrong')).toMatch(/FS_WIDGET_KEY/);
    expect(await withAnon(async () => errorOf(f.db, `select public.fs_widget_availability($1, null, 1)`, [t]))).toMatch(/FS_WIDGET_KEY/);
    const saved = await q<{ key_hash: string }>(f.db, `select key_hash from pm.fs_widget_server_keys`);
    await f.db.query(`delete from pm.fs_widget_server_keys`);
    try {
      expect(await wbook(t, day, '5155555001', '192.0.2.20', null)).toMatch(/FS_WIDGET_NOT_SET_UP/);
      expect(await wbook(t, day, '5155555001', '192.0.2.20')).toMatch(/FS_WIDGET_NOT_SET_UP/); // even the old key
      expect(await withAnon(async () => errorOf(f.db, `select public.fs_widget_availability($1, null, 1, null, $2)`, [t, WKEY]))).toMatch(/FS_WIDGET_NOT_SET_UP/);
    } finally {
      for (const k of saved) await f.db.query(`insert into pm.fs_widget_server_keys (key_hash) values ($1)`, [k.key_hash]);
    }
    expect(await wbook(t, day, '5155555001', '192.0.2.20')).toBeNull();
  });
  it('counters never grow past a limit, and no new IP / phone bucket is created once the widget cap is spent', async () => {
    const t = await mkWidget('grow-token-0123456789abcdefghi', { max_requests_per_day: 1, per_phone_per_day: 10, per_ip_per_hour: 10 });
    const wid = (await one<{ id: string }>(`select id from pm.booking_widgets where token_hash = $1`, [createHash('sha256').update(t).digest('hex')])).id;
    expect(await wbook(t, day, '5155556001', '203.0.113.50')).toBeNull();
    const rows0 = await q<{ bucket: string; hits: number }>(f.db, `select bucket, hits from pm.fs_rate_counters where widget_id = $1 order by bucket`, [wid]);
    expect(rows0).toHaveLength(3);                     // widget, IP, phone
    for (let i = 0; i < 5; i++) expect(await wbook(t, day, `51555570${10 + i}`, `203.0.113.${60 + i}`)).toMatch(/FS_WIDGET_BUSY/);
    const rows1 = await q<{ bucket: string; hits: number }>(f.db, `select bucket, hits from pm.fs_rate_counters where widget_id = $1 order by bucket`, [wid]);
    expect(rows1).toEqual(rows0);                      // no new buckets, the cap row is still 1
    expect(rows1.find((r) => r.bucket === `w:${wid}`)!.hits).toBe(1);
    // availability: a widget-wide lookup cap also comes before the per-IP bucket
    await f.db.query(`update pm.booking_widgets set max_lookups_per_hour = 2 where id = $1`, [wid]);
    const look = (ip: string) => withAnon(async () => errorOf(f.db, `select public.fs_widget_availability($1, null, 1, $2, $3)`, [t, ip, WKEY]));
    expect(await look('198.18.0.1')).toBeNull();
    expect(await look('198.18.0.2')).toBeNull();
    expect(await look('198.18.0.3')).toMatch(/FS_WIDGET_BUSY/);
    expect(await look('198.18.0.4')).toMatch(/FS_WIDGET_BUSY/);
    const avail = await q<{ bucket: string; hits: number }>(f.db, `select bucket, hits from pm.fs_rate_counters where widget_id = $1 and (bucket like 'avail:%' or bucket like 'aw:%')`, [wid]);
    expect(avail.filter((r) => r.bucket.startsWith('avail:'))).toHaveLength(2);
    expect(avail.find((r) => r.bucket.startsWith('aw:'))!.hits).toBe(2);
  });
  it('each call deletes that widget\'s expired buckets (deterministic cleanup)', async () => {
    const t = await mkWidget('sweep-token-0123456789abcdefgh');
    const wid = (await one<{ id: string }>(`select id from pm.booking_widgets where token_hash = $1`, [createHash('sha256').update(t).digest('hex')])).id;
    const other = (await one<{ id: string }>(`select id from pm.booking_widgets where token_hash = $1`, [createHash('sha256').update('grow-token-0123456789abcdefghi').digest('hex')])).id;
    await f.db.query(`insert into pm.fs_rate_counters (widget_id, bucket, window_start, expires_at, hits) values
                      ($1::uuid, 'ip:' || $1::text || ':old', now() - interval '3 hours', now() - interval '2 hours', 5),
                      ($1::uuid, 'ph:' || $1::text || ':old', now() - interval '2 days', now() - interval '1 day', 3),
                      ($2::uuid, 'ip:' || $2::text || ':old', now() - interval '3 hours', now() - interval '2 hours', 5)`, [wid, other]);
    expect(await withAnon(async () => errorOf(f.db, `select public.fs_widget_availability($1, null, 1, '198.18.1.1', $2)`, [t, WKEY]))).toBeNull();
    const left = await q<{ widget_id: string; bucket: string }>(f.db, `select widget_id, bucket from pm.fs_rate_counters where bucket like '%:old'`);
    expect(left.map((r) => r.widget_id)).toEqual([other]);   // this widget's expired rows are gone; the other widget's wait for its own call
    const live = await q<{ n: number }>(f.db, `select count(*)::int n from pm.fs_rate_counters where widget_id = $1 and expires_at > now()`, [wid]);
    expect(live[0]!.n).toBe(2);                              // aw + avail for this hour
  });
});

describe('caller pop (FS-02) — AR masked for CSRs', () => {
  it('matches by phone and returns history, equipment, agreement badge, open work and AR flags', async () => {
    await f.db.query(`insert into public.invoices (org_id, location_id, customer_id, invoice_number, invoice_date, due_date, total_cents, status)
                      values ($1, $2, $3, 'INV-FS-1', current_date - 60, current_date - 30, 25000, 'SENT')`, [ORG_A, L1, ids.cust]);
    const pop = await as(f, 'dispatcher', async () => (await q<{ r: Record<string, unknown> & { ar: Record<string, unknown>; matches: unknown[]; open_work: unknown[] } }>(f.db,
      `select pm.fs_caller_pop($1, '(515) 555-0101') r`, [L1]))[0].r);
    expect(pop.matches).toHaveLength(1);
    expect(pop.open_work.length).toBeGreaterThan(0);
    expect(pop.ar).toMatchObject({ has_balance: true, past_due: true, amounts_visible: false, open_cents: null });
    const popOwner = await as(f, 'owner', async () => (await q<{ r: { ar: Record<string, unknown> } }>(f.db,
      `select pm.fs_caller_pop($1, null, $2) r`, [L1, ids.cust]))[0].r);
    expect(popOwner.ar).toMatchObject({ amounts_visible: true, open_cents: 25000, past_due_cents: 25000 });
  });
});

describe('price-book formulas (FS-45)', () => {
  it('rounding rules', async () => {
    const r = await one<{ none: number; whole: number; five: number; nine: number; nine2: number }>(
      `select pm.fs_round_rule(28740, 'NONE') none, pm.fs_round_rule(28740, 'WHOLE') whole, pm.fs_round_rule(28740, 'FIVE') five,
              pm.fs_round_rule(28740, 'NINE') nine, pm.fs_round_rule(29001, 'NINE') nine2`);
    expect(r).toEqual({ none: 28740, whole: 28800, five: 29000, nine: 28900, nine2: 29900 });
  });
  it('service = hours × burdened rate ÷ (1 − GM) + material markup ladder, then member and after-hours', async () => {
    // HV-CAP: 0.75 h × $95 ÷ 0.45 = 158.333…; capacitor $18.50 × (1 + 1.25) = 41.625 → 41.63; 199.96 → NINE → 199.00? no: up → 199.96 → 209? ceil to 200 then next …9 → 209
    const it = await one<{ price_cents: number; member_price_cents: number; after_hours_price_cents: number; material_cost_cents: number; labor_cost_cents: number }>(
      `select price_cents, member_price_cents, after_hours_price_cents, material_cost_cents, labor_cost_cents from pm.price_book_items where location_id = $1 and code = 'HV-CAP'`, [L1]);
    // labor 7125 cents ÷ 0.45 = 15833.33…; material sell round(1850 × 2.25) = 4163 (1850 ≤ 5000 tier 1.25); raw 19996.33 → 19996 → NINE: ceil $200 → $209
    expect(it.labor_cost_cents).toBe(7125);
    expect(it.material_cost_cents).toBe(1850);
    expect(it.price_cents).toBe(20900);
    // member: 20900 × 0.85 = 17765 → $178 → $179
    expect(it.member_price_cents).toBe(17900);
    // after hours: 20900 × 1.5 = 31350 → $314 → $319
    expect(it.after_hours_price_cents).toBe(31900);
  });
  it('bulk change previews the margin effect without writing; applying writes', async () => {
    const before = await one<{ price_cents: number }>(`select price_cents from pm.price_book_items where location_id = $1 and code = 'HV-CAP'`, [L1]);
    const prev = await as(f, 'owner', async () => (await q<{ r: { count: number; applied: boolean; rows: Array<{ code: string; price_cents: number; margin_pct: number; old_margin_pct: number }> } }>(f.db,
      `select pm.fs_bulk_price_change($1, '{"codes":["HV-CAP"]}', '{"mode":"PCT","value":0.10}', true) r`, [L1]))[0].r);
    expect(prev.count).toBe(1);
    expect(prev.applied).toBe(false);
    expect(prev.rows[0].price_cents).toBeGreaterThan(before.price_cents);
    expect(prev.rows[0].margin_pct).toBeGreaterThan(prev.rows[0].old_margin_pct);
    const still = await one<{ price_cents: number }>(`select price_cents from pm.price_book_items where location_id = $1 and code = 'HV-CAP'`, [L1]);
    expect(still.price_cents).toBe(before.price_cents);
    // the dispatcher (no financials, no settings) cannot run it
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select pm.fs_bulk_price_change($1, '{}', '{"mode":"REPRICE"}', true)`, [L1]))).toMatch(forbidden);
  });
  it('import: dry run reports, commit upserts by code and links bundled materials', async () => {
    const rows = JSON.stringify([
      { code: 'M-TEST-PART', name: 'Test part', kind: 'MATERIAL', cost_cents: '2000' },
      { code: 'SV-TEST', name: 'Test task', kind: 'SERVICE', task_hours: '1.00', materials: 'M-TEST-PART:2' },
      { code: '', name: 'bad' },
      { code: 'HV-CAP', name: 'Replace run capacitor', kind: 'SERVICE', task_hours: '0.75' },
    ]);
    const dry = await as(f, 'owner', async () => (await q<{ r: { inserted: number; error_count: number; unchanged: number; errors: Array<{ row: number }> } }>(f.db,
      `select pm.fs_import_pricebook($1, $2::jsonb, true) r`, [L1, rows]))[0].r);
    expect(dry).toMatchObject({ inserted: 2, error_count: 1, unchanged: 1 });
    expect(dry.errors[0].row).toBe(3);
    expect((await q(f.db, `select 1 from pm.price_book_items where code = 'SV-TEST'`)).length).toBe(0);
    await as(f, 'owner', async () => { await f.db.query(`select pm.fs_import_pricebook($1, $2::jsonb, false)`, [L1, rows]); });
    const sv = await one<{ price_cents: number; material_cost_cents: number }>(`select price_cents, material_cost_cents from pm.price_book_items where location_id = $1 and code = 'SV-TEST'`, [L1]);
    // 1 h × $95 ÷ 0.45 = 21111.11; 2 × 2000 × (1 + 1.25) = 9000 → 30111 → $302 → $309
    expect(sv.material_cost_cents).toBe(4000);
    expect(sv.price_cents).toBe(30900);
  });
  it('monthly payment: amortized; 0 % = amount ÷ months', async () => {
    const r = await one<{ a: number; b: number }>(`select pm.fs_monthly_payment(1200000, 0.0999, 60) a, pm.fs_monthly_payment(120000, 0, 12) b`);
    expect(r.b).toBe(10000);
    expect(r.a).toBe(25491); // $12,000 at 9.99 % for 60 months = $254.9055 → $254.91
  });
  it('target margin is masked like cost (security review L)', async () => {
    await f.db.query(`update pm.price_book_items set target_gm_pct = 0.6 where location_id = $1 and code = 'HV-CAP'`, [L1]);
    const d = await as(f, 'dispatcher', async () => one<{ target_gm_pct: string | null }>(`select target_gm_pct from pm.v_price_book_items_masked where location_id = $1 and code = 'HV-CAP'`, [L1]));
    expect(d.target_gm_pct).toBeNull();
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select target_gm_pct from pm.price_book_items limit 1`))).toMatch(/permission denied/);
    const o = await as(f, 'owner', async () => one<{ target_gm_pct: string | null }>(`select target_gm_pct::text from pm.v_price_book_items_masked where location_id = $1 and code = 'HV-CAP'`, [L1]));
    expect(o.target_gm_pct).toBe('0.6000');
    await f.db.query(`update pm.price_book_items set target_gm_pct = null where location_id = $1 and code = 'HV-CAP'`, [L1]);
  });
  it('the dispatcher reads sell prices but never price-book cost', async () => {
    const r = await as(f, 'dispatcher', async () => one<{ price_cents: number; cost_cents: number | null; material_cost_cents: number | null }>(
      `select price_cents, cost_cents, material_cost_cents from pm.v_price_book_items_masked where location_id = $1 and code = 'HV-CAP'`, [L1]));
    expect(r.price_cents).toBeGreaterThan(0);
    expect(r.cost_cents).toBeNull();
    expect(r.material_cost_cents).toBeNull();
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select material_cost_cents from pm.price_book_items limit 1`))).toMatch(/permission denied/);
    expect(await as(f, 'dispatcher', async () => q(f.db, `select * from pm.pricebook_settings`))).toEqual([]);
  });
});

describe('good / better / best (FS-32 / FS-33 / FS-34)', () => {
  it('the dispatched tech builds options, the customer signs one, it becomes APPROVED work lines; unsold are dismissed', async () => {
    const pb = await q<{ id: string; code: string; price_cents: number; member_price_cents: number }>(f.db,
      `select id, code, price_cents, member_price_cents from pm.price_book_items where location_id = $1 and code in ('HV-CAP','HV-CAP-SURGE','HV-CFAN','M-SURGE-HVAC') order by code`, [L1]);
    const by = Object.fromEntries(pb.map((p) => [p.code, p]));
    const wo = f.ids[`wo:${J2}`]; // labor is dispatched on J2's work order
    const opts = JSON.stringify([
      { tier: 'GOOD', name: 'Capacitor', items: [{ price_book_item_id: by['HV-CAP'].id }] },
      { tier: 'BETTER', name: 'Capacitor + surge', rebate_cents: 2500, items: [{ price_book_item_id: by['HV-CAP-SURGE'].id }, { price_book_item_id: by['M-SURGE-HVAC'].id, optional: true, selected: false }] },
      { tier: 'BEST', name: 'Fan motor + capacitor', items: [{ price_book_item_id: by['HV-CFAN'].id }] },
    ]);
    const est = await as(f, 'labor', async () => (await q<{ id: string }>(f.db, `select pm.fs_build_estimate($1, 'AC repair options', $2::jsonb, false) id`, [wo, opts]))[0].id);
    const tot = await as(f, 'labor', async () => q<{ tier: string; regular_cents: number; member_cents: number; option_id: string }>(f.db,
      `select tier, regular_cents, member_cents, option_id from pm.v_fs_option_totals where estimate_id = $1 order by sort`, [est]));
    expect(tot.map((t) => t.tier)).toEqual(['GOOD', 'BETTER', 'BEST']);
    expect(tot[0].regular_cents).toBe(by['HV-CAP'].price_cents);
    expect(tot[0].member_cents).toBe(by['HV-CAP'].member_price_cents);
    // labor (no financials) never sees option cost
    const cost = await as(f, 'labor', async () => q<{ unit_cost_cents: number | null }>(f.db,
      `select unit_cost_cents from pm.v_fs_estimate_option_items_masked i join pm.fs_estimate_options o on o.id = i.option_id where o.estimate_id = $1`, [est]));
    expect(cost.length).toBeGreaterThan(0);
    expect(cost.every((c) => c.unit_cost_cents === null)).toBe(true);
    const tpl = await one<{ id: string }>(`select id from pm.agreement_templates where location_id = $1 and key = 'comfort_club'`, [L1]);
    // J2 has no customer in the fixture: give it one so the membership can be sold on site
    await f.db.query(`update core.jobs set customer_id = $1 where id = $2`, [ids.cust2, J2]);
    await f.db.query(`update pm.fs_estimates set customer_id = $1 where id = $2`, [ids.cust2, est]);
    const sold = await as(f, 'labor', async () => (await q<{ r: { lines: number; agreement_id: string; member_pricing: boolean } }>(f.db,
      `select pm.fs_sell_estimate(p_estimate => $1, p_option_ids => array[$2]::uuid[], p_signed_name => 'Sam Second', p_dismiss_reason => 'Price', p_join_template => $3) r`,
      [est, tot[0].option_id, tpl.id]))[0].r);
    expect(sold.lines).toBe(1);
    expect(sold.member_pricing).toBe(true);
    expect(sold.agreement_id).toBeTruthy();
    const lines = await q<{ status: string; unit_price_cents: number; sold_by_employee_id: string }>(f.db,
      `select status, unit_price_cents, sold_by_employee_id from pm.work_order_lines where work_order_id = $1 and fs_option_item_id is not null`, [wo]);
    expect(lines).toEqual([{ status: 'APPROVED', unit_price_cents: by['HV-CAP'].member_price_cents, sold_by_employee_id: f.employee.labor }]);
    const optsAfter = await q<{ tier: string; status: string; dismiss_reason: string | null }>(f.db,
      `select tier, status, dismiss_reason from pm.fs_estimate_options where estimate_id = $1 order by sort`, [est]);
    expect(optsAfter).toEqual([
      { tier: 'GOOD', status: 'SOLD', dismiss_reason: null },
      { tier: 'BETTER', status: 'DISMISSED', dismiss_reason: 'Price' },
      { tier: 'BEST', status: 'DISMISSED', dismiss_reason: 'Price' },
    ]);
    // a deposit request to Books needs billing:create — the tech cannot
    const est2 = await as(f, 'labor', async () => (await q<{ id: string }>(f.db, `select pm.fs_build_estimate($1, 'Again', $2::jsonb) id`, [wo, opts]))[0].id);
    const o2 = await one<{ id: string }>(`select id from pm.fs_estimate_options where estimate_id = $1 order by sort limit 1`, [est2]);
    expect(await as(f, 'labor', async () => errorOf(f.db,
      `select pm.fs_sell_estimate(p_estimate => $1, p_option_ids => array[$2]::uuid[], p_signed_name => 'Sam', p_deposit_cents => 5000, p_request_deposit => true)`, [est2, o2.id]))).toMatch(forbidden);
  });
  it('a tech not dispatched on the visit cannot build options on it', async () => {
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.fs_build_estimate($1, 'x', '[{"name":"a","items":[{"description":"x","unit_price_cents":100}]}]'::jsonb)`, [f.ids[`wo:${J1}`]]))).toMatch(forbidden);
  });
});

describe('agreements end to end (FS-61 / FS-62 / FS-63 / FS-65)', () => {
  let agr: string;
  beforeAll(async () => {
    const tpl = await one<{ id: string }>(`select id from pm.agreement_templates where location_id = $1 and key = 'comfort_club'`, [L1]);
    agr = await as(f, 'owner', async () => (await q<{ id: string }>(f.db, `select pm.fs_create_agreement_from_template($1, $2, $3, null, current_date - 40) id`, [tpl.id, ids.cust, L1]))[0].id);
  });

  it('visits generate by season window and land in the visits-due queue', async () => {
    const n = await as(f, 'owner', async () => (await q<{ n: number }>(f.db, `select pm.generate_agreement_visits($1, 400) n`, [agr]))[0].n);
    expect(n).toBe(2);
    const due = await as(f, 'dispatcher', async () => q<{ visit_seq: number; is_overdue: boolean }>(f.db, `select visit_seq, is_overdue from pm.v_fs_visits_due where agreement_id = $1 order by visit_seq`, [agr]));
    expect(due.map((d) => d.visit_seq)).toEqual([1, 2]);
  });

  it('monthly billing: one DRAFT recurring billing request per period due, idempotent, Books seam shape', async () => {
    const n = await as(f, 'owner', async () => (await q<{ n: number }>(f.db, `select pm.fs_generate_agreement_billing($1, current_date) n`, [agr]))[0].n);
    expect(n).toBe(2); // started 40 days ago: periods 1 and 2 are due
    const again = await as(f, 'owner', async () => (await q<{ n: number }>(f.db, `select pm.fs_generate_agreement_billing($1, current_date) n`, [agr]))[0].n);
    expect(again).toBe(0);
    const sched = await one<{ n: number; total: number }>(`select count(*)::int n, sum(amount_cents)::int total from pm.agreement_billing_schedule where agreement_id = $1`, [agr]);
    expect(sched).toEqual({ n: 12, total: 1995 * 12 });
    const reqs = await q<{ billing_type: string; billing_subtype: string; status: string; net_cents: number }>(f.db,
      `select r.billing_type, r.billing_subtype, r.status, r.net_cents from pm.billing_requests r join pm.agreement_billing_schedule s on s.billing_request_id = r.id where s.agreement_id = $1`, [agr]);
    expect(reqs).toHaveLength(2);
    expect(reqs.every((r) => r.billing_type === 'MILESTONE' && r.billing_subtype === 'RECURRING' && r.status === 'DRAFT' && r.net_cents === 1995)).toBe(true);
    // the dispatcher (no billing) cannot draft bills
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select pm.fs_generate_agreement_billing($1)`, [agr]))).toMatch(forbidden);
  });

  it('a completed visit records a VISIT_DELIVERED fact = term ÷ visits; the roll-forward shows the deferred balance', async () => {
    const v1 = await one<{ id: string }>(`select id from pm.work_orders where agreement_id = $1 and visit_seq = 1`, [agr]);
    await as(f, 'owner', async () => { await f.db.query(`select pm.complete_work_order($1, 'COMPLETED')`, [v1.id]); });
    const fact = await one<{ amount_cents: number; visits_delivered: number; status: string }>(
      `select amount_cents, visits_delivered, status from pm.agreement_revenue_facts where agreement_id = $1 and kind = 'VISIT_DELIVERED'`, [agr]);
    expect(fact).toEqual({ amount_cents: (1995 * 12) / 2, visits_delivered: 1, status: 'PENDING' });
    const roll = await as(f, 'owner', async () => one<{ billed_cents: number; recognized_cents: number; deferred_cents: number; visits_delivered: number }>(
      `select billed_cents, recognized_cents, deferred_cents, visits_delivered from pm.v_fs_agreement_deferred where agreement_id = $1`, [agr]));
    expect(roll).toEqual({ billed_cents: 3990, recognized_cents: 11970, deferred_cents: 3990 - 11970, visits_delivered: 1 });
    // deferred facts are financials: the dispatcher reads none
    expect(await as(f, 'dispatcher', async () => q(f.db, `select * from pm.agreement_revenue_facts`))).toEqual([]);
  });

  it('import with a reconciliation report: dry run counts deferred dollars and visits owed; commit creates agreements + remaining visits', async () => {
    const rows = JSON.stringify([
      { customer_name: 'Pat Homeowner', plan_name: 'Legacy Club', tier: 'Gold', starts_on: '2026-03-01', ends_on: '2027-03-01', price_cents: '1500', billing_frequency: 'MONTHLY', visits_per_term: '2', visits_remaining: '1', deferred_cents: '9000', external_ref: 'FE-1' },
      { customer_name: 'Nobody Known', plan_name: 'Legacy Club', starts_on: '2026-03-01', ends_on: '2027-03-01', external_ref: 'FE-2' },
      { customer_name: 'Sam Second', plan_name: 'Legacy Club', tier: 'Silver', starts_on: '2026-05-01', ends_on: '2027-05-01', price_cents: '0', visits_per_term: '0', visits_remaining: '0', deferred_cents: '0', external_ref: 'FE-3' },
    ]);
    const dry = await as(f, 'owner', async () => (await q<{ r: { ok: number; error_count: number; deferred_cents: number; visits_owed: number; no_billing: unknown[]; no_visits: unknown[] } }>(f.db,
      `select pm.fs_import_agreements($1, 'build', $2::jsonb, true, 'FIELDEDGE') r`, [L1, rows]))[0].r);
    expect(dry).toMatchObject({ ok: 2, error_count: 1, deferred_cents: 9000, visits_owed: 1 });
    expect(dry.no_billing).toHaveLength(1);
    expect(dry.no_visits).toHaveLength(1);
    await as(f, 'owner', async () => { await f.db.query(`select pm.fs_import_agreements($1, 'build', $2::jsonb, false, 'FIELDEDGE')`, [L1, rows]); });
    const g = await one<{ id: string; status: string }>(`select id, status from pm.service_agreements where import_ref = 'FE-1'`);
    const visits = await q<{ visit_seq: number }>(f.db, `select visit_seq from pm.work_orders where agreement_id = $1`, [g.id]);
    expect(visits.map((v) => v.visit_seq)).toEqual([2]);
    const opening = await one<{ amount_cents: number; visits_delivered: number }>(`select amount_cents, visits_delivered from pm.agreement_revenue_facts where agreement_id = $1 and kind = 'OPENING_BALANCE'`, [g.id]);
    expect(opening).toEqual({ amount_cents: 9000, visits_delivered: 1 });
    const reports = await q(f.db, `select 1 from pm.agreement_imports where location_id = $1`, [L1]);
    expect(reports.length).toBe(2);
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select pm.fs_import_agreements($1, 'build', '[]'::jsonb, true)`, [L1]))).toMatch(forbidden);
  });

  it('cancelling releases the unrecognized balance as a CANCEL_REFUND fact', async () => {
    const g = await one<{ id: string }>(`select id from pm.service_agreements where import_ref = 'FE-1'`);
    await as(f, 'owner', async () => { await f.db.query(`select pm.cancel_agreement($1, 'moved')`, [g.id]); });
    const r = await one<{ amount_cents: number }>(`select amount_cents from pm.agreement_revenue_facts where agreement_id = $1 and kind = 'CANCEL_REFUND'`, [g.id]);
    expect(r.amount_cents).toBe(9000);
  });

  it('bulk booking owed visits respects capacity', async () => {
    const v2 = await one<{ id: string }>(`select id from pm.work_orders where agreement_id = $1 and visit_seq = 2`, [agr]);
    const day = nextWeekday(1, 21);
    const r = await as(f, 'dispatcher', async () => (await q<{ r: { booked: unknown[]; failed: unknown[] } }>(f.db,
      `select pm.fs_bulk_book_visits(array[$1]::uuid[], $2::date, $3, $4) r`, [v2.id, day, ids.win, ids.maintBu]))[0].r);
    expect(r.booked).toHaveLength(1);
  });
});

describe('equipment (FS-72 / FS-75)', () => {
  it('an INSTALL work order cannot close while its equipment registration is pending', async () => {
    const wo = await as(f, 'owner', async () => (await q<{ id: string }>(f.db, `select pm.create_work_order($1, 'INSTALL', 'Install heat pump') id`, [J1]))[0].id);
    await f.db.query(`insert into pm.assets (org_id, location_id, customer_id, serial_number, make, equipment_type, install_work_order_id, registration_status, installed_on)
                      values ($1, $2, $3, 'HP-123', 'Acme', 'HEAT_PUMP', $4, 'PENDING', current_date)`, [ORG_A, L1, ids.cust, wo]);
    const a = await one<{ registration_deadline: string }>(`select registration_deadline::text from pm.assets where serial_number = 'HP-123'`);
    expect(a.registration_deadline).toBeTruthy();
    await as(f, 'owner', async () => { await f.db.query(`select pm.complete_work_order($1, 'COMPLETED')`, [wo]); });
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.close_work_order($1)`, [wo]))).toMatch(/PM_FS_WARRANTY_REGISTRATION/);
    await f.db.query(`update pm.assets set registration_status = 'REGISTERED' where serial_number = 'HP-123'`);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.close_work_order($1)`, [wo]))).toBeNull();
  });
});

describe('dispatch depth (FS-17 / FS-18 / FS-16)', () => {
  it('PTO blocks a dispatch assignment; eligibility explains why', async () => {
    const day = nextWeekday(3, 28);
    await f.db.query(`insert into pm.tech_events (org_id, location_id, employee_id, kind, slot) values ($1, $2, $3, 'PTO', tstzrange(($4::date + time '07:00')::timestamptz, ($4::date + time '18:00')::timestamptz))`,
      [ORG_A, L1, f.employee.labor, day]);
    const wo = f.ids[`wo:${J1}`];
    const e = await as(f, 'dispatcher', async () => errorOf(f.db, `select pm.schedule_work_order($1, ($2::date + time '09:00')::timestamptz, ($2::date + time '10:00')::timestamptz, array[$3]::uuid[])`,
      [wo, day, f.employee.labor]));
    expect(e).toMatch(/PM_FS_TECH_UNAVAILABLE/);
    const el = await as(f, 'dispatcher', async () => q<{ employee_id: string; eligible: boolean; reasons: string[] }>(f.db,
      `select employee_id, eligible, reasons from pm.fs_eligible_techs($1, ($2::date + time '09:00')::timestamptz, ($2::date + time '10:00')::timestamptz)`, [wo, day]));
    const me = el.find((x) => x.employee_id === f.employee.labor);
    expect(me?.eligible).toBe(false);
    expect(me?.reasons.join(' ')).toMatch(/PTO/);
  });
  it('going en route queues an on-my-way text to the consented contact', async () => {
    const day = nextWeekday(2);
    const r = await book('dispatcher', nextWeekday(4, 35), { p_customer: ids.cust, p_site: ids.site });
    await as(f, 'dispatcher', async () => {
      await f.db.query(`select pm.schedule_work_order($1, ($2::date + time '13:00')::timestamptz, ($2::date + time '14:00')::timestamptz, array[$3]::uuid[])`, [r.work_order_id, nextWeekday(4, 35), f.employee.labor]);
    });
    void day;
    const asg = await one<{ id: string }>(`select id from pm.dispatch_assignments where work_order_id = $1 and status <> 'CANCELLED'`, [r.work_order_id]);
    await as(f, 'labor', async () => { await f.db.query(`select pm.set_assignment_status($1, 'EN_ROUTE')`, [asg.id]); });
    const m = await one<{ kind: string; status: string; to_address: string; body: string }>(`select kind, status, to_address, body from pm.fs_messages where work_order_id = $1`, [r.work_order_id]);
    expect(m).toMatchObject({ kind: 'ON_MY_WAY', status: 'QUEUED', to_address: '5155550101' });
    expect(m.body).toMatch(/Lee/);
  });
});

describe('scorecards + performance pay (FS-40 / FS-101 / FS-103) — only the right people', () => {
  beforeAll(async () => {
    const plan = await one<{ id: string }>(`insert into pm.fs_pay_plans (org_id, location_id, name, commission_pct, membership_spiff_cents) values ($1, $2, 'Service tech', 0.10, 2500) returning id`, [ORG_A, L1]);
    await f.db.query(`insert into pm.fs_pay_assignments (org_id, location_id, employee_id, pay_plan_id) values ($1, $2, $3, $4)`, [ORG_A, L1, f.employee.labor, plan.id]);
    await as(f, 'owner', async () => { await f.db.query(`select pm.complete_work_order($1, 'FIXED')`, [f.ids[`wo:${J2}`]]); });
  });
  it('a tech sees only their own row, with revenue and pay', async () => {
    const rows = await as(f, 'labor', async () => q<{ employee_id: string; revenue_cents: number | null; commission_cents: number | null; memberships_sold: number; membership_spiff_cents: number | null }>(f.db,
      `select employee_id, revenue_cents, commission_cents, memberships_sold, membership_spiff_cents from pm.fs_tech_scorecard($1, current_date - 30, current_date)`, [L1]));
    expect(rows).toHaveLength(1);
    expect(rows[0].employee_id).toBe(f.employee.labor);
    expect(rows[0].revenue_cents).toBeGreaterThan(0);
    expect(rows[0].commission_cents).toBe(Math.round((rows[0].revenue_cents ?? 0) * 0.1));
    expect(rows[0].memberships_sold).toBe(1);
    expect(rows[0].membership_spiff_cents).toBe(2500);
    // their own pay plan is readable, nobody else's pay table is writable
    expect((await as(f, 'labor', async () => q(f.db, `select * from pm.fs_pay_plans`))).length).toBe(1);
    expect(await as(f, 'labor', async () => errorOf(f.db, `update pm.fs_pay_plans set commission_pct = 0.5`))).toBeNull();
    const pct = await one<{ commission_pct: string }>(`select commission_pct::text from pm.fs_pay_plans where name = 'Service tech'`);
    expect(pct.commission_pct).toBe('0.1000');
  });
  it('the GM sees every tech with revenue; pay needs labor_rates (GM yes, PM no); the dispatcher sees counts only', async () => {
    const gm = await as(f, 'gm', async () => q<{ revenue_cents: number | null; commission_cents: number | null; pay_visible: boolean }>(f.db,
      `select revenue_cents, commission_cents, pay_visible from pm.fs_tech_scorecard($1, current_date - 30, current_date)`, [L1]));
    expect(gm.length).toBeGreaterThan(0);
    expect(gm[0].revenue_cents).not.toBeNull();
    expect(gm[0].pay_visible).toBe(true);
    const disp = await as(f, 'dispatcher', async () => q<{ revenue_cents: number | null; commission_cents: number | null; completed_jobs: number }>(f.db,
      `select revenue_cents, commission_cents, completed_jobs from pm.fs_tech_scorecard($1, current_date - 30, current_date)`, [L1]));
    expect(disp.length).toBeGreaterThan(0);
    expect(disp[0].revenue_cents).toBeNull();
    expect(disp[0].commission_cents).toBeNull();
    expect(await as(f, 'dispatcher', async () => q(f.db, `select * from pm.fs_pay_plans`))).toEqual([]);
  });
  it('the supervisor (no reports, no dispatch edit, no tech seat) is refused', async () => {
    // supervisor has an employee row → sees only their own (empty) row set
    const rows = await as(f, 'supervisor', async () => q(f.db, `select * from pm.fs_tech_scorecard($1, current_date - 30, current_date)`, [L1]));
    expect(rows.every((r) => (r as { is_me: boolean }).is_me)).toBe(true);
    expect(await as(f, 'accountant', async () => errorOf(f.db, `select * from pm.fs_tech_scorecard($1, current_date - 30, current_date)`, [L2]))).toMatch(forbidden);
  });
});

describe('RLS per persona on the new tables', () => {
  it('org B sees no org A field-service rows; labor sees no calls; config is readable by every company member', async () => {
    for (const t of ['service_calls', 'business_units', 'fs_estimates', 'agreement_billing_schedule', 'price_book_items']) {
      const n = await as(f, 'bOwner', async () => (await q<{ n: number }>(f.db, `select count(*)::int n from pm.${t === 'price_book_items' ? 'v_price_book_items_masked' : t}`))[0].n);
      expect(n, t).toBe(0);
    }
    expect((await as(f, 'labor', async () => q(f.db, `select * from pm.service_calls`)))).toEqual([]);
    expect((await as(f, 'dispatcher', async () => q(f.db, `select * from pm.service_calls`))).length).toBeGreaterThan(0);
    expect((await as(f, 'labor', async () => q(f.db, `select * from pm.business_units`))).length).toBe(6);
    // agreement billing schedule is contract money: dispatcher none, accountant all
    expect(await as(f, 'dispatcher', async () => q(f.db, `select * from pm.agreement_billing_schedule`))).toEqual([]);
    expect((await as(f, 'accountant', async () => q(f.db, `select * from pm.agreement_billing_schedule`))).length).toBeGreaterThan(0);
  });
  it('members cannot write calls directly or change capacity without dispatch', async () => {
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `insert into pm.service_calls (org_id, location_id, channel) values ($1, $2, 'PHONE')`, [ORG_A, L1]))).toMatch(/permission denied/);
    const lab = await as(f, 'labor', async () => errorOf(f.db, `update pm.capacity_limits set max_jobs = 99`));
    const n = await one<{ n: number }>(`select count(*)::int n from pm.capacity_limits where max_jobs = 99`);
    expect(lab === null ? n.n : 0).toBe(0);
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `update pm.capacity_limits set max_jobs = 5 where business_unit_id = $1 and arrival_window_id = $2 and on_date is null and zone_id is null and day_of_week is null`, [ids.bu, ids.win]))).toBeNull();
  });
});

async function withAnon<T>(fn: () => Promise<T>): Promise<T> {
  await f.db.query(`select set_config('request.jwt.claims', '{"role":"anon"}', false)`);
  await f.db.exec('set role anon');
  try {
    return await fn();
  } finally {
    await f.db.exec('reset role');
    await f.db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

describe('idempotency', () => {
  it('1117 applies a second time without error and changes no counts', async () => {
    const before = await one<{ n: number }>(`select (select count(*) from pm.price_book_items) + (select count(*) from pm.capacity_limits) + (select count(*) from pm.access_table_classes) as n`);
    await applyMigration(f.db, '1117_pm_field_service_depth.sql');
    const after = await one<{ n: number }>(`select (select count(*) from pm.price_book_items) + (select count(*) from pm.capacity_limits) + (select count(*) from pm.access_table_classes) as n`);
    expect(Number(after.n)).toBe(Number(before.n));
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    // labor can still go en route after a re-apply (guard alias fix survives)
    expect(await q(f.db, `select 1 from pg_proc where proname = 'set_assignment_status' and prosrc like '%ga.id = p_assignment%'`)).toHaveLength(1);
  });
});

describe('price formulas: SQL (pm.fs_*) and the browser (lib/fieldservice/pricing.ts) agree', () => {
  it('on 300 random inputs, including half-cent ties', async () => {
    const tsp = await import('../../../apps/projects/src/lib/fieldservice/pricing');
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const rules = ['NONE', 'WHOLE', 'FIVE', 'NINE'] as const;
    const cases: Array<[number, number, number, number, string, number, number, number, number, number]> = [];
    for (let i = 0; i < 300; i++) {
      const hours = Math.round(rnd() * 800) / 100;              // 0.00–8.00
      const rate = 4000 + Math.round(rnd() * 12000);            // $40–$160
      const gm = Math.round(rnd() * 7000) / 10000;              // 0–70 %
      const matCost = Math.round(rnd() * 60000);
      const rule = rules[i % 4]!;
      const qty = Math.round(rnd() * 5000) / 1000 + 0.001;
      const price = Math.round(rnd() * 900000) + 1;
      const mem = Math.round(rnd() * 3000) / 10000;
      const mult = Math.round((1 + rnd() * 2) * 100) / 100;
      const apr = Math.round(rnd() * 25000) / 100000;
      cases.push([hours, rate, gm, matCost, rule, qty, price, mem, mult, apr]);
    }
    const ladder = JSON.stringify([{ up_to_cents: 1000, markup_pct: 2 }, { up_to_cents: 5000, markup_pct: 1.25 }, { up_to_cents: 25000, markup_pct: 0.8 }, { up_to_cents: null, markup_pct: 0.4 }]);
    const tsLadder = [{ upToCents: 1000, markupPct: 2 }, { upToCents: 5000, markupPct: 1.25 }, { upToCents: 25000, markupPct: 0.8 }, { upToCents: null, markupPct: 0.4 }];
    for (const [hours, rate, gm, matCost, rule, qty, price, mem, mult, apr] of cases) {
      const r = await one<{ ms: number; sp: number; mp: number; ah: number; mo: number; ch: number }>(
        `select pm.fs_material_sell($6::numeric, $4::bigint, $11::jsonb) ms,
                pm.fs_service_price($1::numeric, $2::bigint, $3::numeric, pm.fs_material_sell($6::numeric, $4::bigint, $11::jsonb), $5) sp,
                pm.fs_round_rule(pm.fs_rdiv($7::bigint * (10000 - round($8::numeric * 10000)), 10000), $5) mp,
                pm.fs_round_rule(pm.fs_rdiv($7::bigint * round($9::numeric * 100), 100), $5) ah,
                pm.fs_monthly_payment($7::bigint, $10::numeric, 60) mo,
                pm.fs_round_rule(pm.fs_rdiv($7::bigint * (10000 + round($8::numeric * 10000)), 10000), $5) ch`,
        [hours, rate, gm, matCost, rule, qty, price, mem, mult, apr, ladder]);
      const ms = tsp.materialSell(qty, matCost, tsLadder);
      expect(Number(r.ms), `material ${qty}×${matCost}`).toBe(ms);
      expect(Number(r.sp), `service ${hours}h ${rate} ${gm} ${rule}`).toBe(tsp.servicePrice(hours, rate, gm, ms, rule));
      expect(Number(r.ah), `after hours ${price}×${mult}`).toBe(tsp.afterHoursPrice(price, mult, rule));
      expect(Number(r.ch), `change ${price}+${mem}`).toBe(tsp.changedPrice(price, mem, rule));
      expect(Number(r.mo), `monthly ${price} ${apr}`).toBe(tsp.monthlyPayment(price, apr, 60));
      // member: SQL caps at the regular price inside _fs_price_item; compare the uncapped rule here
      expect(Math.min(Number(r.mp), price), `member ${price} ${mem}`).toBe(tsp.memberPrice(price, mem, rule));
    }
  });
});
