/**
 * Field-service completion (migration 1123) against a PGlite replay of every migration:
 * telephony ingest, two-way threads + inbound routing, 24 h / 2 h reminders with reply-to-confirm,
 * the outbox bridge, forms with required readings, structured notes, follow-up cadences, the
 * comfort-advisor pipeline, online estimate approval and the client hub (portal session), install
 * projects end to end, will-call, invoice review, sales tax by line, text-to-pay, financing,
 * timesheet exceptions, the billing-integrity auditor, dashboards / metrics, setup and shadow run —
 * and RLS / masking per persona.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { buildFixture, as, q, errorOf, type Fixture, type Persona, ORG_A, ORG_B, L1, L2, LB, J1, J2 } from './fixture';
import { applyMigration, listMigrationFiles } from './pg';

let f: Fixture;
const ids: Record<string, string> = {};
const WKEY = 'server-key-for-the-app-route-0001';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const forbidden = /PM_FORBIDDEN|permission denied|row-level security/i;

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(f.db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}
const call = <T = unknown>(p: Persona, sql: string, params: unknown[] = []): Promise<T> =>
  as(f, p, async () => (await q<{ r: T }>(f.db, `select ${sql} as r`, params))[0]!.r);
const callErr = (p: Persona, sql: string, params: unknown[] = []): Promise<string | null> => as(f, p, () => errorOf(f.db, `select ${sql}`, params));

async function anon<T>(fn: () => Promise<T>): Promise<T> {
  await f.db.query(`select set_config('request.jwt.claims', '{}', false)`);
  await f.db.exec('set role anon');
  try {
    return await fn();
  } finally {
    await f.db.exec('reset role');
  }
}
const anonRpc = async <T = unknown>(sql: string, params: unknown[] = []): Promise<T> => anon(async () => (await q<{ r: T }>(f.db, `select ${sql} as r`, params))[0]!.r);
const anonErr = (sql: string, params: unknown[] = []) => anon(() => errorOf(f.db, `select ${sql}`, params));

const skipped: string[] = [];
async function applyAll(): Promise<void> {
  for (const file of listMigrationFiles().filter((x) => parseInt(x, 10) > 1110)) {
    const n = parseInt(file, 10);
    try {
      await applyMigration(f.db, file);
    } catch (e) {
      if ([1111, 1112, 1113, 1114, 1117, 1118, 1119, 1123].includes(n)) throw e;
      skipped.push(`${file}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  if (skipped.length) console.warn(`[fieldservice-completion] skipped in-progress migrations:\n  ${skipped.join('\n  ')}`);
}

function tomorrowAt(hourUtc: number, days = 1): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

beforeAll(async () => {
  f = await buildFixture();
  await applyAll();
  await f.db.query(`insert into pm.fs_widget_server_keys (key_hash, note) values ($1, 'test route') on conflict do nothing`, [sha(WKEY)]);
  await f.db.query(`insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, core_status, is_initial)
                    select org_id, location_id, id, 'm', 'active', 'Active', 'ACTIVE', true from pm.pack_installs p where location_id in ($1, $2)
                     and not exists (select 1 from pm.stage_defs s where s.install_id = p.id and s.stage_key = 'active')`, [L1, L2]);
  await f.db.query(`insert into core.sms_sender_numbers (org_id, location_id, phone, status, provider_sid, verified_at) values ($1, $2, '+15155550000', 'verified', 'PN-test', now())`, [ORG_A, L1]);
  await as(f, 'owner', async () => {
    await f.db.query(`select pm.fs_seed_field_service($1)`, [L1]);
    await f.db.query(`select pm.fs_seed_completion($1)`, [L1]);
    await f.db.query(`select pm.notify_configure($1, '{"customer_messages_live": true}'::jsonb)`, [L1]);
  });
  await f.db.query(`update core.notification_settings set sms_from_number = '+15155550000', sms_enabled = true where org_id = $1 and location_id = $2`, [ORG_A, L1]);
  ids.cust = (await one<{ id: string }>(`insert into core.customers (org_id, name, phone, state, city, zip) values ($1, 'Pat Homeowner', '515-555-0101', 'IA', 'Des Moines', '50310') returning id`, [ORG_A])).id;
  ids.contact = (await one<{ id: string }>(`insert into core.contacts (org_id, customer_id, first_name, phone, email, sms_consent, email_consent, is_primary)
                                            values ($1, $2, 'Pat', '515-555-0101', 'pat@home.test', true, true, true) returning id`, [ORG_A, ids.cust])).id;
  ids.site = (await one<{ id: string }>(`insert into core.sites (org_id, customer_id, location_id, address_line1, city, state, zip) values ($1, $2, $3, '1 Elm St', 'Des Moines', 'IA', '50310') returning id`, [ORG_A, ids.cust, L1])).id;
  await f.db.query(`update core.jobs set customer_id = $1 where id = $2`, [ids.cust, J2]);
  ids.wo2 = f.ids[`wo:${J2}`]!;
  await f.db.query(`update pm.work_orders set site_id = $1 where id = $2`, [ids.site, ids.wo2]);
  await f.db.query(`insert into pm.tech_profiles (org_id, location_id, employee_id, display_name) values ($1, $2, $3, 'Lee') on conflict do nothing`, [ORG_A, L1, f.employee.labor]);
  // Books rate table: state 6 %, Des Moines zip 7 %
  await f.db.query(`insert into public.sales_tax_rates (org_id, state, jurisdiction_label, combined_rate_pct, effective_date) values ($1, 'IA', 'Iowa', 6, '2020-01-01')`, [ORG_A]);
  await f.db.query(`insert into public.sales_tax_rates (org_id, state, city, postal_code, jurisdiction_label, combined_rate_pct, effective_date) values ($1, 'IA', 'Des Moines', '50310', 'Des Moines IA', 7, '2020-01-01')`, [ORG_A]);
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('migration 1123 registers with the 1110 access foundation', () => {
  it('every pm table classified, every member definer RPC guarded, nothing in pm for anon, no unprotected public/core table', async () => {
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    expect(await q(f.db, `select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'pm' and has_function_privilege('anon', p.oid, 'execute')`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
  });
  it('is idempotent (re-applying changes no seeded counts)', async () => {
    const before = await one<{ n: number }>(`select (select count(*) from pm.fs_form_templates) + (select count(*) from pm.access_rpc_guards) + (select count(*) from pm.fs_message_templates) as n`);
    await applyMigration(f.db, '1123_pm_field_service_completion.sql');
    await as(f, 'owner', () => f.db.query(`select pm.fs_seed_completion($1)`, [L1]));
    const after = await one<{ n: number }>(`select (select count(*) from pm.fs_form_templates) + (select count(*) from pm.access_rpc_guards) + (select count(*) from pm.fs_message_templates) as n`);
    expect(Number(after.n)).toBe(Number(before.n));
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
  });
});

describe('FS-05 telephony and call tracking', () => {
  it('the webhook ingest fails closed without the server key and ignores a provider that is not switched on', async () => {
    expect(await anonErr(`public.fs_voice_event($1, 'RINGCENTRAL', $2::jsonb)`, ['nope-nope-nope-nope', JSON.stringify({ call_id: 'c1', from: '5155550101', to: '5155550000' })])).toMatch(/FS_WIDGET_KEY/);
    const r = await anonRpc<{ status: string }>(`public.fs_voice_event($1, 'RINGCENTRAL', $2::jsonb)`, [WKEY, JSON.stringify({ call_id: 'c1', from: '5155550101', to: '5155559999' })]);
    expect(r.status).toBe('ignored');
  });
  it('H1: nothing the caller says turns a provider on — only numbers the platform verified for this company', async () => {
    // no verified number yet: refused, whatever the app claims about credentials
    expect(await callErr('owner', `pm.fs_set_phone_provider($1, 'RINGCENTRAL', true, array['5155559999'])`, [L1])).toMatch(/PM_FS_PROVIDER_CREDENTIALS/);
    expect(await callErr('dispatcher', `pm.fs_set_phone_provider($1, 'RINGCENTRAL', true, array['5155559999'])`, [L1])).toMatch(forbidden);
    // members can neither read nor write the registry
    expect(await callErr('owner', `(select count(*) from pm.fs_voice_numbers)`)).toMatch(/permission denied/);
    expect(await as(f, 'owner', () => errorOf(f.db, `insert into pm.fs_voice_numbers (phone, org_id, location_id, provider, verified_at) values ('+15155559999', $1, $2, 'RINGCENTRAL', now())`, [ORG_A, L1]))).toMatch(/permission denied/);
    // the platform registers and verifies them (service role)
    await f.db.query(`insert into pm.fs_voice_numbers (phone, org_id, location_id, provider, verified_at) values
      ('+15155559999', $1, $2, 'RINGCENTRAL', now()), ('+15155557777', $1, $2, 'RINGCENTRAL', now()), ('+15155556666', $1, $2, 'RINGCENTRAL', null)`, [ORG_A, L1]);
    expect(await callErr('owner', `pm.fs_set_phone_provider($1, 'RINGCENTRAL', true, array['5155556666'])`, [L1])).toMatch(/PM_FS_NUMBER_NOT_REGISTERED/);
    expect(await callErr('owner', `pm.fs_set_phone_provider($1, 'RINGCENTRAL', true, array['5155550123'])`, [L1])).toMatch(/PM_FS_NUMBER_NOT_REGISTERED/);
    expect(await callErr('owner', `pm.fs_set_phone_provider($1, 'DIALPAD', true, null)`, [L1])).toMatch(/PM_FS_PROVIDER_CREDENTIALS/);
    const p = await call<{ status: string; main_numbers: string[] }>('owner', `pm.fs_set_phone_provider($1, 'RINGCENTRAL', true, array['(515) 555-9999'])`, [L1]);
    expect(p).toMatchObject({ status: 'ACTIVE', main_numbers: ['+15155559999'] });
  });
  it('H1: a tracking number must be a verified number of the same company; another org cannot claim it', async () => {
    expect(await as(f, 'owner', () => errorOf(f.db, `insert into pm.campaigns (org_id, location_id, code, name, channel, tracking_phone) values ($1, $2, 'BAD1', 'Unverified', 'LSA', '515-555-6666')`, [ORG_A, L1]))).toMatch(/PM_FS_NUMBER_NOT_REGISTERED/);
    const bLoc = LB;
    expect(await errorOf(f.db, `insert into pm.campaigns (org_id, location_id, code, name, channel, tracking_phone) values ($1, $2, 'HIJACK', 'Hijack', 'LSA', '515-555-7777')`, [ORG_B, bLoc])).toMatch(/PM_FS_NUMBER_NOT_REGISTERED/);
    expect(await errorOf(f.db, `insert into pm.campaigns (org_id, location_id, code, name, channel, tracking_phone) values ($1, $2, 'L2X', 'Other company', 'LSA', '515-555-7777')`, [ORG_A, L2])).toMatch(/PM_FS_NUMBER_NOT_REGISTERED/);
    // an ignored event is logged for the platform
    await anonRpc(`public.fs_voice_event($1, 'RINGCENTRAL', $2::jsonb)`, [WKEY, JSON.stringify({ call_id: 'c-unreg', from: '5155550101', to: '5155550123' })]);
    expect((await one<{ reason: string }>(`select reason from pm.fs_voice_event_log where provider_call_id = 'c-unreg'`)).reason).toMatch(/not registered/);
  });
  it('a call from a known customer is logged once per provider call id, matched to the customer and the tracking campaign', async () => {
    await f.db.query(`insert into pm.campaigns (org_id, location_id, code, name, channel, tracking_phone) values ($1, $2, 'LSA1', 'Google LSA', 'LSA', '515-555-7777')`, [ORG_A, L1]);
    const ev = (o: Record<string, unknown>) => anonRpc<{ status: string; id: string; customer_id: string; campaign_id: string | null }>(
      `public.fs_voice_event($1, 'RINGCENTRAL', $2::jsonb)`, [WKEY, JSON.stringify({ call_id: 'rc-1', direction: 'INBOUND', from: '+15155550101', to: '+15155557777', ...o })]);
    const a = await ev({ outcome: 'IN_PROGRESS' });
    expect(a.status).toBe('recorded');
    expect(a.customer_id).toBe(ids.cust);
    expect(a.campaign_id).not.toBeNull();
    const b = await ev({ outcome: 'ANSWERED', duration_seconds: 185, recording_ref: 'rec-1' });
    expect(b.id).toBe(a.id);
    const row = await one<{ n: number; outcome: string; duration_seconds: number }>(`select count(*)::int n, max(outcome) outcome, max(duration_seconds) duration_seconds from pm.fs_call_log where provider_call_id = 'rc-1'`);
    expect(row).toMatchObject({ n: 1, outcome: 'ANSWERED', duration_seconds: 185 });
    ids.callLog = a.id;
  });
  it('L3: a late, older provider event never overwrites a newer outcome', async () => {
    const ev = (o: Record<string, unknown>) => anonRpc(`public.fs_voice_event($1, 'RINGCENTRAL', $2::jsonb)`,
      [WKEY, JSON.stringify({ call_id: 'rc-order', direction: 'INBOUND', from: '+15155550101', to: '+15155559999', ...o })]);
    await ev({ outcome: 'ANSWERED', duration_seconds: 90, event_at: '2026-10-25T15:05:00Z' });
    await ev({ outcome: 'MISSED', duration_seconds: 0, event_at: '2026-10-25T15:01:00Z' });
    expect(await one<{ outcome: string; duration_seconds: number }>(`select outcome, duration_seconds from pm.fs_call_log where provider_call_id = 'rc-order'`)).toMatchObject({ outcome: 'ANSWERED', duration_seconds: 90 });
    await ev({ outcome: 'VOICEMAIL', event_at: '2026-10-25T15:09:00Z' });
    expect((await one<{ outcome: string }>(`select outcome from pm.fs_call_log where provider_call_id = 'rc-order'`)).outcome).toBe('VOICEMAIL');
  });
  it('dispatch reads and links calls; a technician cannot', async () => {
    expect((await as(f, 'dispatcher', () => q(f.db, `select id from pm.fs_call_log where provider_call_id = 'rc-1'`))).length).toBe(1);
    expect(await as(f, 'labor', () => q(f.db, `select id from pm.fs_call_log`))).toEqual([]);
    expect(await call('dispatcher', `pm.fs_link_call($1, null, $2)`, [ids.callLog, ids.wo2])).toBe(ids.callLog);
    expect(await callErr('labor', `pm.fs_link_call($1, null, $2)`, [ids.callLog, ids.wo2])).toMatch(forbidden);
    const rep = await call<{ rows: Array<{ campaign: string; calls: number; booked: number }> }>('owner', `pm.fs_call_report($1, null, null)`, [L1]);
    expect(rep.rows[0]).toMatchObject({ campaign: 'Google LSA', calls: 1, booked: 1 });
  });
});

describe('FS-12 two-way messaging', () => {
  it('a CSR texts the customer through the notifications service; the thread records it', async () => {
    const r = await call<{ thread_id: string; status: string }>('dispatcher', `pm.fs_send_message($1, $2, $3, 'SMS', 'Hi {first_name}, this is {company}.')`, [L1, ids.cust, J2]);
    expect(r.status).toBe('QUEUED');
    ids.thread = r.thread_id;
    const o = await one<{ body: string; event_type: string }>(`select body, event_type from core.outbound_messages where contact_id = $1 order by created_at desc limit 1`, [ids.contact]);
    expect(o).toMatchObject({ event_type: 'customer.message' });
    expect(o.body).toMatch(/^Hi Pat, this is /);
  });
  it('a tech texts only from their own visit', async () => {
    expect(await callErr('labor', `pm.fs_send_message($1, $2, $3, 'SMS', 'On the way')`, [L1, ids.cust, J2])).toMatch(forbidden);
    const r = await call<{ status: string }>('labor', `pm.fs_send_message($1, $2, $3, 'SMS', 'On the way', null, null, $4)`, [L1, ids.cust, J2, ids.wo2]);
    expect(r.status).toBe('QUEUED');
    expect(await callErr('bOwner', `pm.fs_send_message($1, $2, $3, 'SMS', 'x')`, [L1, ids.cust, J2])).toMatch(forbidden);
  });
  it('an inbound text lands on the open job thread (idempotent per provider id); STOP still applies', async () => {
    const r = await anonRpc<{ routed: boolean; thread_id: string; intent: string }>(`public.fs_inbound_sms($1, '+15155550101', '+15155550000', 'Is the tech still coming?', 'SM1')`, [WKEY]);
    expect(r).toMatchObject({ routed: true, thread_id: ids.thread, intent: 'OTHER' });
    await anonRpc(`public.fs_inbound_sms($1, '+15155550101', '+15155550000', 'Is the tech still coming?', 'SM1')`, [WKEY]);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.fs_thread_messages where provider_sid = 'SM1'`)).n).toBe(1);
    expect((await one<{ unread_count: number }>(`select unread_count from pm.fs_threads where id = $1`, [ids.thread])).unread_count).toBe(1);
    expect(await call('dispatcher', `pm.fs_mark_thread($1, 'READ')`, [ids.thread])).toBe(ids.thread);
    expect(await anonErr(`public.fs_inbound_sms('bad-key-bad-key-bad', '+15155550101', '+15155550000', 'x', 'SM2')`)).toMatch(/FS_WIDGET_KEY/);
  });
});

describe('FS-22 reminders with reply-to-confirm, and the outbox bridge', () => {
  beforeAll(async () => {
    await f.db.query(`update pm.fs_settings set quiet_start = '00:00', quiet_end = '00:00' where location_id = $1`, [L1]);
    ids.woRem = (await one<{ id: string }>(`insert into pm.work_orders (org_id, location_id, job_id, summary, status, requested_start, requested_end, site_id)
      values ($1, $2, $3, 'No cool', 'SCHEDULED', now() + interval '23 hours 30 minutes', now() + interval '25 hours', $4) returning id`, [ORG_A, L1, J2, ids.site])).id;
  });
  it('the 24 h reminder goes out once, through core.notify_customer, and waits for the reply', async () => {
    const a = await call<{ reminders: number; delivered: number }>('dispatcher', `pm.fs_run_automations($1)`, [L1]);
    expect(a.reminders).toBe(1);
    expect(a.delivered).toBeGreaterThanOrEqual(1);
    const r = await one<{ status: string; awaiting_reply: boolean; phone: string; outbound_id: string | null }>(
      `select r.status, r.awaiting_reply, r.phone, m.outbound_id from pm.fs_appointment_reminders r join pm.fs_messages m on m.id = r.fs_message_id
        where r.work_order_id = $1 and r.kind = 'REMINDER_24H'`, [ids.woRem]);
    expect(r).toMatchObject({ status: 'SENT', awaiting_reply: true, phone: '+15155550101' });
    expect(r.outbound_id).not.toBeNull();
    const again = await call<{ reminders: number }>('dispatcher', `pm.fs_run_automations($1)`, [L1]);
    expect(again.reminders).toBe(0);
    expect(await callErr('labor', `pm.fs_run_automations($1)`, [L1])).toMatch(forbidden);
  });
  it('replying C confirms the visit on the board and answers the customer', async () => {
    const r = await anonRpc<{ intent: string; reply: string }>(`public.fs_inbound_sms($1, '+15155550101', '+15155550000', 'c', 'SM3')`, [WKEY]);
    expect(r.intent).toBe('CONFIRM');
    expect(r.reply).toMatch(/confirmed/i);
    const w = await one<{ customer_confirmation: string }>(`select customer_confirmation from pm.work_orders where id = $1`, [ids.woRem]);
    expect(w.customer_confirmation).toBe('CONFIRMED');
  });
});

describe('FS-29 forms with required readings; FS-30/31 structured notes', () => {
  it('a missing required reading is refused; out-of-range readings are flagged; a command applies once', async () => {
    const t = await one<{ id: string }>(`select id from pm.fs_form_templates where location_id = $1 and key = 'ac_tune_up'`, [L1]);
    ids.tune = t.id;
    expect(await callErr('labor', `pm.fs_submit_form($1, $2, '{"superheat": 12}'::jsonb)`, [ids.wo2, t.id])).toMatch(/PM_FS_FORM_INCOMPLETE: required — Subcool/);
    const answers = { superheat: 12, subcool: 22, static_pressure: 0.5, temp_split: 18, compressor_amps: 14, capacitor: 'PASS', filter: 'FAIL' };
    const cmd = '11111111-1111-4111-8111-111111111111';
    const r = await call<{ id: string; out_of_range: Array<{ key: string }>; failed: string[] }>('labor', `pm.fs_submit_form($1, $2, $3::jsonb, null, null, '{}', $4)`, [ids.wo2, t.id, JSON.stringify(answers), cmd]);
    expect(r.out_of_range.map((x) => x.key)).toEqual(['subcool']);
    expect(r.failed).toEqual(['filter']);
    const dup = await call<{ id: string; duplicate: boolean }>('labor', `pm.fs_submit_form($1, $2, $3::jsonb, null, null, '{}', $4)`, [ids.wo2, t.id, JSON.stringify(answers), cmd]);
    expect(dup).toMatchObject({ id: r.id, duplicate: true });
    expect(await callErr('labor', `pm.fs_submit_form($1, $2, $3::jsonb)`, [f.ids[`wo:${J1}`], t.id, JSON.stringify(answers)])).toMatch(forbidden);
  });
  it('a red tag needs the customer signature and flags the visit for follow-up', async () => {
    const t = await one<{ id: string }>(`select id from pm.fs_form_templates where location_id = $1 and key = 'combustion_safety'`, [L1]);
    const a = { co_flue_ppm: 40, co_ambient_ppm: 50, heat_exchanger: 'PASS', venting: 'PASS', temp_rise: 45 };
    expect(await callErr('labor', `pm.fs_submit_form($1, $2, $3::jsonb)`, [ids.wo2, t.id, JSON.stringify(a)])).toMatch(/PM_FS_RED_TAG_SIGNATURE/);
    const r = await call<{ red_tag: boolean }>('labor', `pm.fs_submit_form($1, $2, $3::jsonb, 'Pat Homeowner')`, [ids.wo2, t.id, JSON.stringify(a)]);
    expect(r.red_tag).toBe(true);
    expect((await one<{ follow_up_required: boolean }>(`select follow_up_required from pm.work_orders where id = $1`, [ids.wo2])).follow_up_required).toBe(true);
    const forms = await call<Array<{ key: string; submitted: boolean }>>('labor', `pm.fs_forms_for_wo($1)`, [ids.wo2]);
    expect(forms.find((x) => x.key === 'combustion_safety')?.submitted).toBe(true);
  });
  it('a voice note writes the diagnosis and work performed onto the visit', async () => {
    await call('labor', `pm.fs_save_visit_note($1, 'VOICE', 'Found a weak capacitor. Replaced it.', $2::jsonb)`,
      [ids.wo2, JSON.stringify({ diagnosis: 'Weak run capacitor', work_performed: 'Replaced the run capacitor', recommendations: 'System is 16 years old — consider replacement', customer_summary: 'We replaced a failing part.' })]);
    const w = await one<{ cause: string; resolution: string }>(`select cause, resolution from pm.work_orders where id = $1`, [ids.wo2]);
    expect(w).toMatchObject({ cause: 'Weak run capacitor', resolution: 'Replaced the run capacitor' });
  });
});

describe('FS-56 / FS-57 / FS-95 presented estimate: follow-ups, pipeline, tax pinned at quote', () => {
  beforeAll(async () => {
    ids.eq = (await one<{ id: string }>(`insert into pm.price_book_items (org_id, location_id, code, name, kind, price_cents, cost_cents, member_price_cents)
      values ($1, $2, 'EQ-AC3', '3-ton 16 SEER2 AC + coil', 'EQUIPMENT', 650000, 380000, 640000) returning id`, [ORG_A, L1])).id;
    ids.cap = (await one<{ id: string }>(`select id from pm.price_book_items where location_id = $1 and code = 'HV-CAP'`, [L1])).id;
    const opts = [
      { tier: 'GOOD', name: 'Repair', items: [{ price_book_item_id: ids.cap }] },
      { tier: 'BEST', name: 'New system', items: [{ price_book_item_id: ids.eq }, { description: 'Install labor', unit_price_cents: 150000 },
        { description: 'Surge protector', unit_price_cents: 25000, optional: true }] },
    ];
    ids.est = await call<string>('labor', `pm.fs_build_estimate($1, 'Repair or replace', $2::jsonb, false)`, [ids.wo2, JSON.stringify(opts)]);
    // a tech-generated lead on this visit becomes a pipeline lead (FS-57)
    await call('labor', `pm.fs_set_tgl($1, '16-year-old R-22 system', 'HIGH')`, [ids.wo2]);
    await call('labor', `pm.fs_present_estimate($1)`, [ids.est]);
  });
  it('presenting starts the cadence and the pipeline row moves to PROPOSAL', async () => {
    const fu = await q<{ step_no: number; channel: string }>(f.db, `select step_no, channel from pm.fs_estimate_followups where estimate_id = $1 order by step_no`, [ids.est]);
    expect(fu.map((x) => x.channel)).toEqual(['SMS', 'CALL_TASK', 'EMAIL', 'SMS']);
    const o = await one<{ stage: string; source: string }>(`select stage, source from pm.fs_opportunities where estimate_id = $1`, [ids.est]);
    expect(o).toMatchObject({ stage: 'PROPOSAL', source: 'TGL' });
  });
  it('a due step is sent; the queue shows the estimate with its next step', async () => {
    await f.db.query(`update pm.fs_estimate_followups set due_at = now() - interval '1 minute' where estimate_id = $1 and step_no = 1`, [ids.est]);
    await call('dispatcher', `pm.fs_run_automations($1)`, [L1]);
    expect((await one<{ status: string }>(`select status from pm.fs_estimate_followups where estimate_id = $1 and step_no = 1`, [ids.est])).status).toBe('SENT');
    const qd = await call<Array<{ id: string; touches: number; next_step: { channel: string } }>>('dispatcher', `pm.fs_followup_queue($1)`, [L1]);
    const row = qd.find((x) => x.id === ids.est);
    expect(row?.touches).toBe(1);
    expect(row?.next_step.channel).toBe('CALL_TASK');
    expect(await callErr('labor', `pm.fs_followup_queue($1)`, [L1])).toMatch(forbidden);
  });
  it('tax is computed per line from the Books rate table (zip beats state) and equipment is taxable, service is not', async () => {
    const t = await call<{ rate_pct: string; jurisdiction: string; options: Array<{ option_id: string; tax_cents: number }> }>('labor', `pm.fs_quote_tax($1)`, [ids.est]);
    expect(Number(t.rate_pct)).toBe(7);
    expect(t.jurisdiction).toBe('Des Moines IA');
    const best = await one<{ id: string }>(`select id from pm.fs_estimate_options where estimate_id = $1 and tier = 'BEST'`, [ids.est]);
    ids.bestOpt = best.id;
    // 650 000 × 7 % = 45 500 (install labor and the unselected add-on are not taxed)
    expect(Number(t.options.find((x) => x.option_id === best.id)?.tax_cents)).toBe(45500);
  });
  it('the advisor pipeline counts TGL sources; a tech cannot read it', async () => {
    const p = await call<{ by_source: Array<{ source: string; opportunities: number }>; open: Array<{ id: string }> }>('owner', `pm.fs_advisor_pipeline($1)`, [L1]);
    expect(p.by_source.find((x) => x.source === 'TGL')?.opportunities).toBe(1);
    expect(await callErr('labor', `pm.fs_advisor_pipeline($1)`, [L1])).toMatch(forbidden);
  });
});

describe('FS-59 / FS-115 portal: client hub and online approval', () => {
  const token = randomBytes(32).toString('base64url');
  beforeAll(async () => {
    const person = await one<{ id: string }>(`insert into pm.portal_people (email, phone, display_name) values ('pat@home.test', '+15155550101', 'Pat') returning id`);
    const g = await one<{ id: string }>(`insert into pm.portal_grants (org_id, location_id, person_id, contact_id, audience, customer_id, display_name, email, phone, role, can_sign, can_pay)
      values ($1, $2, $3, $4, 'customer', $5, 'Pat Homeowner', 'pat@home.test', '+15155550101', 'approver', true, true) returning id`, [ORG_A, L1, person.id, ids.contact, ids.cust]);
    await f.db.query(`insert into pm.portal_grant_jobs (org_id, grant_id, job_id) values ($1, $2, $3)`, [ORG_A, g.id, J2]);
    await f.db.query(`insert into pm.portal_sessions (person_id, token_hash, auth_method, org_id, verified_email, verified_phone, phone_verified_at, expires_at)
      values ($1, $2, 'sms', $3, 'pat@home.test', '+15155550101', now(), now() + interval '1 day')`, [person.id, sha(token), ORG_A]);
  });
  it('the hub shows visits, the presented estimate and no cost anywhere', async () => {
    const h = await anonRpc<{ visits: Array<{ id: string }>; estimates: Array<{ id: string }> }>(`portal.fs_hub($1, $2)`, [token, ORG_A]);
    expect(h.visits.map((v) => v.id)).toContain(ids.wo2);
    expect(h.estimates.map((e) => e.id)).toEqual([ids.est]);
    expect(JSON.stringify(h)).not.toMatch(/cost|margin/);
    expect(await anonErr(`portal.fs_hub($1, $2)`, ['x'.repeat(40), ORG_A])).toMatch(/PORTAL_AUTH/);
  });
  it('the customer reviews options (sell only), ticks an add-on and signs', async () => {
    const e = await anonRpc<{ can_accept: boolean; options: Array<{ id: string; items: Array<{ id: string; optional: boolean }> }> }>(`portal.fs_estimate($1, $2, $3)`, [token, ORG_A, ids.est]);
    expect(e.can_accept).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(/cost/);
    const addOn = e.options.find((o) => o.id === ids.bestOpt)!.items.find((i) => i.optional)!.id;
    expect(await anonErr(`portal.fs_estimate_accept($1, $2, $3, $4, '{}', 'Pat Homeowner', false)`, [token, ORG_A, ids.est, ids.bestOpt])).toMatch(/PORTAL_INVALID/);
    const r = await anonRpc<{ status: string; total_cents: number }>(`portal.fs_estimate_accept($1, $2, $3, $4, $5::uuid[], 'Pat Homeowner', true, '10.0.0.1', 'vitest')`,
      [token, ORG_A, ids.est, ids.bestOpt, [addOn]]);
    expect(r.status).toBe('received');
    expect(Number(r.total_cents)).toBe(650000 + 150000 + 25000);
    ids.acceptance = (await one<{ id: string }>(`select id from pm.fs_online_acceptances where estimate_id = $1 and status = 'PENDING'`, [ids.est])).id;
  });
  it('staff finalize the online acceptance: sold, install project, financing record, pipeline SOLD, follow-ups stopped', async () => {
    const plan = await one<{ id: string }>(`select id from pm.financing_plans where location_id = $1 order by created_at limit 1`, [L1]);
    expect(await callErr('labor', `pm.fs_finalize_online_acceptance($1)`, [ids.acceptance])).toMatch(forbidden);
    await call('owner', `pm.fs_finalize_online_acceptance($1, 0, false, $2)`, [ids.acceptance, plan.id]);
    expect((await one<{ status: string }>(`select status from pm.fs_estimates where id = $1`, [ids.est])).status).toBe('SOLD');
    const p = await one<{ id: string; stage: string; contract_cents: number; install_work_order_id: string }>(`select id, stage, contract_cents, install_work_order_id from pm.fs_install_projects where estimate_id = $1`, [ids.est]);
    expect(p.stage).toBe('SOLD');
    expect(Number(p.contract_cents)).toBe(825000);
    ids.project = p.id; ids.installWo = p.install_work_order_id;
    expect((await one<{ n: number }>(`select count(*)::int n from pm.fs_install_items where project_id = $1`, [p.id])).n).toBe(3);
    const fin = await one<{ id: string; amount_financed_cents: number; status: string }>(`select id, amount_financed_cents, status from pm.fs_financed_sales where estimate_id = $1`, [ids.est]);
    expect(Number(fin.amount_financed_cents)).toBe(825000);
    ids.fin = fin.id;
    expect((await one<{ stage: string }>(`select stage from pm.fs_opportunities where estimate_id = $1`, [ids.est])).stage).toBe('SOLD');
    expect((await one<{ n: number }>(`select count(*)::int n from pm.fs_estimate_followups where estimate_id = $1 and status in ('SCHEDULED','DUE')`, [ids.est])).n).toBe(0);
  });
  it('the customer confirms the install visit from the hub', async () => {
    const r = await anonRpc<{ status: string }>(`portal.fs_confirm_visit($1, $2, $3, 'RESCHEDULE', 'Mornings only')`, [token, ORG_A, ids.installWo]);
    expect(r.status).toBe('reschedule_requested');
  });
});

describe('FS-79 … FS-86 / FS-90 install project end to end', () => {
  it('equipment PO (will-call), approved, picked up at the counter with serials', async () => {
    ids.vendor = (await one<{ id: string }>(`insert into core.vendors (org_id, name) values ($1, 'Johnstone Supply') returning id`, [ORG_A])).id;
    expect(await callErr('labor', `pm.fs_install_po($1, $2, 'WILL_CALL')`, [ids.project, ids.vendor])).toMatch(forbidden);
    ids.po = await call<string>('owner', `pm.fs_install_po($1, $2, 'WILL_CALL', current_date + 3)`, [ids.project, ids.vendor]);
    expect((await one<{ stage: string }>(`select stage from pm.fs_install_projects where id = $1`, [ids.project])).stage).toBe('ORDERED');
    const lines = await q<{ id: string; amount_cents: number }>(f.db, `select id, amount_cents from pm.commitment_lines where commitment_id = $1`, [ids.po]);
    expect(lines.length).toBe(1);
    expect(Number(lines[0]!.amount_cents)).toBe(380000);
    expect(await callErr('labor', `pm.fs_receive_po($1, $2::jsonb, '000000')`, [ids.po, JSON.stringify([{ line_id: lines[0]!.id, qty: 1 }])])).toMatch(/PM_FS_PICKUP_CODE|PM_FS_PO_NOT_APPROVED/);
    await f.db.exec(`set session_replication_role = replica`);
    try {
      await f.db.query(`update pm.commitments set status = 'APPROVED', approved_at = now(), approved_by = 'user_owner' where id = $1`, [ids.po]);
    } finally {
      await f.db.exec(`set session_replication_role = origin`);
    }
    const mine = await call<Array<{ commitment_id: string; pickup_code: string; ready: boolean }>>('labor', `pm.fs_my_will_calls()`);
    const wc = mine.find((x) => x.commitment_id === ids.po)!;
    expect(wc.ready).toBe(true);
    expect(JSON.stringify(mine)).not.toMatch(/cents/);
    // nested-guard audit: with only the pickup code, no more than ordered, and only once
    expect(await callErr('labor', `pm.fs_receive_po($1, $2::jsonb, $3)`, [ids.po, JSON.stringify([{ line_id: lines[0]!.id, qty: 2 }]), wc.pickup_code])).toMatch(/more than was ordered/);
    const r = await call<{ serials: number }>('labor', `pm.fs_receive_po($1, $2::jsonb, $3)`, [ids.po, JSON.stringify([{ line_id: lines[0]!.id, qty: 1, serials: ['SN-AC-0001'], make: 'Trane' }]), wc.pickup_code]);
    expect(r.serials).toBe(1);
    expect(await callErr('labor', `pm.fs_receive_po($1, $2::jsonb, $3)`, [ids.po, JSON.stringify([{ line_id: lines[0]!.id, qty: 1 }]), wc.pickup_code])).toMatch(/already picked up/);
    expect((await one<{ status: string }>(`select status from pm.fs_serial_units where serial = 'SN-AC-0001'`)).status).toBe('ON_TRUCK');
  });
  it('permit from the jurisdiction template; issued moves the board', async () => {
    const permit = await call<string>('owner', `pm.fs_apply_permit($1, null, 'M-2026-77', current_date)`, [ids.project]);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.res_inspections where permit_id = $1`, [permit])).n).toBe(1);
    await call('owner', `pm.fs_update_permit($1, 'ISSUED')`, [permit]);
    expect((await one<{ stage: string }>(`select stage from pm.fs_install_projects where id = $1`, [ids.project])).stage).toBe('PERMITTED');
  });
  it('crew scheduling honours weekly install capacity; override needs a reason', async () => {
    const e = await call<{ date: string }>('dispatcher', `pm.fs_install_earliest($1)`, [ids.project]);
    expect(e.date).toBeTruthy();
    const mon = await one<{ d: string }>(`select (current_date + (8 - extract(isodow from current_date)::int))::text as d`);
    await f.db.query(`insert into pm.fs_install_capacity (org_id, location_id, week_start, crew_days) values ($1, $2, $3::date, 1)`, [ORG_A, L1, mon.d]);
    expect(await callErr('dispatcher', `pm.fs_schedule_install($1, $2::date, 2, null, $3)`, [ids.project, mon.d, f.employee.labor])).toMatch(/PM_FS_INSTALL_CAPACITY/);
    const s = await call<{ dates: string[] }>('dispatcher', `pm.fs_schedule_install($1, $2::date, 2, null, $3, '{}', 'Customer asked for this week')`, [ids.project, mon.d, f.employee.labor]);
    expect(s.dates.length).toBe(2);
    expect((await one<{ stage: string }>(`select stage from pm.fs_install_projects where id = $1`, [ids.project])).stage).toBe('SCHEDULED');
    expect((await one<{ n: number }>(`select count(*)::int n from pm.dispatch_assignments where work_order_id = $1 and status <> 'CANCELLED'`, [ids.installWo])).n).toBe(2);
    expect(await callErr('labor', `pm.fs_schedule_install($1, $2::date, 1, null, $3)`, [ids.project, mon.d, f.employee.labor])).toMatch(forbidden);
  });
  it('commissioning + walkthrough creates the equipment record; closing waits for registration and the final invoice', async () => {
    const t = await one<{ id: string }>(`select id from pm.fs_form_templates where location_id = $1 and key = 'hvac_commissioning'`, [L1]);
    const answers = { charge_verified: 'PASS', superheat: 10, subcool: 10, airflow_cfm: 1200, static_pressure: 0.5, thermostat: 'PASS', condensate: 'PASS',
                      install_photos: ['22222222-2222-4222-8222-222222222222'], walkthrough: 'PASS' };
    expect(await callErr('labor', `pm.fs_submit_form($1, $2, $3::jsonb)`, [ids.installWo, t.id, JSON.stringify(answers)])).toMatch(/PM_FS_FORM_SIGNATURE/);
    const sub = await call<{ id: string }>('labor', `pm.fs_submit_form($1, $2, $3::jsonb, 'Pat Homeowner')`, [ids.installWo, t.id, JSON.stringify(answers)]);
    const c = await call<{ assets: string[] }>('labor', `pm.fs_commission_install($1, $2, $3::jsonb, 'Pat Homeowner')`,
      [ids.project, sub.id, JSON.stringify([{ serial: 'SN-AC-0001', make: 'Trane', model: '4TTR6036', equipment_type: 'AC_CONDENSER', tonnage: 3 }])]);
    expect(c.assets.length).toBe(1);
    const a = await one<{ registration_status: string; parts_warranty_ends_on: string }>(`select registration_status, parts_warranty_ends_on::text from pm.assets where id = $1`, [c.assets[0]]);
    expect(a.registration_status).toBe('PENDING');
    expect((await one<{ status: string }>(`select status from pm.fs_serial_units where serial = 'SN-AC-0001'`)).status).toBe('INSTALLED');
    expect(await callErr('owner', `pm.fs_set_install_stage($1, 'CLOSED')`, [ids.project])).toMatch(/register SN-AC-0001/);
    await f.db.query(`update pm.assets set registration_status = 'REGISTERED' where id = $1`, [c.assets[0]]);
    expect(await callErr('owner', `pm.fs_set_install_stage($1, 'CLOSED')`, [ids.project])).toMatch(/final invoice/);
  });
  it('billing: progress then final for the rest of the sold total; costing compares estimate to Books cost', async () => {
    const p = await call<{ amount_cents: number }>('owner', `pm.fs_install_bill($1, 'PROGRESS', null, 0.5)`, [ids.project]);
    expect(Number(p.amount_cents)).toBe(412500);
    expect(await callErr('owner', `pm.fs_install_bill($1, 'PROGRESS', 500000)`, [ids.project])).toMatch(/more than the sold total/);
    const fin = await call<{ amount_cents: number; billing_request_id: string }>('owner', `pm.fs_install_bill($1, 'FINAL')`, [ids.project]);
    expect(Number(fin.amount_cents)).toBe(412500);
    expect(await call('owner', `pm.fs_set_install_stage($1, 'CLOSED')`, [ids.project])).toMatchObject({ stage: 'CLOSED' });
    await f.db.query(`insert into pm.job_costs (org_id, job_id, location_id, source_ref, cost_type, amount_cents, lifecycle, occurred_on, last_event_id, last_event_at, last_lifecycle_rank, first_event_at)
                      values ($1, $2, $3, 'bill:1', 'EQUIPMENT', 410000, 'CLEARED', current_date, gen_random_uuid(), now(), 2, now())`, [ORG_A, J2, L1]);
    const cost = await call<{ estimated: Record<string, number>; actual: Record<string, number>; variances: Array<{ category: string; explanation: string }> }>('owner', `pm.fs_install_costing($1)`, [ids.project]);
    expect(Number(cost.estimated.equipment)).toBe(380000);
    expect(Number(cost.actual.equipment)).toBe(410000);
    expect(cost.variances.find((v) => v.category === 'equipment')?.explanation).toMatch(/Equipment ran over the estimate by \$300\.00/);
    expect(await callErr('dispatcher', `pm.fs_install_costing($1)`, [ids.project])).toMatch(forbidden);
  });
  it('the board strips the contract value for a dispatcher', async () => {
    const own = await call<Array<{ id: string; contract_cents: number | null }>>('owner', `pm.fs_install_board($1)`, [L1]);
    expect(Number(own.find((x) => x.id === ids.project)?.contract_cents)).toBe(825000);
    const disp = await call<Array<{ id: string; contract_cents: number | null }>>('dispatcher', `pm.fs_install_board($1)`, [L1]);
    expect(disp.find((x) => x.id === ids.project)?.contract_cents).toBeNull();
    // masked view: the install items' cost is hidden from the dispatcher
    const items = await as(f, 'dispatcher', () => q<{ unit_cost_cents: number | null; unit_price_cents: number | null }>(f.db, `select unit_cost_cents, unit_price_cents from pm.v_fs_install_items_masked where project_id = $1`, [ids.project]));
    expect(items.length).toBe(3);
    expect(items.every((i) => i.unit_cost_cents === null && i.unit_price_cents === null)).toBe(true);
  });
});

describe('FS-94 invoice review, FS-95 tax at invoice = tax at quote, FS-96 text-to-pay', () => {
  beforeAll(async () => {
    // a part came off the truck and is not on the invoice
    ids.truck = (await one<{ id: string }>(`insert into pm.stock_locations (org_id, location_id, code, name, kind) values ($1, $2, 'T1', 'Truck 1', 'TRUCK') returning id`, [ORG_A, L1])).id;
    const item = await one<{ id: string }>(`insert into core.items (org_id, name, sku, item_type) values ($1, 'Contactor 30A', 'CONT-30', 'INVENTORY') returning id`, [ORG_A]);
    await f.db.query(`insert into pm.material_moves (org_id, location_id, kind, item_id, description, qty, from_stock_location_id, job_id, work_order_id, source_ref)
                      values ($1, $2, 'ISSUE', $6, 'Contactor 30A', 1, $3, $4, $5, 'mm:test:1')`, [ORG_A, L1, ids.truck, J2, ids.wo2, item.id]);
    await f.db.query(`update pm.work_orders set status = 'COMPLETE', completed_at = now() where id = $1`, [ids.wo2]);
    ids.review = (await one<{ id: string }>(`select id from pm.fs_invoice_reviews where work_order_id = $1`, [ids.wo2])).id;
  });
  it('a completed visit enters the queue with rule flags', async () => {
    const r = await one<{ status: string; flags: Array<{ code: string; severity: string }>; blocking_count: number }>(`select status, flags, blocking_count from pm.fs_invoice_reviews where id = $1`, [ids.review]);
    expect(r.status).toBe('FLAGGED');
    expect(r.flags.map((x) => x.code)).toContain('PARTS_NOT_BILLED');
    expect(r.blocking_count).toBeGreaterThanOrEqual(1);
  });
  it('the invoice uses the rate pinned at quote; the equipment line is taxed at 7 %', async () => {
    const s = await one<{ rate_pct: string; tax_cents: number }>(`select s.rate_pct, s.tax_cents from pm.fs_tax_snapshots s join pm.fs_invoice_reviews r on r.tax_snapshot_id = s.id where r.id = $1`, [ids.review]);
    expect(Number(s.rate_pct)).toBe(7);
    expect(Number(s.tax_cents)).toBe(45500);
  });
  it('a CSR sees the queue without totals and cannot send it to Books; blocking flags need an approver override', async () => {
    const qd = await call<Array<{ id: string; total_cents: number | null }>>('dispatcher', `pm.fs_review_queue($1)`, [L1]);
    expect(qd.find((x) => x.id === ids.review)?.total_cents).toBeNull();
    expect(await callErr('dispatcher', `pm.fs_decide_review($1, 'APPROVE')`, [ids.review])).toMatch(/billing:create/);
    expect(await callErr('owner', `pm.fs_decide_review($1, 'APPROVE')`, [ids.review])).toMatch(/PM_FS_REVIEW_BLOCKED: .*Contactor/);
    const ok = await call<{ status: string; billing_request_id: string; lines: number }>('owner', `pm.fs_decide_review($1, 'APPROVE', null, 'Contactor was warranty stock')`, [ids.review]);
    expect(ok.status).toBe('APPROVED');
    ids.br = ok.billing_request_id;
    const b = await one<{ status: string; billing_type: string; memo: string }>(`select status, billing_type, memo from pm.billing_requests where id = $1`, [ids.br]);
    expect(b).toMatchObject({ status: 'DRAFT', billing_type: 'MILESTONE' });
    expect(b.memo).toMatch(/sales tax 455\.00/);
  });
  it('text-to-pay waits for the Books invoice, then sends the pay link (no amount in the text)', async () => {
    expect(await callErr('dispatcher', `pm.fs_text_to_pay($1)`, [ids.review])).toMatch(/PM_FS_NOT_INVOICED/);
    const inv = await one<{ id: string; public_token: string }>(`insert into public.invoices (org_id, location_id, customer_id, invoice_number, invoice_date, due_date, total_cents, status)
      values ($1, $2, $3, 'INV-9001', current_date, current_date + 30, 870500, 'SENT') returning id, public_token`, [ORG_A, L1, ids.cust]);
    await f.db.exec(`set session_replication_role = replica`);
    try {
      await f.db.query(`update pm.billing_requests set invoice_id = $1, invoice_number = 'INV-9001' where id = $2`, [inv.id, ids.br]);
    } finally {
      await f.db.exec(`set session_replication_role = origin`);
    }
    const r = await call<{ link: string; status: string; thread_id: string }>('dispatcher', `pm.fs_text_to_pay($1, null, 'SMS', null)`, [ids.review]);
    expect(r.link).toBe(`https://books.meritmgt.com/pay/${inv.public_token}`);
    const m = await one<{ body: string }>(`select body from pm.fs_thread_messages where thread_id = $1 order by created_at desc limit 1`, [r.thread_id]);
    expect(m.body).toContain('INV-9001');
    expect(m.body).not.toMatch(/\$|870/);
    expect(await callErr('labor', `pm.fs_text_to_pay($1)`, [ids.review])).toMatch(forbidden);
  });
});

describe('FS-96 auto-pay, FS-97 financing funding', () => {
  it('auto-pay consent is recorded (charging is a Books request)', async () => {
    const tpl = await one<{ id: string }>(`select id from pm.agreement_templates where location_id = $1 order by created_at limit 1`, [L1]);
    ids.agr = await call<string>('owner', `pm.fs_create_agreement_from_template($1, $2, $3, null, current_date, $4)`, [tpl.id, ids.cust, L1, ids.site]);
    const e = await call<string>('owner', `pm.fs_request_autopay($1, $2, 'Visa ending 4242', 'Pat Homeowner')`, [ids.agr, ids.contact]);
    const row = await one<{ status: string; consent_text: string }>(`select status, consent_text from pm.fs_autopay_enrollments where id = $1`, [e]);
    expect(row.status).toBe('REQUESTED');
    expect(row.consent_text).toMatch(/Visa ending 4242/);
    expect(await callErr('labor', `pm.fs_request_autopay($1, $2, 'Visa', 'Pat')`, [ids.agr, ids.contact])).toMatch(forbidden);
  });
  it('funding short of the expected net is SHORT_FUNDED; the recon strips dealer fees without financials', async () => {
    const r = await call<{ status: string }>('owner', `pm.fs_update_financing($1, 'FUNDED', 'GS-123', 700000)`, [ids.fin]);
    expect(r.status).toBe('SHORT_FUNDED');
    const own = await call<{ rows: Array<{ dealer_fee_cents: number | null; amount_financed_cents: number | null }> }>('owner', `pm.fs_financing_recon($1)`, [L1]);
    expect(own.rows.length).toBe(1);
    expect(own.rows[0]!.dealer_fee_cents).not.toBeNull();
    expect(await callErr('dispatcher', `pm.fs_financing_recon($1)`, [L1])).toMatch(forbidden);
    expect(await as(f, 'dispatcher', () => q(f.db, `select id from pm.fs_financed_sales`))).toEqual([]);
  });
});

describe('FS-102 timesheet review with exceptions', () => {
  beforeAll(async () => {
    const y = "current_date - 1";
    await f.db.query(`insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, approval_state) values ($1, $2, $3, ${y}, 10, 'SUBMITTED')`, [ORG_A, J2, f.employee.labor]);
    const wo = (await one<{ id: string }>(`insert into pm.work_orders (org_id, location_id, job_id, summary, status) values ($1, $2, $3, 'Drive test', 'IN_PROGRESS') returning id`, [ORG_A, L1, J2])).id;
    await f.db.query(`insert into pm.dispatch_assignments (org_id, job_id, work_order_id, employee_id, slot, status, en_route_at, arrived_at)
      values ($1, $2, $3, $4, tstzrange(((${y})::timestamp + time '15:00') at time zone 'America/Chicago', ((${y})::timestamp + time '17:00') at time zone 'America/Chicago'), 'ON_SITE',
              ((${y})::timestamp + time '13:00') at time zone 'America/Chicago', ((${y})::timestamp + time '14:40') at time zone 'America/Chicago')`, [ORG_A, J2, wo, f.employee.labor]);
  });
  it('flags overtime, a long drive and a missing clock-out, with a proposed fix', async () => {
    const rows = await call<Array<{ employee_id: string; flags: Array<{ code: string; fix: string }>; submitted_ids: string[] }>>('owner', `pm.fs_timesheet_exceptions($1, current_date - 2, current_date)`, [L1]);
    const mine = rows.find((r) => r.employee_id === f.employee.labor && r.flags.length > 0)!;
    const codes = mine.flags.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['OVERTIME_DAY', 'LONG_DRIVE', 'MISSING_CLOCK_OUT']));
    expect(mine.flags.every((x) => x.fix.length > 0)).toBe(true);
    expect(mine.submitted_ids.length).toBeGreaterThanOrEqual(1);
    expect(await callErr('labor', `pm.fs_timesheet_exceptions($1, current_date - 2, current_date)`, [L1])).toMatch(forbidden);
    expect(await callErr('dispatcher', `pm.fs_timesheet_exceptions($1, current_date - 2, current_date)`, [L1])).toMatch(forbidden);
  });
});

describe('FS-112 billing integrity auditor, FS-109 dashboards, FS-110 metrics, FS-117 setup + shadow run', () => {
  beforeAll(async () => {
    await f.db.query(`update pm.work_orders set status = 'COMPLETE', completed_at = now() - interval '3 days' where id = $1`, [f.ids[`wo:${J1}`]]);
  });
  it('finds a completed visit that was never invoiced, opens a fix task, and resolves what no longer applies', async () => {
    const r = await call<Record<string, number>>('owner', `pm.fs_run_integrity($1)`, [L1]);
    expect(Number(r.COMPLETED_NOT_INVOICED)).toBeGreaterThanOrEqual(1);
    const fnd = await one<{ id: string }>(`select id from pm.fs_integrity_findings where kind = 'COMPLETED_NOT_INVOICED' and subject_id = $1`, [f.ids[`wo:${J1}`]]);
    const task = await call<string>('owner', `pm.fs_task_finding($1)`, [fnd.id]);
    expect((await one<{ title: string }>(`select title from pm.tasks where id = $1`, [task])).title).toMatch(/^Billing fix:/);
    expect(await callErr('dispatcher', `pm.fs_dismiss_finding($1, 'not a leak')`, [fnd.id])).toMatch(forbidden);
    expect(await callErr('labor', `pm.fs_run_integrity($1)`, [L1])).toMatch(forbidden);
  });
  it('role dashboards strip money the viewer may not see', async () => {
    const gm = await call<{ revenue_cents: number | null }>('owner', `pm.fs_dashboard($1, 'gm')`, [L1]);
    expect(gm.revenue_cents).not.toBeNull();
    const d = await call<{ revenue_cents: number | null }>('dispatcher', `pm.fs_dashboard($1, 'gm')`, [L1]);
    expect(d.revenue_cents).toBeNull();
    const disp = await call<{ unread_threads: number; reschedule_requests: number }>('dispatcher', `pm.fs_dashboard($1, 'dispatcher')`, [L1]);
    expect(Number(disp.reschedule_requests)).toBeGreaterThanOrEqual(0);
    const ip = await call<{ by_stage: Record<string, number> }>('owner', `pm.fs_dashboard($1, 'install_pm')`, [L1]);
    expect(ip.by_stage).toBeTruthy();
    expect(await callErr('labor', `pm.fs_dashboard($1, 'gm')`, [L1])).toMatch(forbidden);
  });
  it('the metric catalog answers with rows that link to records; unknown metrics are refused', async () => {
    const m = await call<{ value: number; rows: Array<{ ref_table: string }> }>('owner', `pm.fs_metric($1, 'unbilled_jobs', current_date - 30, current_date)`, [L1]);
    expect(Number(m.value)).toBeGreaterThanOrEqual(1);
    expect(m.rows[0]!.ref_table).toBe('work_orders');
    const dr = await call<{ masked: boolean; rows: unknown[] }>('dispatcher', `pm.fs_metric($1, 'deferred_revenue')`, [L1]);
    expect(dr.masked).toBe(true);
    expect(dr.rows).toEqual([]);
    expect(await callErr('owner', `pm.fs_metric($1, 'drop table')`, [L1])).toMatch(/PM_INVALID/);
  });
  it('guided setup lists what is done; a shadow-run day compares the old system with Merit', async () => {
    const s = await call<{ done: number; total: number; steps: Array<{ key: string; done: boolean }> }>('owner', `pm.fs_setup_status($1)`, [L1]);
    expect(s.total).toBe(16);
    expect(s.steps.find((x) => x.key === 'forms')?.done).toBe(true);
    const day = await call<{ status: string; merit: { jobs: number } }>('owner', `pm.fs_record_shadow_day($1, current_date, '{"jobs": 0, "revenue_cents": 0}'::jsonb, 'SERVICETITAN')`, [L1]);
    expect(day.status).toBe('VARIANCE');
    expect(Number(day.merit.jobs)).toBeGreaterThanOrEqual(1);
    const rep = await call<{ days: Array<{ diff: { revenue_cents: number | null } }> }>('dispatcher', `pm.fs_shadow_report($1)`, [L1]).catch(() => null);
    expect(rep).toBeNull();
    const own = await call<{ days: Array<{ diff: { jobs: number } }> }>('owner', `pm.fs_shadow_report($1)`, [L1]);
    expect(own.days.length).toBe(1);
  });
});

describe('FS-26 phone parity: nameplate equipment, idempotent per command', () => {
  it('a nameplate read creates the equipment once and reports age and coverage', async () => {
    const cmd = '33333333-3333-4333-8333-333333333333';
    const r = await call<{ asset_id: string; age_years: number }>('labor', `pm.fs_upsert_equipment($1, null, $2::jsonb, null, $3)`,
      [ids.wo2, JSON.stringify({ make: 'Carrier', model: '24ACC636', serial: '1209E12345', manufactured_on: '2009-03-01', equipment_type: 'AC_CONDENSER' }), cmd]);
    expect(r.age_years).toBeGreaterThanOrEqual(16);
    const again = await call<{ asset_id: string; duplicate: boolean }>('labor', `pm.fs_upsert_equipment($1, null, $2::jsonb, null, $3)`, [ids.wo2, JSON.stringify({ make: 'Carrier' }), cmd]);
    expect(again).toMatchObject({ asset_id: r.asset_id, duplicate: true });
    expect(await callErr('labor', `pm.fs_upsert_equipment($1, null, '{"make": "x"}'::jsonb)`, [f.ids[`wo:${J1}`]])).toMatch(forbidden);
  });
});

describe('FS-26 phone follow-up: sale at the signing time, photo documents, visit context', () => {
  const sellCmd = '44444444-4444-4444-8444-444444444441';
  const photoCmd = '55555555-5555-4555-8555-555555555551';
  const plateCmd = '55555555-5555-4555-8555-555555555552';
  const doc = async (job: string, photo: string, ext = 'png'): Promise<string> => {
    const d = await one<{ id: string }>(`insert into public.documents (org_id, storage_path, file_name, mime_type) values ($1::uuid, $1::text || '/projects/field/' || $2::text || '/' || $3::text || '.' || $4::text, 'p.' || $4::text, 'image/png') returning id`, [ORG_A, job, photo, ext]);
    await f.db.query(`insert into pm.document_links (org_id, document_id, job_id, subject_table, subject_id, role) values ($1, $2, $3, 'projects', $3, 'photo')`, [ORG_A, d.id, job]);
    return d.id;
  };
  beforeAll(async () => {
    ids.wo3 = (await one<{ id: string }>(`insert into pm.work_orders (org_id, location_id, job_id, summary, site_id) values ($1, $2, $3, 'Second visit', $4) returning id`, [ORG_A, L1, J2, ids.site])).id;
    await f.db.query(`insert into pm.dispatch_assignments (org_id, job_id, work_order_id, employee_id, slot) values ($1, $2, $3, $4, tstzrange(now() + interval '3 days', now() + interval '3 days 2 hours'))`, [ORG_A, J2, ids.wo3, f.employee.labor]);
    const opts = [{ tier: 'GOOD', name: 'Repair', items: [{ description: 'Replace inducer motor', unit_price_cents: 64000 }, { description: 'Surge protector', unit_price_cents: 25000, optional: true }] },
                  { tier: 'BETTER', name: 'Repair + tune-up', items: [{ description: 'Replace inducer motor + tune-up', unit_price_cents: 79000 }] }];
    ids.est3 = await call<string>('labor', `pm.fs_build_estimate($1, 'Inducer', $2::jsonb, false)`, [ids.wo3, JSON.stringify(opts)]);
    await call('labor', `pm.fs_present_estimate($1)`, [ids.est3]);
    const o = await q<{ id: string; name: string }>(f.db, `select id, name from pm.fs_estimate_options where estimate_id = $1 order by sort`, [ids.est3]);
    ids.opt3 = o.find((x) => x.name === 'Repair')!.id;
    ids.opt3b = o.find((x) => x.name !== 'Repair')!.id;
    ids.surge3 = (await one<{ id: string }>(`select id from pm.fs_estimate_option_items where option_id = $1 and description = 'Surge protector'`, [ids.opt3])).id;
    ids.sig3 = await doc(J2, photoCmd);
  });

  it('the signing time is required and bounded: not ahead of the clock, not older than 35 days, not before the estimate', async () => {
    const sell = (at: string | null) => callErr('labor', `pm.fs_field_sell($1, $2, array[$3::uuid], 'Pat Homeowner', ${at ?? 'null'})`, [ids.est3, sellCmd, ids.opt3]);
    expect(await sell(null)).toMatch(/PM_FS_SIGNED_AT/);
    expect(await sell(`now() + interval '1 hour'`)).toMatch(/PM_FS_SIGNED_AT: .*future/);
    expect(await sell(`now() - interval '40 days'`)).toMatch(/PM_FS_SIGNED_AT: .*35 days/);
    expect(await sell(`now() - interval '1 day'`)).toMatch(/PM_FS_SIGNED_AT: .*before/);
    expect(await callErr('labor', `pm.fs_field_sell($1, $2, array[$3::uuid], 'Pat', now(), $4::jsonb)`,
      [ids.est3, sellCmd, ids.opt3, JSON.stringify([{ item_id: ids.cap, selected: true }])])).toMatch(/PM_INVALID|not on/);
    expect((await one<{ status: string }>(`select status from pm.fs_estimates where id = $1`, [ids.est3])).status).toBe('PRESENTED');
  });

  it('sells at the signing time with the add-on ticked and the drawn signature resolved; replays are duplicates', async () => {
    const r = await call<{ estimate_id: string; lines: number; signed_at: string; received_at: string; signature: string }>('labor',
      `pm.fs_field_sell($1, $2, array[$3::uuid], 'Pat Homeowner', now() - interval '3 minutes', $4::jsonb, $5)`,
      [ids.est3, sellCmd, ids.opt3, JSON.stringify([{ item_id: ids.surge3, selected: true }]), photoCmd]);
    expect(r).toMatchObject({ estimate_id: ids.est3, lines: 2, signature: 'ATTACHED' });
    const e = await one<{ status: string; signed_at: Date; received_at: Date; sold_at: Date; signature_document_id: string; lag: number }>(
      `select status, signed_at, received_at, sold_at, signature_document_id, extract(epoch from received_at - signed_at)::int as lag from pm.fs_estimates where id = $1`, [ids.est3]);
    expect(e).toMatchObject({ status: 'SOLD', signature_document_id: ids.sig3 });
    expect(e.lag).toBeGreaterThanOrEqual(170);
    expect(e.sold_at.getTime()).toBe(e.received_at.getTime()); // period by receipt (M2)
    expect(Number((await one<{ n: number }>(`select count(*)::int as n from pm.work_order_lines where work_order_id = $1 and description = 'Surge protector'`, [ids.wo3])).n)).toBe(1);
    const again = await call<{ duplicate: boolean; estimate_id: string }>('labor', `pm.fs_field_sell($1, $2, array[$3::uuid], 'Pat Homeowner', now())`, [ids.est3, sellCmd, ids.opt3]);
    expect(again).toMatchObject({ duplicate: true, estimate_id: ids.est3 });
    const other = await call<{ duplicate: boolean; already_sold: boolean }>('labor', `pm.fs_field_sell($1, $2, array[$3::uuid], 'Pat Homeowner', now())`,
      [ids.est3, '44444444-4444-4444-8444-444444444442', ids.opt3]);
    expect(other).toMatchObject({ duplicate: true, already_sold: true });
    expect(await callErr('labor', `pm.fs_field_sell($1, $2, array[$3::uuid], 'Pat Homeowner', now())`, [ids.est3, '44444444-4444-4444-8444-444444444443', ids.opt3b])).toMatch(/PM_FS_ESTIMATE_LOCKED/);
    expect(Number((await one<{ n: number }>(`select count(*)::int as n from pm.work_order_lines where work_order_id = $1`, [ids.wo3])).n)).toBe(2);
    expect(await callErr('dispatcher', `pm.fs_field_sell($1, $2, array[$3::uuid], 'X', now())`, [ids.est3, '44444444-4444-4444-8444-444444444444', ids.opt3])).toBeNull();
  });

  it('the tablet path still sells without a signing time (now)', async () => {
    const est = await call<string>('labor', `pm.fs_build_estimate($1, 'Filter', $2::jsonb, false)`, [ids.wo3, JSON.stringify([{ tier: 'GOOD', name: 'Filter', items: [{ description: 'Filter', unit_price_cents: 4000 }] }])]);
    const opt = (await one<{ id: string }>(`select id from pm.fs_estimate_options where estimate_id = $1`, [est])).id;
    const r = await call<{ lines: number; signed_at: string }>('labor', `pm.fs_sell_estimate($1, array[$2::uuid], 'Pat')`, [est, opt]);
    expect(r.lines).toBe(1);
    expect(r.signed_at).toBeTruthy();
  });

  it('a nameplate photo becomes its document only from this org and this job or site; an upload not yet in is PENDING', async () => {
    const plateDoc = await doc(J2, plateCmd, 'jpg');
    const otherJob = await doc(J1, '55555555-5555-4555-8555-555555555553');
    const fields = JSON.stringify({ make: 'Goodman', serial: '1805123456' });
    expect(await callErr('labor', `pm.fs_upsert_equipment($1, null, $2::jsonb, $3, null)`, [ids.wo3, fields, otherJob])).toMatch(/PM_INVALID: .*nameplate/);
    const r = await call<{ asset_id: string; nameplate: string; nameplate_document_id: string }>('labor', `pm.fs_upsert_equipment($1, null, $2::jsonb, null, $3, $4)`,
      [ids.wo3, fields, '66666666-6666-4666-8666-666666666661', plateCmd]);
    expect(r).toMatchObject({ nameplate: 'ATTACHED', nameplate_document_id: plateDoc });
    expect((await one<{ nameplate_document_id: string }>(`select nameplate_document_id from pm.assets where id = $1`, [r.asset_id])).nameplate_document_id).toBe(plateDoc);
    const pending = await call<{ nameplate: string; nameplate_document_id: string | null }>('labor', `pm.fs_upsert_equipment($1, $2, $3::jsonb, null, $4, $5)`,
      [ids.wo3, r.asset_id, fields, '66666666-6666-4666-8666-666666666662', '55555555-5555-4555-8555-555555555554']);
    expect(pending).toMatchObject({ nameplate: 'PENDING', nameplate_document_id: null });
    expect((await one<{ nameplate_document_id: string }>(`select nameplate_document_id from pm.assets where id = $1`, [r.asset_id])).nameplate_document_id).toBe(plateDoc);
  });

  it('visit context: the customer for the tech; the invoice review only for billing / dispatch, its total only with contract value', async () => {
    type Ctx = { customer_id: string; invoice_review: null | { id: string; status: string; invoiced: boolean; can_send_pay_link: boolean; total_cents: number | null } };
    const tech = await call<Ctx>('labor', `pm.fs_visit_context($1)`, [ids.wo2]);
    expect(tech.customer_id).toBe(ids.cust);
    expect(tech.invoice_review).toBeNull();
    const csr = await call<Ctx>('dispatcher', `pm.fs_visit_context($1)`, [ids.wo2]);
    expect(csr.invoice_review).toMatchObject({ id: ids.review, status: 'APPROVED', invoiced: true, can_send_pay_link: true, total_cents: null });
    const owner = await call<Ctx>('owner', `pm.fs_visit_context($1)`, [ids.wo2]);
    expect(typeof owner.invoice_review?.total_cents).toBe('number');
    expect(await callErr('labor', `pm.fs_visit_context($1)`, [f.ids[`wo:${J1}`]])).toMatch(forbidden);
  });

  it('the registry stays clean with the new RPCs', async () => {
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
  });
});

describe('security review round 1 (1123)', () => {
  const persons: Persona[] = ['owner', 'gm', 'pm', 'supervisor', 'labor', 'dispatcher', 'accountant'];
  const can = (p: Persona, cap: string, action: string) => call<boolean>(p, `pm.can($1, $2, $3)`, [cap, action, L1]);

  it('H2: refreshing a review returns totals only with contract value on the job', async () => {
    const d = await call<{ total_cents: number | null; subtotal_cents: number | null; tax_cents: number | null; id: string }>('dispatcher', `pm.fs_refresh_review($1)`, [ids.review]);
    expect(d.id).toBe(ids.review);
    expect(await call<boolean>('dispatcher', `$1::uuid in (select pm.my_money_job_ids('projects.contract_value'))`, [J2])).toBe(false);
    expect(d).toMatchObject({ total_cents: null, subtotal_cents: null, tax_cents: null });
    const o = await call<{ total_cents: number | null }>('owner', `pm.fs_refresh_review($1)`, [ids.review]);
    expect(typeof o.total_cents).toBe('number');
  });

  it('M1: link base URLs come from service-only, allowlisted config — never from the caller', async () => {
    expect(await errorOf(f.db, `insert into pm.fs_platform_settings (key, value) values ('books_base_url', 'https://evil.example')`)).toMatch(/check constraint/);
    expect(await as(f, 'owner', () => errorOf(f.db, `insert into pm.fs_platform_settings (key, value) values ('books_base_url', 'https://books.meritmgt.com')`))).toMatch(/permission denied/);
    await f.db.query(`insert into pm.fs_platform_settings (key, value) values ('projects_base_url', 'https://projects.meritmgt.com') on conflict (key) do nothing`);
    expect(await one<{ b: string; p: string }>(`select pm._fs_app_url('books') b, pm._fs_app_url('projects') p`)).toEqual({ b: 'https://books.meritmgt.com', p: 'https://projects.meritmgt.com' });
    expect(await callErr('dispatcher', `pm.fs_text_to_pay($1, null, 'SMS', null, 'https://evil.example')`, [ids.review])).toMatch(/function .* does not exist|invalid input syntax/);
    expect(await callErr('dispatcher', `pm.fs_run_automations($1, 'https://evil.example')`, [L1])).toMatch(/does not exist/);
  });

  describe('M2: the sale', () => {
    beforeAll(async () => {
      const opts = [{ tier: 'GOOD', name: 'Blower motor', items: [{ description: 'Blower motor', unit_price_cents: 52000 }] }];
      ids.est4 = await call<string>('labor', `pm.fs_build_estimate($1, 'Blower', $2::jsonb, false)`, [ids.wo3, JSON.stringify(opts)]);
      await call('labor', `pm.fs_present_estimate($1)`, [ids.est4]);
      ids.opt4 = (await one<{ id: string }>(`select id from pm.fs_estimate_options where estimate_id = $1`, [ids.est4])).id;
    });
    it('the seller must be on the visit unless the caller may edit the estimate', async () => {
      expect(await callErr('labor', `pm.fs_sell_estimate($1, array[$2::uuid], 'Pat', null, null, 0, false, null, null, $3)`, [ids.est4, ids.opt4, f.employee.supervisor])).toMatch(/PM_FORBIDDEN: credit the sale/);
      expect(await callErr('labor', `pm.fs_sell_estimate($1, array[$2::uuid], 'Pat', null, null, 0, false, null, null, $3)`, [ids.est4, ids.opt4, '00000000-0000-4000-8000-0000000000ff'])).toMatch(/not in this organization/);
    });
    it('the signature document must be on this job; a cash deposit cannot exceed the sold total', async () => {
      const other = (await one<{ id: string }>(`insert into public.documents (org_id, storage_path, file_name, mime_type) values ($1::uuid, $1::text || '/x/sig.png', 'sig.png', 'image/png') returning id`, [ORG_A])).id;
      expect(await callErr('labor', `pm.fs_sell_estimate($1, array[$2::uuid], 'Pat', null, null, 0, false, null, null, null, $3)`, [ids.est4, ids.opt4, other])).toMatch(/signature is not a document on this job/);
      expect(await callErr('labor', `pm.fs_sell_estimate($1, array[$2::uuid], 'Pat', null, null, 52001, false, 'Cash')`, [ids.est4, ids.opt4])).toMatch(/deposit is more than the sold total/);
      expect((await one<{ status: string }>(`select status from pm.fs_estimates where id = $1`, [ids.est4])).status).toBe('PRESENTED');
    });
    it('not before the visit was first dispatched; sold_at is the server time', async () => {
      await f.db.query(`update pm.dispatch_assignments set created_at = now() + interval '1 hour' where work_order_id = $1`, [ids.wo3]);
      expect(await callErr('labor', `pm.fs_field_sell($1, $2, array[$3::uuid], 'Pat', now())`, [ids.est4, '44444444-4444-4444-8444-444444444451', ids.opt4])).toMatch(/PM_FS_SIGNED_AT: .*dispatched/);
      await f.db.query(`update pm.dispatch_assignments set created_at = now() - interval '1 hour' where work_order_id = $1`, [ids.wo3]);
      const r = await call<{ signed_at: string; received_at: string }>('labor', `pm.fs_field_sell($1, $2, array[$3::uuid], 'Pat', now() - interval '4 minutes', '[]'::jsonb, null, null, null, 52000, false, 'Cash')`,
        [ids.est4, '44444444-4444-4444-8444-444444444452', ids.opt4]);
      expect(new Date(r.received_at).getTime() - new Date(r.signed_at).getTime()).toBeGreaterThanOrEqual(230_000);
      const e = await one<{ same: boolean }>(`select sold_at = received_at as same from pm.fs_estimates where id = $1`, [ids.est4]);
      expect(e.same).toBe(true);
    });
  });

  it('M3: equipment updates only this visit\'s customer or site', async () => {
    const other = (await one<{ id: string }>(`insert into core.customers (org_id, name) values ($1, 'Someone Else') returning id`, [ORG_A])).id;
    const asset = (await one<{ id: string }>(`insert into pm.assets (org_id, location_id, kind, customer_id, make, description) values ($1, $2, 'CUSTOMER_EQUIPMENT', $3, 'Lennox', 'Furnace') returning id`, [ORG_A, L1, other])).id;
    expect(await callErr('labor', `pm.fs_upsert_equipment($1, $2, '{"make": "Lennox"}'::jsonb)`, [ids.wo3, asset])).toMatch(/not at this customer or site/);
  });

  it('L1: a command id is claimed once — another action or another user cannot reuse it', async () => {
    const cmd = '99999999-9999-4999-8999-999999999991';
    await call('labor', `pm.fs_save_visit_note($1, 'TYPED', 'Replaced filter', '{"work_performed": "Replaced filter"}'::jsonb, '{}', '{}'::jsonb, $2, 'RULES')`, [ids.wo3, cmd]);
    expect(await callErr('labor', `pm.fs_upsert_equipment($1, null, '{"make": "Trane"}'::jsonb, null, $2)`, [ids.wo3, cmd])).toMatch(/PM_FS_COMMAND_MISMATCH/);
    expect(await callErr('owner', `pm.fs_save_visit_note($1, 'TYPED', 'x', '{}'::jsonb, '{}', '{}'::jsonb, $2, 'RULES')`, [ids.wo3, cmd])).toMatch(/PM_FS_COMMAND_MISMATCH/);
    const again = await call<{ duplicate: boolean }>('labor', `pm.fs_save_visit_note($1, 'TYPED', 'Replaced filter', '{}'::jsonb, '{}', '{}'::jsonb, $2, 'RULES')`, [ids.wo3, cmd]);
    expect(again.duplicate).toBe(true);
    expect((await one<{ n: number }>(`select count(*)::int n from pm.fs_field_commands where command_id = $1`, [cmd])).n).toBe(1);
  });

  it('L: opportunity references must be in this org and company', async () => {
    const bEmp = (await one<{ id: string }>(`insert into core.employees (org_id, first_name, last_name) values ($1, 'Other', 'Org') returning id`, [ORG_B])).id;
    expect(await callErr('owner', `pm.fs_open_opportunity($1, $2, 'Replace', 'MARKETING', null, $3)`, [L1, ids.cust, bEmp])).toMatch(/advisor is not in this organization/);
    const bu = (await one<{ id: string }>(`select id from pm.business_units where location_id = $1 limit 1`, [L1])).id;
    expect(await callErr('owner', `pm.fs_open_opportunity($1, $2, 'Replace', 'MARKETING', null, null, null, null, null, $3)`, [L2, null, bu])).toMatch(/business unit is not at this company/);
    const opp = await call<string>('owner', `pm.fs_open_opportunity($1, $2, 'Replace')`, [L1, ids.cust]);
    expect(await callErr('owner', `pm.fs_advance_opportunity($1, 'APPOINTMENT', null, now() + interval '1 day', $2)`, [opp, bEmp])).toMatch(/advisor is not in this organization/);
  });

  it('L: an unverified portal viewer cannot ask for a new time', async () => {
    const token = randomBytes(32).toString('base64url');
    const person = await one<{ id: string }>(`insert into pm.portal_people (email, display_name) values ('viewer@home.test', 'Viewer') returning id`);
    const g = await one<{ id: string }>(`insert into pm.portal_grants (org_id, location_id, person_id, audience, customer_id, display_name, email, phone, role)
      values ($1, $2, $3, 'customer', $4, 'Viewer', 'viewer@home.test', '+15155550199', 'viewer') returning id`, [ORG_A, L1, person.id, ids.cust]);
    await f.db.query(`insert into pm.portal_grant_jobs (org_id, grant_id, job_id) values ($1, $2, $3)`, [ORG_A, g.id, J2]);
    await f.db.query(`insert into pm.portal_sessions (person_id, token_hash, auth_method, org_id, verified_email, expires_at) values ($1, $2, 'email', $3, 'viewer@home.test', now() + interval '1 day')`, [person.id, sha(token), ORG_A]);
    expect(await anonErr(`portal.fs_confirm_visit($1, $2, $3, 'RESCHEDULE')`, [token, ORG_A, ids.wo3])).toMatch(/PORTAL_VERIFY/);
    expect((await anonRpc<{ status: string }>(`portal.fs_confirm_visit($1, $2, $3, 'CONFIRM')`, [token, ORG_A, ids.wo3])).status).toBe('confirmed');
  });

  it('nested-guard audit: report metrics re-check the caller; SOV activation needs billing:edit; closing the visit needs dispatch:edit', async () => {
    for (const p of persons) {
      if (!(await call<boolean>(p, `pm.can('projects.dispatch', 'view', $1) or pm.can('projects.reports', 'view', $1) or pm.can('projects.leads', 'view', $1)`, [L1]))) continue;
      const pipe = (await can(p, 'projects.leads', 'view')) || (await can(p, 'projects.reports', 'view')) || (await can(p, 'projects.estimates', 'view'));
      const fin = (await can(p, 'projects.billing', 'view')) || (await can(p, 'projects.financials', 'view')) || (await can(p, 'projects.reports', 'view'));
      const inst = (await can(p, 'projects.dispatch', 'view')) || (await can(p, 'projects.jobs', 'view'));
      const err = (m: string) => callErr(p, `pm.fs_metric($1, $2)`, [L1, m]);
      expect(await err('close_rate_by_advisor'), `${p} close rate`).toEqual(pipe ? null : expect.stringMatching(forbidden));
      expect(await err('unfunded_financing'), `${p} financing`).toEqual(fin ? null : expect.stringMatching(forbidden));
      expect(await err('installs_stuck'), `${p} installs`).toEqual(inst ? null : expect.stringMatching(forbidden));
    }
    let sov = 0;
    for (const p of persons) {
      const create = await can(p, 'projects.billing', 'create');
      const edit = await can(p, 'projects.billing', 'edit');
      if (!create) continue;
      const e = await callErr(p, `pm.fs_install_setup_sov($1, '[{"description": "Equipment", "scheduled_value_cents": 825000}]'::jsonb)`, [ids.project]);
      if (e && /not one of the caller's jobs/.test(e)) continue; // job not reachable for this persona (guard, not the audit)
      if (edit) expect(e, p).toBeNull(); else expect(e, p).toMatch(/billing:edit/);
      sov += 1;
    }
    expect(sov).toBeGreaterThan(0);
  });

  it('nested-guard audit: approving a review closes the visit only for a caller with dispatch:edit', async () => {
    const probe = async (p: Persona) => ({
      bill: await can(p, 'projects.billing', 'create'),
      approve: await can(p, 'projects.billing', 'approve'),
      dispatch: await can(p, 'projects.dispatch', 'edit'),
    });
    const mk = async () => {
      const wo = (await one<{ id: string }>(`insert into pm.work_orders (org_id, location_id, job_id, summary, site_id) values ($1, $2, $3, 'Review probe', $4) returning id`, [ORG_A, L1, J2, ids.site])).id;
      await f.db.query(`insert into pm.work_order_lines (org_id, job_id, work_order_id, description, qty, unit_price_cents, unit_cost_cents, status) values ($1, $2, $3, 'Diagnostic', 1, 9900, 0, 'APPROVED')`, [ORG_A, J2, wo]);
      await f.db.query(`update pm.work_orders set status = 'COMPLETE', completed_at = now() where id = $1`, [wo]);
      return { wo, review: (await one<{ id: string }>(`select id from pm.fs_invoice_reviews where work_order_id = $1`, [wo])).id };
    };
    let checked = 0;
    for (const p of persons) {
      const probeWo = await mk();
      const c = await probe(p);
      if (!c.bill || !c.approve) continue;
      await call(p, `pm.fs_decide_review($1, 'APPROVE', null, 'Probe override for the audit test')`, [probeWo.review]);
      const st = (await one<{ status: string }>(`select status from pm.work_orders where id = $1`, [probeWo.wo])).status;
      expect(st, p).toBe(c.dispatch ? 'CLOSED' : 'COMPLETE');
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('H1: inbound texts route only by the verified sender registry, which holds a number for one company', async () => {
    await f.db.query(`insert into core.sms_sender_numbers (org_id, location_id, phone, status, provider_sid, verified_at) values ($1, $2, '+15155554444', 'verified', 'PN-a', now())`, [ORG_A, L1]);
    expect(await errorOf(f.db, `insert into core.sms_sender_numbers (org_id, location_id, phone, status, provider_sid, verified_at) values ($1, $2, '+15155554444', 'verified', 'PN-b', now())`, [ORG_B, LB])).toMatch(/ux_sms_sender_verified/);
    expect((await anonRpc<{ routed: boolean }>(`public.fs_inbound_sms($1, '+15155550101', '+15155553333', 'Hello')`, [WKEY])).routed).toBe(false);
  });

  it('round 2 M: a technician\'s equipment sale never sets the contract value; the office is told', async () => {
    const J4 = 'a0000000-0000-4000-8000-000000000104';
    await f.db.query(`insert into core.jobs (id, org_id, location_id, job_number, name, customer_id) values ($1, $2, $3, 'J4', 'J4', $4)`, [J4, ORG_A, L1, ids.cust]);
    await f.db.query(`insert into pm.projects (job_id, org_id, location_id, job_type_id, stage_key) values ($1, $2, $3, $4, 'active')`, [J4, ORG_A, L1, f.ids[`jobType:${L1}`]]);
    const wo = (await one<{ id: string }>(`insert into pm.work_orders (org_id, location_id, job_id, summary, site_id) values ($1, $2, $3, 'Replacement quote', $4) returning id`, [ORG_A, L1, J4, ids.site])).id;
    await f.db.query(`insert into pm.dispatch_assignments (org_id, job_id, work_order_id, employee_id, slot) values ($1, $2, $3, $4, tstzrange(now() + interval '5 days', now() + interval '5 days 2 hours'))`, [ORG_A, J4, wo, f.employee.labor]);
    await f.db.query(`update pm.dispatch_assignments set created_at = now() - interval '1 hour' where work_order_id = $1`, [wo]);
    expect(await call<boolean>('labor', `pm.can('projects.financials', 'edit', $1)`, [L1])).toBe(false);
    const est = await call<string>('labor', `pm.fs_build_estimate($1, 'New system', $2::jsonb, false)`, [wo, JSON.stringify([{ tier: 'BEST', name: 'New system', items: [{ price_book_item_id: ids.eq }] }])]);
    await call('labor', `pm.fs_present_estimate($1)`, [est]);
    const opt = (await one<{ id: string }>(`select id from pm.fs_estimate_options where estimate_id = $1`, [est])).id;
    await call('labor', `pm.fs_sell_estimate($1, array[$2::uuid], 'Pat')`, [est, opt]);
    const proj = await one<{ id: string; contract_note: string }>(`select id, contract_note from pm.fs_install_projects where estimate_id = $1`, [est]);
    expect(proj.contract_note).toBe('Sold total awaiting the office to set the contract value');
    expect((await one<{ n: number }>(`select count(*)::int n from pm.contracts where job_id = $1`, [J4])).n).toBe(0);
    expect((await one<{ n: number }>(`select count(*)::int n from core.notifications where event_type = 'install.contract_needed' and job_id = $1`, [J4])).n).toBeGreaterThan(0);
  });

  it('round 2 L1/L2: service-only tables have no permissive member policy and a deny-all; registry company must be in its org', async () => {
    const t = ['fs_voice_numbers', 'fs_voice_event_log', 'fs_platform_settings'];
    expect(await q(f.db, `select tablename, policyname from pg_policies where schemaname = 'pm' and tablename = any ($1) and permissive = 'PERMISSIVE'`, [t])).toEqual([]);
    expect((await q(f.db, `select tablename from pg_policies where schemaname = 'pm' and tablename = any ($1) and policyname = 'fs_service_only' and permissive = 'RESTRICTIVE'`, [t])).length).toBe(3);
    for (const x of t) {
      expect(await one<{ a: boolean; b: boolean }>(`select has_table_privilege('authenticated', $1, 'select') a, has_table_privilege('anon', $1, 'select') b`, [`pm.${x}`])).toEqual({ a: false, b: false });
    }
    // the generated class-O policies are restrictive only, and the explicit deny-all wins for members
    expect(await as(f, 'owner', () => errorOf(f.db, `select count(*) from pm.fs_platform_settings`))).toMatch(/permission denied/);
    expect(await errorOf(f.db, `insert into pm.fs_voice_numbers (phone, org_id, location_id, provider, verified_at) values ('+15155552222', $1, $2, 'TWILIO_VOICE', now())`, [ORG_A, LB])).toMatch(/PM_LOCATION_ORG_MISMATCH/);
  });

  it('round 2 L3: can_send_pay_link follows fs_text_to_pay (billing:create or dispatch:edit)', async () => {
    for (const p of persons) {
      const r = await call<{ invoice_review: null | { can_send_pay_link: boolean } } | null>(p, `pm.fs_visit_context($1)`, [ids.wo2]).catch(() => null);
      if (!r?.invoice_review) continue;
      const sendErr = await callErr(p, `pm.fs_text_to_pay($1, null, 'SMS', null, gen_random_uuid())`, [ids.review]);
      expect(r.invoice_review.can_send_pay_link, p).toBe(sendErr === null || !forbidden.test(sendErr));
    }
  });

  it('the registry stays clean after the security fixes', async () => {
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
    expect(await q(f.db, `select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'pm' and has_function_privilege('anon', p.oid, 'execute')`)).toEqual([]);
  });
});
