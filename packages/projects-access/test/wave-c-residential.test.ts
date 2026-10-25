/**
 * Wave C residential completion (migration 1124) against a PGlite replay of every migration: the
 * setup interview plan, builder job types, drive-time-aware appointment slots + booking + homeowner
 * self-booking (anon, token only), site capture → measure + RRP, the K&B cabinet-list import, crew
 * capacity flags, client-visible date changes → portal, receipt capture with its money mask, the
 * field "Today" site cards, job cash position, margin fade + the daily scan, the weekly client
 * update, the closeout package, the owner dashboard and the export manifest — plus the registry
 * guards (every table classified, every member definer RPC guarded, nothing in pm for anon).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { buildFixture, as, q, errorOf, type Fixture, type Persona, ORG_A, L1, L2, J1, J2 } from './fixture';
import { applyMigration, listMigrationFiles } from './pg';
import { documentRow, registryClean, vendor } from './industry';
import { driveMinutes } from '../../../apps/projects/src/lib/residential/routing';
import { buildResidentialPlan } from '../../../apps/projects/src/lib/residential/setup';
import * as recipes from '../../../apps/projects/src/lib/notify/recipes';

let f: Fixture;
const ids: Record<string, string> = {};
const forbidden = /PM_FORBIDDEN|permission denied|row-level security/i;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SKEY = 'wave-c-route-server-key-0001';

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(f.db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}
const call = async <T = unknown>(p: Persona, sql: string, params: unknown[] = []): Promise<T> =>
  as(f, p, async () => (await q<{ r: T }>(f.db, `select ${sql} as r`, params))[0]!.r);
const fails = (p: Persona, sql: string, params: unknown[] = []) => as(f, p, async () => errorOf(f.db, `select ${sql}`, params));

/** A weekday at least 3 days out (ISO date). */
function futureWeekday(): string {
  const d = new Date(Date.now() + 3 * 86400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function asAnon<T>(fn: () => Promise<T>): Promise<T> {
  await f.db.query(`select set_config('request.jwt.claims', '{"role":"anon"}', false)`);
  await f.db.exec('set role anon');
  try { return await fn(); } finally { await f.db.exec('reset role'); await f.db.query(`select set_config('request.jwt.claims', '{}', false)`); }
}

beforeAll(async () => {
  f = await buildFixture();
  const skipped: string[] = [];
  for (const file of listMigrationFiles().filter((x) => parseInt(x, 10) > 1110)) {
    const n = parseInt(file, 10);
    try { await applyMigration(f.db, file); } catch (e) {
      if (n <= 1122 || n === 1124) throw e;
      skipped.push(`${file}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  if (skipped.length) console.warn(`[wave-c-residential] skipped in-progress migrations:\n  ${skipped.join('\n  ')}`);
  await f.db.query(`insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, core_status, is_initial)
                    select org_id, location_id, id, 'm', 'active', 'Active', 'ACTIVE', true from pm.pack_installs
                     where not exists (select 1 from pm.stage_defs s where s.install_id = pack_installs.id and s.stage_key = 'active')`);
  await f.db.query(`update pm.contracts set status = 'ACTIVE' where job_id in ($1, $2)`, [J1, J2]);
  await f.db.query(`insert into pm.fs_widget_server_keys (key_hash, note) values ($1, 'wave C booking route') on conflict do nothing`, [sha(SKEY)]);
  ids.cust = (await one<{ id: string }>(`insert into core.customers (org_id, name, email) values ($1, 'Pat Smith', 'pat@example.test') returning id`, [ORG_A])).id;
  ids.contact = (await one<{ id: string }>(`insert into core.contacts (org_id, customer_id, first_name, last_name, email, phone, sms_consent, is_primary)
                                            values ($1, $2, 'Pat', 'Smith', 'pat@example.test', '515-555-0101', true, true) returning id`, [ORG_A, ids.cust])).id;
  await f.db.query(`update core.jobs set customer_id = $2 where id = $1`, [J1, ids.cust]);
  ids.vendor = await vendor(f, 'Prairie Trim Co');
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('1124 registers with the 1110 access foundation', () => {
  it('every pm table classified, every member definer RPC guarded, nothing in pm for anon, seats protected', async () => {
    expect(await registryClean(f)).toEqual({ unclassified: [], unguarded: [], anon: [], seat: [] });
  });
  it('seeds role recipes for its seven internal events, matching lib/notify/recipes.ts', async () => {
    const events = ['sales.appointment_booked', 'job.margin_fade', 'job.cash_negative', 'client_update.ready', 'development.key_date_due', 'flooring.goods_received', 'design.room_over_budget'];
    const rows = await q<{ persona_key: string; event_type: string; in_app: string; push: string; email: string; sms: string }>(f.db,
      `select persona_key, event_type, in_app, push, email, sms from core.notification_recipes where org_id is null and event_type = any ($1::text[])`, [events]);
    expect(rows).toHaveLength(events.length * recipes.RECIPE_PERSONAS.length);
    // the code side: in the parity set (INTERNAL_EVENTS / RECIPE_CODES) once the pending block is folded in, else the pending block
    type Row = { persona: string; event: string; in_app: string; push: string; email: string; sms: string };
    const pending = (recipes as unknown as { pendingRecipeDefaults?: () => Row[] }).pendingRecipeDefaults;
    const codeRows = [...(recipes.recipeDefaults() as Row[]), ...(pending ? pending() : [])].filter((c) => events.includes(c.event));
    expect(codeRows).toHaveLength(rows.length);
    const db = new Map(rows.map((r) => [`${r.persona_key}|${r.event_type}`, r]));
    for (const c of codeRows) {
      const r = db.get(`${c.persona}|${c.event}`);
      expect({ in_app: r?.in_app, push: r?.push, email: r?.email, sms: r?.sms }, `${c.persona} ${c.event}`).toEqual({ in_app: c.in_app, push: c.push, email: c.email, sms: c.sms });
    }
  });
  it('applies twice (idempotent) without duplicating seeded rows', async () => {
    const before = await one<{ n: number }>(`select count(*)::int n from core.notification_event_types`);
    const recipesBefore = await one<{ n: number }>(`select count(*)::int n from core.notification_recipes`);
    await applyMigration(f.db, '1124_pm_res_dev_design_flooring.sql');
    expect((await one<{ n: number }>(`select count(*)::int n from core.notification_event_types`)).n).toBe(before.n);
    expect((await one<{ n: number }>(`select count(*)::int n from core.notification_recipes`)).n).toBe(recipesBefore.n);
    expect(await registryClean(f)).toEqual({ unclassified: [], unguarded: [], anon: [], seat: [] });
  });
});

describe('setup interview + builder job types (RES-01/03)', () => {
  const plan = buildResidentialPlan({ businessKind: 'hybrid', contractTypes: ['FIXED_PRICE', 'COST_PLUS_PCT'], billingMethod: 'MILESTONE', selfPerform: 'MIXED',
    stateCode: 'IA', taxForm: 'LUMP_SUM_IMPROVEMENT', depositPct: 0.1, markupPct: 0.3, workmanshipWarrantyMonths: 12, structuralWarrantyYears: 10, usesSelectionsPortal: true });
  it('the plan sums its payment schedule to 100 % and is applied by settings holders only', async () => {
    expect(plan.payment_template.reduce((s, p) => s + p.pct, 0)).toBeCloseTo(1, 6);
    expect(await fails('supervisor', `pm.wc_apply_setup($1, 'RESIDENTIAL', '{}'::jsonb, $2::jsonb)`, [L1, JSON.stringify(plan)])).toMatch(forbidden);
    const r = await call<{ cost_codes_added: number; job_types_added: number; run_id: string }>('owner', `pm.wc_apply_setup($1, 'RESIDENTIAL', '{"businessKind":"hybrid"}'::jsonb, $2::jsonb)`,
      [L1, JSON.stringify(plan)]);
    expect(r.cost_codes_added).toBe(plan.cost_codes.length);
    expect(r.job_types_added).toBe(5);
    const s = await one<{ billing_method: string; state_code: string; default_markup_pct: string; setup_completed_at: string | null }>(
      `select billing_method, state_code, default_markup_pct, setup_completed_at from pm.res_settings where location_id = $1`, [L1]);
    expect(s).toMatchObject({ billing_method: 'MILESTONE', state_code: 'IA' });
    expect(Number(s.default_markup_pct)).toBe(0.3);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.wc_books_requests where kind = 'ACCOUNT_MAP' and source_id = $1`, [r.run_id])).n).toBe(1);
    const again = await call<{ cost_codes_added: number }>('owner', `pm.wc_apply_setup($1, 'RESIDENTIAL', '{}'::jsonb, $2::jsonb)`, [L1, JSON.stringify(plan)]);
    expect(again.cost_codes_added).toBe(0);
  });
  it('a spec home: its selection list, capitalize-to-inventory, the Books account map; re-applying adds nothing', async () => {
    const r = await call<{ selections_created: number; gl_disposition: string }>('owner', `pm.res_apply_job_template($1, 'spec_home')`, [J2]);
    expect(r.gl_disposition).toBe('CAPITALIZE_INVENTORY');
    expect(r.selections_created).toBeGreaterThan(5);
    const again = await call<{ selections_created: number }>('owner', `pm.res_apply_job_template($1, 'spec_home')`, [J2]);
    expect(again.selections_created).toBe(0);
    const b = await one<{ payload: { gl_disposition: string } }>(`select payload from pm.wc_books_requests where kind = 'ACCOUNT_MAP' and job_id = $1`, [J2]);
    expect(b.payload.gl_disposition).toBe('CAPITALIZE');
    expect(await fails('labor', `pm.res_apply_job_template($1, 'spec_home')`, [J2])).toMatch(forbidden);
  });
});

describe('in-home appointments (RES-10)', () => {
  const day = futureWeekday();
  const home = { lat: 41.5868, lng: -93.625 };
  const site = { lat: 41.6611, lng: -93.737 };
  it('slots are drive-time aware (SQL ≡ lib/residential/routing.ts) and ranked by skill and territory', async () => {
    ids.rep = (await as(f, 'owner', () => q<{ id: string }>(f.db, `insert into pm.wc_reps (location_id, membership_id, display_name, kinds, skills, zip_prefixes, home_lat, home_lng)
       values ($1, $2, 'Dana Dispatcher', '{SALES,MEASURE}', '{kitchen}', '{503}', $3, $4) returning id`, [L1, f.membership.dispatcher, home.lat, home.lng])))[0]!.id;
    const sql = await one<{ m: number }>(`select pm.wc_drive_minutes($1, $2, $3, $4) as m`, [home.lat, home.lng, site.lat, site.lng]);
    expect(sql.m).toBe(driveMinutes(home, site));
    const s = await call<{ slots: Array<{ rep_id: string; starts_at: string; drive_in_minutes: number; skill_match: boolean; in_territory: boolean }> }>('dispatcher',
      `pm.wc_appointment_slots($1, $2::date, 'SALES', 'kitchen', $3, $4, '50310', 90, 40)`, [L1, day, site.lat, site.lng]);
    expect(s.slots.length).toBeGreaterThan(5);
    expect(s.slots[0]).toMatchObject({ rep_id: ids.rep, skill_match: true, in_territory: true, drive_in_minutes: driveMinutes(home, site) });
    ids.slot = s.slots[0]!.starts_at;
    expect(await fails('labor', `pm.wc_appointment_slots($1, $2::date)`, [L1, day])).toMatch(forbidden);
  });
  it('booking blocks a double-book; the rep can say "on my way" (customer text queued)', async () => {
    ids.appt = await call<string>('dispatcher', `pm.wc_book_appointment($1, $2::jsonb)`, [L1, JSON.stringify({ rep_id: ids.rep, starts_at: ids.slot, minutes: 90,
      address: '12 Elm St', lat: site.lat, lng: site.lng, contact_id: ids.contact, kind: 'SALES', notes: 'Kitchen, wants quartz' })]);
    expect(await fails('dispatcher', `pm.wc_book_appointment($1, $2::jsonb)`, [L1, JSON.stringify({ rep_id: ids.rep, starts_at: ids.slot, minutes: 60 })])).toMatch(/PM_WC_DOUBLE_BOOKED/);
    const after = await call<{ slots: Array<{ starts_at: string }> }>('dispatcher', `pm.wc_appointment_slots($1, $2::date, 'SALES', null, $3, $4, null, 90, 200)`, [L1, day, site.lat, site.lng]);
    expect(after.slots.some((x) => x.starts_at === ids.slot)).toBe(false);
    await call('dispatcher', `pm.wc_set_appointment_status($1, 'ON_MY_WAY')`, [ids.appt]);
    const m = await q<{ event_type: string }>(f.db, `select event_type from core.outbound_messages where dispatch_key = $1`, [`appt.omw:${ids.appt}`]);
    expect(m.map((x) => x.event_type)).toEqual(['customer.on_my_way']);
    expect(await fails('labor', `pm.wc_set_appointment_status($1, 'DONE')`, [ids.appt])).toMatch(forbidden);
  });
  it('homeowner self-booking: anon with the token sees open times only and files a request', async () => {
    const token = 'self-book-token-1234567890abcdef';
    await call('owner', `pm.wc_create_booking_link($1, $2, 'SALES', 'Book a design visit', 60)`, [L1, sha(token)]);
    const slots = await asAnon(() => q<{ r: { times: string[]; label: string } }>(f.db, `select public.wc_booking_slots($3, $1, $2::date) as r`, [token, day, SKEY]));
    expect(slots[0]!.r.label).toBe('Book a design visit');
    expect(slots[0]!.r.times.length).toBeGreaterThan(0);
    expect(JSON.stringify(slots[0]!.r)).not.toContain('Dana');
    const r = await asAnon(() => q<{ r: { requested: boolean } }>(f.db, `select public.wc_self_book($3, $1, $2::timestamptz, 'Jordan Lee', '515-555-0144', null, '9 Oak', '50310', 'Bath') as r`,
      [token, slots[0]!.r.times[slots[0]!.r.times.length - 1], SKEY]));
    expect(r[0]!.r.requested).toBe(true);
    expect(await asAnon(() => errorOf(f.db, `select public.wc_booking_slots($1, 'wrong', current_date)`, [SKEY]))).toMatch(/PORTAL_FORBIDDEN/);
    // round 2: the anon key alone (no or a wrong server key) cannot reach either function
    expect(await asAnon(() => errorOf(f.db, `select public.wc_booking_slots(null, $1, current_date)`, [token]))).toMatch(/FS_WIDGET_KEY/);
    expect(await asAnon(() => errorOf(f.db, `select public.wc_self_book('not-the-server-key-xx', $1, now() + interval '1 day', 'X Y', '1')`, [token]))).toMatch(/FS_WIDGET_KEY/);
    expect(await asAnon(() => errorOf(f.db, `select pm.wc_appointment_slots($1, current_date)`, [L1]))).toMatch(/permission denied/);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.wc_appointments where status = 'REQUESTED' and self_booked`)).n).toBe(1);
  });
  it('M1: only an offered time books; per-client limits; one digest notice per hour; links expire and can be revoked', async () => {
    const token = 'self-book-token-m1-0000000000abcdef';
    await call('owner', `pm.wc_create_booking_link($1, $2, 'SALES', 'M1 link', 60)`, [L1, sha(token)]);
    const link = await one<{ id: string; expires_at: string | null }>(`select id, expires_at from pm.wc_booking_links where token_hash = $1`, [sha(token)]);
    expect(link.expires_at).not.toBeNull();
    const times = (await asAnon(() => q<{ r: { times: string[] } }>(f.db, `select public.wc_booking_slots($3, $1, $2::date) as r`, [token, day, SKEY])))[0]!.r.times;
    const book = (at: string, ip: string | null) => asAnon(() => errorOf(f.db,
      `select public.wc_self_book($4, $1, $2::timestamptz, 'Pat Doe', '515-555-0100', null, '1 Elm', '50310', null, $3)`, [token, at, ip, SKEY]));
    const offTime = new Date(Date.parse(times[0]!) + 7 * 60_000).toISOString();
    expect(await book(offTime, null)).toMatch(/no longer open/);
    const ipA = sha('203.0.113.7'); const ipB = sha('198.51.100.9');
    for (let i = 0; i < 3; i++) expect(await book(times[0]!, ipA)).toBeNull();
    expect(await book(times[0]!, ipA)).toMatch(/RATE_LIMITED/);
    expect(await book(times[0]!, ipB)).toBeNull();
    expect((await one<{ n: number }>(`select count(*)::int n from pm.wc_booking_hits where link_id = $1`, [link.id])).n).toBe(4);
    await f.db.query(`update pm.wc_booking_hits set created_at = now() - interval '3 days' where link_id = $1 and ip_hash = $2`, [link.id, ipB]);
    expect(await book(times[0]!, ipB)).toBeNull();   // the next booking sweeps hits older than two days
    expect((await one<{ n: number }>(`select count(*)::int n from pm.wc_booking_hits where created_at < now() - interval '2 days'`)).n).toBe(0);
    // one notice per recipient for the hour, not one per request, and no requester text in it
    const notes = await q<{ membership_id: string; title: string }>(f.db, `select membership_id, title from core.notifications where event_type = 'sales.appointment_booked' and subject_id = $1`, [link.id]);
    expect(notes.length).toBeGreaterThan(0);
    expect(new Set(notes.map((n) => n.membership_id)).size).toBe(notes.length);
    expect(notes.every((n) => !/Pat Doe/.test(n.title))).toBe(true);
    // revoke: settings:configure only; the link stops working
    expect(await fails('labor', `pm.wc_revoke_booking_link($1)`, [link.id])).toMatch(forbidden);
    expect((await call<{ revoked: boolean }>('owner', `pm.wc_revoke_booking_link($1)`, [link.id])).revoked).toBe(true);
    expect(await asAnon(() => errorOf(f.db, `select public.wc_booking_slots($3, $1, $2::date)`, [token, day, SKEY]))).toMatch(/PORTAL_FORBIDDEN/);
    // expiry
    const t2 = 'self-book-token-m1-expired-00000000';
    await call('owner', `pm.wc_create_booking_link($1, $2, 'SALES', 'Old link', 60, 1)`, [L1, sha(t2)]);
    await f.db.query(`update pm.wc_booking_links set expires_at = now() - interval '1 minute' where token_hash = $1`, [sha(t2)]);
    expect(await asAnon(() => errorOf(f.db, `select public.wc_booking_slots($3, $1, $2::date)`, [t2, day, SKEY]))).toMatch(/PORTAL_FORBIDDEN/);
    expect(await asAnon(() => errorOf(f.db, `select pm.wc_revoke_booking_link($1)`, [link.id]))).toMatch(/permission denied/);
  });
});

describe('site capture (RES-11)', () => {
  it('rooms become a measure, a pre-1978 home gets its RRP record; crew cannot capture on a job that is not theirs', async () => {
    ids.capture = await call<string>('pm', `pm.res_save_site_capture($1, null, $2::jsonb)`, [J1, JSON.stringify({
      rooms: [{ name: 'Kitchen', length_in: 168, width_in: 144 }, { name: 'Dining', length_in: 144, width_in: 120 }],
      utilities: { water_shutoff: 'basement NE corner' }, conditions: { year_built: 1965, panel_amps: 100, asbestos_risk: true } })]);
    const r = await call<{ rooms: number; rrp_required: boolean; measure_id: string }>('pm', `pm.res_finalize_site_capture($1)`, [ids.capture]);
    expect(r).toMatchObject({ rooms: 2, rrp_required: true });
    const a = await q<{ room_name: string; sqft: string }>(f.db, `select room_name, sqft from pm.measure_areas where measure_id = $1 order by room_name`, [r.measure_id]);
    expect(a.map((x) => [x.room_name, Number(x.sqft)])).toEqual([['Dining', 120], ['Kitchen', 168]]);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.res_rrp_records where job_id = $1 and required`, [J1])).n).toBe(1);
    expect(await fails('pm', `pm.res_finalize_site_capture($1)`, [ids.capture])).toMatch(/already final/);
    expect(await fails('labor', `pm.res_save_site_capture($1, null, '{}'::jsonb)`, [J1])).toMatch(forbidden);
    // L4: a document id from outside the job (not the caller's upload) is refused
    const stray = await documentRow(f, 'stray.jpg');
    expect(await fails('pm', `pm.res_save_site_capture($1, null, $2::jsonb)`, [J1, JSON.stringify({ photo_document_ids: [stray] })])).toMatch(/not on this job/);
  });
});

describe('K&B design-software import (RES-23)', () => {
  it('a 2020 list maps known SKUs, refuses unknown ones without a cost, learns a map, and lands priced lines', async () => {
    ids.b30 = (await one<{ id: string }>(`insert into pm.res_catalog_items (org_id, location_id, code, name, uom, unit_cost_cents, markup_pct, supplier_sku, category)
                                          values ($1, $2, 'CAB-B30', 'Base cabinet 30"', 'EA', 32000, 0.40, 'B30', 'Cabinets') returning id`, [ORG_A, L1])).id;
    ids.w3030 = (await one<{ id: string }>(`insert into pm.res_catalog_items (org_id, location_id, code, name, uom, unit_cost_cents, markup_pct, category)
                                            values ($1, $2, 'CAB-W3030', 'Wall cabinet 30x30', 'EA', 21000, 0.40, 'Cabinets') returning id`, [ORG_A, L1])).id;
    ids.proposal = await call<string>('owner', `pm.res_create_proposal($1, null, $2, 'Kitchen cabinets', null, '{}'::jsonb)`, [L1, J1]);
    // what lib/residential/kb-import.ts makes of a 2020 item list (parser unit-tested in apps/projects)
    const parsed = { lines: [
      { sku: 'B30', description: 'Base 30', qty: 3, uom: 'EA', width_in: 30, finish: 'Shaker White', room: 'Kitchen', list_price_cents: 61000, unit_cost_cents: null },
      { sku: 'W3030', description: 'Wall 30x30', qty: 1, uom: 'EA', width_in: 30, finish: 'Shaker White', room: 'Kitchen', list_price_cents: 39800, unit_cost_cents: null },
      { sku: 'XX99', description: 'Filler', qty: 1, uom: 'EA', width_in: 3, finish: 'Shaker White', room: 'Kitchen', list_price_cents: 4000, unit_cost_cents: null }] };
    const st = await call<{ import_id: string; matched: number; unmatched: number }>('owner', `pm.res_stage_kb_import($1, 'TWENTY_TWENTY', 'kitchen-2020.csv', $2::jsonb, 'Kitchen')`,
      [ids.proposal, JSON.stringify(parsed.lines)]);
    expect(st).toMatchObject({ matched: 1, unmatched: 2 });
    ids.kb = st.import_id;
    expect(await fails('owner', `pm.res_apply_kb_import($1)`, [ids.kb])).toMatch(/PM_RES_KB_UNMAPPED/);
    const w = await one<{ id: string }>(`select id from pm.res_kb_import_lines where import_id = $1 and sku = 'W3030'`, [ids.kb]);
    const x = await one<{ id: string }>(`select id from pm.res_kb_import_lines where import_id = $1 and sku = 'XX99'`, [ids.kb]);
    await call('owner', `pm.res_map_kb_line($1, $2, true)`, [w.id, ids.w3030]);
    await call('owner', `pm.res_map_kb_line($1, null)`, [x.id]);
    const ap = await call<{ lines_added: number }>('owner', `pm.res_apply_kb_import($1)`, [ids.kb]);
    expect(ap.lines_added).toBe(2);
    const lines = await q<{ qty: string; cost_cents: string; price_cents: string }>(f.db,
      `select qty, cost_cents, price_cents from pm.res_proposal_lines where proposal_id = $1 and ext ->> 'kb_import_id' = $2 order by cost_cents desc`, [ids.proposal, ids.kb]);
    expect(lines.map((l) => [Number(l.qty), Number(l.cost_cents), Number(l.price_cents)])).toEqual([[3, 96000, 134400], [1, 21000, 29400]]);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.res_kb_sku_map where vendor_sku = 'W3030'`)).n).toBe(1);
    // the learned map matches the next file at staging
    const st2 = await call<{ matched: number }>('owner', `pm.res_stage_kb_import($1, 'TWENTY_TWENTY', 'b.csv', '[{"sku":"W3030","qty":2}]'::jsonb)`, [ids.proposal]);
    expect(st2.matched).toBe(1);
    expect(await fails('labor', `pm.res_stage_kb_import($1, 'CSV', 'x', '[{"sku":"A"}]'::jsonb)`, [ids.proposal])).toMatch(forbidden);
  });
});

describe('crew and trade capacity (RES-49)', () => {
  it('flags a trade booked on two jobs the same days', async () => {
    const mon = futureWeekday();
    await f.db.query(`insert into pm.tasks (org_id, job_id, title, start_on, due_on, assigned_vendor_id) values ($1, $2, 'Trim out', $4::date, $4::date + 2, $5), ($1, $3, 'Trim out', $4::date + 1, $4::date + 3, $5)`,
      [ORG_A, J1, J2, mon, ids.vendor]);
    const c = await call<{ rows: Array<{ resource: string; double_booked_days: number; overloaded: boolean }>; flags: number }>('dispatcher', `pm.res_crew_capacity($1, $2::date, 4)`, [L1, mon]);
    const v = c.rows.filter((r) => r.resource === 'Prairie Trim Co');
    expect(v.some((r) => r.double_booked_days > 0 && r.overloaded)).toBe(true);
    expect(c.flags).toBeGreaterThan(0);
    expect(await fails('labor', `pm.res_crew_capacity($1)`, [L1])).toMatch(forbidden);
  });
});

describe('client-visible schedule (RES-52)', () => {
  it('the filter shows milestones and homeowner keywords; a date move queues an explanation posted to the portal', async () => {
    const t = await one<{ id: string }>(`insert into pm.tasks (org_id, job_id, title, start_on, due_on) values ($1, $2, 'Countertop template', '2027-02-01', '2027-02-01') returning id`, [ORG_A, J1]);
    await f.db.query(`insert into pm.tasks (org_id, job_id, title, start_on) values ($1, $2, 'Set floor protection', '2027-01-20')`, [ORG_A, J1]);
    const r = await call<{ visible: number; hidden: number }>('pm', `pm.res_apply_client_schedule_filter($1)`, [J1]);
    expect(r.visible).toBeGreaterThanOrEqual(1);
    expect((await one<{ client_visible: boolean }>(`select client_visible from pm.tasks where id = $1`, [t.id])).client_visible).toBe(true);
    await f.db.query(`update pm.tasks set start_on = '2027-02-04', due_on = '2027-02-04' where id = $1`, [t.id]);
    const ch = await one<{ id: string; shift_days: number; status: string }>(`select id, shift_days, status from pm.res_client_date_changes where task_id = $1`, [t.id]);
    expect(ch).toMatchObject({ shift_days: 3, status: 'PENDING' });
    const p = await call<{ explanation: string }>('pm', `pm.res_post_date_change($1, 'MATERIAL')`, [ch.id]);
    expect(p.explanation).toMatch(/Countertop template moved out 3 day\(s\).*material is arriving later/);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.portal_messages where job_id = $1 and audience = 'customer'`, [J1])).n).toBe(1);
    expect(await fails('labor', `pm.res_dismiss_date_change($1)`, [ch.id])).toMatch(forbidden);
  });
});

describe('receipt capture (RES-62) and the field "Today" card (RES-68)', () => {
  it('crew snaps a receipt on their job; its amount is theirs and the money roles\' — not another job\'s PM', async () => {
    const doc = await documentRow(f, 'receipt.jpg');
    await f.db.query(`update public.documents set uploaded_by_user = $1 where id = $2`, [f.clerk.labor, doc]);
    const cap = await call<{ receipt_id: string; status: string; photo_pending: boolean; replayed: boolean }>('labor', `pm.res_capture_receipt($1, $2, '{"amount_cents": 4599, "vendor_name": "Menards", "card_last4": "4242"}'::jsonb)`, [J2, doc]);
    expect(cap).toMatchObject({ status: 'CAPTURED', photo_pending: false, replayed: false });
    ids.receipt = cap.receipt_id;
    const own = await as(f, 'labor', () => q<{ amount_cents: string | null; status: string }>(f.db, `select amount_cents, status from pm.v_res_receipt_captures_masked where id = $1`, [ids.receipt]));
    expect(own.map((x) => [Number(x.amount_cents), x.status])).toEqual([[4599, 'CAPTURED']]);
    expect(await fails('labor', `pm.res_capture_receipt($1, $2)`, [J1, doc])).toMatch(forbidden);
    const cc = await one<{ id: string }>(`select id from pm.cost_codes where location_id = $1 and code = '06-000'`, [L1]);
    expect(await fails('labor', `pm.res_code_receipt($1, $2)`, [ids.receipt, cc.id])).toMatch(forbidden);
    expect((await call<{ status: string }>('owner', `pm.res_code_receipt($1, $2, '{"books_txn_ref":"bt_123"}'::jsonb)`, [ids.receipt, cc.id])).status).toBe('CODED');
    const b = await one<{ kind: string; payload: { amount_cents: number } }>(`select kind, payload from pm.wc_books_requests where source_id = $1`, [ids.receipt]);
    expect(b).toMatchObject({ kind: 'CARD_CODING', payload: { amount_cents: 4599 } });
  });
  it('offline queue: a lasting clientId dedupes in the database; a photo command id links the photo when it lands', async () => {
    const cmd = '7d1e2f30-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
    const capture = () => call<{ receipt_id: string; status: string; photo_pending: boolean; replayed: boolean }>('labor',
      `pm.res_capture_receipt($1, null, '{"amount_cents": 1250, "vendor_name": "Ace"}'::jsonb, 'phone-rcpt-0001', $2::uuid)`, [J2, cmd]);
    const first = await capture();
    expect(first).toMatchObject({ status: 'CAPTURED', photo_pending: true, replayed: false });
    // the photo lands under its command id (lib field photos path), then the queue re-sends the receipt
    const doc = await documentRow(f, 'r.jpg');
    await f.db.query(`update public.documents set storage_path = $1, uploaded_by_user = $2 where id = $3`, [`${ORG_A}/projects/field/${J2}/${cmd.toUpperCase()}.jpg`, f.clerk.labor, doc]);
    const again = await capture();
    expect(again).toMatchObject({ receipt_id: first.receipt_id, replayed: true, photo_pending: false });
    expect(await one<{ n: number; d: string | null }>(`select count(*)::int n, max(document_id::text) d from pm.res_receipt_captures where client_id = 'phone-rcpt-0001'`)).toEqual({ n: 1, d: doc });
    // the id is the capturer's own: another person's same id is a separate capture (M5), never a replay of labor's
    const owners = await call<{ receipt_id: string; replayed: boolean; photo_pending: boolean }>('owner', `pm.res_capture_receipt($1, null, '{}'::jsonb, 'phone-rcpt-0001', $2::uuid)`, [J1, cmd]);
    expect(owners).toMatchObject({ replayed: false, photo_pending: true });   // labor's photo is not the owner's
    expect(owners.receipt_id).not.toBe(first.receipt_id);
    // no photo at all is refused
    expect(await fails('labor', `pm.res_capture_receipt($1, null, '{}'::jsonb, 'phone-rcpt-0002')`, [J2])).toMatch(/attach the receipt photo/);
    expect(await fails('labor', `pm.res_capture_receipt($1, null, '{}'::jsonb, 'short', $2::uuid)`, [J2, cmd])).toMatch(/8 to 80/);
  });
  it('M5: a crew cost code is only a suggestion (no Books hand-off); another person\'s photo or capture id is not theirs', async () => {
    const cc = await one<{ id: string }>(`select id from pm.cost_codes where location_id = $1 and code = '06-000'`, [L1]);
    const mine = await documentRow(f, 'mine.jpg');
    await f.db.query(`update public.documents set uploaded_by_user = $1 where id = $2`, [f.clerk.labor, mine]);
    const r = await call<{ receipt_id: string; status: string; suggested_cost_code_id: string | null }>('labor',
      `pm.res_capture_receipt($1, $2, $3::jsonb, 'phone-rcpt-m5-01')`, [J2, mine, JSON.stringify({ cost_code_id: cc.id, amount_cents: 900 })]);
    expect(r).toMatchObject({ status: 'CAPTURED', suggested_cost_code_id: cc.id });
    expect((await one<{ n: number }>(`select count(*)::int n from pm.wc_books_requests where source_id = $1`, [r.receipt_id])).n).toBe(0);
    // someone else's upload, not linked to the job
    const theirs = await documentRow(f, 'theirs.jpg');
    await f.db.query(`update public.documents set uploaded_by_user = $1 where id = $2`, [f.clerk.owner, theirs]);
    expect(await fails('labor', `pm.res_capture_receipt($1, $2, '{}'::jsonb, 'phone-rcpt-m5-02')`, [J2, theirs])).toMatch(/not found/);
    // the same client id from another person is a different capture, not a replay of labor's
    const own = await documentRow(f, 'own.jpg');
    await f.db.query(`update public.documents set uploaded_by_user = $1 where id = $2`, [f.clerk.supervisor, own]);
    const other = await call<{ receipt_id: string; replayed: boolean }>('supervisor', `pm.res_capture_receipt($1, $2, '{}'::jsonb, 'phone-rcpt-m5-01')`, [J1, own]);
    expect(other.replayed).toBe(false);
    expect(other.receipt_id).not.toBe(r.receipt_id);
    // the office codes with financials:edit and the hand-off is made then
    expect((await call<{ status: string }>('owner', `pm.res_code_receipt($1, $2)`, [r.receipt_id, cc.id])).status).toBe('CODED');
    expect((await one<{ n: number }>(`select count(*)::int n from pm.wc_books_requests where source_id = $1`, [r.receipt_id])).n).toBe(1);
  });
  it('site cards: codes, homeowner notes and today\'s tasks — only for jobs the caller reaches, no money', async () => {
    await f.db.query(`insert into pm.res_home_profiles (org_id, job_id, occupied, lockbox_code, pets, notes) values ($1, $2, true, '4471', 'Dog in back yard', 'Use side door')
                      on conflict (org_id, job_id) do update set lockbox_code = excluded.lockbox_code, pets = excluded.pets`, [ORG_A, J2]);
    const sites = () => call<Array<{ job_id: string; codes: { lockbox?: string }; home: { pets?: string } }>>('labor', `pm.res_field_sites($1::uuid[])`, [[J1, J2]]);
    // L10: reaching the job is not enough for the entry codes — the job team or someone scheduled on it
    const before = await sites();
    expect(before.map((c) => c.job_id)).toEqual([J2]);
    expect(before[0]).toMatchObject({ codes: {}, home: { pets: 'Dog in back yard' } });
    await f.db.query(`insert into pm.job_members (org_id, job_id, membership_id, slot) values ($1, $2, $3, 'crew') on conflict do nothing`, [ORG_A, J2, f.membership.labor]);
    const cards = await sites();
    expect(cards[0]).toMatchObject({ codes: { lockbox: '4471' }, home: { pets: 'Dog in back yard' } });
    expect(JSON.stringify(cards)).not.toMatch(/_cents/);
  });
});

describe('cash position, margin fade, the daily scan (RES-84/122)', () => {
  it('cost ahead of cash is negative and explained; the fade names the code that moved and the missing CO', async () => {
    const cc = f.ids[`costCode:${L1}`];
    await f.db.query(`insert into pm.job_costs (org_id, job_id, location_id, source_ref, cost_type, amount_cents, lifecycle, cost_code_id, last_event_id, last_event_at, last_lifecycle_rank, first_event_at)
                      values ($1, $2, $3, 'test:fade', 'OTHER', 2000000, 'CLEARED', $4, gen_random_uuid(), now(), 2, now())`, [ORG_A, J1, L1, cc]);
    const c = await call<{ negative: boolean; cost_incurred_cents: number; why: string }>('pm', `pm.res_job_cash_position($1)`, [J1]);
    expect(c).toMatchObject({ negative: true, cost_incurred_cents: 2000000 });
    expect(c.why).toMatch(/Cost incurred/);
    const m = await call<{ fading: boolean; sold_margin_pct: number; moved_codes: Array<{ code: string; change_order_on_code: boolean }>; missing_change_orders: number }>('pm', `pm.res_margin_fade($1)`, [J1]);
    expect(m.fading).toBe(true);
    expect(Number(m.sold_margin_pct)).toBe(0.6);
    expect(m.moved_codes[0]).toMatchObject({ code: '01', change_order_on_code: false });
    expect(m.missing_change_orders).toBe(1);
    expect(await fails('supervisor', `pm.res_margin_fade($1)`, [J1])).toMatch(forbidden);
    const s = await call<{ margin_fade: number; cash_negative: number }>('owner', `pm.res_scan_job_health($1)`, [L1]);
    expect(s.margin_fade).toBeGreaterThanOrEqual(1);
    expect(s.cash_negative).toBeGreaterThanOrEqual(1);
    const n = await q<{ membership_id: string }>(f.db, `select membership_id from core.notifications where event_type = 'job.margin_fade' and job_id = $1`, [J1]);
    expect(n.map((x) => x.membership_id)).toContain(f.membership.pm);
    // a second scan the same day does not open a second alert
    await call('owner', `pm.res_scan_job_health($1)`, [L1]);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.res_margin_alerts where job_id = $1 and kind = 'MARGIN_FADE'`, [J1])).n).toBe(1);
  });
});

describe('weekly client update (RES-90) and closeout package (RES-97)', () => {
  it('drafts from the week (rules only), the PM edits and sends it to the portal thread', async () => {
    await f.db.query(`insert into pm.field_logs (org_id, job_id, log_date, body, client_visible) values ($1, $2, current_date, 'Cabinets delivered and set.', true)`, [ORG_A, J1]);
    await f.db.query(`insert into pm.tasks (org_id, job_id, title, status, start_on, due_on, actual_finish) values ($1, $2, 'Hang cabinets', 'DONE', current_date, current_date, current_date)`, [ORG_A, J1]);
    ids.update = await call<string>('pm', `pm.res_draft_client_update($1)`, [J1]);
    const u = await one<{ body: string; drafted_by: string }>(`select body, drafted_by from pm.res_client_updates where id = $1`, [ids.update]);
    expect(u.drafted_by).toBe('RULES');
    expect(u.body).toMatch(/Finished this week: .*Hang cabinets/);
    expect(u.body).toMatch(/Cabinets delivered and set\./);
    await call('pm', `pm.res_edit_client_update($1, $2)`, [ids.update, `${u.body}\n\nSee you Monday.`]);
    const before = (await one<{ n: number }>(`select count(*)::int n from pm.portal_messages where job_id = $1`, [J1])).n;
    await call('pm', `pm.res_send_client_update($1)`, [ids.update]);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.portal_messages where job_id = $1`, [J1])).n).toBe(before + 1);
    expect(await fails('pm', `pm.res_send_client_update($1)`, [ids.update])).toMatch(/already sent/);
  });
  it('assembles from what the job holds, lists what is missing, publishes', async () => {
    await f.db.query(`insert into pm.compliance_docs (org_id, job_id, vendor_id, doc_type, status) values ($1, $2, $3, 'LIEN_WAIVER_FINAL', 'RECEIVED')`, [ORG_A, J1, ids.vendor]);
    const a = await call<{ package_id: string; items: number; missing: string[] }>('pm', `pm.res_assemble_closeout($1)`, [J1]);
    expect(a.items).toBe(1);
    expect(a.missing).toEqual(expect.arrayContaining(['warranty', 'product list', 'rough-in photos']));
    expect(a.missing).not.toContain('lien releases');
    const again = await call<{ items: number }>('pm', `pm.res_assemble_closeout($1)`, [J1]);
    expect(again.items).toBe(1);
    await call('pm', `pm.res_add_closeout_item($1, 'PAINT_COLOR', 'Kitchen walls: SW 7008 Alabaster')`, [J1]);
    const p = await call<{ shared: number }>('pm', `pm.res_publish_closeout($1)`, [a.package_id]);
    expect(p.shared).toBe(0);
    expect((await one<{ status: string }>(`select status from pm.res_closeout_packages where id = $1`, [a.package_id])).status).toBe('PUBLISHED');
    expect(await fails('labor', `pm.res_assemble_closeout($1)`, [J2])).toMatch(forbidden);
  });
  it('L4/L5: closeout items take only this job\'s documents; publishing skips a file from another job', async () => {
    const stray = await documentRow(f, 'other-job.pdf');
    expect(await fails('pm', `pm.res_add_closeout_item($1, 'WARRANTY', 'Roof', '{}'::jsonb, null, $2)`, [J1, stray])).toMatch(/not on this job/);
  });
});

describe('owner dashboard (RES-123) and export manifest (RES-127)', () => {
  it('per company and rolled up for the owner; a PM sees only where they hold financials', async () => {
    const o = await call<{ companies: Array<{ location_id: string; backlog_cents: number; jobs_at_risk: number }>; total: { backlog_cents: number } }>('owner', `pm.res_owner_dashboard(null)`);
    expect(o.companies.map((c) => c.location_id).sort()).toEqual([L1, L2].sort());
    expect(o.total.backlog_cents).toBe(o.companies.reduce((s, c) => s + Number(c.backlog_cents), 0));
    expect(o.companies.find((c) => c.location_id === L1)!.jobs_at_risk).toBeGreaterThanOrEqual(1);
    // M7: Books bank balances only with a Books cash / banking / report view (none in this fixture)
    const c1 = o.companies.find((c) => c.location_id === L1) as unknown as { cash_cents: number | null; cash_unavailable_reason: string | null };
    expect(c1.cash_cents).toBeNull();
    expect(c1.cash_unavailable_reason).toBe('needs_books_cash_view');
    const p = await call<{ companies: Array<{ location_id: string }> }>('pm', `pm.res_owner_dashboard(null)`);
    expect(p.companies.map((c) => c.location_id)).not.toContain(L2);
    expect(await fails('labor', `pm.res_owner_dashboard(null)`)).toMatch(forbidden);
    expect(await fails('pm', `pm.res_owner_dashboard($1)`, [L2])).toMatch(forbidden);
  });
  it('the export manifest names every readable family, money tables through their masked views', async () => {
    const t = await call<Array<{ table: string; source: string }>>('labor', `pm.res_export_tables()`);
    const byName = new Map(t.map((x) => [x.source, x.table]));
    expect(byName.get('res_receipt_captures')).toBe('v_res_receipt_captures_masked');
    expect(byName.get('res_site_captures')).toBe('res_site_captures');
    expect(byName.has('access_table_classes')).toBe(false);
  });
});
