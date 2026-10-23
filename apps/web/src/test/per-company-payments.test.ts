/**
 * Wave 1A — live payments & per-company Stripe accounts (migration 175, FPB-payments-fees §17),
 * against a REAL Postgres (PGlite replay) through a service-role-like client:
 *
 *   schema     location_id + the two partial unique keys (one tenant-level row, NULLS NOT
 *              DISTINCT; Plaid keyed per Item), the same-org guard, members can't write
 *   registry   connectProvider: one row per company; reconnect updates; two Plaid Items coexist
 *   intent     company A's invoice → A's connected account, B's → B's; no account → off
 *              (per company); single mode → tenant account; method cascade enforced;
 *              a test-mode connection is never used under a live key
 *   webhook    payout.paid from B's account posts on company B; account.updated stores the
 *              status and audits a payout-bank change; PAID → GL exactly once on replay
 *   $1 test    create → pay (webhook) → refund: Stripe refund + every GL line voided, the
 *              company nets to zero; cancel before payment voids the invoice
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { seedTenant, type Tenant } from './seam-fixture';

const holder: { sb: SupabaseClient | null } = { sb: null };
const created: Array<{ destination: string; amount: number; method: string; metadata: Record<string, string> }> = [];

vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => holder.sb,
  createServerSupabase: () => holder.sb,
}));
vi.mock('@/lib/money/providers/stripe', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/money/providers/stripe')>();
  return {
    ...orig,
    // The webhook body in these tests IS the (already-verified) event.
    constructWebhookEvent: (raw: string) => JSON.parse(raw),
    createDestinationPaymentIntent: async (a: { destinationAccount: string; amountCents: number; method: string; metadata: Record<string, string> }) => {
      created.push({ destination: a.destinationAccount, amount: a.amountCents, method: a.method, metadata: a.metadata });
      return { clientSecret: 'cs_test', id: `pi_${created.length}_${crypto.randomUUID().slice(0, 8)}` };
    },
  };
});

let db: PGlite;
let sb: SupabaseClient;

const TEST_KEYS = { STRIPE_SECRET_KEY: 'sk_test_x', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
function useKeys(k: Record<string, string>) {
  for (const [n, v] of Object.entries(k)) vi.stubEnv(n, v);
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0];
}

/** An account of a given type, in its own group (mirrors seam-fixture's helper). */
async function addAccount(org: string, number: string, name: string, type: string, subType: string): Promise<string> {
  const t = await one<{ id: string }>(
    `insert into public.account_types (org_id, name, code, display_order, normal_balance)
     values ($1, $2::text, ($2::text)::account_type_enum, 1, $3)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [org, type, ['ASSET', 'COGS', 'OPEX', 'OTHER'].includes(type) ? 'DEBIT' : 'CREDIT']);
  const st = await one<{ id: string }>(
    `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order)
     values ($1, $2, $3::text, ($3::text)::account_sub_type_enum, 1)
     on conflict (org_id, code) do update set name = excluded.name returning id`, [org, t.id, subType]);
  const g = await one<{ id: string }>(
    `insert into public.account_groups (org_id, account_sub_type_id, name, display_order)
     values ($1, $2, $3, 1) on conflict (org_id, name) do update set display_order = 1 returning id`, [org, st.id, `G ${subType}`]);
  const id = crypto.randomUUID();
  await db.query(
    `insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
     values ($1, $2, $3, $4, $5, $6::account_type_enum, $7::account_sub_type_enum, true, 'APPROVED')`,
    [id, org, g.id, number, name, type, subType]);
  return id;
}

async function addCompany(org: string, code: string): Promise<string> {
  const loc = crypto.randomUUID();
  await db.query(`insert into core.locations (id, org_id, name, short_code, rev_rec_method) values ($1, $2, $3, $4, 'AS_BILLED'::rev_rec_method_enum)`, [loc, org, `Co ${code}`, code]);
  for (const y of [2025, 2026, 2027]) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      await db.query(
        `insert into public.fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status)
         values ($1, $2, $3, $4, $5::date, ($5::date + interval '1 month' - interval '1 day')::date, 'OPEN')`, [org, loc, y, m, start]);
    }
  }
  return loc;
}

interface World extends Tenant { locB: string; locC: string; clearing: string; fee: string }

async function world(code: string): Promise<World> {
  const t = await seedTenant(db, { projects: false, shortCode: code });
  await db.query(`update core.organizations set entitlements = entitlements || '{"ar_collection": true, "bank_feed": true}'::jsonb where id = $1`, [t.org]);
  const clearing = await addAccount(t.org, '1095', 'Settlement Clearing', 'ASSET', 'CURRENT_ASSET');
  const fee = await addAccount(t.org, '6630', 'Merchant Fees', 'OPEX', 'OPERATING_EXPENSE');
  const locB = await addCompany(t.org, `${code}B`);
  const locC = await addCompany(t.org, `${code}C`);
  return { ...t, locB, locC, clearing, fee };
}

async function invoiceFor(w: World, locationId: string, cents = 50_000): Promise<{ id: string; token: string }> {
  const { createInvoice } = await import('@/lib/invoices/create-invoice');
  const out = await createInvoice(sb, {
    orgId: w.org, actor: 'user_test',
    input: { location_id: locationId, customer_id: w.cust, invoice_date: '2026-06-15', due_date: '2026-07-15', post_to_gl: true, lines: [{ description: 'Work', account_id: w.acct.REV, quantity: 1, unit_price_cents: cents }] },
  });
  if (!out.ok) throw new Error(out.error);
  const r = await one<{ public_token: string }>(`select public_token from public.invoices where id = $1`, [out.result.invoice_id]);
  return { id: out.result.invoice_id, token: r.public_token };
}

async function connect(w: World, locationId: string | null, handle: string, environment: 'test' | 'live' = 'test', chargesConfirmed = true) {
  const { connectProvider } = await import('@/lib/money/connections');
  const c = await connectProvider(sb, w.org, { capability: 'AR_COLLECTION', provider: 'stripe', environment, locationId, accountHandle: handle, connectedBy: 'user_test' });
  // Stripe confirmed the account can take charges (what the Connect webhook / a status
  // refresh stores). Online payment requires it (lib/invoices/pay-link.ts, fix 1G-1).
  if (chargesConfirmed) await db.query(`update core.provider_connections set charges_enabled = true where id = $1`, [c.id]);
  return c;
}

async function payIntent(token: string, body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/pay/[token]/intent/route');
  const res = await POST(new Request(`http://x/api/pay/${token}/intent`, { method: 'POST', body: JSON.stringify(body), headers: { 'x-forwarded-for': crypto.randomUUID() } }), { params: { token } });
  return { status: res.status, body: (await res.json()) as { enabled: boolean; message?: string; amount_cents?: number; test_mode?: boolean } };
}

async function webhook(event: Record<string, unknown>) {
  const { POST } = await import('@/app/api/webhooks/stripe/route');
  const res = await POST(new Request('http://x/api/webhooks/stripe', { method: 'POST', body: JSON.stringify(event), headers: { 'stripe-signature': 't=1,v1=x' } }));
  return { status: res.status, body: await res.json() };
}

function piSucceeded(piId: string, meta: Record<string, string>, destination: string, amount: number) {
  return {
    id: `evt_${crypto.randomUUID()}`, type: 'payment_intent.succeeded', account: null,
    data: { object: { id: piId, amount, application_fee_amount: Number(meta.app_fee_cents ?? 0), metadata: meta, transfer_data: { destination } } },
  };
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  sb = pgSupabase(db);
  holder.sb = sb;
  useKeys(TEST_KEYS);
}, 170_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.close();
});

describe('migration 175 — schema', () => {
  it('one tenant-level row per key (NULLS NOT DISTINCT), one row per company, Plaid per Item', async () => {
    const w = await world('M1');
    const ins = (loc: string | null, handle: string, cap = 'AR_COLLECTION', provider = 'stripe') =>
      db.query(`insert into core.provider_connections (org_id, capability, provider, environment, location_id, account_handle, status) values ($1, $2, $3, 'test', $4, $5, 'active')`, [w.org, cap, provider, loc, handle]);
    await ins(null, 'acct_t1');
    await expect(ins(null, 'acct_t2')).rejects.toThrow(/duplicate key/);
    await ins(w.loc, 'acct_a');
    await ins(w.locB, 'acct_b');
    await expect(ins(w.loc, 'acct_a2')).rejects.toThrow(/duplicate key/);
    await ins(w.loc, 'item_1', 'BANK_FEED', 'plaid');
    await ins(w.loc, 'item_2', 'BANK_FEED', 'plaid');
    await expect(ins(w.locB, 'item_1', 'BANK_FEED', 'plaid')).rejects.toThrow(/duplicate key/);
  });

  it("a connection cannot point at another tenant's company", async () => {
    const w = await world('M2');
    const other = await world('M3');
    await expect(db.query(`insert into core.provider_connections (org_id, capability, provider, environment, location_id, status) values ($1, 'AR_COLLECTION', 'stripe', 'test', $2, 'active')`, [w.org, other.loc]))
      .rejects.toThrow(/not part of this organization/);
    await expect(db.query(`insert into public.payment_test_runs (org_id, location_id, environment, amount_cents, created_by) values ($1, $2, 'test', 100, 'u')`, [w.org, other.loc]))
      .rejects.toThrow(/not part of this organization/);
  });

  it('members cannot write the new tables (or provider_connections) over PostgREST', async () => {
    const w = await world('M4');
    for (const sql of [
      `insert into core.org_payment_settings (org_id, account_mode) values ('${w.org}', 'single')`,
      `insert into public.payment_test_runs (org_id, location_id, environment, amount_cents, created_by) values ('${w.org}', '${w.loc}', 'test', 100, 'u')`,
      `update core.provider_connections set account_handle = 'acct_evil' where org_id = '${w.org}'`,
    ]) {
      await db.exec('set role authenticated');
      try {
        await expect(db.query(sql)).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec('reset role');
      }
    }
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname in ('org_payment_settings', 'payment_test_runs')`);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});

describe('connection registry', () => {
  it('one row per company; reconnecting a company updates its row; two Plaid Items coexist', async () => {
    const w = await world('R1');
    const a1 = await connect(w, w.loc, 'acct_R1A');
    const b = await connect(w, w.locB, 'acct_R1B');
    const a2 = await connect(w, w.loc, 'acct_R1A2');
    expect(a2.id).toBe(a1.id);
    expect(b.id).not.toBe(a1.id);
    expect(a2.locationId).toBe(w.loc);
    const { connectProvider } = await import('@/lib/money/connections');
    const p1 = await connectProvider(sb, w.org, { capability: 'BANK_FEED', provider: 'plaid', environment: 'test', locationId: w.loc, accountHandle: 'item_A', connectedBy: 'u' });
    const p2 = await connectProvider(sb, w.org, { capability: 'BANK_FEED', provider: 'plaid', environment: 'test', locationId: w.loc, accountHandle: 'item_B', connectedBy: 'u' });
    expect(p1.id).not.toBe(p2.id);
    const n = await one<{ n: number }>(`select count(*)::int n from core.provider_connections where org_id = $1`, [w.org]);
    expect(n.n).toBe(4);
  });
});

describe('pay intent routes to the issuing company', () => {
  let w: World;
  beforeAll(async () => {
    w = await world('P1');
    await connect(w, w.loc, 'acct_P1A');
    await connect(w, w.locB, 'acct_P1B');
    await connect(w, null, 'acct_P1T');
  });

  it("A's invoice → A's account; B's → B's", async () => {
    const ia = await invoiceFor(w, w.loc);
    const ib = await invoiceFor(w, w.locB);
    const ra = await payIntent(ia.token, { method: 'ACH' });
    expect(ra.body.enabled).toBe(true);
    expect(ra.body.test_mode).toBe(true);
    expect(created.at(-1)?.destination).toBe('acct_P1A');
    expect(created.at(-1)?.metadata.location_id).toBe(w.loc);
    const rb = await payIntent(ib.token, { method: 'ACH' });
    expect(rb.body.enabled).toBe(true);
    expect(created.at(-1)?.destination).toBe('acct_P1B');
  });

  it('per-company mode: a company without its own account is not routed to the tenant account', async () => {
    const ic = await invoiceFor(w, w.locC);
    const before = created.length;
    const r = await payIntent(ic.token, { method: 'ACH' });
    expect(r.body.enabled).toBe(false);
    expect(r.body.message).toMatch(/being set up/);
    expect(created.length).toBe(before);
  });

  it('an account Stripe has not confirmed (charges never checked) takes no payment (1G-1)', async () => {
    const w2 = await world('P9');
    await connect(w2, w2.loc, 'acct_P9A', 'test', false);
    const inv = await invoiceFor(w2, w2.loc);
    const before = created.length;
    const r = await payIntent(inv.token, { method: 'ACH' });
    expect(r.body.enabled).toBe(false);
    expect(created.length).toBe(before);
    // and the documents agree: no pay link
    const { loadInvoiceDocById } = await import('@/lib/invoices/invoice-doc');
    const doc = await loadInvoiceDocById(sb, w2.org, inv.id);
    expect(doc?.pay).toMatchObject({ payable: false, code: 'NOT_READY' });
  });

  it('the pay page, documents and intent agree: per-company mode with only a tenant account → no pay link (1G-1)', async () => {
    const ic = await invoiceFor(w, w.locC);
    const { loadInvoiceDocById } = await import('@/lib/invoices/invoice-doc');
    const doc = await loadInvoiceDocById(sb, w.org, ic.id);
    expect(doc?.pay).toMatchObject({ payable: false, code: 'NO_CONNECTION', methods: [] });
    const ia = await invoiceFor(w, w.loc);
    const docA = await loadInvoiceDocById(sb, w.org, ia.id);
    expect(docA?.pay).toMatchObject({ payable: true, mode: 'test', methods: ['ACH'] });
  });

  it('single mode (explicit opt-in): it falls back to the tenant-level account', async () => {
    const { setAccountMode } = await import('@/lib/money/payment-accounts');
    await setAccountMode(sb, w.org, 'single', 'user_test');
    try {
      const ic = await invoiceFor(w, w.locC);
      const r = await payIntent(ic.token, { method: 'ACH' });
      expect(r.body.enabled).toBe(true);
      expect(created.at(-1)?.destination).toBe('acct_P1T');
      expect(created.at(-1)?.metadata.account_source).toBe('tenant');
      const audit = await one<{ n: number }>(`select count(*)::int n from public.audit_log where org_id = $1 and field_name = 'account_mode' and new_value = 'single'`, [w.org]);
      expect(audit.n).toBe(1);
    } finally {
      await setAccountMode(sb, w.org, 'per_company', 'user_test');
    }
  });

  it('the method cascade is enforced server-side (card off by default; company switch turns it on)', async () => {
    const ia = await invoiceFor(w, w.loc);
    const off = await payIntent(ia.token, { method: 'CARD', accept_fee: true });
    expect(off.status).toBe(409);
    expect(off.body.message).toMatch(/Card payment is not accepted/);
    await db.query(`update core.locations set payment_methods_allowed = array['CHECK','ACH','CARD'] where id = $1`, [w.loc]);
    const on = await payIntent(ia.token, { method: 'CARD', accept_fee: true });
    expect(on.body.enabled).toBe(true);
    expect(created.at(-1)?.method).toBe('CARD');
    // card fee passes through by default: 3% on $500.00
    expect(on.body.amount_cents).toBe(51_500);
  });

  it('a test-mode connection is never used under a live key; mismatched keys turn payment off', async () => {
    const ia = await invoiceFor(w, w.loc);
    useKeys({ STRIPE_SECRET_KEY: 'sk_live_x', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_x' });
    try {
      const before = created.length;
      expect((await payIntent(ia.token, { method: 'ACH' })).body.enabled).toBe(false);
      useKeys({ STRIPE_SECRET_KEY: 'sk_live_x', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_x' });
      expect((await payIntent(ia.token, { method: 'ACH' })).body.enabled).toBe(false);
      expect(created.length).toBe(before);
    } finally {
      useKeys(TEST_KEYS);
    }
  });
});

describe('webhooks route by connected account', () => {
  it('payout.paid from B posts the payout on company B; an unknown account posts nothing', async () => {
    const w = await world('W1');
    await connect(w, w.loc, 'acct_W1A');
    await connect(w, w.locB, 'acct_W1B');
    const r = await webhook({ id: `evt_${crypto.randomUUID()}`, type: 'payout.paid', account: 'acct_W1B', data: { object: { id: 'po_W1', amount: 12_345 } } });
    expect(r.status).toBe(200);
    const e = await one<{ location_id: string; n: number }>(
      `select e.location_id, count(*) over ()::int n from public.gl_entries e where e.org_id = $1 and e.source_ref = 'po_W1'`, [w.org]);
    expect(e.location_id).toBe(w.locB);
    expect(e.n).toBe(1);
    await webhook({ id: `evt_${crypto.randomUUID()}`, type: 'payout.paid', account: 'acct_nobody', data: { object: { id: 'po_X', amount: 1 } } });
    const none = await one<{ n: number }>(`select count(*)::int n from public.gl_entries where source_ref = 'po_X'`);
    expect(none.n).toBe(0);
  });

  it('account.updated stores the status and audits a payout-bank change (old/new last 4)', async () => {
    const w = await world('W2');
    const c = await connect(w, w.loc, 'acct_W2A');
    const acct = (last4: string) => ({
      id: `evt_${crypto.randomUUID()}`, type: 'account.updated', account: 'acct_W2A',
      data: { object: { id: 'acct_W2A', charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [], past_due: [], disabled_reason: null }, external_accounts: { data: [{ object: 'bank_account', bank_name: 'Chase', last4, default_for_currency: true }] } } },
    });
    await webhook(acct('1111'));
    await webhook(acct('2222'));
    const row = await one<{ charges_enabled: boolean; payout_bank_last4: string }>(`select charges_enabled, payout_bank_last4 from core.provider_connections where id = $1`, [c.id]);
    expect(row).toEqual({ charges_enabled: true, payout_bank_last4: '2222' });
    const audit = await db.query<{ old_value: string; new_value: string; user_id: string }>(
      `select old_value, new_value, user_id from public.audit_log where record_id = $1 and field_name = 'payout_bank' order by created_at`, [c.id]);
    expect(audit.rows.map((a) => [a.old_value, a.new_value])).toEqual([['none', 'Chase ··1111'], ['Chase ··1111', 'Chase ··2222']]);
    expect(audit.rows[0].user_id).toBe('stripe');
  });

  it('PAID → GL posts exactly once when Stripe redelivers (new event id, same PaymentIntent)', async () => {
    const w = await world('W3');
    await connect(w, w.loc, 'acct_W3A');
    const inv = await invoiceFor(w, w.loc, 20_000);
    await payIntent(inv.token, { method: 'ACH' });
    const pi = created.at(-1)!;
    const piId = 'pi_W3_once';
    await webhook(piSucceeded(piId, pi.metadata, pi.destination, pi.amount));
    await webhook(piSucceeded(piId, pi.metadata, pi.destination, pi.amount));
    const n = await one<{ n: number }>(`select count(*)::int n from public.gl_entries where org_id = $1 and source_ref = $2 and entry_type = 'AR_COLLECTION' and status = 'POSTED'`, [w.org, piId]);
    expect(n.n).toBe(1);
    const st = await one<{ status: string }>(`select status from public.invoices where id = $1`, [inv.id]);
    expect(st.status).toBe('PAID');
  });
});

describe('$1 test payment', () => {
  it('create → pay → refund: Stripe refund, every GL entry voided, the company nets to zero', async () => {
    const w = await world('T1');
    await connect(w, w.loc, 'acct_T1A');
    const { createTestPayment, refundTestPayment, listTestRuns, cancelTestPayment } = await import('@/lib/money/test-payment');

    const { run } = await createTestPayment(sb, { orgId: w.org, locationId: w.loc, userId: 'user_admin' });
    expect(run.state).toBe('awaiting_payment');
    expect(run.payPath).toMatch(/^\/pay\//);
    // A second click hands back the same open test.
    expect((await createTestPayment(sb, { orgId: w.org, locationId: w.loc, userId: 'user_admin' })).reused).toBe(true);

    const token = run.payPath!.split('/').pop()!;
    const intent = await payIntent(token, { method: 'ACH' });
    expect(intent.body.enabled).toBe(true);
    const pi = created.at(-1)!;
    expect(pi.destination).toBe('acct_T1A');
    expect(pi.amount).toBe(100);
    await webhook(piSucceeded('pi_T1_test', pi.metadata, pi.destination, pi.amount));
    expect((await listTestRuns(sb, w.org))[0].state).toBe('paid');

    const refunds: string[] = [];
    const refunded = await refundTestPayment(sb, { orgId: w.org, runId: run.id, userId: 'user_admin' }, {
      refund: async (piId) => { refunds.push(piId); return { id: 're_1', status: 'succeeded' }; },
    });
    expect(refunds).toEqual(['pi_T1_test']);
    expect(refunded.state).toBe('refunded');

    // Every POSTED entry on the company is gone: AR, revenue, clearing and fees net to zero.
    const net = await db.query<{ account_id: string; net: number }>(
      `select l.account_id, sum(l.debit_cents - l.credit_cents)::int net
         from public.gl_entry_lines l join public.gl_entries e on e.id = l.gl_entry_id
        where e.org_id = $1 and e.status = 'POSTED' group by l.account_id`, [w.org]);
    expect(net.rows.filter((r) => r.net !== 0)).toEqual([]);
    const inv = await one<{ status: string }>(`select status from public.invoices where id = $1`, [refunded.invoiceId]);
    expect(inv.status).toBe('VOIDED');
    const pay = await one<{ settlement_status: string }>(`select settlement_status from public.customer_payments where reference_number = 'pi_T1_test'`);
    expect(pay.settlement_status).toBe('REFUNDED');
    // Closed is closed.
    await expect(refundTestPayment(sb, { orgId: w.org, runId: run.id, userId: 'user_admin' }, { refund: async () => ({ id: 're_2', status: null }) })).rejects.toThrow(/already closed/);

    // Cancel before payment: invoice voided, issuance reversed.
    const second = await createTestPayment(sb, { orgId: w.org, locationId: w.loc, userId: 'user_admin' });
    expect(second.reused).toBe(false);
    const cancelled = await cancelTestPayment(sb, { orgId: w.org, runId: second.run.id, userId: 'user_admin' });
    expect(cancelled.state).toBe('cancelled');
    const net2 = await db.query(`select 1 from public.gl_entry_lines l join public.gl_entries e on e.id = l.gl_entry_id where e.org_id = $1 and e.status = 'POSTED'`, [w.org]);
    expect(net2.rows.length).toBe(0);
  });

  it('refuses before any money moves when the payment is not in yet', async () => {
    const w = await world('T2');
    await connect(w, w.loc, 'acct_T2A');
    const { createTestPayment, refundTestPayment } = await import('@/lib/money/test-payment');
    const { run } = await createTestPayment(sb, { orgId: w.org, locationId: w.loc, userId: 'user_admin' });
    const refund = vi.fn();
    await expect(refundTestPayment(sb, { orgId: w.org, runId: run.id, userId: 'user_admin' }, { refund })).rejects.toThrow(/not been paid/);
    expect(refund).not.toHaveBeenCalled();
  });

  it('a company without a Stripe account cannot run a test', async () => {
    const w = await world('T3');
    const { createTestPayment } = await import('@/lib/money/test-payment');
    await expect(createTestPayment(sb, { orgId: w.org, locationId: w.locC, userId: 'u' })).rejects.toThrow(/Connect this company to Stripe first/);
  });
});
