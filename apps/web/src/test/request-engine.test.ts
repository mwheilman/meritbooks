/**
 * Migration 178 + lib/requests — the request & chase engine against a REAL Postgres
 * (PGlite migration replay WITH hosted Supabase's default grants, so "members can't
 * write" is not vacuous). FPB-request-engine-notifications §8.
 *
 *   RLS        members read only their org's requests and only their OWN notifications;
 *              nobody but the service role reads request_tokens; members / anon cannot
 *              write any 178 table.
 *   engine     W-9 proof end to end (vendor → request → email with a /r/ link → cadence),
 *              no double-send on rerun or a racing stale copy, quiet hours, escalation
 *              exactly once, auto-fulfil from the books and from a portal upload, token
 *              hashing, not-configured email = skipped (never "sent"), suppression,
 *              bounce webhook, vendor sync dedupe, the scheduler job wrapper.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import type { Channels, EmailOut, ChannelOutcome } from '@/lib/notify/channels';
import { smsChannel, pushChannel } from '@/lib/notify/channels';
import { dispatchDueRequests, dispatchOne, type EngineDeps } from '@/lib/requests/dispatch';
import { createRequest, cancelRequest, fulfilRequest, getRequest, sendNow } from '@/lib/requests/service';
import { loadPolicyContext } from '@/lib/requests/policy';
import { hashRequestToken, resolveRequestToken } from '@/lib/requests/tokens';
import { createVendorDocRequest, syncVendorComplianceRequests, vendorPortalPathFor } from '@/lib/requests/vendor-compliance';
import { applyResendEvent } from '@/lib/notify/resend-webhook';
import { REQUESTS_DISPATCH_JOB, runRequestsDispatchJob } from '@/lib/scheduler/jobs/requests-dispatch';
import { isValidCron } from '@/lib/scheduler/cron';
import { openRequestLink, unsubscribeByToken } from '@/lib/requests/public-link';
import type { RequestRow } from '@/lib/requests/types';
import type { JobContext } from '@/lib/scheduler/types';

const ORG_A = '17800000-0000-0000-0000-00000000000a';
const ORG_B = '17800000-0000-0000-0000-00000000000b';
const VENDOR = '17800000-0000-0000-0000-0000000000a1';
const VENDOR_2 = '17800000-0000-0000-0000-0000000000a2';
const VENDOR_B = '17800000-0000-0000-0000-0000000000b1';

let db: PGlite;
let svc: SupabaseClient;
const members = new Map<string, string>(); // label → membership id

// Mon 2026-11-02 15:00Z = 09:00 America/Chicago (CST, after the Nov 1 DST change)
const T0 = new Date('2026-11-02T15:00:00Z');
const DAY = 86_400_000;

interface Sent { to: string; subject: string; html: string; text: string }
let providerSeq = 0; // unique provider ids across every mock (as Resend's are)
const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : v);
function mockEmail(mode: { state: 'ok' | 'fail' | 'off' } = { state: 'ok' }) {
  const sent: Sent[] = [];
  const channel = {
    id: 'email' as const,
    async send(m: EmailOut): Promise<ChannelOutcome> {
      if (mode.state === 'off') return { status: 'not_configured', reason: 'Email is not configured (test).' };
      if (mode.state === 'fail') return { status: 'failed', reason: 'Resend 500 (test)', provider: 'resend' };
      sent.push(m);
      providerSeq++;
      return { status: 'sent', provider: 'resend', providerMessageId: `re_test_${providerSeq}` };
    },
  };
  const channels: Channels = { email: channel, sms: smsChannel(), push: pushChannel() };
  return { sent, channels, mode };
}

function deps(at: Date, channels: Channels): EngineDeps {
  return { db: svc, channels, now: () => at, appUrl: 'https://books.example.test' };
}

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function as<T>(sub: string | null, org: string | null, fn: () => Promise<T>): Promise<T> {
  const claims = sub ? { sub, org_id: org, role: 'authenticated' } : {};
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${sub ? 'authenticated' : 'anon'}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function addMember(label: string, org: string, role: string): Promise<void> {
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [`user_${label}`]);
  const m = await db.query<{ id: string }>(`insert into core.memberships (user_id, org_id, role, status) values ($1, $2, $3, 'active') returning id`, [u.rows[0].id, org, role]);
  members.set(label, m.rows[0].id);
}

async function events(requestId: string): Promise<Array<{ event_type: string; channel: string | null; delivery_status: string | null; provider_message_id: string | null; step: number | null }>> {
  return (
    await db.query<{ event_type: string; channel: string | null; delivery_status: string | null; provider_message_id: string | null; step: number | null }>(
      `select event_type, channel, delivery_status, provider_message_id, step from core.request_events where request_id = $1 order by occurred_at, event_type`,
      [requestId],
    )
  ).rows;
}

async function row(id: string): Promise<RequestRow> {
  return (await getRequest({ db: svc }, ORG_A, id)) as RequestRow;
}

function tokenFrom(html: string): string {
  const m = /\/r\/([A-Za-z0-9_-]{40,64})"/.exec(html);
  if (!m) throw new Error('no /r/ link in email');
  return m[1];
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  svc = pgSupabase(db);
  await db.exec(`
    insert into core.organizations (id, name, slug, timezone) values
      ('${ORG_A}', 'Artistry Homes', 'artistry', 'America/Chicago'),
      ('${ORG_B}', 'Tenant B', 'tenant-b', 'America/New_York');
    insert into core.vendors (id, org_id, name, email) values
      ('${VENDOR}', '${ORG_A}', 'Prairie Drywall', 'ap@prairie.test'),
      ('${VENDOR_2}', '${ORG_A}', 'Cedar Electric', 'office@cedar.test'),
      ('${VENDOR_B}', '${ORG_B}', 'Other Vendor', 'x@other.test');
    insert into public.vendor_compliance_docs (org_id, vendor_id, doc_type, status) values
      ('${ORG_A}', '${VENDOR}', 'W9', 'MISSING'),
      ('${ORG_A}', '${VENDOR_2}', 'W9', 'MISSING');
  `);
  await addMember('owner', ORG_A, 'owner');
  await addMember('bk', ORG_A, 'accounting_specialist');
  await addMember('b_admin', ORG_B, 'owner');
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('migration 178 — RLS and write locks', () => {
  it('members cannot write any 178 table; anon cannot read them', async () => {
    for (const t of ['requests', 'request_events', 'request_tokens', 'request_policies', 'request_suppressions', 'notifications', 'notification_prefs']) {
      const ins = await as('user_bk', ORG_A, () => errorOf(`insert into core.${t} (org_id) values ('${ORG_A}')`));
      expect(ins, t).toMatch(/permission denied|row-level security|violates not-null/i);
      expect(await as('user_bk', ORG_A, () => errorOf(`update core.${t} set org_id = org_id`)), t).toMatch(/permission denied/i);
      expect(await as('user_bk', ORG_A, () => errorOf(`delete from core.${t}`)), t).toMatch(/permission denied/i);
      expect(await as(null, null, () => errorOf(`select 1 from core.${t}`)), t).toMatch(/permission denied/i);
    }
  });

  it('members read only their org; request_tokens are invisible to members', async () => {
    const owner = members.get('owner')!;
    await createRequest(deps(T0, mockEmail().channels), {
      orgId: ORG_A, kind: 'client_question', title: 'Is the Home Depot charge on the Ankeny job?', recipient: { type: 'email', email: 'client@a.test' }, createdBy: 'user_owner', ownerMembershipId: owner,
    });
    await createRequest(deps(T0, mockEmail().channels), {
      orgId: ORG_B, kind: 'client_question', title: 'B question', recipient: { type: 'email', email: 'client@b.test' }, createdBy: 'user_b_admin',
    });
    const seenA = await as('user_bk', ORG_A, async () => (await db.query<{ org_id: string }>(`select org_id from core.requests`)).rows);
    expect(seenA.length).toBeGreaterThan(0);
    expect(seenA.every((r) => r.org_id === ORG_A)).toBe(true);
    const seenB = await as('user_b_admin', ORG_B, async () => (await db.query<{ title: string }>(`select title from core.requests`)).rows.map((r) => r.title));
    expect(seenB).toEqual(['B question']);
    expect(await as('user_bk', ORG_A, () => errorOf(`select * from core.request_tokens`))).toMatch(/permission denied/i);
  });

  it('a member reads only their OWN notifications (not a colleague’s, not another tenant’s)', async () => {
    await db.query(
      `insert into core.notifications (org_id, membership_id, kind, title) values ($1, $2, 'request.escalated', 'for owner'), ($1, $3, 'request.escalated', 'for bk'), ($4, $5, 'request.escalated', 'for b')`,
      [ORG_A, members.get('owner'), members.get('bk'), ORG_B, members.get('b_admin')],
    );
    const bk = await as('user_bk', ORG_A, async () => (await db.query<{ title: string }>(`select title from core.notifications`)).rows.map((r) => r.title));
    expect(bk).toEqual(['for bk']);
    // a forged org claim does not leak tenant B's rows to an A member
    const forged = await as('user_bk', ORG_B, async () => (await db.query<{ title: string }>(`select title from core.notifications`)).rows.map((r) => r.title));
    expect(forged).toEqual([]);
  });

  it('CHECKs hold: bad channel, external deep link, unknown kind', async () => {
    expect(await errorOf(`insert into core.requests (org_id, kind, title, recipient_type, channels) values ('${ORG_A}', 'w9', 'x', 'email', array['fax'])`)).toMatch(/requests_channels_chk/);
    expect(await errorOf(`insert into core.requests (org_id, kind, title, recipient_type, deep_link) values ('${ORG_A}', 'w9', 'x', 'email', '//evil.test')`)).toMatch(/requests_deep_link_chk/);
    expect(await errorOf(`insert into core.requests (org_id, kind, title, recipient_type) values ('${ORG_A}', 'telegram', 'x', 'email')`)).toMatch(/requests_kind_chk/);
    expect(await errorOf(`insert into core.request_tokens (org_id, request_id, token_hash, expires_at) select org_id, id, 'not-a-hash', now() from core.requests limit 1`)).toMatch(/request_tokens_hash_chk/);
  });
});

describe('W-9 chase, end to end', () => {
  let reqId = '';
  const mail = mockEmail();

  it('opens ONE w9 request with a vendor-portal link (dedupe on rerun)', async () => {
    const ctx = await loadPolicyContext(svc, ORG_A);
    const vendor = { id: VENDOR, name: 'Prairie Drywall', email: 'ap@prairie.test' };
    const need = { kind: 'w9' as const, docTypes: ['W9'], renewal: false as const, dueDate: null };
    const a = await createVendorDocRequest({ db: svc, now: () => T0 }, ctx, { orgId: ORG_A, vendor, need, createdBy: 'user_owner', ownerMembershipId: members.get('owner'), source: 'manual' });
    const b = await createVendorDocRequest({ db: svc, now: () => T0 }, ctx, { orgId: ORG_A, vendor, need, createdBy: 'user_owner', source: 'manual' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.request.id).toBe(a.request.id);
    reqId = a.request.id;
    expect(iso(a.request.next_send_at)).toBe(T0.toISOString());
    expect(await vendorPortalPathFor(svc, ORG_A, a.request.meta)).toMatch(/^\/portal\/vendor\/[A-Za-z0-9_-]{40,}$/);
  });

  it('sends the first ask by email with a hashed magic link + unsubscribe', async () => {
    const s = await dispatchDueRequests(deps(T0, mail.channels), ORG_A);
    expect(s.sent).toBeGreaterThanOrEqual(1);
    const mine = mail.sent.filter((m) => m.to === 'ap@prairie.test');
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe('Please send your W-9');
    expect(mine[0].html).toContain('Artistry Homes');
    expect(mine[0].html).toMatch(/https:\/\/books\.example\.test\/r\/[A-Za-z0-9_-]{40,64}\/unsubscribe/);
    expect(mine[0].text).toContain('Upload your W-9: https://books.example.test/r/');
    const ev = await events(reqId);
    expect(ev.map((e) => e.event_type)).toEqual(['created', 'sent']);
    expect(ev[1]).toMatchObject({ channel: 'email', delivery_status: 'sent', step: 1 });
    expect(ev[1].provider_message_id).toMatch(/^re_test_\d+$/);
    const r = await row(reqId);
    expect(r.status).toBe('sent');
    expect(r.sends_count).toBe(1);
    expect(iso(r.next_send_at)).toBe(new Date(T0.getTime() + 3 * DAY).toISOString());
  });

  it('tokens are stored only as sha256; the clear token resolves, the hash does not', async () => {
    const token = tokenFrom(mail.sent.find((m) => m.to === 'ap@prairie.test')!.html);
    const stored = await db.query<{ token_hash: string }>(`select token_hash from core.request_tokens where request_id = $1`, [reqId]);
    expect(stored.rows.map((x) => x.token_hash)).toEqual([hashRequestToken(token)]);
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    const ok = await resolveRequestToken(svc, token, T0);
    expect(ok.ok && ok.request.id).toBe(reqId);
    expect((await resolveRequestToken(svc, hashRequestToken(token), T0)).ok).toBe(false);
  });

  it('a rerun at the same instant sends nothing; a racing stale copy cannot double-send', async () => {
    const before = mail.sent.length;
    await dispatchDueRequests(deps(T0, mail.channels), ORG_A);
    expect(mail.sent.length).toBe(before);
    // stale copy (as a parallel tick would have read it before the first send)
    const stale = { ...(await row(reqId)), sends_count: 0, cadence_slot: 1, status: 'open' as const, next_send_at: T0.toISOString() };
    const res = await dispatchOne(deps(T0, mail.channels), stale, null, { resolution: { satisfied: false } });
    expect(mail.sent.length).toBe(before);
    expect(['raced', 'sent']).toContain(res.outcome);
    expect((await events(reqId)).filter((e) => e.event_type === 'sent' && e.channel === 'email')).toHaveLength(1);
  });

  it('day 3 and day 7 reminders go out; the 3rd unanswered ask escalates to the owner exactly once', async () => {
    await dispatchDueRequests(deps(new Date(T0.getTime() + 3 * DAY), mail.channels), ORG_A);
    expect((await row(reqId)).sends_count).toBe(2);
    expect(mail.sent.filter((m) => m.to === 'ap@prairie.test').map((m) => m.subject)).toEqual(['Please send your W-9', 'Reminder: Please send your W-9']);
    const d7 = new Date(T0.getTime() + 7 * DAY);
    const s = await dispatchDueRequests(deps(d7, mail.channels), ORG_A);
    expect(s.escalated).toBeGreaterThanOrEqual(1);
    await dispatchDueRequests(deps(d7, mail.channels), ORG_A);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from core.notifications where membership_id = $1 and kind = 'request.escalated' and request_id = $2`, [members.get('owner'), reqId]);
    expect(n.rows[0].n).toBe(1);
    const r = await row(reqId);
    expect(r.sends_count).toBe(3);
    expect(r.escalated_at).not.toBeNull();
    expect(iso(r.next_send_at)).toBe(new Date(T0.getTime() + 14 * DAY).toISOString()); // then weekly
  });

  it('a portal upload closes the request before the next reminder (nothing sent)', async () => {
    await db.query(
      `insert into public.documents (org_id, storage_path, file_name, doc_type, entity_type, entity_id, notes, created_at)
       values ($1, 'x/w9.pdf', 'w9.pdf', 'W9', 'vendor', $2, 'Vendor portal submission · Form W-9 · pending review', $3)`,
      [ORG_A, VENDOR, new Date(T0.getTime() + 8 * DAY).toISOString()],
    );
    const toPrairie = () => mail.sent.filter((m) => m.to === 'ap@prairie.test').length;
    const before = toPrairie();
    const s = await dispatchDueRequests(deps(new Date(T0.getTime() + 14 * DAY), mail.channels), ORG_A);
    expect(s.fulfilled).toBeGreaterThanOrEqual(1);
    expect(toPrairie()).toBe(before);
    const r = await row(reqId);
    expect(r.status).toBe('fulfilled');
    expect(r.fulfilled_via).toBe('magic_link');
    const token = tokenFrom(mail.sent.find((m) => m.to === 'ap@prairie.test')!.html);
    const closed = await resolveRequestToken(svc, token, new Date(T0.getTime() + 14 * DAY));
    expect(closed.ok).toBe(false);
    const fulfilledNote = await db.query<{ n: number }>(`select count(*)::int as n from core.notifications where request_id = $1 and kind = 'request.fulfilled'`, [reqId]);
    expect(fulfilledNote.rows[0].n).toBe(1);
  });
});

describe('cadence edge cases', () => {
  it('quiet hours: a send due at 22:00 Chicago is held until 07:00 Chicago (DST-correct)', async () => {
    const mail = mockEmail();
    const t = new Date('2026-11-03T04:00:00Z'); // 22:00 CST Nov 2
    const { request } = await createRequest(deps(t, mail.channels), {
      orgId: ORG_A, kind: 'document', title: 'October bank statement', recipient: { type: 'email', email: 'late@a.test' }, createdBy: 'user_owner',
    });
    expect(iso(request.next_send_at)).toBe('2026-11-03T13:00:00.000Z'); // 07:00 CST, deferred at creation
    // force due now (as "Send now" would) → still deferred, nothing sent
    const res = await sendNow(deps(t, mail.channels), ORG_A, request.id, 'user_owner');
    expect(res.outcome).toBe('deferred');
    expect(iso(res.nextSendAt)).toBe('2026-11-03T13:00:00.000Z');
    expect(mail.sent).toHaveLength(0);
    await dispatchDueRequests(deps(new Date('2026-11-03T13:00:00Z'), mail.channels), ORG_A);
    expect(mail.sent.map((m) => m.to)).toEqual(['late@a.test']);
  });

  it('email not configured → skipped (never "sent"), owner told once; a provider failure frees the step for retry', async () => {
    const off = mockEmail({ state: 'off' });
    const t = new Date('2026-11-04T16:00:00Z');
    const { request } = await createRequest(deps(t, off.channels), {
      orgId: ORG_A, kind: 'document', title: 'Signed engagement letter', recipient: { type: 'email', email: 'nocfg@a.test' }, createdBy: 'user_owner', ownerMembershipId: members.get('owner'),
    });
    const r1 = await dispatchOne(deps(t, off.channels), request, null);
    expect(r1.outcome).toBe('undeliverable');
    const ev = await events(request.id);
    expect(ev.some((e) => e.event_type === 'sent' && e.delivery_status === 'sent')).toBe(false);
    expect(ev.some((e) => e.event_type === 'skipped' && e.channel === 'email')).toBe(true);

    const fail = mockEmail({ state: 'fail' });
    const { request: q } = await createRequest(deps(t, fail.channels), {
      orgId: ORG_A, kind: 'document', title: 'W-2s', recipient: { type: 'email', email: 'fail@a.test' }, createdBy: 'user_owner',
    });
    const r2 = await dispatchOne(deps(t, fail.channels), q, null);
    expect(r2.outcome).toBe('failed');
    expect(iso(r2.nextSendAt)).toBe(new Date(t.getTime() + 15 * 60_000).toISOString());
    fail.mode.state = 'ok';
    const later = new Date(t.getTime() + 15 * 60_000);
    const r3 = await dispatchOne(deps(later, fail.channels), await row(q.id), null);
    expect(r3.outcome).toBe('sent');
    expect(fail.sent).toHaveLength(1);
    const qe = await events(q.id);
    expect(qe.filter((e) => e.event_type === 'failed')).toHaveLength(1);
    expect(qe.filter((e) => e.event_type === 'sent' && e.delivery_status === 'sent')).toHaveLength(1);
  });

  it('an unsubscribed address is never emailed', async () => {
    const mail = mockEmail();
    await db.query(`insert into core.request_suppressions (org_id, channel, address, reason) values ($1, 'email', 'gone@a.test', 'unsubscribe')`, [ORG_A]);
    const t = new Date('2026-11-04T16:00:00Z');
    const { request } = await createRequest(deps(t, mail.channels), {
      orgId: ORG_A, kind: 'document', title: 'Payroll register', recipient: { type: 'email', email: 'Gone@A.test' }, createdBy: 'user_owner',
    });
    await dispatchOne(deps(t, mail.channels), request, null);
    expect(mail.sent).toHaveLength(0);
  });

  it('SMS reports "not configured" and is recorded as skipped', async () => {
    const mail = mockEmail();
    const t = new Date('2026-11-04T16:00:00Z');
    const { request } = await createRequest(deps(t, mail.channels), {
      orgId: ORG_A, kind: 'client_question', title: 'Text me', channels: ['sms', 'email'], recipient: { type: 'email', email: 'sms@a.test', phone: '+15155550100' }, createdBy: 'user_owner',
    });
    await dispatchOne(deps(t, mail.channels), request, null);
    const ev = await events(request.id);
    expect(ev.find((e) => e.channel === 'sms')?.event_type).toBe('skipped');
    expect(ev.find((e) => e.channel === 'email' && e.event_type === 'sent')?.delivery_status).toBe('sent');
  });

  it('a member recipient gets an in-app notification per ask', async () => {
    const mail = mockEmail();
    const t = new Date('2026-11-04T16:00:00Z');
    const { request } = await createRequest(deps(t, mail.channels), {
      orgId: ORG_A, kind: 'approval_nudge', title: 'Approve the Oct 30 pay run', channels: ['in_app'], recipient: { type: 'member', membershipId: members.get('bk') }, createdBy: 'user_owner',
    });
    await dispatchOne(deps(t, mail.channels), request, null);
    await dispatchOne(deps(t, mail.channels), request, null); // rerun with the same copy
    const mine = await as('user_bk', ORG_A, async () => (await db.query<{ title: string }>(`select title from core.notifications where request_id = '${request.id}'`)).rows);
    expect(mine.map((m) => m.title)).toEqual(['Approve the Oct 30 pay run']);
  });

  it('cancel stops the chase and kills its links', async () => {
    const mail = mockEmail();
    const t = new Date('2026-11-04T16:00:00Z');
    const { request } = await createRequest(deps(t, mail.channels), {
      orgId: ORG_A, kind: 'document', title: 'Cancel me', recipient: { type: 'email', email: 'c@a.test' }, createdBy: 'user_owner',
    });
    await dispatchOne(deps(t, mail.channels), request, null);
    const token = tokenFrom(mail.sent[0].html);
    await cancelRequest(deps(t, mail.channels), ORG_A, request.id, 'user_owner', 'Client sent it by hand');
    expect((await row(request.id)).status).toBe('cancelled');
    expect((await resolveRequestToken(svc, token, t)).ok).toBe(false);
    await expect(cancelRequest(deps(t, mail.channels), ORG_A, request.id, 'user_owner', 'again')).rejects.toThrow(/already closed/);
  });
});

describe('bounce webhook', () => {
  it('a hard bounce marks the request, suppresses the address and notifies the owner; a retry is a no-op', async () => {
    const mail = mockEmail();
    const t = new Date('2026-11-05T16:00:00Z');
    const { request } = await createRequest(deps(t, mail.channels), {
      orgId: ORG_A, kind: 'document', title: 'Bounce me', recipient: { type: 'email', email: 'bounce@a.test' }, createdBy: 'user_owner', ownerMembershipId: members.get('owner'),
    });
    await dispatchOne(deps(t, mail.channels), request, null);
    const msgId = (await events(request.id)).find((e) => e.event_type === 'sent')!.provider_message_id!;
    const ev = { type: 'email.bounced', data: { email_id: msgId, bounce: { type: 'Permanent', message: 'mailbox does not exist' } } };
    expect(await applyResendEvent(svc, 'msg_1', ev, t)).toBe('applied');
    expect(await applyResendEvent(svc, 'msg_1', ev, t)).toBe('duplicate');
    expect(await applyResendEvent(svc, 'msg_2', { type: 'email.bounced', data: { email_id: 'unknown' } }, t)).toBe('unknown_message');
    const r = await row(request.id);
    expect(r.bounced_at).not.toBeNull();
    const sup = await db.query<{ n: number }>(`select count(*)::int as n from core.request_suppressions where org_id = $1 and address = 'bounce@a.test' and reason = 'bounce'`, [ORG_A]);
    expect(sup.rows[0].n).toBe(1);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from core.notifications where request_id = $1 and kind = 'request.bounced'`, [request.id]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('vendor sync + the scheduler job', () => {
  it('auto-create off → no requests; on → one per vendor, rerun dedupes; tenant B untouched', async () => {
    const t = new Date('2026-11-06T16:00:00Z');
    const off = await syncVendorComplianceRequests({ db: svc, now: () => t }, ORG_A);
    expect(off.enabled).toBe(false);
    expect(off.created).toBe(0);
    await db.query(`insert into core.request_policies (org_id, policy_key, auto_create) values ($1, 'w9', true)`, [ORG_A]);
    const on = await syncVendorComplianceRequests({ db: svc, now: () => t }, ORG_A);
    // Cedar Electric only: Prairie's W-9 is still MISSING on file, but its request was answered
    // (portal upload awaiting review) — the 30-day cool-down keeps the sync from re-asking.
    expect(on.created).toBe(1);
    const again = await syncVendorComplianceRequests({ db: svc, now: () => t }, ORG_A);
    expect(again.created).toBe(0);
    const b = await db.query<{ n: number }>(`select count(*)::int as n from core.requests where org_id = $1 and kind = 'w9'`, [ORG_B]);
    expect(b.rows[0].n).toBe(0);
  });

  it('the job runs sync + dispatch on the service role, pinned to its tenant', async () => {
    const mail = mockEmail();
    const t = new Date('2026-11-06T16:00:00Z');
    const ctx: JobContext = { orgId: ORG_A, now: t, slotAt: t, signal: new AbortController().signal, admin: svc, scopedClient: () => null };
    const res = await runRequestsDispatchJob(ctx, { channels: mail.channels, appUrl: 'https://books.example.test' });
    expect(['ok', 'partial']).toContain(res.status);
    expect(res.error).toBeUndefined();
    expect(mail.sent.every((m) => !m.to.endsWith('@other.test'))).toBe(true);
    const skipped = await runRequestsDispatchJob({ ...ctx, orgId: null });
    expect(skipped.status).toBe('skipped');
  });
});

describe('the public magic link + unsubscribe', () => {
  it('a W-9 link forwards to the vendor portal and records ONE click; a member sees the timeline', async () => {
    const mail = mockEmail();
    const t = new Date('2026-11-09T16:00:00Z');
    const ctx = await loadPolicyContext(svc, ORG_A);
    const { request } = await createVendorDocRequest({ db: svc, now: () => t }, ctx, {
      orgId: ORG_A,
      vendor: { id: VENDOR_2, name: 'Cedar Electric', email: 'office@cedar.test' },
      need: { kind: 'coi', docTypes: ['GL_COI'], renewal: false, dueDate: null },
      createdBy: 'user_owner',
      source: 'manual',
    });
    await dispatchOne(deps(t, mail.channels), request, null, { resolution: { satisfied: false } });
    const token = tokenFrom(mail.sent[0].html);
    const a = await openRequestLink(svc, token, t);
    const b = await openRequestLink(svc, token, t);
    expect(a.state).toBe('redirect');
    expect(a.state === 'redirect' && a.to).toMatch(/^\/portal\/vendor\//);
    expect(b).toEqual(a);
    const clicks = (await events(request.id)).filter((e) => e.event_type === 'clicked');
    expect(clicks).toHaveLength(1);
    const seen = await as('user_bk', ORG_A, async () => (await db.query<{ n: number }>(`select count(*)::int as n from core.request_events where request_id = '${request.id}'`)).rows[0].n);
    expect(seen).toBeGreaterThanOrEqual(3);
    const outsider = await as('user_b_admin', ORG_B, async () => (await db.query<{ n: number }>(`select count(*)::int as n from core.request_events where request_id = '${request.id}'`)).rows[0].n);
    expect(outsider).toBe(0);
    expect((await openRequestLink(svc, 'x'.repeat(43), t)).state).toBe('invalid');
  });

  it('unsubscribe suppresses the address for the tenant, tells the owner, and the next ask is not emailed', async () => {
    const mail = mockEmail();
    const t = new Date('2026-11-09T16:00:00Z');
    const { request } = await createRequest(deps(t, mail.channels), {
      orgId: ORG_A, kind: 'client_question', title: 'Unsubscribe me', recipient: { type: 'email', email: 'unsub@a.test' }, createdBy: 'user_owner', ownerMembershipId: members.get('owner'),
    });
    await dispatchOne(deps(t, mail.channels), request, null);
    const token = tokenFrom(mail.sent[0].html);
    expect(await unsubscribeByToken(svc, token, t)).toBe('done');
    const r = await row(request.id);
    expect(r.unsubscribed_at).not.toBeNull();
    const later = new Date(t.getTime() + 2 * DAY);
    await dispatchOne(deps(later, mail.channels), await row(request.id), null);
    expect(mail.sent).toHaveLength(1);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from core.notifications where request_id = $1 and kind = 'request.unsubscribed'`, [request.id]);
    expect(n.rows[0].n).toBe(1);
    // a different request to the same address in this tenant is suppressed too
    const { request: other } = await createRequest(deps(later, mail.channels), {
      orgId: ORG_A, kind: 'document', title: 'Another ask', recipient: { type: 'email', email: 'UNSUB@a.test' }, createdBy: 'user_owner',
    });
    await dispatchOne(deps(later, mail.channels), other, null);
    expect(mail.sent).toHaveLength(1);
  });

  it('the job definition is valid for the registry (the lead registers it)', () => {
    expect(REQUESTS_DISPATCH_JOB.key).toMatch(/^[a-z0-9_]+(\.[a-z0-9_:-]+)+$/);
    expect(isValidCron(REQUESTS_DISPATCH_JOB.cron)).toBe(true);
    expect(REQUESTS_DISPATCH_JOB.timeoutMs).toBeLessThanOrEqual(240_000);
    expect(REQUESTS_DISPATCH_JOB.postsToGl).toBe(false);
    expect(REQUESTS_DISPATCH_JOB.implemented).toBe(true);
  });
});

describe('closing a W-9 / COI request revokes the vendor upload link it minted', () => {
  async function token(label: string, createdBy: string): Promise<string> {
    return (await db.query<{ id: string }>(
      `insert into public.vendor_portal_tokens (org_id, vendor_id, token, label, status, requested_docs, created_by)
       values ($1, $2, $3, $4, 'ACTIVE', array['W9'], $5) returning id`,
      [ORG_A, VENDOR, `tok_${Math.random().toString(36).slice(2)}${Date.now()}`, label, createdBy],
    )).rows[0].id;
  }
  async function status(id: string): Promise<string> {
    return (await db.query<{ status: string }>(`select status from public.vendor_portal_tokens where id = $1`, [id])).rows[0].status;
  }
  async function w9(tokenId: string, title: string) {
    return (await createRequest(deps(new Date('2026-11-05T15:00:00Z'), mockEmail().channels), {
      orgId: ORG_A, kind: 'w9', title, recipient: { type: 'email', email: 'ap@prairie.test' }, createdBy: 'user_owner',
      meta: { vendor_portal_token_id: tokenId },
    })).request;
  }
  const t = new Date('2026-11-05T15:00:00Z');

  it('cancel revokes a bridge-minted link no other live request uses', async () => {
    const id = await token('Document request link', 'system:requests');
    const r = await w9(id, 'Please send your W-9 (cancel)');
    await cancelRequest(deps(t, mockEmail().channels), ORG_A, r.id, 'user_owner', 'Vendor emailed it');
    expect(await status(id)).toBe('REVOKED');
  });

  it('keeps a link another live request still points at, and never touches a hand-made link', async () => {
    const shared = await token('Document request link', 'system:requests');
    const a = await w9(shared, 'Shared A');
    const b = await w9(shared, 'Shared B');
    await fulfilRequest(deps(t, mockEmail().channels), ORG_A, a.id, 'user_owner');
    expect(await status(shared)).toBe('ACTIVE'); // b still needs it
    await fulfilRequest(deps(t, mockEmail().channels), ORG_A, b.id, 'user_owner');
    expect(await status(shared)).toBe('REVOKED');

    const manual = await token('Sent to Prairie by Mike', 'user_owner');
    const c = await w9(manual, 'Manual link');
    await cancelRequest(deps(t, mockEmail().channels), ORG_A, c.id, 'user_owner', 'Not needed');
    expect(await status(manual)).toBe('ACTIVE');
  });
});
