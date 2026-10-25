/**
 * 1118 portals: grants, sign-in (server key, browser-bound links and codes, go-live hold), scoping
 * (granted jobs only, never other customers / vendors / tenants, never cost), cross-org vendors,
 * revocation, expiry, phone step-up, decisions, e-sign links, pay applications, uploads, messages.
 *
 * Replays every migration after 1110 on the two-tenant fixture (the state production reaches).
 */

import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildFixture, applyAfter1110, as, q, errorOf, type Fixture, ORG_A, ORG_B, L1, LB, J1, J2, J3, JB } from './fixture';
import { applyMigration } from './pg';

let f: Fixture;
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const rnd = (): string => randomBytes(32).toString('base64url');
const SERVER_KEY = 'portal-test-server-key-0123456789';
const BASE = 'https://projects.example.test';
const ids: Record<string, string> = {};

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(f.db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}

/** As an anonymous PostgREST caller (anon key, no JWT) — the portal's only database role. */
async function anon<T>(fn: () => Promise<T>): Promise<T> {
  await f.db.query(`select set_config('request.jwt.claims', '{}', false)`);
  await f.db.exec('set role anon');
  try {
    return await fn();
  } finally {
    await f.db.exec('reset role');
  }
}
const anonRpc = async <T = unknown>(sql: string, params: unknown[] = []): Promise<T> =>
  anon(async () => (await q<{ r: T }>(f.db, sql, params))[0].r);
const anonErr = (sql: string, params: unknown[] = []) => anon(() => errorOf(f.db, sql, params));

interface Session { token: string; nonce: string }

/** Full sign-in: start (server key) → link redeemed in the same browser. */
async function signIn(identifier: string): Promise<Session> {
  const nonce = rnd();
  const token = rnd();
  const r = await anonRpc<{ ok: boolean; sent: boolean }>(`select portal.auth_start($1, $2, $3, $4, $5, '10.0.0.1', $6, 'en') as r`,
    [SERVER_KEY, identifier, sha(nonce), token, '123456', BASE]);
  expect(r, identifier).toMatchObject({ ok: true, sent: true });
  const session = rnd();
  const red = await anonRpc<{ ok: boolean; reason: string | null }>(`select portal.auth_redeem($1, $2, $3, '10.0.0.1', 'vitest') as r`, [token, nonce, sha(session)]);
  expect(red.ok, red.reason ?? '').toBe(true);
  return { token: session, nonce };
}

/** A company switch: a fresh code FROM that company to the address the session proved. */
async function switchTo(s: Session, org: string): Promise<Session> {
  const nonce = rnd();
  const r = await anonRpc<{ ok: boolean; sent: boolean }>(`select portal.auth_switch($1, $2, $3, $4, $5, '222222', null, $6) as r`,
    [SERVER_KEY, s.token, org, sha(nonce), rnd(), BASE]);
  expect(r).toMatchObject({ ok: true, sent: true });
  const session = rnd();
  expect(await anonRpc(`select portal.auth_verify_switch('${SERVER_KEY}', $1, '222222', $2, $3) as r`, [s.token, nonce, sha(session)])).toMatchObject({ ok: true, org_id: org });
  return { token: session, nonce };
}

async function signInAt(identifier: string, org: string): Promise<Session> {
  const s = await signIn(identifier);
  const me = await anonRpc<{ orgs: { org_id: string }[] }>(`select portal.me($1) as r`, [s.token]);
  return me.orgs[0]?.org_id === org ? s : switchTo(s, org);
}

const home = (s: Session, org = ORG_A) => anonRpc<{ jobs: { id: string }[]; queue: Record<string, unknown>[]; grants: { audience: string }[] }>(
  `select portal.home($1, $2) as r`, [s.token, org]);

function keysDeep(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}
const FORBIDDEN_KEYS = /cost|margin|markup|budget_line|internal|notes|unit_cost|ext$/;

beforeAll(async () => {
  f = await buildFixture();
  await applyAfter1110(f.db);
  const db = f.db;
  // parties
  ids.cust = (await one<{ id: string }>(`insert into core.customers (org_id, name) values ($1, 'Smith Home') returning id`, [ORG_A])).id;
  ids.cust2 = (await one<{ id: string }>(`insert into core.customers (org_id, name) values ($1, 'Jones Home') returning id`, [ORG_A])).id;
  ids.custB = (await one<{ id: string }>(`insert into core.customers (org_id, name) values ($1, 'B Customer') returning id`, [ORG_B])).id;
  ids.lenderCust = (await one<{ id: string }>(`insert into core.customers (org_id, name) values ($1, 'First Bank') returning id`, [ORG_A])).id;
  ids.vendor = (await one<{ id: string }>(`insert into core.vendors (org_id, name) values ($1, 'Ace Tile') returning id`, [ORG_A])).id;
  ids.vendor2 = (await one<{ id: string }>(`insert into core.vendors (org_id, name) values ($1, 'Other Sub') returning id`, [ORG_A])).id;
  ids.vendorB = (await one<{ id: string }>(`insert into core.vendors (org_id, name) values ($1, 'Ace Tile (B)') returning id`, [ORG_B])).id;
  await db.query(`update core.jobs set customer_id = $1 where id = $2`, [ids.cust, J1]);
  await db.query(`update core.jobs set customer_id = $1 where id = $2`, [ids.cust2, J2]);
  await db.query(`update core.jobs set customer_id = $1 where id = $2`, [ids.custB, JB]);
  const contact = async (org: string, c: Record<string, unknown>) =>
    (await one<{ id: string }>(`insert into core.contacts (org_id, customer_id, vendor_id, first_name, last_name, email, phone, can_sign, can_pay, is_primary)
                                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [org, c.customer ?? null, c.vendor ?? null, c.first, c.last ?? null, c.email ?? null, c.phone ?? null, c.sign ?? false, c.pay ?? false, c.primary ?? false])).id;
  ids.homeowner = await contact(ORG_A, { customer: ids.cust, first: 'Pat', last: 'Smith', email: 'pat@home.test', phone: '+15155550101', sign: true, pay: true, primary: true });
  ids.spouse = await contact(ORG_A, { customer: ids.cust, first: 'Sam', last: 'Smith', email: 'sam@home.test' });
  ids.other = await contact(ORG_A, { customer: ids.cust2, first: 'Jo', last: 'Jones', email: 'jo@jones.test' });
  ids.sub = await contact(ORG_A, { vendor: ids.vendor, first: 'Tia', last: 'Tile', email: 'tia@acetile.test' });
  ids.sub2 = await contact(ORG_A, { vendor: ids.vendor2, first: 'Otto', email: 'otto@other.test' });
  ids.subB = await contact(ORG_B, { vendor: ids.vendorB, first: 'Tia', last: 'Tile', email: 'tia@acetile.test' });
  ids.lender = await contact(ORG_A, { customer: ids.lenderCust, first: 'Lena', last: 'Loan', email: 'lena@bank.test' });

  // job records the portals read
  await db.query(`update pm.estimates set status = 'SENT', sent_at = now(), title = 'Kitchen proposal', total_cents = 4200000, cost_total_cents = 2500000, valid_until = current_date + 10 where id = $1`, [f.ids[`estimate:${J1}`]]);
  await db.query(`update pm.estimates set status = 'SENT', sent_at = now() where id = $1`, [f.ids[`estimate:${J2}`]]);
  await db.query(`update pm.change_orders set stage = 'COR', cost_impact_cents = 60000 where id = $1`, [f.ids[`co:${J1}`]]);
  await db.query(`update pm.tasks set client_visible = true, is_milestone = true, start_on = current_date + 3 where id = $1`, [f.ids[`task:${J1}`]]);
  ids.subTask = (await one<{ id: string }>(`insert into pm.tasks (org_id, job_id, title, assigned_vendor_id, start_on) values ($1, $2, 'Set tile', $3, current_date + 5) returning id`, [ORG_A, J1, ids.vendor])).id;
  ids.otherTask = (await one<{ id: string }>(`insert into pm.tasks (org_id, job_id, title, assigned_vendor_id, start_on) values ($1, $2, 'Drywall', $3, current_date + 5) returning id`, [ORG_A, J1, ids.vendor2])).id;
  ids.privateTask = (await one<{ id: string }>(`insert into pm.tasks (org_id, job_id, title, start_on) values ($1, $2, 'Internal margin review', current_date + 1) returning id`, [ORG_A, J1])).id;
  ids.sel = (await one<{ id: string }>(`insert into pm.selections (org_id, job_id, category, title, allowance_cents, status, proposed_at, due_on) values ($1, $2, 'Tile', 'Backsplash', 150000, 'PROPOSED', now(), current_date + 7) returning id`, [ORG_A, J1])).id;
  ids.optA = (await one<{ id: string }>(`insert into pm.selection_options (org_id, selection_id, label, qty, unit_cost_cents, unit_price_cents) values ($1, $2, 'Subway', 1, 90000, 140000) returning id`, [ORG_A, ids.sel])).id;
  ids.optB = (await one<{ id: string }>(`insert into pm.selection_options (org_id, selection_id, label, qty, unit_cost_cents, unit_price_cents, is_recommended) values ($1, $2, 'Zellige', 1, 210000, 334000, true) returning id`, [ORG_A, ids.sel])).id;
  ids.commit = (await one<{ id: string }>(`insert into pm.commitments (org_id, location_id, job_id, vendor_id, commitment_type, title, status, approved_at, approved_by, retainage_pct)
                                            values ($1, $2, $3, $4, 'SUBCONTRACT', 'Tile labor', 'APPROVED', now(), 'user_owner', 0.10) returning id`, [ORG_A, L1, J1, ids.vendor])).id;
  ids.cline = (await one<{ id: string }>(`insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, description, amount_cents) values ($1, $2, 1, $3, 'Tile install', 1000000) returning id`,
    [ORG_A, ids.commit, f.ids[`costCode:${L1}`]])).id;
  ids.waiver = (await one<{ id: string }>(`insert into pm.compliance_docs (org_id, job_id, commitment_id, vendor_id, doc_type, status) values ($1, $2, $3, $4, 'LIEN_WAIVER_CONDITIONAL', 'MISSING') returning id`,
    [ORG_A, J1, ids.commit, ids.vendor])).id;
  ids.punch = (await one<{ id: string }>(`insert into pm.punch_items (org_id, job_id, title, responsible_vendor_id) values ($1, $2, 'Grout touch-up', $3) returning id`, [ORG_A, J1, ids.vendor])).id;
  ids.sched = (await one<{ id: string }>(`insert into pm.draw_schedules (org_id, job_id, lender_name, lender_customer_id, loan_commitment_cents, status, activated_at)
                                           values ($1, $2, 'First Bank', $3, 100000000, 'ACTIVE', now()) returning id`, [ORG_A, J3, ids.lenderCust])).id;
  ids.bline = (await one<{ id: string }>(`insert into pm.draw_budget_lines (org_id, draw_schedule_id, job_id, line_no, description, category, original_cents) values ($1, $2, $3, 1, 'Framing', 'HARD', 5000000) returning id`,
    [ORG_A, ids.sched, J3])).id;
  ids.draw = (await one<{ id: string }>(`insert into pm.draws (org_id, job_id, draw_schedule_id, draw_number, period_end, created_by) values ($1, $2, $3, 1, current_date, 'user_pm') returning id`, [ORG_A, J3, ids.sched])).id;
  await db.query(`insert into pm.draw_lines (org_id, job_id, draw_schedule_id, draw_id, draw_budget_line_id, requested_cents) values ($1, $2, $3, $4, $5, 800000)`, [ORG_A, J3, ids.sched, ids.draw, ids.bline]);
  await db.exec(`set session_replication_role = replica`);
  try {
    await db.query(`update pm.draws set status = 'SUBMITTED', submitted_at = now(), submitted_by = 'user_pm', requested_cents = 800000 where id = $1`, [ids.draw]);
  } finally {
    await db.exec(`set session_replication_role = origin`);
  }
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('staff invites (pm.portal_invite)', () => {
  it('needs the audience capability at the company; labor and other tenants are refused', async () => {
    expect(await as(f, 'labor', () => errorOf(f.db, `select pm.portal_invite($1, 'customer', $2, $3::uuid[], '{}'::jsonb)`, [L1, ids.homeowner, [J1]]))).toMatch(/PM_FORBIDDEN/);
    expect(await as(f, 'bOwner', () => errorOf(f.db, `select pm.portal_invite($1, 'customer', $2, $3::uuid[], '{}'::jsonb)`, [L1, ids.homeowner, [J1]]))).toMatch(/PM_FORBIDDEN/);
  });

  it('never shares another customer’s job, and a vendor invite needs a vendor contact', async () => {
    expect(await as(f, 'owner', () => errorOf(f.db, `select pm.portal_invite($1, 'customer', $2, $3::uuid[], '{}'::jsonb)`, [L1, ids.homeowner, [J2]]))).toMatch(/another customer/);
    expect(await as(f, 'owner', () => errorOf(f.db, `select pm.portal_invite($1, 'vendor', $2, $3::uuid[], '{}'::jsonb)`, [L1, ids.homeowner, [J1]]))).toMatch(/vendor contact/);
  });

  it('before go-live the invitation is HELD and carries no secret', async () => {
    const r = await as(f, 'owner', async () => (await q<{ r: { grant_id: string; message: { status: string } } }>(f.db,
      `select pm.portal_invite($1, 'customer', $2, $3::uuid[], $4::jsonb) as r`, [L1, ids.homeowner, [J1], JSON.stringify({ portal_url: BASE })]))[0].r);
    expect(r.message.status).toBe('held');
    ids.gHome = r.grant_id;
    const m = await one<{ body: string }>(`select body from core.outbound_messages where contact_id = $1 order by created_at desc limit 1`, [ids.homeowner]);
    expect(m.body).toContain(`${BASE}/portal`);
    expect(m.body).not.toMatch(/\/portal\/auth\//);
  });

  it('go live, then invite the household (viewer spouse), the other customer, subs in two tenants and the lender', async () => {
    await as(f, 'owner', () => f.db.query(`select pm.notify_configure($1, '{"customer_messages_live": true}'::jsonb)`, [L1]));
    await as(f, 'owner', () => f.db.query(`select pm.notify_configure($1, '{"customer_messages_live": true}'::jsonb)`, [L2Of()]));
    await as(f, 'bOwner', () => f.db.query(`select pm.notify_configure($1, '{"customer_messages_live": true}'::jsonb)`, [LB]));
    const inv = (p: 'owner' | 'bOwner', loc: string, aud: string, contact: string, jobs: string[], attrs: Record<string, unknown> = {}) =>
      as(f, p, async () => (await q<{ r: { grant_id: string; message: { status: string } } }>(f.db,
        `select pm.portal_invite($1, $2, $3, $4::uuid[], $5::jsonb) as r`, [loc, aud, contact, jobs, JSON.stringify({ portal_url: BASE, ...attrs })]))[0].r);
    const spouse = await inv('owner', L1, 'customer', ids.spouse, [J1], { role: 'viewer' });
    expect(spouse.message.status).toBe('queued');
    ids.gSpouse = spouse.grant_id;
    ids.gOther = (await inv('owner', L1, 'customer', ids.other, [J2])).grant_id;
    ids.gSub = (await inv('owner', L1, 'vendor', ids.sub, [], { all_jobs: true })).grant_id;
    ids.gSub2 = (await inv('owner', L1, 'vendor', ids.sub2, [J1])).grant_id;
    ids.gSubB = (await inv('bOwner', LB, 'vendor', ids.subB, [JB])).grant_id;
    ids.gLender = (await inv('owner', L2Of(), 'lender', ids.lender, [J3])).grant_id;
    const people = await q<{ n: number }>(f.db, `select count(*)::int n from pm.portal_people where email = 'tia@acetile.test'`);
    expect(people[0].n).toBe(1); // one person across both tenants
  });

  it('staff read grants through RLS by company; other tenants see none', async () => {
    const own = await as(f, 'owner', () => q<{ id: string }>(f.db, `select id from pm.portal_grants`));
    expect(own.length).toBeGreaterThanOrEqual(6);
    const b = await as(f, 'bOwner', () => q<{ id: string }>(f.db, `select id from pm.portal_grants`));
    expect(b.map((x) => x.id)).toEqual([ids.gSubB]);
    expect(await as(f, 'labor', () => q(f.db, `select id from pm.portal_grants`))).toEqual([]);
  });
});

function L2Of(): string {
  // J3 is at L2 (fixture)
  return 'a0000000-0000-4000-8000-0000000000a2';
}

describe('sign-in', () => {
  it('fails closed without a registered server key, and refuses a wrong key', async () => {
    expect(await anonErr(`select portal.auth_start($1, 'pat@home.test', $2, $3, '123456', null, $4)`, [SERVER_KEY, sha('n'), rnd(), BASE])).toMatch(/PORTAL_NOT_SET_UP/);
    await f.db.query(`insert into pm.portal_server_keys (key_hash, note) values ($1, 'test')`, [sha(SERVER_KEY)]);
    expect(await anonErr(`select portal.auth_start($1, 'pat@home.test', $2, $3, '123456', null, $4)`, ['wrong-key-wrong-key-wrong', sha('n'), rnd(), BASE])).toMatch(/PORTAL_KEY/);
  });

  it('unknown addresses get the same answer and no message', async () => {
    const before = await one<{ n: number }>(`select count(*)::int n from core.outbound_messages`);
    const r = await anonRpc<{ ok: boolean; sent: boolean }>(`select portal.auth_start($1, 'nobody@x.test', $2, $3, '123456', null, $4) as r`, [SERVER_KEY, sha('n'), rnd(), BASE]);
    expect(r).toMatchObject({ ok: true, sent: false });
    expect((await one<{ n: number }>(`select count(*)::int n from core.outbound_messages`)).n).toBe(before.n);
  });

  it('a link works once, only in the browser that asked; the code works too; wrong codes lock out', async () => {
    const nonce = rnd(); const token = rnd();
    await anonRpc(`select portal.auth_start($1, 'pat@home.test', $2, $3, '654321', null, $4) as r`, [SERVER_KEY, sha(nonce), token, BASE]);
    // the notifications service records the message, but never the secret: the app sends it at dispatch time
    const msg = await one<{ id: string; body: string; status: string; attempts: number }>(`select id, body, status, attempts from core.outbound_messages where contact_id = $1 order by created_at desc limit 1`, [ids.homeowner]);
    expect(msg.status).toBe('sending');
    expect(msg.attempts).toBe(5); // a stale claim ends failed, never re-queued for the worker
    expect(msg.body).not.toContain(token);
    expect(msg.body).not.toContain('654321');
    expect(JSON.stringify(await q(f.db, `select * from core.outbound_messages`))).not.toMatch(/654321|portal\/auth\//);
    expect(await q(f.db, `select id from core.notify_outbound_claim(50) where id = $1`, [msg.id])).toEqual([]);
    await anonRpc(`select portal.dispatch_result($1, $2, true, 'resend', 'msg-1') as r`, [SERVER_KEY, msg.id]);
    expect((await one<{ status: string }>(`select status from core.outbound_messages where id = $1`, [msg.id])).status).toBe('sent');
    // staff (or anyone) holding the link but not the browser nonce cannot use it
    expect(await anonRpc<{ reason: string }>(`select portal.auth_redeem($1, $2, $3) as r`, [token, rnd(), sha(rnd())])).toMatchObject({ ok: false, reason: 'other_device' });
    // the code path, same browser: wrong code counts, right code opens a session
    expect(await anonRpc(`select portal.auth_verify_code('${SERVER_KEY}', 'pat@home.test', '000000', $1, $2) as r`, [nonce, sha(rnd())])).toMatchObject({ ok: false, reason: 'wrong_code' });
    expect(await anonRpc(`select portal.auth_verify_code('${SERVER_KEY}', 'pat@home.test', '654321', $1, $2) as r`, [nonce, sha(rnd())])).toMatchObject({ ok: true });
    expect(await anonRpc(`select portal.auth_redeem($1, $2, $3) as r`, [token, nonce, sha(rnd())])).toMatchObject({ ok: false, reason: 'used' });
    // five wrong codes revoke the link
    const n2 = rnd();
    await anonRpc(`select portal.auth_start($1, 'pat@home.test', $2, $3, '111111', null, $4) as r`, [SERVER_KEY, sha(n2), rnd(), BASE]);
    for (let i = 0; i < 4; i += 1) await anonRpc(`select portal.auth_verify_code('${SERVER_KEY}', 'pat@home.test', '999999', $1, $2) as r`, [n2, sha(rnd())]);
    expect(await anonRpc(`select portal.auth_verify_code('${SERVER_KEY}', 'pat@home.test', '999999', $1, $2) as r`, [n2, sha(rnd())])).toMatchObject({ reason: 'too_many' });
    expect(await anonRpc(`select portal.auth_verify_code('${SERVER_KEY}', 'pat@home.test', '111111', $1, $2) as r`, [n2, sha(rnd())])).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rate-limits sign-in requests per address', async () => {
    for (let i = 0; i < 2; i += 1) await anonRpc(`select portal.auth_start($1, 'sam@home.test', $2, $3, '123456', null, $4) as r`, [SERVER_KEY, sha('x'), rnd(), BASE]);
    let last: { reason?: string } = {};
    for (let i = 0; i < 4; i += 1) last = await anonRpc(`select portal.auth_start($1, 'sam@home.test', $2, $3, '123456', null, $4) as r`, [SERVER_KEY, sha('x'), rnd(), BASE]);
    expect(last.reason).toBe('rate_limited');
  });

  it('a forged or expired session is refused', async () => {
    expect(await anonErr(`select portal.home($1, $2)`, [rnd(), ORG_A])).toMatch(/PORTAL_AUTH/);
    expect(await anonErr(`select portal.me('short')`)).toMatch(/PORTAL_AUTH/);
  });
});

describe('scoping', () => {
  let pat: Session; let jo: Session; let tia: Session; let tiaB: Session; let lena: Session; let otto: Session;
  beforeAll(async () => {
    pat = await signIn('pat@home.test');
    jo = await signIn('jo@jones.test');
    tiaB = await signInAt('tia@acetile.test', ORG_B);
    tia = await switchTo(tiaB, ORG_A);
    lena = await signIn('lena@bank.test');
    otto = await signIn('otto@other.test');
  });

  it('the homeowner sees their job only, with the waiting-on-you queue (deadline and $ impact), no cost anywhere', async () => {
    const h = await home(pat);
    expect(h.jobs.map((j) => j.id)).toEqual([J1]);
    const kinds = h.queue.map((x) => `${x.kind}:${x.id}`);
    expect(kinds).toEqual(expect.arrayContaining([`estimate:${f.ids[`estimate:${J1}`]}`, `change_order:${f.ids[`co:${J1}`]}`, `selection:${ids.sel}`]));
    expect(kinds).not.toContain(`estimate:${f.ids[`estimate:${J2}`]}`);
    const est = h.queue.find((x) => x.kind === 'estimate')!;
    expect(est).toMatchObject({ amount_cents: 4200000, action: 'approve' });
    expect(est.deadline).toBeTruthy();
    const sel = h.queue.find((x) => x.kind === 'selection')!;
    expect(sel.amount_cents).toBe(334000 - 150000); // recommended option vs allowance
    expect([...keysDeep(h)].filter((k) => FORBIDDEN_KEYS.test(k))).toEqual([]);
    expect(JSON.stringify(h)).not.toMatch(/2500000|60000/); // estimate cost, CO cost impact
  });

  it('job view: client-visible milestones only; no other customer’s job; no other tenant', async () => {
    const j = await anonRpc<{ milestones: { title: string }[] }>(`select portal.job($1, $2, $3) as r`, [pat.token, ORG_A, J1]);
    expect(j.milestones.map((m) => m.title)).toEqual([`task ${J1.slice(-2)}`]);
    expect(JSON.stringify(j)).not.toContain('Internal margin review');
    expect([...keysDeep(j)].filter((k) => FORBIDDEN_KEYS.test(k))).toEqual([]);
    expect(await anonErr(`select portal.job($1, $2, $3)`, [pat.token, ORG_A, J2])).toMatch(/PORTAL_FORBIDDEN/);
    expect(await anonErr(`select portal.job($1, $2, $3)`, [jo.token, ORG_A, J1])).toMatch(/PORTAL_FORBIDDEN/);
    expect(await anonErr(`select portal.home($1, $2)`, [pat.token, ORG_B])).toMatch(/PORTAL_FORBIDDEN/);
    expect(await anonErr(`select portal.job($1, $2, $3)`, [pat.token, ORG_B, JB])).toMatch(/PORTAL_FORBIDDEN/);
  });

  it('one vendor login across two companies: each company shows only that company’s records', async () => {
    // one session = one company; the other company is offered for a switch (fresh code from it)
    const me = await anonRpc<{ orgs: { org_id: string }[]; other_orgs: { org_id: string }[] }>(`select portal.me($1) as r`, [tia.token]);
    expect(me.orgs.map((o) => o.org_id)).toEqual([ORG_A]);
    expect(me.other_orgs.map((o) => o.org_id)).toEqual([ORG_B]);
    expect(await anonErr(`select portal.home($1, $2)`, [tia.token, ORG_B])).toMatch(/PORTAL_FORBIDDEN/);
    expect(await anonErr(`select portal.home($1, $2)`, [tiaB.token, ORG_A])).toMatch(/PORTAL_FORBIDDEN/);
    const a = await home(tia, ORG_A);
    const kinds = a.queue.map((x) => `${x.kind}:${x.id}`);
    expect(kinds).toEqual(expect.arrayContaining([`assignment:${ids.subTask}`, `commitment:${ids.commit}`, `compliance:${ids.waiver}`, `punch:${ids.punch}`]));
    expect(kinds).not.toContain(`assignment:${ids.otherTask}`);
    expect(kinds.some((k) => k.startsWith('estimate') || k.startsWith('selection'))).toBe(false);
    const b = await home(tiaB, ORG_B);
    expect(b.jobs.map((j) => j.id)).toEqual([JB]);
    expect(b.queue).toEqual([]);
    // another sub on the same job sees only their own task
    const o = await home(otto, ORG_A);
    expect(o.queue.map((x) => x.id)).toEqual([ids.otherTask]);
  });

  it('the lender sees the draw on their loan only; the homeowner does not', async () => {
    const h = await home(lena);
    expect(h.queue.map((x) => `${x.kind}:${x.id}`)).toEqual([`draw:${ids.draw}`]);
    const d = await anonRpc<{ lines: { this_period_cents: number; budget_cents: number }[]; can_decide: boolean }>(`select portal.draw($1, $2, $3) as r`, [lena.token, ORG_A, ids.draw]);
    expect(d.can_decide).toBe(true);
    expect(d.lines[0]).toMatchObject({ this_period_cents: 800000, budget_cents: 5000000 });
    expect(await anonErr(`select portal.draw($1, $2, $3)`, [pat.token, ORG_A, ids.draw])).toMatch(/PORTAL_FORBIDDEN/);
  });

  it('another company cannot attach its own phone to someone and reach what this company shared', async () => {
    // org B records Pat's email with an attacker's phone, and invites them
    const c = (await one<{ id: string }>(`insert into core.contacts (org_id, customer_id, first_name, email, phone) values ($1, $2, 'Pat', 'pat@home.test', '+15155559999') returning id`, [ORG_B, ids.custB])).id;
    await as(f, 'bOwner', () => f.db.query(`select pm.portal_invite($1, 'customer', $2, $3::uuid[], $4::jsonb)`, [LB, c, [JB], JSON.stringify({ portal_url: BASE })]));
    const g = await one<{ person_id: string; phone: string }>(`select person_id, phone from pm.portal_grants where contact_id = $1`, [c]);
    const pat0 = await one<{ person_id: string }>(`select person_id from pm.portal_grants where id = $1`, [ids.gHome]);
    expect(g.person_id).toBe(pat0.person_id); // same person (matched by email) …
    expect((await one<{ phone: string }>(`select phone from pm.portal_people where id = $1`, [g.person_id])).phone).toBe('+15155550101'); // … whose phone org B could not change
    // the attacker signs in with their phone: org B only
    const nonce = rnd(); const token = rnd(); const sess = rnd();
    await anonRpc(`select portal.auth_start($1, '+1 515 555 9999', $2, $3, '123456', null, $4) as r`, [SERVER_KEY, sha(nonce), token, BASE]);
    expect(await anonRpc(`select portal.auth_redeem($1, $2, $3) as r`, [token, nonce, sha(sess)])).toMatchObject({ ok: true });
    const me = await anonRpc<{ orgs: { org_id: string }[] }>(`select portal.me($1) as r`, [sess]);
    expect(me.orgs.map((o) => o.org_id)).toEqual([ORG_B]);
    expect(await anonErr(`select portal.home($1, $2)`, [sess, ORG_A])).toMatch(/PORTAL_FORBIDDEN/);
    expect(await anonErr(`select portal.job($1, $2, $3)`, [sess, ORG_A, J1])).toMatch(/PORTAL_FORBIDDEN/);
    // Pat (by email) reaches org A only, and org B is not even listed until Pat opens it (invite link)
    const pm = await anonRpc<{ orgs: { org_id: string }[]; other_orgs: { org_id: string }[] }>(`select portal.me($1) as r`, [pat.token]);
    expect(pm.orgs.map((o) => o.org_id)).toEqual([ORG_A]);
    expect(pm.other_orgs).toEqual([]);
    const n2 = rnd(); const t2 = rnd(); const s2 = rnd();
    await anonRpc(`select portal.auth_start($1, 'pat@home.test', $2, $3, '123456', null, $4, 'en', $5) as r`, [SERVER_KEY, sha(n2), t2, BASE, ORG_B]);
    expect(await anonRpc(`select portal.auth_redeem($1, $2, $3) as r`, [t2, n2, sha(s2)])).toMatchObject({ ok: true, org_id: ORG_B });
    const pb = await anonRpc<{ orgs: { org_id: string }[]; other_orgs: { org_id: string }[] }>(`select portal.me($1) as r`, [s2]);
    expect(pb.orgs.map((o) => o.org_id)).toEqual([ORG_B]);
    expect(pb.other_orgs.map((o) => o.org_id)).toEqual([ORG_A]);
  });

  it('anon can read no pm table directly and execute nothing in pm', async () => {
    for (const t of ['portal_people', 'portal_sessions', 'portal_grants', 'portal_links', 'estimates']) {
      expect(await anonErr(`select * from pm.${t}`), t).toMatch(/permission denied/);
    }
    const r = await q<{ sig: string }>(f.db, `select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                               where n.nspname = 'pm' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(r).toEqual([]);
    const helpers = await q<{ sig: string }>(f.db, `select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                                     where n.nspname = 'portal' and p.proname like '\\_%' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(helpers).toEqual([]);
  });

  it('the registry guards still hold (classified tables, guarded RPCs)', async () => {
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
  });

  describe('decisions', () => {
    it('approvals need a verified phone when one is on file; the code is bound to the session', async () => {
      expect(await anonErr(`select portal.decide($1, $2, 'selection', $3, 'approved', 'Pat Smith', $4)`, [pat.token, ORG_A, ids.sel, ids.optB])).toMatch(/PORTAL_VERIFY/);
      // texting is held until the company turns it on, and suppressed without consent
      expect(await anonRpc(`select portal.phone_start($1, $2, '424242') as r`, [SERVER_KEY, pat.token])).toMatchObject({ ok: false });
      await f.db.query(`insert into core.sms_sender_numbers (org_id, location_id, phone, status, verified_at, provider_sid) values ($1, $2, '+15155550000', 'verified', now(), 'PN1')`, [ORG_A, L1]);
      await f.db.query(`update core.notification_settings set sms_enabled = true, sms_from_number = '+15155550000' where location_id = $1`, [L1]);
      await f.db.query(`update core.contacts set sms_consent = true where id = $1`, [ids.homeowner]);
      const st = await anonRpc<{ ok: boolean; reason: string }>(`select portal.phone_start($1, $2, '424242') as r`, [SERVER_KEY, pat.token]);
      expect(st.ok, st.reason).toBe(true);
      expect(st).toMatchObject({ dispatch: { channel: 'sms', to: '+15155550101', from: '+15155550000' } });
      const sms = await one<{ channel: string; body: string }>(`select channel, body from core.outbound_messages where contact_id = $1 order by created_at desc limit 1`, [ids.homeowner]);
      expect(sms.channel).toBe('sms');
      expect(sms.body).not.toContain('424242');
      // another session cannot use this code
      const other = await signInAt('pat@home.test', ORG_A);
      expect(await anonRpc(`select portal.phone_verify('${SERVER_KEY}', $1, '424242') as r`, [other.token])).toMatchObject({ ok: false });
      expect(await anonRpc(`select portal.phone_verify('${SERVER_KEY}', $1, '424242') as r`, [pat.token])).toMatchObject({ ok: true });
    });

    it('a viewer in the household cannot approve or sign, but sees the household and who can sign / pay', async () => {
      const tok = rnd();
      await f.db.query(`insert into pm.portal_sessions (person_id, org_id, token_hash, auth_method, verified_email, expires_at)
                        select person_id, org_id, $1, 'email', email, now() + interval '1 day' from pm.portal_grants where id = $2`, [sha(tok), ids.gSpouse]);
      expect(await anonErr(`select portal.decide($1, $2, 'estimate', $3, 'approved', 'Sam Smith')`, [tok, ORG_A, f.ids[`estimate:${J1}`]])).toMatch(/someone else in your household/);
      const j = await anonRpc<{ household: { name: string; role: string; can_sign: boolean; can_pay: boolean; you: boolean }[] }>(`select portal.job($1, $2, $3) as r`, [tok, ORG_A, J1]);
      expect(j.household).toEqual([
        { name: 'Sam Smith', role: 'viewer', can_sign: false, can_pay: false, you: true },
        { name: 'Pat Smith', role: 'approver', can_sign: true, can_pay: true, you: false },
      ]);
      expect(JSON.stringify(j.household)).not.toMatch(/@|\+1515/); // names and rights only
    });

    it('choosing a selection pins the choice and the allowance variance (method PORTAL), audited', async () => {
      const r = await anonRpc<{ ok: boolean; client_approval_id: string }>(
        `select portal.decide($1, $2, 'selection', $3, 'approved', 'Pat Smith', $4, null, null, '10.0.0.9', 'vitest') as r`, [pat.token, ORG_A, ids.sel, ids.optB]);
      expect(r.ok).toBe(true);
      const s = await one<{ status: string; chosen_total_cents: string; variance_cents: string; approved_by_name: string }>(
        `select status, chosen_total_cents, variance_cents, approved_by_name from pm.selections where id = $1`, [ids.sel]);
      expect({ ...s, chosen_total_cents: Number(s.chosen_total_cents), variance_cents: Number(s.variance_cents) })
        .toEqual({ status: 'APPROVED', chosen_total_cents: 334000, variance_cents: 184000, approved_by_name: 'Pat Smith' });
      const ca = await one<{ method: string; decision: string }>(`select method, decision from pm.client_approvals where id = $1`, [r.client_approval_id]);
      expect(ca).toEqual({ method: 'PORTAL', decision: 'APPROVED' });
      const a = await one<{ verified_by: string; ip: string; detail: Record<string, unknown> }>(`select verified_by, ip, detail from pm.portal_actions where subject_id = $1`, [ids.sel]);
      expect(a.verified_by).toBe('phone_code');
      expect(a.ip).toBe('10.0.0.9');
      expect(Object.keys(a.detail).some((k) => k.includes('cents'))).toBe(false);
    });

    it('approving a change order records the client decision once and tells the team (staff finalize)', async () => {
      await f.db.query(`insert into pm.job_members (org_id, job_id, membership_id, slot) values ($1, $2, $3, 'pm') on conflict do nothing`, [ORG_A, J1, f.membership.owner]);
      const r = await anonRpc<{ ok: boolean }>(`select portal.decide($1, $2, 'change_order', $3, 'approved', 'Pat Smith') as r`, [pat.token, ORG_A, f.ids[`co:${J1}`]]);
      expect(r.ok).toBe(true);
      expect((await one<{ stage: string }>(`select stage from pm.change_orders where id = $1`, [f.ids[`co:${J1}`]])).stage).toBe('COR');
      expect(await anonErr(`select portal.decide($1, $2, 'change_order', $3, 'approved', 'Pat Smith')`, [pat.token, ORG_A, f.ids[`co:${J1}`]])).toMatch(/already sent/);
      const n = await q<{ title: string }>(f.db, `select title from core.notifications where event_type = 'portal.activity' and job_id = $1`, [J1]);
      expect(n.length).toBeGreaterThanOrEqual(1);
      const h = await home(pat);
      expect(h.queue.find((x) => x.kind === 'change_order')).toMatchObject({ state: 'sent' });
    });

    it('a declined estimate needs a reason; the other customer cannot decide on it', async () => {
      expect(await anonErr(`select portal.decide($1, $2, 'estimate', $3, 'declined', 'Pat Smith')`, [pat.token, ORG_A, f.ids[`estimate:${J1}`]])).toMatch(/why/);
      expect(await anonErr(`select portal.decide($1, $2, 'estimate', $3, 'approved', 'Jo Jones')`, [jo.token, ORG_A, f.ids[`estimate:${J1}`]])).toMatch(/PORTAL_FORBIDDEN|PORTAL_VERIFY/);
    });

    it('the lender approves part of a draw (snapshot keeps the line amounts)', async () => {
      const r = await anonRpc<{ ok: boolean; client_approval_id: string }>(`select portal.decide($1, $2, 'draw', $3, 'approved', 'Lena Loan', null, null, $4::jsonb) as r`,
        [lena.token, ORG_A, ids.draw, JSON.stringify([{ line_id: ids.bline, approved_cents: 700000 }])]);
      expect(r.ok).toBe(true);
      const ca = await one<{ amount_cents: string }>(`select amount_cents from pm.client_approvals where id = $1`, [r.client_approval_id]);
      expect(Number(ca.amount_cents)).toBe(700000);
      expect(await anonErr(`select portal.decide($1, $2, 'draw', $3, 'approved', 'Lena Loan', null, null, $4::jsonb)`,
        [lena.token, ORG_A, ids.draw, JSON.stringify([{ line_id: ids.bline, approved_cents: 900000 }])])).toMatch(/exceeds|already/);
    });

    it('an e-sign link is minted only for the person’s own signer slot, and opens the signing page', async () => {
      expect(await anonErr(`select portal.esign_link($1, $2, $3, $4)`, [pat.token, ORG_A, '00000000-0000-4000-8000-000000000000', sha(rnd())])).toMatch(/PORTAL_FORBIDDEN/);
      const env = await as(f, 'owner', async () => {
        const d = await q<{ id: string }>(f.db, `insert into public.documents (org_id, storage_path, file_name, mime_type, size_bytes, doc_type, entity_type, uploaded_by_user)
                                                 values ($1, $2, 'addendum.pdf', 'application/pdf', 100, 'OTHER', 'pm.doc_files', 'user_owner') returning id`, [ORG_A, `${ORG_A}/pm/docs/addendum.pdf`]);
        const doc = await q<{ r: { file_id: string } }>(f.db, `select pm.doc_create($1, null, $2, $3::jsonb) as r`,
          [J1, d[0].id, JSON.stringify({ mime_type: 'application/pdf', content_sha256: sha('addendum'), title: 'Addendum' })]);
        const e = await q<{ id: string }>(f.db, `select pm.esign_create($1, $2::jsonb, '{}'::jsonb) as id`,
          [doc[0].r.file_id, JSON.stringify([{ name: 'Pat Smith', email: 'pat@home.test' }, { name: 'Jo Jones', email: 'jo@jones.test' }])]);
        await f.db.query(`select pm.esign_send($1)`, [e[0].id]);
        return e[0].id;
      });
      const item = (await home(pat)).queue.find((x) => x.kind === 'signature' && x.id === env)!;
      expect(item).toBeTruthy();
      // Jo is a signer on the envelope but has no access to J1: no item, no link
      expect((await home(jo)).queue.some((x) => x.id === env)).toBe(false);
      const tok = rnd();
      const r = await anonRpc<{ ok: boolean }>(`select portal.esign_link($1, $2, $3, $4) as r`, [pat.token, ORG_A, item.signer_id, sha(tok)]);
      expect(r.ok).toBe(true);
      const open = await anonRpc<{ ok: boolean; can_act: boolean }>(`select esign.open($1) as r`, [tok]);
      expect(open).toMatchObject({ ok: true, can_act: true });
    });
  });

  describe('subs', () => {
    it('confirm / propose a date; staff accept moves the task start', async () => {
      expect(await anonErr(`select portal.task_respond($1, $2, $3, 'confirmed')`, [tia.token, ORG_A, ids.otherTask])).toMatch(/not assigned to you/);
      const d = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
      const r = await anonRpc<{ id: string }>(`select portal.task_respond($1, $2, $3, 'proposed', $4::date, 'Tile arrives late') as r`, [tia.token, ORG_A, ids.subTask, d]);
      await as(f, 'owner', () => f.db.query(`select pm.portal_resolve_response($1, 'accepted')`, [r.id]));
      expect((await one<{ s: string }>(`select start_on::text s from pm.tasks where id = $1`, [ids.subTask])).s).toBe(d);
    });

    it('pay application against the commitment lines: retainage computed, over-billing refused, other subs refused', async () => {
      const r = await anonRpc<{ gross_cents: number; retainage_cents: number; net_cents: number; application_no: number }>(
        `select portal.submit_pay_app($1, $2, $3, $4::jsonb, current_date, 'INV-7') as r`, [tia.token, ORG_A, ids.commit, JSON.stringify([{ line_id: ids.cline, pct_complete: 0.5 }])]);
      expect(r).toMatchObject({ gross_cents: 500000, retainage_cents: 50000, net_cents: 450000, application_no: 1 });
      expect(await anonErr(`select portal.submit_pay_app($1, $2, $3, $4::jsonb, current_date)`, [tia.token, ORG_A, ids.commit, JSON.stringify([{ line_id: ids.cline, pct_complete: 0.4 }])])).toMatch(/already billed/);
      expect(await anonErr(`select portal.submit_pay_app($1, $2, $3, $4::jsonb, current_date)`, [otto.token, ORG_A, ids.commit, JSON.stringify([{ line_id: ids.cline, pct_complete: 0.9 }])])).toMatch(/PORTAL_FORBIDDEN/);
      // staff with financials see it; labor does not
      expect((await as(f, 'owner', () => q(f.db, `select id from pm.portal_pay_apps`))).length).toBe(1);
      expect(await as(f, 'labor', () => q(f.db, `select id from pm.portal_pay_apps`))).toEqual([]);
    });

    it('upload → lien waiver received on the job; W-9 → Books review queue', async () => {
      const up = async (name: string, mime: string) => {
        const b = await anonRpc<{ upload_id: string; path: string }>(`select portal.upload_begin($1, $2, 'compliance', $3, $4, 2048) as r`, [tia.token, ORG_A, name, mime]);
        expect(b.path.startsWith(`${ORG_A}/pm/`)).toBe(true);
        expect(await anonErr(`select portal.upload_finish($1, $2)`, [tia.token, b.upload_id])).toMatch(/did not arrive/);
        await f.db.query(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [b.path]);
        return (await anonRpc<{ document_id: string }>(`select portal.upload_finish($1, $2) as r`, [tia.token, b.upload_id])).document_id;
      };
      const waiverDoc = await up('waiver.pdf', 'application/pdf');
      await anonRpc(`select portal.compliance_submit($1, $2, 'LIEN_WAIVER', $3, $4) as r`, [tia.token, ORG_A, waiverDoc, ids.waiver]);
      expect((await one<{ status: string }>(`select status from pm.compliance_docs where id = $1`, [ids.waiver])).status).toBe('RECEIVED');
      const w9 = await up('w9.pdf', 'application/pdf');
      const s = await anonRpc<{ target: string; id: string }>(`select portal.compliance_submit($1, $2, 'W9', $3) as r`, [tia.token, ORG_A, w9]);
      expect(s.target).toBe('books');
      const sub = await one<{ status: string; source: string; vendor_id: string }>(`select status, source, vendor_id from public.vendor_document_submissions where id = $1`, [s.id]);
      expect(sub).toEqual({ status: 'received', source: 'portal_upload', vendor_id: ids.vendor });
      // someone else's upload cannot be filed
      expect(await anonErr(`select portal.compliance_submit($1, $2, 'W9', $3)`, [otto.token, ORG_A, w9])).toMatch(/upload the file first/);
      // and the customer cannot open compliance / pay-app slots
      expect(await anonErr(`select portal.upload_begin($1, $2, 'compliance', 'x.pdf', 'application/pdf', 10)`, [pat.token, ORG_A])).toMatch(/PORTAL_FORBIDDEN/);
      expect(await anonErr(`select portal.upload_begin($1, $2, 'photo', 'x.exe', 'application/x-msdownload', 10)`, [pat.token, ORG_A])).toMatch(/PDF or a photo/);
    });
  });

  describe('messages, requests and files', () => {
    it('threads are per party: the homeowner and staff talk; another sub or customer never reads it', async () => {
      await anonRpc(`select portal.post_message($1, $2, $3, 'customer', 'When is tile going in?') as r`, [pat.token, ORG_A, J1]);
      await as(f, 'owner', () => f.db.query(`select pm.portal_post_message($1, 'customer', $2, 'Tuesday!', $3)`, [J1, ids.cust, BASE]));
      const t = await anonRpc<{ body: string; from_team: boolean }[]>(`select portal.messages($1, $2, $3, 'customer') as r`, [pat.token, ORG_A, J1]);
      expect(t.map((m) => m.body)).toEqual(['When is tile going in?', 'Tuesday!']);
      expect(await anonErr(`select portal.messages($1, $2, $3, 'customer')`, [tia.token, ORG_A, J1])).toMatch(/PORTAL_FORBIDDEN/);
      const sub = await anonRpc<unknown[]>(`select portal.messages($1, $2, $3, 'vendor') as r`, [tia.token, ORG_A, J1]);
      expect(sub).toEqual([]);
      const crm = await q(f.db, `select 1 from crm.activities where kind = 'portal_message' and job_id = $1`, [J1]);
      expect(crm.length).toBe(1);
    });

    it('a shared document opens through a 2-minute grant; an unshared one does not', async () => {
      await f.db.query(`insert into public.documents (id, org_id, storage_path, file_name, mime_type) values ('d0000000-0000-4000-8000-000000000001', $1, $2, 'plan.pdf', 'application/pdf')`, [ORG_A, `${ORG_A}/pm/docs/plan.pdf`]);
      const file = await one<{ id: string }>(`insert into pm.doc_files (org_id, location_id, job_id, title, kind) values ($1, $2, $3, 'Plans', 'file') returning id`, [ORG_A, L1, J1]);
      const v = await one<{ id: string }>(`insert into pm.doc_versions (org_id, file_id, version_no, document_id, file_name, mime_type) values ($1, $2, 1, 'd0000000-0000-4000-8000-000000000001', 'plan.pdf', 'application/pdf') returning id`, [ORG_A, file.id]);
      await f.db.query(`update pm.doc_files set current_version_id = $1 where id = $2`, [v.id, file.id]);
      expect(await anonErr(`select portal.file_grant($1, $2, 'document', $3)`, [pat.token, ORG_A, file.id])).toMatch(/PORTAL_FORBIDDEN/);
      await as(f, 'owner', () => f.db.query(`select pm.portal_share_document($1, array['customer'])`, [file.id]));
      const g = await anonRpc<{ path: string }>(`select portal.file_grant($1, $2, 'document', $3) as r`, [pat.token, ORG_A, file.id]);
      expect(g.path).toBe(`${ORG_A}/pm/docs/plan.pdf`);
      expect(await anonRpc<boolean>(`select portal.download_path_ok($1) as r`, [g.path])).toBe(true);
      expect(await anonRpc<boolean>(`select portal.download_path_ok($1) as r`, [`${ORG_A}/pm/docs/other.pdf`])).toBe(false);
      expect(await anonErr(`select portal.file_grant($1, $2, 'document', $3)`, [jo.token, ORG_A, file.id])).toMatch(/PORTAL_FORBIDDEN/);
    });

    it('a warranty request lands for the team with its photos', async () => {
      const r = await anonRpc<{ id: string }>(`select portal.service_request($1, $2, $3, 'warranty', 'Cabinet door sags', 'Left of sink') as r`, [pat.token, ORG_A, J1]);
      const staff = await as(f, 'owner', () => q<{ title: string }>(f.db, `select title from pm.portal_requests where id = $1`, [r.id]));
      expect(staff).toEqual([{ title: 'Cabinet door sags' }]);
      await as(f, 'owner', () => f.db.query(`select pm.portal_update_request($1, 'acknowledged', 'We will call')`, [r.id]));
    });
  });

  describe('revocation and expiry', () => {
    it('revoking a grant ends access at once (the session stays, the access does not)', async () => {
      expect((await home(jo)).jobs.map((j) => j.id)).toEqual([J2]);
      await as(f, 'owner', () => f.db.query(`select pm.portal_revoke($1, 'Project closed')`, [ids.gOther]));
      expect(await anonErr(`select portal.home($1, $2)`, [jo.token, ORG_A])).toMatch(/PORTAL_FORBIDDEN/);
      expect(await anonErr(`select portal.job($1, $2, $3)`, [jo.token, ORG_A, J2])).toMatch(/PORTAL_FORBIDDEN/);
      expect((await anonRpc<{ orgs: unknown[] }>(`select portal.me($1) as r`, [jo.token])).orgs).toEqual([]);
    });

    it('an expired grant reaches nothing; staff can extend it', async () => {
      await f.db.query(`update pm.portal_grants set expires_at = now() - interval '1 minute' where id = $1`, [ids.gSub2]);
      expect(await anonErr(`select portal.home($1, $2)`, [otto.token, ORG_A])).toMatch(/PORTAL_FORBIDDEN/);
      await as(f, 'owner', () => f.db.query(`select pm.portal_update_grant($1, $2::jsonb)`, [ids.gSub2, JSON.stringify({ expires_at: new Date(Date.now() + 86400000).toISOString() })]));
      expect((await home(otto)).jobs.map((j) => j.id)).toEqual([J1]);
    });

    it('signing out revokes the session', async () => {
      const s = await signIn('otto@other.test');
      expect(await anonRpc(`select portal.sign_out($1) as r`, [s.token])).toBe(true);
      expect(await anonErr(`select portal.home($1, $2)`, [s.token, ORG_A])).toMatch(/PORTAL_AUTH/);
    });
  });
});

describe('security review (2026-10-25) proofs', () => {
  it('F1: a company that records the same email cannot read the code from its outbound log, and a code it issues opens only that company', async () => {
    const v = (await one<{ id: string }>(`insert into core.contacts (org_id, customer_id, first_name, email) values ($1, $2, 'Vic', 'victim2@home.test') returning id`, [ORG_A, ids.cust])).id;
    const planted = (await one<{ id: string }>(`insert into core.contacts (org_id, customer_id, first_name, email) values ($1, $2, 'Vic', 'victim2@home.test') returning id`, [ORG_B, ids.custB])).id;
    await as(f, 'owner', () => f.db.query(`select pm.portal_invite($1, 'customer', $2, $3::uuid[], $4::jsonb)`, [L1, v, [J1], JSON.stringify({ portal_url: BASE })]));
    const victim = await signInAt('victim2@home.test', ORG_A);
    await as(f, 'bOwner', () => f.db.query(`select pm.portal_invite($1, 'customer', $2, $3::uuid[], $4::jsonb)`, [LB, planted, [JB], JSON.stringify({ portal_url: BASE })]));
    // org B's admin asks for a code from their own browser
    const nonce = rnd();
    const r = await anonRpc<{ ok: boolean; sent: boolean; dispatch: { company: string } }>(
      `select portal.auth_start($1, 'victim2@home.test', $2, $3, '482913', '10.0.0.9', $4, 'en') as r`, [SERVER_KEY, sha(nonce), rnd(), BASE]);
    expect(r.ok).toBe(true);
    const log = await as(f, 'bOwner', () => q<{ body: string }>(f.db, `select body from pm.notify_outbound_messages(null, 200) where event_type = 'customer.portal_access'`));
    expect(log.length).toBeGreaterThan(0);
    expect(log.map((x) => x.body ?? '').join(' ')).not.toMatch(/482913|\/portal\/auth\//);
    // even holding the code, the session reaches only the company that sent it
    const sess = rnd();
    const opened = await anonRpc<{ ok: boolean; org_id: string }>(`select portal.auth_verify_code('${SERVER_KEY}', 'victim2@home.test', '482913', $1, $2) as r`, [nonce, sha(sess)]);
    expect(opened.ok).toBe(true);
    const other = opened.org_id === ORG_A ? ORG_B : ORG_A;
    expect(await anonErr(`select portal.home($1, $2)`, [sess, other])).toMatch(/PORTAL_FORBIDDEN/);
    // the same address live at two companies is flagged for the platform
    const ev = await q<{ kind: string }>(f.db, `select kind from pm.portal_security_events where identifier_hash = $1`, [sha('victim2@home.test')]);
    expect(ev.map((e) => e.kind)).toContain('multi_org_sessions');
    void victim;
  });

  it('F2: lender / investor access needs a party', async () => {
    const loose = (await one<{ id: string }>(`insert into core.contacts (org_id, first_name, email) values ($1, 'Loose', 'loose@lender.test') returning id`, [ORG_A])).id;
    expect(await as(f, 'owner', () => errorOf(f.db, `select pm.portal_invite($1, 'lender', $2, $3::uuid[], '{}'::jsonb)`, [L2Of(), loose, [J3]]))).toMatch(/customer record/);
    expect(await errorOf(f.db, `update pm.portal_grants set customer_id = null where id = $1`, [ids.gLender])).toMatch(/check constraint/);
  });

  it('F3: duplicate draw lines are refused and the approved total never exceeds the request', async () => {
    await f.db.exec(`set session_replication_role = replica`);
    try {
      await f.db.query(`update pm.draws set status = 'CANCELLED', cancelled_at = now() where id = $1`, [ids.draw]);
    } finally {
      await f.db.exec(`set session_replication_role = origin`);
    }
    const d2 = (await one<{ id: string }>(`insert into pm.draws (org_id, job_id, draw_schedule_id, draw_number, period_end, created_by) values ($1, $2, $3, 2, current_date, 'user_pm') returning id`, [ORG_A, J3, ids.sched])).id;
    await f.db.query(`insert into pm.draw_lines (org_id, job_id, draw_schedule_id, draw_id, draw_budget_line_id, requested_cents) values ($1, $2, $3, $4, $5, 800000)`, [ORG_A, J3, ids.sched, d2, ids.bline]);
    await f.db.exec(`set session_replication_role = replica`);
    try {
      await f.db.query(`update pm.draws set status = 'SUBMITTED', submitted_at = now(), submitted_by = 'user_pm', requested_cents = 500000 where id = $1`, [d2]);
    } finally {
      await f.db.exec(`set session_replication_role = origin`);
    }
    const lena = await signInAt('lena@bank.test', ORG_A);
    const dup = JSON.stringify([{ line_id: ids.bline, approved_cents: 800000 }, { line_id: ids.bline, approved_cents: 800000 }]);
    expect(await anonErr(`select portal.decide($1, $2, 'draw', $3, 'approved', 'Lena Loan', null, null, $4::jsonb)`, [lena.token, ORG_A, d2, dup])).toMatch(/once/);
    const over = JSON.stringify([{ line_id: ids.bline, approved_cents: 800000 }]);
    expect(await anonErr(`select portal.decide($1, $2, 'draw', $3, 'approved', 'Lena Loan', null, null, $4::jsonb)`, [lena.token, ORG_A, d2, over])).toMatch(/exceeds what was requested/);
    const ok = await anonRpc<{ ok: boolean }>(`select portal.decide($1, $2, 'draw', $3, 'approved', 'Lena Loan', null, null, $4::jsonb) as r`,
      [lena.token, ORG_A, d2, JSON.stringify([{ line_id: ids.bline, approved_cents: 450000 }])]);
    expect(ok.ok).toBe(true);
  });

  it('a change order on another customer’s contract never reaches this customer', async () => {
    const ct = (await one<{ id: string }>(`insert into pm.contracts (org_id, job_id, customer_id, original_cents) values ($1, $2, $3, 100000) returning id`, [ORG_A, J1, ids.cust2])).id;
    const co = (await one<{ id: string }>(`insert into pm.change_orders (org_id, job_id, contract_id, number, title, amount_cents, stage) values ($1, $2, $3, 'CO-X-1', 'Jones extra', 50000, 'COR') returning id`, [ORG_A, J1, ct])).id;
    const tok = rnd();
    await f.db.query(`insert into pm.portal_sessions (person_id, org_id, token_hash, auth_method, verified_email, verified_phone, phone_verified_at, expires_at)
                      select person_id, org_id, $1, 'sms', email, phone, now(), now() + interval '1 day' from pm.portal_grants where id = $2`, [sha(tok), ids.gHome]);
    const h = await anonRpc<{ queue: { id: string }[] }>(`select portal.home($1, $2) as r`, [tok, ORG_A]);
    expect(h.queue.map((x) => x.id)).not.toContain(co);
    expect(await anonErr(`select portal.item($1, $2, 'change_order', $3)`, [tok, ORG_A, co])).toMatch(/PORTAL_FORBIDDEN/);
    expect(await anonErr(`select portal.decide($1, $2, 'change_order', $3, 'approved', 'Pat Smith')`, [tok, ORG_A, co])).toMatch(/PORTAL_FORBIDDEN/);
  });
});

describe('security re-review: code guessing, request caps, unresolvable change orders', () => {
  const lockId = 'lock@home.test';
  beforeAll(async () => {
    const c = (await one<{ id: string }>(`insert into core.contacts (org_id, customer_id, first_name, email) values ($1, $2, 'Lock', $3) returning id`, [ORG_A, ids.cust, lockId])).id;
    await as(f, 'owner', () => f.db.query(`select pm.portal_invite($1, 'customer', $2, $3::uuid[], '{}'::jsonb)`, [L1, c, [J1]]));
  });

  it('code checks go only through the app (server key)', async () => {
    expect(await anonErr(`select portal.auth_verify_code('nope-nope-nope-nope', 'pat@home.test', '123456', $1, $2)`, [rnd(), sha(rnd())])).toMatch(/PORTAL_KEY/);
    expect(await anonErr(`select portal.phone_verify('nope-nope-nope-nope', $1, '123456')`, [rnd()])).toMatch(/PORTAL_KEY/);
  });

  it('15 wrong codes in a day across links lock the address for 24 hours (with a security event)', async () => {
    for (let k = 0; k < 3; k += 1) {
      const nonce = rnd();
      await anonRpc(`select portal.auth_start($1, $2, $3, $4, '777777', '10.9.9.9', $5) as r`, [SERVER_KEY, lockId, sha(nonce), rnd(), BASE]);
      for (let i = 0; i < 5; i += 1) await anonRpc(`select portal.auth_verify_code($1, $2, '000000', $3, $4, '10.9.9.9') as r`, [SERVER_KEY, lockId, nonce, sha(rnd())]);
    }
    const ev = await q(f.db, `select 1 from pm.portal_security_events where kind = 'address_locked' and identifier_hash = $1`, [sha(lockId)]);
    expect(ev.length).toBe(1);
    const nonce = rnd();
    expect(await anonRpc(`select portal.auth_start($1, $2, $3, $4, '777777', '10.9.9.9', $5) as r`, [SERVER_KEY, lockId, sha(nonce), rnd(), BASE])).toMatchObject({ sent: false, reason: 'locked' });
    expect(await anonRpc(`select portal.auth_verify_code($1, $2, '777777', $3, $4, '10.9.9.9') as r`, [SERVER_KEY, lockId, nonce, sha(rnd())])).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('per client IP: 30 code checks an hour', async () => {
    let last: { reason?: string } = {};
    for (let i = 0; i < 31; i += 1) {
      last = await anonRpc(`select portal.auth_verify_code($1, $2, '000000', $3, $4, '10.8.8.8') as r`, [SERVER_KEY, `nobody${i}@x.test`, rnd(), sha(rnd())]);
    }
    expect(last.reason).toBe('rate_limited');
    // another IP is not affected
    expect(await anonRpc(`select portal.auth_verify_code($1, 'nobody0@x.test', '000000', $2, $3, '10.8.8.9') as r`, [SERVER_KEY, rnd(), sha(rnd())])).toMatchObject({ reason: 'expired' });
  });

  it('per address: at most 10 sign-in requests a day (no spamming a victim)', async () => {
    await f.db.query(`insert into pm.portal_rate_counters (bucket, window_start, expires_at, hits) values ($1, date_trunc('day', now()), date_trunc('day', now()) + interval '1 day', 10) on conflict (bucket, window_start) do update set hits = 10`,
      [`signin:idday:${sha('jo@jones.test')}`]);
    expect(await anonRpc(`select portal.auth_start($1, 'jo@jones.test', $2, $3, '123456', '10.7.7.7', $4) as r`, [SERVER_KEY, sha(rnd()), rnd(), BASE])).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('a change order with no resolvable customer is never shown or approvable in the portal', async () => {
    await f.db.query(`update core.jobs set customer_id = null where id = $1`, [J1]);
    try {
      const co = (await one<{ id: string }>(`insert into pm.change_orders (org_id, job_id, number, title, amount_cents, stage) values ($1, $2, 'CO-NC-1', 'Orphan', 1000, 'COR') returning id`, [ORG_A, J1])).id;
      const tok = rnd();
      await f.db.query(`insert into pm.portal_sessions (person_id, org_id, token_hash, auth_method, verified_email, verified_phone, phone_verified_at, expires_at)
                        select person_id, org_id, $1, 'sms', email, phone, now(), now() + interval '1 day' from pm.portal_grants where id = $2`, [sha(tok), ids.gHome]);
      const h = await anonRpc<{ queue: { id: string }[] }>(`select portal.home($1, $2) as r`, [tok, ORG_A]);
      expect(h.queue.map((x) => x.id)).not.toContain(co);
      expect(await anonErr(`select portal.item($1, $2, 'change_order', $3)`, [tok, ORG_A, co])).toMatch(/PORTAL_FORBIDDEN/);
      expect(await anonErr(`select portal.decide($1, $2, 'change_order', $3, 'approved', 'Pat Smith')`, [tok, ORG_A, co])).toMatch(/PORTAL_FORBIDDEN/);
    } finally {
      await f.db.query(`update core.jobs set customer_id = $1 where id = $2`, [ids.cust, J1]);
    }
  });
});

describe('idempotency', () => {
  it('1118 applies a second time; guards, grants and data survive', async () => {
    const before = await one<{ n: number }>(`select count(*)::int n from pm.portal_grants`);
    await applyMigration(f.db, '1118_pm_portals.sql');
    expect((await one<{ n: number }>(`select count(*)::int n from pm.portal_grants`)).n).toBe(before.n);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await as(f, 'labor', () => errorOf(f.db, `select pm.portal_invite($1, 'customer', $2, $3::uuid[], '{}'::jsonb)`, [L1, ids.homeowner, [J1]]))).toMatch(/PM_FORBIDDEN/);
  });
});
