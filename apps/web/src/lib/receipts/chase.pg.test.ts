/**
 * Receipt capture & chase against the REAL schema (PGlite replay of every migration incl.
 * 178 + 181) — FPB-workforce-app §15.3 acceptance:
 *   1 policy threshold + one request per charge (rerun-safe)   2 payments / refunds ignored
 *   3 a match fulfils the request + copies the chase count; the engine resolver closes
 *     a request whose charge got a receipt elsewhere          4 escalation after the last ask
 *   5 tenant / client switch (audited, no burst on re-enable)  6 matching (auto)
 *   7 magic-link scope                                        8 RLS / grants / client scope
 *   9 opt-out separation of duties                            + inbound email handler
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from '@/test/pg';
import { pgSupabase } from '@/test/pg-supabase';
import { dispatchDueRequests, type EngineDeps } from '@/lib/requests/dispatch';
import { pushChannel, smsChannel, type Channels } from '@/lib/notify/channels';
import { mintRequestToken } from '@/lib/requests/tokens';
import { openRequestLink } from '@/lib/requests/public-link';
import type { InboundEmail, InboundHandlerContext } from '@/lib/email/inbound-types';
import { UNVERIFIED_AUTH } from '@/lib/email/inbound-sender-auth';
import { syncReceiptChase } from './chase';
import { captureReceipt, CaptureError, type CaptureDeps, type StoreFile } from './capture';
import { createCardholder, decideOptOut, endCardholder, requestOptOut, CardholderError } from './cardholders';
import { setReceiptChase, SwitchError } from './switch';
import { mintWorkforceLink, resolveWorkforceLink, hashWorkforceToken } from './links';
import { loadHolderView } from './holder-view';
import { handleInboundReceiptEmail } from './inbound';
import { listOutstanding, markNotRequired, reassignCharge } from './bookkeeper';
import type { CardAssignmentRow } from './types';

let db: PGlite;
let sb: SupabaseClient;

const ORG = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const CARD = crypto.randomUUID();
const CARD_B = crypto.randomUUID();
const E1 = crypto.randomUUID();
const E2 = crypto.randomUUID();
let M_MGR = '';
let M_BK = '';
let andre: CardAssignmentRow;
let kelly: CardAssignmentRow;

const T0 = new Date('2026-10-22T15:00:00Z'); // 10:00 in Chicago — outside quiet hours
let clock = T0;
const now = () => clock;
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const sent: Array<{ to: string; subject: string }> = [];
const channels: Channels = {
  email: { id: 'email', send: async (m) => { sent.push({ to: m.to, subject: m.subject }); return { status: 'sent', provider: 'test', providerMessageId: `msg-${sent.length}` }; } },
  sms: smsChannel(),
  push: pushChannel(),
};
const engine = (): EngineDeps => ({ db: sb, channels, now, appUrl: 'https://app.test' });

const storeFile: StoreFile = async ({ orgId, file }) => {
  const r = await db.query<{ id: string }>(
    `insert into public.documents (org_id, storage_path, file_name, mime_type, size_bytes, doc_type, entity_type)
     values ($1, $2, $3, $4, $5, 'RECEIPT', 'receipt') returning id`,
    [orgId, `${orgId}/receipt/${crypto.randomUUID()}-${file.fileName}`, file.fileName, file.mimeType, file.sizeBytes],
  );
  return { documentId: r.rows[0].id };
};
const capDeps = (): CaptureDeps => ({ db: sb, now, anthropicApiKey: null, storeFile });
const pdf = (seed: string) => {
  const b = Buffer.from(`%PDF-1.4 receipt ${seed}`);
  return { base64: b.toString('base64'), fileName: `${seed}.pdf`, mimeType: 'application/pdf', sizeBytes: b.length };
};

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0];
}

async function txn(id: string, amount: number, date: string, desc: string, bank = CARD, loc = A) {
  await db.query(
    `insert into public.bank_transactions (id, org_id, bank_account_id, location_id, transaction_date, description, amount_cents, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'PENDING')`,
    [id, ORG, bank, loc, date, desc, amount],
  );
  return id;
}

async function state(txnId: string) {
  return one<{ status: string; request_id: string | null; chase_count: number; receipt_id: string | null; card_assignment_id: string | null }>(
    `select status, request_id, chase_count, receipt_id, card_assignment_id from public.receipt_charge_states where bank_transaction_id = $1`,
    [txnId],
  );
}
async function request(id: string) {
  return one<{ status: string; sends_count: number; recipient_email: string; channels: string[]; cadence_offsets_minutes: number[]; escalate_after: number; escalate_to_membership_id: string | null; cancel_reason: string | null; escalated_at: string | null }>(
    `select status, sends_count, recipient_email, channels, cadence_offsets_minutes, escalate_after, escalate_to_membership_id, cancel_reason, escalated_at from core.requests where id = $1`,
    [id],
  );
}

const T1 = crypto.randomUUID(); // Andre, 120.00, needs a receipt
const T2 = crypto.randomUUID(); // 50.00, under the limit
const T3 = crypto.randomUUID(); // card payment
const T4 = crypto.randomUUID(); // Kelly (x7788), 90.00
const T5 = crypto.randomUUID(); // 90 days old — outside the window
const T6 = crypto.randomUUID(); // company B, no cardholder yet
const T7 = crypto.randomUUID(); // refund

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  sb = pgSupabase(db);
  await db.query(`insert into core.organizations (id, name, slug, timezone) values ($1, 'Heartland Group', $2, 'America/Chicago'), ($3, 'Other', $4, 'America/Chicago')`, [ORG, `hg-${ORG.slice(0, 6)}`, OTHER, `ot-${OTHER.slice(0, 6)}`]);
  await db.query(`insert into core.locations (id, org_id, name, short_code) values ($1, $2, 'Heartland Heating', 'HH'), ($3, $2, 'Crystal Kitchen', 'CK')`, [A, ORG, B]);
  const u1 = await one<{ id: string }>(`insert into core.users (clerk_user_id, email, first_name, last_name) values ('user_mgr', 'kelly.mgr@example.com', 'Kelly', 'Brandt') returning id`);
  const u2 = await one<{ id: string }>(`insert into core.users (clerk_user_id, email, first_name, last_name) values ('user_bk', 'sam@example.com', 'Sam', 'Kovac') returning id`);
  M_MGR = (await one<{ id: string }>(`insert into core.memberships (user_id, org_id, role, status) values ($1, $2, 'accounting_manager', 'active') returning id`, [u1.id, ORG])).id;
  M_BK = (await one<{ id: string }>(`insert into core.memberships (user_id, org_id, role, status) values ($1, $2, 'bookkeeper', 'active') returning id`, [u2.id, ORG])).id;
  await db.query(`insert into core.employees (id, org_id, first_name, last_name, email, is_active) values ($1, $3, 'Andre', 'Willis', 'andre@example.com', true), ($2, $3, 'Kelly', 'Ortiz', 'kelly@example.com', true)`, [E1, E2, ORG]);

  const t = await one<{ id: string }>(
    `insert into public.account_types (org_id, name, code, display_order, normal_balance) values ($1, 'LIABILITY', 'LIABILITY', 1, 'CREDIT') returning id`, [ORG]);
  const st = await one<{ id: string }>(
    `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order) values ($1, $2, 'CURRENT_LIABILITY', 'CURRENT_LIABILITY', 1) returning id`, [ORG, t.id]);
  const g = await one<{ id: string }>(`insert into public.account_groups (org_id, account_sub_type_id, name, display_order) values ($1, $2, 'Cards', 1) returning id`, [ORG, st.id]);
  const gl = await one<{ id: string }>(
    `insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
     values ($1, $2, '2100', 'Credit Card Payable', 'LIABILITY', 'CURRENT_LIABILITY', true, 'APPROVED') returning id`, [ORG, g.id]);
  await db.query(
    `insert into public.bank_accounts (id, org_id, location_id, account_id, institution_name, account_name, account_mask, account_type)
     values ($1, $2, $3, $4, 'Ramp', 'Ramp card', '5512', 'CREDIT_CARD'), ($5, $2, $6, $4, 'Amex', 'Amex', '3003', 'CREDIT_CARD')`,
    [CARD, ORG, A, gl.id, CARD_B, B],
  );

  andre = await createCardholder(sb, ORG, { locationId: A, bankAccountId: CARD, holderType: 'employee', employeeId: E1, holderName: 'Andre Willis', holderEmail: 'andre@example.com', holderTimezone: 'America/Chicago', managerMembershipId: M_MGR }, 'user_bk');
  kelly = await createCardholder(sb, ORG, { locationId: A, bankAccountId: CARD, cardLast4: '7788', holderType: 'employee', employeeId: E2, holderName: 'Kelly Ortiz', holderEmail: 'kelly@example.com' }, 'user_bk');

  await txn(T1, -12000, '2026-10-21', 'SHELL OIL 57442 DES MOINES IA');
  await txn(T2, -5000, '2026-10-21', 'STARBUCKS 1123');
  await txn(T3, -207850, '2026-10-21', 'AUTOMATIC PAYMENT - THANK');
  await txn(T4, -9000, '2026-10-20', 'UBER *TRIP x7788');
  await txn(T5, -15000, '2026-07-20', 'OLD CHARGE');
  await txn(T6, -20000, '2026-10-21', 'HOME DEPOT 4410', CARD_B, B);
  await txn(T7, 4500, '2026-10-21', 'REFUND SHELL OIL');
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('charge → receipt request', () => {
  it('opens one request per charge over the limit, to the right cardholder (rerun opens none)', async () => {
    const s = await syncReceiptChase({ db: sb, now }, ORG);
    expect(s.created).toBe(2);
    expect((await state(T1)).status).toBe('requested');
    expect((await state(T2)).status).toBe('below_threshold');
    expect((await state(T4)).card_assignment_id).toBe(kelly.id);
    expect((await state(T6)).status).toBe('no_cardholder');
    for (const id of [T3, T5, T7]) expect(await state(id)).toBeUndefined();

    const r1 = await request((await state(T1)).request_id as string);
    expect(r1).toMatchObject({ status: 'open', recipient_email: 'andre@example.com', escalate_after: 4, escalate_to_membership_id: M_MGR });
    expect(r1.channels).toContain('email');
    expect(r1.cadence_offsets_minutes).toEqual([30, 2880, 7200, 14400]); // Settings first reminder (30 min), then day 2 / 5 / 10

    expect((await syncReceiptChase({ db: sb, now }, ORG)).created).toBe(0);
    const n = await one<{ n: number }>(`select count(*)::int n from core.requests where org_id = $1 and kind = 'receipt'`, [ORG]);
    expect(n.n).toBe(2);
  });

  it('sends on cadence and escalates to the manager after the last reminder', async () => {
    clock = at(31);
    expect((await dispatchDueRequests(engine(), ORG)).sent).toBe(2);
    for (const m of [2880, 7200, 14400]) {
      clock = at(m + 1);
      await dispatchDueRequests(engine(), ORG);
    }
    const r1 = await request((await state(T1)).request_id as string);
    expect(r1.sends_count).toBe(4);
    expect(r1.escalated_at).not.toBeNull();
    const esc = await one<{ n: number }>(`select count(*)::int n from core.notifications where membership_id = $1 and kind = 'request.escalated'`, [M_MGR]);
    expect(esc.n).toBeGreaterThanOrEqual(1);
    expect(sent.filter((x) => x.to === 'andre@example.com')).toHaveLength(4);
    await syncReceiptChase({ db: sb, now }, ORG);
    expect((await state(T1)).chase_count).toBe(4);
  });
});

describe('capture → match → the chase stops', () => {
  it('refuses a charge that is not the cardholder’s own (magic-link / Workforce scope)', async () => {
    await expect(
      captureReceipt(capDeps(), { orgId: ORG, locationId: A, source: 'MOBILE_CAPTURE', file: pdf('wrong'), holder: andre, chargeId: T4, restrictToHolder: true, submittedBy: `cardholder:${andre.id}` }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a receipt for the picked charge matches it, fulfils the request and keeps the chase count', async () => {
    const r = await captureReceipt(capDeps(), { orgId: ORG, locationId: A, source: 'MOBILE_CAPTURE', file: pdf('kelly-uber'), holder: kelly, chargeId: T4, restrictToHolder: true, memo: 'Airport', submittedBy: `cardholder:${kelly.id}` });
    expect(r.match.kind).toBe('attached');
    const s4 = await state(T4);
    expect(s4).toMatchObject({ status: 'matched', receipt_id: r.receiptId });
    expect((await request(s4.request_id as string)).status).toBe('fulfilled');
    const rc = await one<{ chase_reminder_count: number; match_method: string; bank_transaction_id: string }>(`select chase_reminder_count, match_method, bank_transaction_id from public.receipts where id = $1`, [r.receiptId]);
    expect(rc).toMatchObject({ chase_reminder_count: 4, match_method: 'request', bank_transaction_id: T4 });
    // a duplicate upload of the same file is recognised, not re-captured
    const dup = await captureReceipt(capDeps(), { orgId: ORG, locationId: A, source: 'MANUAL_UPLOAD', file: pdf('kelly-uber'), submittedBy: 'user_bk' });
    expect(dup).toMatchObject({ duplicate: true, receiptId: r.receiptId });
  });

  it('an unattached upload auto-matches by amount / date / merchant', async () => {
    const r = await captureReceipt(capDeps(), { orgId: ORG, locationId: A, source: 'MOBILE_CAPTURE', file: pdf('andre-shell'), holder: andre, typed: { merchant: 'Shell', amountCents: 12000, date: '2026-10-21' }, submittedBy: `cardholder:${andre.id}` });
    expect(r.match).toMatchObject({ kind: 'matched', transactionId: T1 });
    expect((await state(T1)).status).toBe('matched');
    expect((await request((await state(T1)).request_id as string)).status).toBe('fulfilled');
    expect((await one<{ matched_receipt_id: string }>(`select matched_receipt_id from public.bank_transactions where id = $1`, [T1])).matched_receipt_id).toBe(r.receiptId);
  });

  it('the engine resolver closes a request whose charge got its receipt another way', async () => {
    const T8 = await txn(crypto.randomUUID(), -30000, '2026-10-22', 'LOWES 0091');
    await syncReceiptChase({ db: sb, now }, ORG);
    const reqId = (await state(T8)).request_id as string;
    await db.query(`insert into public.receipts (org_id, location_id, source, bank_transaction_id, match_status, status) values ($1, $2, 'MANUAL_UPLOAD', $3, 'matched', 'PENDING')`, [ORG, A, T8]);
    await dispatchDueRequests(engine(), ORG);
    expect((await request(reqId)).status).toBe('fulfilled');
  });
});

let T9 = '';
describe('the tenant / client switch', () => {
  it('tenant off cancels live asks and opens none; a client cannot turn on; audited', async () => {
    T9 = await txn(crypto.randomUUID(), -25000, '2026-10-22', 'NAPA AUTO 22');
    await syncReceiptChase({ db: sb, now }, ORG);
    const first = (await state(T9)).request_id as string;
    expect((await request(first)).status).toBe('open');

    const off = await setReceiptChase(sb, ORG, { kind: 'tenant' }, false, 'Year-end freeze', 'user_mgr', now());
    expect(off.paused).toBeGreaterThanOrEqual(1);
    expect((await request(first)).cancel_reason).toMatch(/^Receipt chase paused:/);
    expect((await state(T9)).status).toBe('chase_off');
    const T10 = await txn(crypto.randomUUID(), -26000, '2026-10-22', 'NAPA AUTO 23');
    expect((await syncReceiptChase({ db: sb, now }, ORG)).created).toBe(0);
    expect((await state(T10)).status).toBe('chase_off');
    await expect(setReceiptChase(sb, ORG, { kind: 'client', locationId: A }, true, 'try', 'user_mgr', now())).rejects.toBeInstanceOf(SwitchError);
    const audit = await one<{ n: number }>(`select count(*)::int n from public.audit_log where org_id = $1 and table_name = 'organizations' and field_name like 'receipt_chase%'`, [ORG]);
    expect(audit.n).toBe(2);
  });

  it('tenant on resumes in-window charges with ONE fresh request each; old charges stay quiet', async () => {
    await setReceiptChase(sb, ORG, { kind: 'tenant' }, true, 'Freeze over', 'user_mgr', now());
    const s = await syncReceiptChase({ db: sb, now }, ORG);
    expect(s.created).toBe(2); // T9 + T10, nothing older than the window
    const again = (await state(T9)).request_id as string;
    expect((await request(again)).status).toBe('open');
    expect((await syncReceiptChase({ db: sb, now }, ORG)).created).toBe(0);
  });

  it('client off stops only that client', async () => {
    const holderB = await createCardholder(sb, ORG, { locationId: B, bankAccountId: CARD_B, holderType: 'external', holderName: 'Pat Lee', holderEmail: 'pat@example.com' }, 'user_bk');
    await syncReceiptChase({ db: sb, now }, ORG);
    expect((await state(T6))).toMatchObject({ status: 'requested', card_assignment_id: holderB.id });
    await setReceiptChase(sb, ORG, { kind: 'client', locationId: A }, false, 'Client collects its own', 'user_mgr', now());
    expect((await state(T9)).status).toBe('chase_off');
    expect((await request((await state(T6)).request_id as string)).status).toBe('open');
    const audit = await one<{ n: number }>(`select count(*)::int n from public.audit_log where org_id = $1 and table_name = 'company_policies'`, [ORG]);
    expect(audit.n).toBe(2);
    await setReceiptChase(sb, ORG, { kind: 'client', locationId: A, follow: true }, true, 'back on', 'user_mgr', now());
    await syncReceiptChase({ db: sb, now }, ORG);
    expect((await state(T9)).status).toBe('requested');
  });
});

describe('bookkeeper actions, opt-out, links', () => {
  it('not required closes the ask; reassign moves it to another cardholder', async () => {
    const T11 = await txn(crypto.randomUUID(), -40000, '2026-10-22', 'GRAINGER 7');
    await syncReceiptChase({ db: sb, now }, ORG);
    const req = (await state(T11)).request_id as string;
    await reassignCharge(sb, ORG, T11, kelly.id, 'user_bk', now());
    const moved = await state(T11);
    expect(moved.card_assignment_id).toBe(kelly.id);
    expect(moved.request_id).not.toBe(req);
    expect((await request(moved.request_id as string)).recipient_email).toBe('kelly@example.com');
    await syncReceiptChase({ db: sb, now }, ORG);
    expect((await state(T11)).card_assignment_id).toBe(kelly.id); // the override sticks
    await markNotRequired(sb, ORG, T11, 'user_bk', 'Fuel card statement covers it', now());
    expect((await state(T11)).status).toBe('not_required');
    expect((await request(moved.request_id as string)).status).toBe('cancelled');
    const { groups, strip } = await listOutstanding(sb, ORG, { now: now() });
    expect(groups.flatMap((g) => g.charges).some((c) => c.transactionId === T11)).toBe(false);
    expect(strip.outstanding).toBeGreaterThan(0);
  });

  it('opt-out needs a different person; approval pauses the cardholder’s asks', async () => {
    await requestOptOut(sb, ORG, andre.id, 'user_bk', 'Owner pays personally', now());
    await expect(decideOptOut(sb, ORG, andre.id, 'user_bk', true, now())).rejects.toBeInstanceOf(CardholderError);
    const { paused } = await decideOptOut(sb, ORG, andre.id, 'user_mgr', true, now());
    expect(paused).toBeGreaterThanOrEqual(1);
    expect((await state(T9)).status).toBe('opted_out');
  });

  it('a magic link resolves by hash only, lists only its cardholder, dies with the assignment', async () => {
    const token = await mintWorkforceLink(sb, kelly, now());
    const ok = await resolveWorkforceLink(sb, token, now());
    expect(ok.ok && ok.assignment.id).toBe(kelly.id);
    expect((await resolveWorkforceLink(sb, hashWorkforceToken(token), now())).ok).toBe(false);
    const view = await loadHolderView(sb, ORG, [kelly]);
    const ids = view.cards.flatMap((c) => c.needed.map((n) => n.transactionId));
    expect(ids).not.toContain(T9); // Andre's
    expect(view.cards[0].recent.length).toBeGreaterThanOrEqual(1);
    await endCardholder(sb, ORG, kelly.id, 'user_bk', now());
    expect((await resolveWorkforceLink(sb, token, now())).ok).toBe(false);
  });

  it('the reminder link forwards a receipt request to Merit Workforce', async () => {
    const reqId = (await state(T6)).request_id as string;
    const r = await one<{ id: string; org_id: string; location_id: string }>(`select id, org_id, location_id from core.requests where id = $1`, [reqId]);
    const tok = await mintRequestToken(sb, r, now());
    const res = await openRequestLink(sb, tok, now());
    expect(res.state).toBe('redirect');
    if (res.state === 'redirect') expect(res.to).toMatch(/^\/w\/s\/[A-Za-z0-9_-]{40,}$/);
  });

  it('re-opening the same reminder link REUSES its unexpired Merit Workforce link (no new row per click)', async () => {
    const reqId = (await state(T6)).request_id as string;
    const r = await one<{ id: string; org_id: string; location_id: string }>(`select id, org_id, location_id from core.requests where id = $1`, [reqId]);
    const tok = await mintRequestToken(sb, r, now());
    const before = (await one<{ n: number }>(`select count(*)::int n from public.workforce_links where source_request_id = $1`, [reqId])).n;
    const a = await openRequestLink(sb, tok, now());
    const b = await openRequestLink(sb, tok, now());
    expect(a.state === 'redirect' && b.state === 'redirect').toBe(true);
    if (a.state !== 'redirect' || b.state !== 'redirect') return;
    expect(b.to).toBe(a.to);
    expect((await one<{ n: number }>(`select count(*)::int n from public.workforce_links where source_request_id = $1`, [reqId])).n).toBe(before + 1);
    const link = await resolveWorkforceLink(sb, a.to.replace('/w/s/', ''), now());
    expect(link.ok).toBe(true);
    // an expired derived link is not reused: a fresh one is minted
    await db.query(`update public.workforce_links set expires_at = now() - interval '1 day' where token_hash = $1`, [hashWorkforceToken(a.to.replace('/w/s/', ''))]);
    const c = await openRequestLink(sb, tok, now());
    expect(c.state === 'redirect' && c.to).not.toBe(a.to);
  });
});

describe('forwarded receipts by email', () => {
  const ctx = (): InboundHandlerContext => ({ admin: sb, alias: { aliasId: 'al', orgId: ORG, locationId: B, purpose: 'receipts', address: 'receipts-ck@in.test' }, messageLogId: null, aiAvailable: false });
  const mail = (from: string, attach = true): InboundEmail => {
    const b = Buffer.from('%PDF-1.4 home depot receipt total 200.00');
    return {
      provider: 'generic',
      providerMessageId: crypto.randomUUID(),
      messageIdHeader: null,
      from: { address: from, name: 'Pat Lee' },
      to: [],
      cc: [],
      recipients: ['receipts-ck@in.test'],
      subject: 'Fwd: Home Depot receipt',
      textBody: 'Total $200.00 on 10/21/2026',
      htmlBody: null,
      receivedAt: now().toISOString(),
      headers: {},
      attachments: attach ? [{ fileName: 'hd.pdf', contentType: 'application/pdf', base64: b.toString('base64'), sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), contentId: null, inline: false }] : [],
      spam: null,
      auth: { ...UNVERIFIED_AUTH, verified: true, dmarc: 'pass', source: 'relay', summary: 'Sender verified (test)' },
    };
  };

  it('M6: an UNVERIFIED sender is never trusted as a cardholder, even with a cardholder’s address', async () => {
    const forged = { ...mail('pat@example.com'), auth: UNVERIFIED_AUTH };
    const r = await handleInboundReceiptEmail(forged, ctx(), { deps: { storeFile, anthropicApiKey: null, now } });
    expect(r.outcome).toBe('rejected_sender');
    expect(r.detail).toMatch(/could not be verified/);
    expect((await handleInboundReceiptEmail({ ...mail('pat@example.com'), auth: undefined }, ctx(), { deps: { storeFile } })).outcome).toBe('rejected_sender');
  });

  it('attaches a known cardholder’s receipt and matches it; rejects strangers; ignores duplicates', async () => {
    expect((await handleInboundReceiptEmail(mail('stranger@evil.test'), ctx(), { deps: { storeFile } })).outcome).toBe('rejected_sender');
    const r = await handleInboundReceiptEmail(mail('pat@example.com'), ctx(), { deps: { storeFile, anthropicApiKey: null, now } });
    expect(r.outcome).toBe('receipt_attached');
    expect((await state(T6)).status).toBe('matched');
    expect((await handleInboundReceiptEmail(mail('pat@example.com'), ctx(), { deps: { storeFile, anthropicApiKey: null, now } })).outcome).toBe('ignored_duplicate');
  });
});

describe('RLS, grants and client scope on the 181 tables', () => {
  it('members read (except links), never write; anon nothing; client scope applies', async () => {
    for (const t of ['receipt_policies', 'card_assignments', 'receipt_charge_states', 'workforce_links']) {
      const r = await one<{ sel: boolean; ins: boolean; upd: boolean; anon: boolean; rls: boolean; scope: number }>(
        `select has_table_privilege('authenticated', 'public.${t}', 'select') sel,
                has_table_privilege('authenticated', 'public.${t}', 'insert') ins,
                has_table_privilege('authenticated', 'public.${t}', 'update') upd,
                has_table_privilege('anon', 'public.${t}', 'select') anon,
                (select relrowsecurity from pg_class where oid = 'public.${t}'::regclass) rls,
                (select count(*)::int from pg_policies where schemaname = 'public' and tablename = '${t}' and policyname = 'client_scope_rls') scope`,
      );
      expect(r).toMatchObject({ ins: false, upd: false, anon: false, rls: true, scope: 1, sel: t !== 'workforce_links' });
    }
  });

  it('member_read pins the org', async () => {
    const p = await one<{ qual: string }>(`select qual from pg_policies where schemaname = 'public' and tablename = 'card_assignments' and policyname = 'member_read'`);
    expect(p.qual).toMatch(/get_org_id/);
    const other = await one<{ n: number }>(`select count(*)::int n from public.card_assignments where org_id = $1`, [OTHER]);
    expect(other.n).toBe(0);
  });

  it('a capture never writes another tenant’s company', async () => {
    await expect(captureReceipt(capDeps(), { orgId: OTHER, locationId: A, source: 'MANUAL_UPLOAD', file: pdf('x-tenant'), chargeId: T1, submittedBy: 'user_bk' })).rejects.toBeInstanceOf(CaptureError);
  });
});

describe('M5 — a holder submission only auto-matches the holder’s OWN charge', () => {
  it('Kelly’s perfect match to Andre’s charge is only "suggested"; a desk upload of the same facts auto-matches', async () => {
    const TX = await txn(crypto.randomUUID(), -15500, '2026-10-22', 'CHIPOTLE 2231 DES MOINES');
    await db.query(
      `insert into public.receipt_charge_states (org_id, location_id, bank_transaction_id, bank_account_id, card_assignment_id, charge_date, amount_cents, merchant, status)
       values ($1, $2, $3, $4, $5, '2026-10-22', 15500, 'Chipotle', 'requested')`,
      [ORG, A, TX, CARD, andre.id],
    );
    const typed = { merchant: 'Chipotle', amountCents: 15500, date: '2026-10-22' };
    const k = await captureReceipt(capDeps(), { orgId: ORG, locationId: A, source: 'MOBILE_CAPTURE', file: pdf('kelly-chipotle'), holder: kelly, typed, submittedBy: `cardholder:${kelly.id}` });
    expect(k.match).toMatchObject({ kind: 'suggested', transactionId: TX });
    expect((await one<{ matched_receipt_id: string | null }>(`select matched_receipt_id from public.bank_transactions where id = $1`, [TX])).matched_receipt_id).toBeNull();
    expect((await one<{ match_status: string; bank_transaction_id: string | null }>(`select match_status, bank_transaction_id from public.receipts where id = $1`, [k.receiptId]))).toEqual({ match_status: 'suggested', bank_transaction_id: null });

    const d = await captureReceipt(capDeps(), { orgId: ORG, locationId: A, source: 'MANUAL_UPLOAD', file: pdf('desk-chipotle'), typed, submittedBy: 'user_bk' });
    expect(d.match).toMatchObject({ kind: 'matched', transactionId: TX });
  });

  it('a file whose bytes do not match its declared type is refused', async () => {
    const fake = Buffer.from('MZ not really a pdf');
    await expect(captureReceipt(capDeps(), { orgId: ORG, locationId: A, source: 'MANUAL_UPLOAD', file: { base64: fake.toString('base64'), fileName: 'r.pdf', mimeType: 'application/pdf', sizeBytes: fake.length }, submittedBy: 'user_bk' }))
      .rejects.toMatchObject({ status: 415 });
  });
});
