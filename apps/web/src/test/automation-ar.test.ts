/**
 * Wave 2E — the AR automation jobs against a REAL Postgres (PGlite migration replay WITH
 * hosted Supabase's default grants, so "members can't write" is not vacuous):
 *
 *   184 RLS       members read their org's policies / fee proposals and cannot write them
 *   ar.recurring  drafts by default (PROPOSE dial), posts only under the AUTO cap, never
 *                 double-generates a period (template advance + source_ref after a "crash")
 *   ar.dunning    the ladder drafts the right step, waits for "Send now", mirrors the send
 *                 onto the invoice timeline, escalates + supersedes, holds on a promise /
 *                 dispute, the request engine's resolver closes it when paid, AUTO mode
 *                 sends through the engine and honours quiet hours
 *   ar.late_fees  once per invoice per month, never on a disputed invoice, approve → one
 *                 posted finance-charge invoice, which is never itself assessed; reject
 *                 is never re-proposed
 *   digest        a daily-digest member gets one email at 8 a.m. local, each item once
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

const { runRecurringInvoicesJob } = await import('@/lib/scheduler/jobs/recurring-invoices');
const { runDunningJob } = await import('@/lib/scheduler/jobs/dunning');
const { runLateFeesJob } = await import('@/lib/scheduler/jobs/late-fees');
const { runNotificationDigestJob } = await import('@/lib/scheduler/jobs/digest');
const { runRequestsDispatchJob } = await import('@/lib/scheduler/jobs/requests-dispatch');
const { createInvoice } = await import('@/lib/invoices/create-invoice');
const { decideLateFees } = await import('@/lib/collections/late-fees');
const { sendNow } = await import('@/lib/requests/service');
const { dispatchDueRequests } = await import('@/lib/requests/dispatch');
const { smsChannel, pushChannel } = await import('@/lib/notify/channels');
type JobContext = import('@/lib/scheduler/types').JobContext;
type Channels = import('@/lib/notify/channels').Channels;
type EmailOut = import('@/lib/notify/channels').EmailOut;
type ChannelOutcome = import('@/lib/notify/channels').ChannelOutcome;

let db: PGlite;
let svc: SupabaseClient;
let T: Tenant;
let OTHER: Tenant;
let adminMembership = '';
let feeIncome = '';

const DAY = 86_400_000;

function ctx(at: Date | string, orgId = T.org, slot?: Date | string): JobContext {
  const now = typeof at === 'string' ? new Date(at) : at;
  return {
    orgId,
    now,
    slotAt: slot ? new Date(slot) : now,
    signal: new AbortController().signal,
    admin: svc,
    scopedClient: () => svc,
  };
}

function mockEmail() {
  const sent: EmailOut[] = [];
  let seq = 0;
  const email = {
    id: 'email' as const,
    async send(m: EmailOut): Promise<ChannelOutcome> {
      sent.push(m);
      return { status: 'sent', provider: 'resend', providerMessageId: `re_${++seq}_${crypto.randomUUID().slice(0, 6)}` };
    },
  };
  const channels: Channels = { email, sms: smsChannel(), push: pushChannel() };
  return { sent, email, channels };
}

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function asMember<T>(org: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: 'user_member', org_id: org, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function dial(feature: string, mode: 'PROPOSE' | 'AUTO_UNDER_LIMIT', cap: number | null): Promise<void> {
  await db.query(
    `insert into public.autonomy_settings (org_id, feature, mode, materiality_limit_cents) values ($1, $2, $3, $4)
     on conflict (org_id, feature) do update set mode = excluded.mode, materiality_limit_cents = excluded.materiality_limit_cents`,
    [T.org, feature, mode, cap],
  );
}

async function invoice(invoiceDate: string, dueDate: string, cents: number, opts: { customer?: string } = {}): Promise<{ id: string; number: string }> {
  const out = await createInvoice(svc, {
    orgId: T.org,
    actor: 'test',
    input: {
      location_id: T.loc,
      customer_id: opts.customer ?? T.cust,
      invoice_date: invoiceDate,
      due_date: dueDate,
      post_to_gl: true,
      lines: [{ description: 'Services', account_id: T.acct.REV, quantity: 1, unit_price_cents: cents }],
    },
  });
  if (!out.ok) throw new Error(out.error);
  expect(out.result.posted).toBe(true);
  return { id: out.result.invoice_id, number: out.result.invoice_number };
}

interface ReqRow { id: string; status: string; next_send_at: string | null; sends_count: number; meta: Record<string, unknown>; cancel_reason: string | null; title: string; message: string | null; fulfilled_via: string | null }
async function dunningRequests(invoiceId: string): Promise<ReqRow[]> {
  return (
    await db.query<ReqRow>(
      `select id, status, next_send_at, sends_count, meta, cancel_reason, title, message, fulfilled_via from core.requests where kind = 'dunning' and subject_id = $1 order by created_at`,
      [invoiceId],
    )
  ).rows;
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  svc = pgSupabase(db);
  holder.svc = svc;
  T = await seedTenant(db, { projects: false, shortCode: 'AUT', termsDays: 30 });
  OTHER = await seedTenant(db, { projects: false, shortCode: 'OTH' });
  await db.query(`update core.organizations set timezone = 'America/Chicago' where id = $1`, [T.org]);
  await db.query(`update core.customers set email = 'ap@owner.test', display_name = 'Owner LLC' where id = $1`, [T.cust]);
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id, email, first_name) values ('user_admin', 'controller@books.test', 'Casey') returning id`);
  const m = await db.query<{ id: string }>(`insert into core.memberships (user_id, org_id, role, status) values ($1, $2, 'admin', 'active') returning id`, [u.rows[0].id, T.org]);
  adminMembership = m.rows[0].id;
  const g = await db.query<{ account_group_id: string }>(`select account_group_id from public.accounts where id = $1`, [T.acct.REV]);
  feeIncome = crypto.randomUUID();
  await db.query(
    `insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
     values ($1, $2, $3, '4900', 'Finance Charge Income', 'REVENUE', 'REVENUE', true, 'APPROVED')`,
    [feeIncome, T.org, g.rows[0].account_group_id],
  );
}, 300_000);

afterAll(async () => {
  await db?.close();
});

// ── 184 ──────────────────────────────────────────────────────────────────────

describe('migration 184 — policies and fee proposals are read-only to members', () => {
  it('members cannot write; they read only their org', async () => {
    await db.query(`insert into public.dunning_policies (org_id, enabled) values ($1, false), ($2, false)`, [T.org, OTHER.org]);
    for (const t of ['dunning_policies', 'late_fee_policies', 'late_fee_assessments']) {
      expect(await asMember(T.org, () => errorOf(`insert into public.${t} (org_id) values ('${T.org}')`)), t).toMatch(/permission denied|row-level security|violates not-null/i);
      expect(await asMember(T.org, () => errorOf(`update public.${t} set org_id = org_id`)), t).toMatch(/permission denied/i);
      expect(await asMember(T.org, () => errorOf(`delete from public.${t}`)), t).toMatch(/permission denied/i);
    }
    const seen = await asMember(T.org, async () => (await db.query<{ org_id: string }>(`select org_id from public.dunning_policies`)).rows);
    expect(seen.map((r) => r.org_id)).toEqual([T.org]);
    await db.query(`delete from public.dunning_policies`);
  });

  it('CHECKs: rate cap, period key, generate mode, discount pairing; one tenant row per org', async () => {
    expect(await errorOf(`insert into public.late_fee_policies (org_id, rate_bps) values ($1, 1500)`, [T.org])).toMatch(/late_fee_policies_chk/);
    expect(await errorOf(`update public.recurring_invoice_templates set generate_mode = 'SEND_ONLY'`)).toBeNull(); // no rows yet
    expect(await errorOf(`insert into public.recurring_invoice_templates (org_id, name, frequency, generate_mode) values ($1, 'x', 'MONTHLY', 'SEND_ONLY')`, [T.org])).toMatch(/generate_mode_chk/);
    expect(await errorOf(`update public.bills set early_pay_discount_bps = 200`)).toBeNull();
    await db.query(`insert into public.late_fee_policies (org_id) values ($1)`, [T.org]);
    expect(await errorOf(`insert into public.late_fee_policies (org_id) values ($1)`, [T.org])).toMatch(/duplicate key|uq_late_fee_policies_scope/);
    await db.query(`delete from public.late_fee_policies`);
  });
});

// ── ar.recurring ─────────────────────────────────────────────────────────────

describe('ar.recurring — generate, gate, never double-generate', () => {
  async function template(name: string, mode: string, cents: number, start = '2026-09-01'): Promise<string> {
    const r = await db.query<{ id: string }>(
      `insert into public.recurring_invoice_templates (org_id, location_id, customer_id, name, frequency, start_date, next_run_date, generate_mode, template_data)
       values ($1, $2, $3, $4, 'MONTHLY', $5, $5, $6, $7::jsonb) returning id`,
      [T.org, T.loc, T.cust, name, start, mode, JSON.stringify({ lines: [{ description: name, account_id: T.acct.REV, quantity: 1, unit_price_cents: cents }], terms: 30 })],
    );
    return r.rows[0].id;
  }
  const invoicesOf = async (tid: string) =>
    (await db.query<{ status: string; gl_entry_id: string | null; invoice_date: string }>(`select status, gl_entry_id, invoice_date::text from public.invoices where source_ref like $1 order by invoice_date`, [`recurring:${tid}:%`])).rows;

  it('PROPOSE dial (the default): every due period becomes a DRAFT — no GL — and a rerun creates nothing', async () => {
    const tid = await template('Monthly retainer', 'POST', 50_000);
    const r1 = await runRecurringInvoicesJob(ctx('2026-10-23T12:00:00Z'));
    expect(r1.status).toBe('ok');
    expect(r1.counts).toMatchObject({ created: 2, drafted: 2, posted: 0 });
    const inv = await invoicesOf(tid);
    expect(inv.map((i) => [i.invoice_date, i.status, i.gl_entry_id])).toEqual([['2026-09-01', 'DRAFT', null], ['2026-10-01', 'DRAFT', null]]);
    const next = await db.query<{ next_run_date: string }>(`select next_run_date::text from public.recurring_invoice_templates where id = $1`, [tid]);
    expect(next.rows[0].next_run_date).toBe('2026-11-01');

    const r2 = await runRecurringInvoicesJob(ctx('2026-10-23T12:00:00Z'));
    expect(r2.counts).toMatchObject({ created: 0 });
    expect((await invoicesOf(tid)).length).toBe(2);

    // A crash between creating the invoices and advancing the template: the retry adopts
    // the existing invoices (source_ref) instead of creating duplicates.
    await db.query(`update public.recurring_invoice_templates set next_run_date = '2026-09-01' where id = $1`, [tid]);
    const r3 = await runRecurringInvoicesJob(ctx('2026-10-23T12:00:00Z'));
    expect(r3.counts).toMatchObject({ created: 0, already_generated: 2 });
    expect((await invoicesOf(tid)).length).toBe(2);
    await db.query(`update public.recurring_invoice_templates set is_active = false where id = $1`, [tid]);
  });

  it('AUTO_UNDER_LIMIT posts AR within the cap, drafts over it; a DRAFT template always drafts', async () => {
    await dial('SCHEDULED_RECURRING_INVOICES', 'AUTO_UNDER_LIMIT', 100_000);
    const small = await template('Small', 'POST', 40_000, '2026-10-01');
    const big = await template('Big', 'POST', 250_000, '2026-10-01');
    const review = await template('Review me', 'DRAFT', 10_000, '2026-10-01');
    const r = await runRecurringInvoicesJob(ctx('2026-10-23T12:00:00Z'));
    expect(r.counts).toMatchObject({ created: 3, posted: 1, drafted: 2 });
    expect((await invoicesOf(small))[0]).toMatchObject({ status: 'SENT' });
    expect((await invoicesOf(small))[0].gl_entry_id).not.toBeNull();
    expect((await invoicesOf(big))[0]).toMatchObject({ status: 'DRAFT', gl_entry_id: null });
    expect((await invoicesOf(review))[0]).toMatchObject({ status: 'DRAFT', gl_entry_id: null });
    await db.query(`update public.recurring_invoice_templates set is_active = false where org_id = $1`, [T.org]);
    await dial('SCHEDULED_RECURRING_INVOICES', 'PROPOSE', null);
  });
});

// ── ar.dunning ───────────────────────────────────────────────────────────────

describe('ar.dunning — the ladder through the request engine', () => {
  let A: { id: string; number: string };
  let B: { id: string; number: string };
  let C: { id: string; number: string };

  beforeAll(async () => {
    A = await invoice('2026-09-01', '2026-10-01', 100_000);
    B = await invoice('2026-09-02', '2026-10-01', 80_000);
    C = await invoice('2026-09-03', '2026-10-01', 60_000);
    await db.query(
      `insert into public.dunning_policies (org_id, location_id, enabled, send_mode, steps)
       values ($1, null, true, 'DRAFT', $2::jsonb)`,
      [T.org, JSON.stringify([
        { stage: 'COURTESY', days: -3, subject: '', body: '' },
        { stage: 'FIRST_NOTICE', days: 7, subject: 'Reminder: {{invoice_number}} is {{days_overdue}} days late', body: 'Hi {{customer}}, {{amount}} is outstanding. {{pay_link}}' },
        { stage: 'SECOND_NOTICE', days: 30, subject: '', body: '' },
        { stage: 'FINAL_NOTICE', days: 90, subject: '', body: '' },
      ])],
    );
  });

  it('drafts the step the invoice has reached; it waits for a person (no next send) and a rerun adds nothing', async () => {
    const r = await runDunningJob(ctx('2026-10-23T14:00:00Z'));
    expect(r.status).toBe('ok');
    expect(r.counts).toMatchObject({ drafted: 3, queued_to_send: 0 });
    const [req] = await dunningRequests(A.id);
    expect(req).toMatchObject({ status: 'open', next_send_at: null, sends_count: 0 });
    expect(req.meta).toMatchObject({ stage: 'FIRST_NOTICE', draft: true });
    expect(req.title).toBe(`Reminder: ${A.number} is 22 days late`);
    expect(req.message).toContain('$1,000.00');
    // the admin is told once
    expect(await count(db, `select count(*) as n from core.notifications where membership_id = $1 and kind = 'scheduler.dunning'`, [adminMembership])).toBe(1);

    const again = await runDunningJob(ctx('2026-10-23T15:00:00Z'));
    expect(again.counts).toMatchObject({ drafted: 0 });
    expect((await dunningRequests(A.id)).length).toBe(1);

    // the dispatcher never sends a draft on its own
    const mail = mockEmail();
    const sum = await dispatchDueRequests({ db: svc, channels: mail.channels, now: () => new Date('2026-10-23T16:00:00Z'), appUrl: 'https://books.test' }, T.org);
    expect(sum.sent).toBe(0);
    expect(mail.sent.length).toBe(0);
  });

  it('"Send now" sends it; the next run records REMINDER_SENT on the invoice and does not resend', async () => {
    const mail = mockEmail();
    const [req] = await dunningRequests(A.id);
    const out = await sendNow({ db: svc, channels: mail.channels, now: () => new Date('2026-10-23T16:00:00Z'), appUrl: 'https://books.test' }, T.org, req.id, 'user_admin');
    expect(out.outcome).toBe('sent');
    expect(mail.sent[0].to).toBe('ap@owner.test');

    const r = await runDunningJob(ctx('2026-10-24T14:00:00Z'));
    expect(r.counts).toMatchObject({ reminders_recorded: 1, drafted: 0 });
    const ev = await db.query<{ meta: Record<string, unknown> }>(`select meta from public.invoice_events where invoice_id = $1 and event_type = 'REMINDER_SENT'`, [A.id]);
    expect(ev.rows.length).toBe(1);
    expect(ev.rows[0].meta).toMatchObject({ stage: 'FIRST_NOTICE', channel: 'dunning', human_approved: true });
    // idempotent mirror
    await runDunningJob(ctx('2026-10-25T14:00:00Z'));
    expect(await count(db, `select count(*) as n from public.invoice_events where invoice_id = $1 and event_type = 'REMINDER_SENT'`, [A.id])).toBe(1);
  });

  it('escalates to the next step when the invoice ages, superseding the earlier reminder', async () => {
    const r = await runDunningJob(ctx('2026-11-01T14:00:00Z'));
    expect(r.counts).toMatchObject({ superseded: 3 });
    const rows = await dunningRequests(A.id);
    expect(rows.map((x) => [x.meta.stage, x.status])).toEqual([['FIRST_NOTICE', 'cancelled'], ['SECOND_NOTICE', 'open']]);
    expect(rows[0].cancel_reason).toMatch(/Superseded by the second notice/);
  });

  it('holds while a promise to pay is pending, and resumes once the promise date passes', async () => {
    await db.query(
      `insert into core.action_log (org_id, actor_type, action, subject_table, subject_id, metadata)
       values ($1, 'HUMAN', 'collections.promise.logged', 'customers', $2, $3::jsonb)`,
      [T.org, T.cust, JSON.stringify({ customerId: T.cust, invoiceId: B.id, amountCents: 80_000, promiseDate: '2026-11-10' })],
    );
    const r = await runDunningJob(ctx('2026-11-02T14:00:00Z'));
    expect(r.counts).toMatchObject({ stopped_promise: 1 });
    expect((await dunningRequests(B.id)).at(-1)).toMatchObject({ status: 'cancelled' });
    // still pending → nothing new
    await runDunningJob(ctx('2026-11-05T14:00:00Z'));
    expect((await dunningRequests(B.id)).filter((x) => ['open', 'sent'].includes(x.status)).length).toBe(0);
    // promise broken → the ladder picks the step up again (a ladder-made hold isn't "done")
    await runDunningJob(ctx('2026-11-12T14:00:00Z'));
    expect((await dunningRequests(B.id)).at(-1)).toMatchObject({ status: 'open', meta: expect.objectContaining({ stage: 'SECOND_NOTICE' }) });
  });

  it('holds a disputed invoice; when it is paid the request engine closes the reminder before sending', async () => {
    await db.query(`update public.invoices set disputed_at = now(), dispute_note = 'wrong rate' where id = $1`, [C.id]);
    const r = await runDunningJob(ctx('2026-11-13T14:00:00Z'));
    expect(r.counts).toMatchObject({ stopped_dispute: 1 });
    await db.query(`update public.invoices set disputed_at = null where id = $1`, [C.id]);
    await runDunningJob(ctx('2026-11-14T14:00:00Z'));
    const open = (await dunningRequests(C.id)).at(-1)!;
    expect(open.status).toBe('open');
    // paid in full → resolver (wired into requests.remind) fulfils it, nothing is emailed
    await db.query(`update public.invoices set amount_paid_cents = total_cents, status = 'PAID' where id = $1`, [C.id]);
    const mail = mockEmail();
    const res = await runRequestsDispatchJob(ctx('2026-11-14T16:00:00Z'), { channels: mail.channels, appUrl: 'https://books.test' });
    expect(res.status).not.toBe('failed');
    expect((await dunningRequests(C.id)).at(-1)).toMatchObject({ status: 'fulfilled', fulfilled_via: 'resolver' });
    expect(mail.sent.filter((m) => m.subject.includes(C.number)).length).toBe(0);
  });

  it('AUTO: with the policy on Send and the dial allowing it, the reminder is due at once — deferred past quiet hours', async () => {
    await db.query(`update public.dunning_policies set send_mode = 'AUTO' where org_id = $1`, [T.org]);
    await dial('SCHEDULED_DUNNING_SEND', 'AUTO_UNDER_LIMIT', 500_000);
    const D = await invoice('2026-10-01', '2026-10-10', 30_000);
    // 02:00 UTC = 20:00 CT (quiet hours 20:00–07:00 by default)
    const r = await runDunningJob(ctx('2026-11-16T02:00:00Z'));
    expect(r.counts).toMatchObject({ queued_to_send: 1 });
    const [req] = await dunningRequests(D.id);
    expect(req.meta).toMatchObject({ stage: 'SECOND_NOTICE', draft: false });
    expect(new Date(req.next_send_at as string).toISOString()).toBe('2026-11-16T13:00:00.000Z'); // 07:00 CT
    const mail = mockEmail();
    const early = await dispatchDueRequests({ db: svc, channels: mail.channels, now: () => new Date('2026-11-16T03:00:00Z'), appUrl: 'https://books.test' }, T.org);
    expect(early.sent).toBe(0);
    const later = await dispatchDueRequests({ db: svc, channels: mail.channels, now: () => new Date('2026-11-16T13:05:00Z'), appUrl: 'https://books.test' }, T.org);
    expect(later.sent).toBeGreaterThanOrEqual(1);
    expect(mail.sent.some((m) => m.text.includes(D.number))).toBe(true);
    await dial('SCHEDULED_DUNNING_SEND', 'PROPOSE', null);
    await db.query(`update public.dunning_policies set enabled = false where org_id = $1`, [T.org]);
  });
});

// ── ar.late_fees ─────────────────────────────────────────────────────────────

describe('ar.late_fees — propose, approve into a finance-charge invoice, never compound', () => {
  let E: { id: string; number: string };
  let F: { id: string; number: string };

  beforeAll(async () => {
    E = await invoice('2026-09-01', '2026-09-30', 100_000);
    F = await invoice('2026-09-01', '2026-09-30', 50_000);
    await db.query(`update public.invoices set disputed_at = now() where id = $1`, [F.id]);
    await db.query(
      `insert into public.late_fee_policies (org_id, enabled, method, rate_bps, grace_days, frequency, income_account_id)
       values ($1, true, 'PERCENT_MONTHLY', 150, 10, 'MONTHLY', $2)`,
      [T.org, feeIncome],
    );
  });

  const fees = async (invoiceId: string) =>
    (await db.query<{ id: string; period_key: string; fee_cents: number; status: string; finance_charge_invoice_id: string | null }>(`select id, period_key, fee_cents::int as fee_cents, status, finance_charge_invoice_id from public.late_fee_assessments where invoice_id = $1 order by period_key`, [invoiceId])).rows;

  it('proposes 1.5% once for the month (not on the disputed invoice); a rerun adds nothing', async () => {
    const r = await runLateFeesJob(ctx('2026-10-23T14:30:00Z'));
    expect(r.status).toBe('ok');
    expect(await fees(E.id)).toEqual([expect.objectContaining({ period_key: '2026-10', fee_cents: 1_500, status: 'PROPOSED' })]);
    expect(await fees(F.id)).toEqual([]);
    const again = await runLateFeesJob(ctx('2026-10-24T14:30:00Z'));
    expect(again.counts).toMatchObject({ proposed: 0 });
    expect((await fees(E.id)).length).toBe(1);
    // nothing touched the ledger
    expect(await balance(db, feeIncome)).toBe(0);
  });

  it('approve → one posted finance-charge invoice crediting the income account', async () => {
    const [fee] = await fees(E.id);
    const res = await decideLateFees(svc, T.org, { ids: [fee.id], action: 'approve', actor: 'user_admin', today: '2026-10-24' });
    expect(res).toMatchObject({ approved: 1, errors: [] });
    const [after] = await fees(E.id);
    expect(after.status).toBe('APPROVED');
    const fc = await db.query<{ invoice_type: string; status: string; total_cents: number }>(`select invoice_type, status, total_cents::int as total_cents from public.invoices where id = $1`, [after.finance_charge_invoice_id]);
    expect(fc.rows[0]).toMatchObject({ invoice_type: 'Finance charge', status: 'SENT', total_cents: 1_500 });
    expect(await balance(db, feeIncome)).toBe(-1_500); // credit
    // re-approving is a no-op (already decided)
    expect((await decideLateFees(svc, T.org, { ids: [fee.id], action: 'approve', actor: 'user_admin', today: '2026-10-24' })).approved).toBe(0);
  });

  it('next month: the original invoice gets its next fee; the finance-charge invoice is never assessed; a rejection sticks', async () => {
    const r = await runLateFeesJob(ctx('2026-11-23T14:30:00Z'));
    expect(r.status).toBe('ok');
    expect((await fees(E.id)).map((f) => f.period_key)).toEqual(['2026-10', '2026-11']);
    const fcIds = (await db.query<{ id: string }>(`select id from public.invoices where invoice_type = 'Finance charge' and org_id = $1`, [T.org])).rows.map((x) => x.id);
    expect(await count(db, `select count(*) as n from public.late_fee_assessments where invoice_id = any($1::uuid[])`, [fcIds])).toBe(0);
    const nov = (await fees(E.id)).find((f) => f.period_key === '2026-11')!;
    expect((await decideLateFees(svc, T.org, { ids: [nov.id], action: 'reject', actor: 'user_admin', note: 'waived', today: '2026-11-23' })).rejected).toBe(1);
    await runLateFeesJob(ctx('2026-11-24T14:30:00Z'));
    expect((await fees(E.id)).find((f) => f.period_key === '2026-11')).toMatchObject({ status: 'REJECTED' });
    expect((await fees(E.id)).length).toBe(2);
  });
});

// ── notifications.digest ─────────────────────────────────────────────────────

describe('notifications.digest — one email at 8 a.m. local, each item once', () => {
  it('sends the daily digest to a subscriber and stamps the items', async () => {
    await db.query(
      `insert into core.notification_prefs (org_id, membership_id, digest, channels) values ($1, $2, 'daily', array['in_app','email'])`,
      [T.org, adminMembership],
    );
    const unread = await count(db, `select count(*) as n from core.notifications where membership_id = $1 and read_at is null and emailed_at is null`, [adminMembership]);
    expect(unread).toBeGreaterThan(0);
    const mail = mockEmail();
    // 2026-11-25 14:00Z = 08:00 CST; lookback is 7 days, so only the recent items go
    const notYet = await runNotificationDigestJob(ctx('2026-11-25T13:00:00Z'), { email: mail.email, appUrl: 'https://books.test' });
    expect(notYet.counts).toMatchObject({ due_now: 0 });
    await db.query(`update core.notifications set created_at = '2026-11-24T12:00:00Z' where membership_id = $1`, [adminMembership]);
    const r = await runNotificationDigestJob(ctx('2026-11-25T14:00:00Z'), { email: mail.email, appUrl: 'https://books.test' });
    expect(r.status).toBe('ok');
    expect(r.counts).toMatchObject({ sent: 1 });
    expect(mail.sent[0].to).toBe('controller@books.test');
    expect(mail.sent[0].subject).toMatch(/^Today in /);
    expect(await count(db, `select count(*) as n from core.notifications where membership_id = $1 and emailed_at is null`, [adminMembership])).toBe(0);
    const again = await runNotificationDigestJob(ctx('2026-11-25T14:30:00Z'), { email: mail.email, appUrl: 'https://books.test' });
    expect(again.counts).toMatchObject({ sent: 0 });
    expect(mail.sent.length).toBe(1);
  });
});

void DAY;
