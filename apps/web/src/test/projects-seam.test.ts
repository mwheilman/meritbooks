/**
 * Projects seam — Books side, part 1 (migration 173). Real Postgres (PGlite replay of
 * every Books migration + the pm emitter chain 1100–1103), real consumers, real GL
 * triggers, and — where it matters — the REAL Projects emitter functions
 * (pm.approve_and_emit_billing, pm.request_retainage_release, pm.request_deposit) and
 * Projects' ack reader (pm.reconcile_billing_requests).
 *
 *   stop-gap  unsupported schema_version / subtype / event type → rejected with error_code
 *   G1        exactly-once: same event twice · same source_ref in two events · concurrent drains
 *   G2        one invoice path: customer terms, sales tax, invoice events, AR by role, per-line revenue
 *   G3        retainage ties both sides; a release moves AR ↔ retainage only (zero revenue)
 *   deposits  one deposit per request, applied (collected part) at the final invoice
 *   gate      a non-Projects org: the consumers do nothing
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { processBillingEvents, planBilling, type BillingPayload } from '@/lib/services/billing-consumer';
import { processDepositRequestEvents } from '@/lib/services/deposit-request-consumer';
import { rejectUnknownProjectsEventTypes, SeamRejection } from '@/lib/events/seam';
import { recordCustomerPayment } from '@/lib/posting/lifecycle';
import { asUser, balance, count, enqueue, eventRow, seamDb, seedTenant, type Tenant } from './seam-fixture';
import { applyMigrationFile } from './pg';

let db: PGlite;
let sb: SupabaseClient;

beforeAll(async () => {
  ({ db, sb } = await seamDb());
}, 300_000);

afterAll(async () => {
  await db?.close();
});

const billing = (t: Tenant, over: Partial<BillingPayload> & Record<string, unknown> = {}): Record<string, unknown> => ({
  job_id: t.job, location_id: t.loc, billing_type: 'PROGRESS', occurred_on: '2026-06-15',
  source_ref: `pm:bill:${crypto.randomUUID()}`, memo: null,
  lines: [{ description: 'Framing', amount_cents: 100_000, item_id: null }],
  ...over,
});

const invoicesFor = (org: string) => count(db, `select count(*) n from public.invoices where org_id = $1`, [org]);
const glEntriesFor = (org: string) => count(db, `select count(*) n from public.gl_entries where org_id = $1`, [org]);

// ── Stop-gap: version / subtype / type rejection ─────────────────────────────
describe('stop-gap — unsupported versions and types are rejected with an error_code', () => {
  let t: Tenant;
  let off: Tenant;
  beforeAll(async () => {
    t = await seedTenant(db, { projects: true, shortCode: 'SG1' });
    off = await seedTenant(db, { projects: false, shortCode: 'SG2' });
  });

  it('JOB_BILLING schema_version 3 → rejected, UNSUPPORTED_SCHEMA_VERSION, nothing booked', async () => {
    const id = await enqueue(db, t.org, 'JOB_BILLING', billing(t, { schema_version: 3 }));
    const r = await processBillingEvents(sb, t.org);
    expect(r).toMatchObject({ processed: 0, rejected: 1 });
    const ev = await eventRow(db, id);
    expect(ev).toMatchObject({ status: 'rejected', error_code: 'UNSUPPORTED_SCHEMA_VERSION' });
    expect(ev.error).toMatch(/^UNSUPPORTED_SCHEMA_VERSION: JOB_BILLING schema_version 3/);
    expect(ev.processed_at).not.toBeNull();
    expect(await invoicesFor(t.org)).toBe(0);
  });

  it('a non-integer schema_version is rejected too (never coerced)', async () => {
    const id = await enqueue(db, t.org, 'JOB_BILLING', billing(t, { schema_version: '2.5' as unknown as number }));
    await processBillingEvents(sb, t.org);
    expect((await eventRow(db, id)).error_code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('the version gate applies even where Projects is not enabled', async () => {
    const id = await enqueue(db, off.org, 'JOB_BILLING', billing(off, { schema_version: 9 }));
    await processBillingEvents(sb, off.org);
    expect(await eventRow(db, id)).toMatchObject({ status: 'rejected', error_code: 'UNSUPPORTED_SCHEMA_VERSION' });
  });

  it('an unknown billing_subtype / line_type is rejected, not ignored', async () => {
    const a = await enqueue(db, t.org, 'JOB_BILLING', billing(t, { schema_version: 2, billing_subtype: 'BARTER' as never }));
    const b = await enqueue(db, t.org, 'JOB_BILLING', billing(t, {
      schema_version: 2, lines: [{ description: 'x', amount_cents: 100, item_id: null, line_type: 'BONUS' as never }],
    }));
    await processBillingEvents(sb, t.org);
    expect((await eventRow(db, a)).error_code).toBe('UNSUPPORTED_BILLING_SUBTYPE');
    expect((await eventRow(db, b)).error_code).toBe('UNSUPPORTED_LINE_TYPE');
  });

  it('JOB_DEPOSIT_REQUEST schema_version 2 → rejected', async () => {
    const id = await enqueue(db, t.org, 'JOB_DEPOSIT_REQUEST', {
      job_id: t.job, location_id: t.loc, customer_id: t.cust, amount_cents: 5000, memo: null,
      occurred_on: '2026-06-15', source_ref: `pm:deposit:${crypto.randomUUID()}`, schema_version: 2,
    });
    await processDepositRequestEvents(sb, t.org);
    expect(await eventRow(db, id)).toMatchObject({ status: 'rejected', error_code: 'UNSUPPORTED_SCHEMA_VERSION' });
  });

  it('an unknown Projects event type is rejected (UNSUPPORTED_EVENT_TYPE); planned types keep waiting', async () => {
    const weird = await enqueue(db, t.org, 'JOB_TELEPORT', { schema_version: 1 });
    const planned = await enqueue(db, t.org, 'JOB_MATERIAL', { schema_version: 1 });
    const n = await rejectUnknownProjectsEventTypes(sb, t.org);
    expect(n).toBe(1);
    expect(await eventRow(db, weird)).toMatchObject({ status: 'rejected', error_code: 'UNSUPPORTED_EVENT_TYPE' });
    expect((await eventRow(db, planned)).status).toBe('pending');
  });

  it('error_code has a CHECKed shape', async () => {
    await expect(db.query(`update core.events set error_code = 'not a code' where org_id = $1`, [t.org])).rejects.toThrow(/events_error_code_format/);
  });

  it('planBilling: v2 tie checks reject a retainage / gross mismatch', () => {
    const p = {
      event_id: 'e', job_id: 'j', location_id: 'l', billing_type: 'PROGRESS', occurred_on: '2026-06-15', source_ref: 'pm:bill:x', memo: null,
      schema_version: 2, retainage_cents: 999, gross_earned_cents: 100_000,
      lines: [{ description: 'w', amount_cents: 100_000, item_id: null, line_type: 'STANDARD' as const },
              { description: 'r', amount_cents: -10_000, item_id: null, line_type: 'RETAINAGE' as const }],
    } satisfies BillingPayload;
    expect(() => planBilling(p)).toThrowError(SeamRejection);
    try { planBilling(p); } catch (e) { expect((e as SeamRejection).code).toBe('RETAINAGE_TIE'); }
    try { planBilling({ ...p, retainage_cents: 10_000, gross_earned_cents: 1 }); } catch (e) { expect((e as SeamRejection).code).toBe('GROSS_TIE'); }
    expect(planBilling({ ...p, retainage_cents: 10_000 })).toMatchObject({ grossCents: 100_000, retainageCents: 10_000, netCents: 90_000 });
  });
});

// ── Gate: Books stands alone ──────────────────────────────────────────────────
describe('gate — a non-Projects org: the consumers do nothing', () => {
  it('billing and deposit requests stay pending and unclaimed; nothing is booked', async () => {
    const t = await seedTenant(db, { projects: false, shortCode: 'OFF' });
    const b = await enqueue(db, t.org, 'JOB_BILLING', billing(t));
    const d = await enqueue(db, t.org, 'JOB_DEPOSIT_REQUEST', {
      job_id: t.job, location_id: t.loc, customer_id: t.cust, amount_cents: 5000, memo: null,
      occurred_on: '2026-06-15', source_ref: `pm:deposit:${crypto.randomUUID()}`, schema_version: 1,
    });
    const rb = await processBillingEvents(sb, t.org);
    const rd = await processDepositRequestEvents(sb, t.org);
    expect(rb).toMatchObject({ processed: 0, rejected: 0, skipped: 1 });
    expect(rd).toMatchObject({ processed: 0, rejected: 0, skipped: 1 });
    for (const id of [b, d]) {
      const row = await db.query<{ status: string; claimed_by: string | null }>(`select status, claimed_by from core.events where id = $1`, [id]);
      expect(row.rows[0]).toEqual({ status: 'pending', claimed_by: null });
    }
    expect(await invoicesFor(t.org)).toBe(0);
    expect(await count(db, `select count(*) n from public.customer_deposits where org_id = $1`, [t.org])).toBe(0);
    expect(await glEntriesFor(t.org)).toBe(0);
  });
});

// ── G1: exactly-once ─────────────────────────────────────────────────────────
describe('G1 — exactly-once billing by event AND by business key', () => {
  let t: Tenant;
  beforeAll(async () => { t = await seedTenant(db, { projects: true, shortCode: 'EX1' }); });

  it('the same event delivered twice → one invoice, one GL entry, both acks identical', async () => {
    const id = await enqueue(db, t.org, 'JOB_BILLING', billing(t, { source_ref: 'pm:bill:same-event' }));
    await processBillingEvents(sb, t.org);
    const first = await eventRow(db, id);
    expect(first.status).toBe('processed');
    // Re-delivery (e.g. an operator re-queues it): the invoice for this event is found.
    await db.query(`update core.events set status = 'pending', processed_at = null, claimed_by = null, claimed_at = null where id = $1`, [id]);
    await processBillingEvents(sb, t.org);
    const again = await eventRow(db, id);
    expect(again).toMatchObject({ status: 'processed', invoice_id: first.invoice_id, invoice_number: first.invoice_number, gl_entry_id: first.gl_entry_id });
    expect(await count(db, `select count(*) n from public.invoices where org_id = $1 and source_ref = 'pm:bill:same-event'`, [t.org])).toBe(1);
    expect(await count(db, `select count(*) n from public.gl_entries where org_id = $1 and source_ref = 'job_billing:pm:bill:same-event'`, [t.org])).toBe(1);
  });

  it('the same source_ref in two events (a re-emit) → ONE invoice; the second event acks with it', async () => {
    const a = await enqueue(db, t.org, 'JOB_BILLING', billing(t, { source_ref: 'pm:bill:reemit' }));
    await processBillingEvents(sb, t.org);
    const b = await enqueue(db, t.org, 'JOB_BILLING', billing(t, { source_ref: 'pm:bill:reemit' }));
    await processBillingEvents(sb, t.org);
    const ea = await eventRow(db, a);
    const eb = await eventRow(db, b);
    expect(eb).toMatchObject({ status: 'processed', invoice_id: ea.invoice_id, invoice_number: ea.invoice_number, gl_entry_id: ea.gl_entry_id });
    expect(eb.ack_meta).toMatchObject({ duplicate_of: ea.invoice_id });
    expect(await count(db, `select count(*) n from public.invoices where org_id = $1 and source_ref = 'pm:bill:reemit'`, [t.org])).toBe(1);
  });

  it('two concurrent drains over a batch with a duplicated key → one invoice per key, every event acked', async () => {
    const t2 = await seedTenant(db, { projects: true, shortCode: 'EX2' });
    const ids = [
      await enqueue(db, t2.org, 'JOB_BILLING', billing(t2, { source_ref: 'pm:bill:c1' })),
      await enqueue(db, t2.org, 'JOB_BILLING', billing(t2, { source_ref: 'pm:bill:c2' })),
      await enqueue(db, t2.org, 'JOB_BILLING', billing(t2, { source_ref: 'pm:bill:c1' })),
    ];
    const [x, y] = await Promise.all([processBillingEvents(sb, t2.org), processBillingEvents(sb, t2.org)]);
    // A lost race on the business key is left pending for the next run (never a 2nd invoice).
    await processBillingEvents(sb, t2.org);
    expect(x.processed + y.processed).toBeGreaterThanOrEqual(2);
    expect(await invoicesFor(t2.org)).toBe(2);
    expect(await glEntriesFor(t2.org)).toBe(2);
    for (const id of ids) expect((await eventRow(db, id)).status).toBe('processed');
    expect((await eventRow(db, ids[0])).invoice_id).toBe((await eventRow(db, ids[2])).invoice_id);
  });

  it('the DB is the guarantor: a second invoice / GL entry with the same business key is refused', async () => {
    const inv = await db.query<{ location_id: string; customer_id: string }>(`select location_id, customer_id from public.invoices where org_id = $1 and source_ref = 'pm:bill:reemit'`, [t.org]);
    await expect(db.query(
      `insert into public.invoices (org_id, location_id, customer_id, invoice_number, invoice_date, due_date, source_ref)
       values ($1, $2, $3, 'X-1', '2026-06-15', '2026-07-15', 'pm:bill:reemit')`,
      [t.org, inv.rows[0].location_id, inv.rows[0].customer_id])).rejects.toThrow(/uq_invoices_org_source_ref/);
  });
});

// ── G2: one invoice path ─────────────────────────────────────────────────────
describe('G2 — the consumer goes through the standard invoice creator', () => {
  it('customer terms, sales tax, invoice events, AR by role, per-line revenue accounts', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'G2A', termsDays: 45, taxRatePct: 7 });
    // Line 2 sells an item whose income account is 4100; the job maps its revenue to 4000.
    const item = crypto.randomUUID();
    await db.query(`insert into core.items (id, org_id, sku, name, income_account_id) values ($1, $2, 'CO-1', 'Change work', $3)`, [item, t.org, t.acct.REV2]);
    await db.query(`update core.jobs set revenue_account_id = $1 where id = $2`, [t.acct.REV, t.job]);
    const id = await enqueue(db, t.org, 'JOB_BILLING', billing(t, {
      lines: [{ description: 'Framing', amount_cents: 60_000, item_id: null }, { description: 'CO #1', amount_cents: 40_000, item_id: item }],
    }));
    await processBillingEvents(sb, t.org);
    const ev = await eventRow(db, id);
    expect(ev.status).toBe('processed');
    expect(ev.invoice_number).toMatch(/^INV-20260615-\d{4}$/);

    const inv = (await db.query<{ due_date: string; subtotal_cents: string; tax_cents: string; total_cents: string; status: string; gl_entry_id: string; source_event_id: string }>(
      `select to_char(due_date, 'YYYY-MM-DD') due_date, subtotal_cents, tax_cents, total_cents, status, gl_entry_id, source_event_id from public.invoices where id = $1`, [ev.invoice_id])).rows[0];
    expect(inv.due_date).toBe('2026-07-30'); // +45 customer terms, not +30
    expect(Number(inv.tax_cents)).toBe(7_000);
    expect(Number(inv.total_cents)).toBe(107_000);
    expect(inv).toMatchObject({ status: 'SENT', gl_entry_id: ev.gl_entry_id, source_event_id: id });

    const events = (await db.query<{ event_type: string }>(`select event_type from public.invoice_events where invoice_id = $1 order by created_at`, [ev.invoice_id])).rows.map((r) => r.event_type);
    expect(events).toEqual(['CREATED', 'POSTED']);

    expect(await balance(db, t.acct.AR)).toBe(107_000);
    expect(await balance(db, t.acct.REV)).toBe(-60_000);
    expect(await balance(db, t.acct.REV2)).toBe(-40_000);
    expect(await balance(db, t.acct.TAX)).toBe(-7_000);
    const lines = (await db.query<{ account_id: string }>(`select account_id from public.invoice_lines where invoice_id = $1 order by line_number`, [ev.invoice_id])).rows;
    expect(lines.map((l) => l.account_id)).toEqual([t.acct.REV, t.acct.REV2]);
  });

  it('rev-rec parity: AS_BILLED credits revenue, a deferral method credits Deferred Revenue, a per-job override wins', async () => {
    const asBilled = await seedTenant(db, { projects: true, shortCode: 'RR1', revRec: 'AS_BILLED' });
    const deferral = await seedTenant(db, { projects: true, shortCode: 'RR2', revRec: 'PCT_COSTS_INCURRED' });
    const override = await seedTenant(db, { projects: true, shortCode: 'RR3', revRec: 'PCT_COSTS_INCURRED', jobOverride: 'POINT_OF_SALE' });
    for (const t of [asBilled, deferral, override]) {
      await enqueue(db, t.org, 'JOB_BILLING', billing(t));
      await processBillingEvents(sb, t.org);
    }
    expect(await balance(db, asBilled.acct.REV)).toBe(-100_000);
    expect(await balance(db, asBilled.acct.DEF)).toBe(0);
    expect(await balance(db, deferral.acct.DEF)).toBe(-100_000);
    expect(await balance(db, deferral.acct.REV)).toBe(0);
    expect(await balance(db, override.acct.REV)).toBe(-100_000);
  });

  it('a HARD_CLOSE period is rejected with PERIOD_CLOSED (nothing booked)', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'HC1' });
    await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where org_id = $1 and period_year = 2026 and period_month = 6`, [t.org]);
    const id = await enqueue(db, t.org, 'JOB_BILLING', billing(t));
    await processBillingEvents(sb, t.org);
    expect(await eventRow(db, id)).toMatchObject({ status: 'rejected', error_code: 'PERIOD_CLOSED' });
    expect(await invoicesFor(t.org)).toBe(0);
  });
});

// ── G3: retainage, through the REAL Projects emitter ─────────────────────────
describe('G3 — retainage ties both sides (real pm emitter → Books → pm reconcile)', () => {
  let t: Tenant;
  let billEvent: string;

  beforeAll(async () => {
    t = await seedTenant(db, { projects: true, shortCode: 'RET' });
    await db.query(`insert into pm.contracts (org_id, job_id, kind, original_cents, retention_pct, status) values ($1, $2, 'PRIME', 1000000, 0.1, 'ACTIVE')`, [t.org, t.job]);
  });

  it('Books advertises seam v2 to Projects for a Projects org (trigger), v1 otherwise', async () => {
    expect((await db.query<{ v: number }>(`select pm.books_seam_version($1) v`, [t.org])).rows[0].v).toBe(2);
    const off = await seedTenant(db, { projects: false, shortCode: 'RV1' });
    expect((await db.query<{ v: number }>(`select pm.books_seam_version($1) v`, [off.org])).rows[0].v).toBe(1);
    await db.query(`update core.organizations set entitlements = entitlements || '{"projects": true}'::jsonb where id = $1`, [off.org]);
    expect((await db.query<{ v: number }>(`select pm.books_seam_version($1) v`, [off.org])).rows[0].v).toBe(2);
  });

  it('a pay application with retainage: DR AR net + DR Retainage receivable = CR revenue gross', async () => {
    const req = crypto.randomUUID();
    await db.query(
      `insert into pm.billing_requests (id, org_id, job_id, billing_type, status, occurred_on, memo, created_by)
       values ($1, $2, $3, 'TIME_MATERIALS', 'DRAFT', '2026-06-15', 'Pay app 1', 'user_prep')`, [req, t.org, t.job]);
    await db.query(
      `insert into pm.billing_request_lines (org_id, billing_request_id, line_no, line_type, description, amount_cents, retainage_rate, retainage_this_period_cents)
       values ($1, $2, 1, 'STANDARD', 'Work this period', 100000, 0.1, 10000),
              ($1, $2, 2, 'RETAINAGE', 'Retainage 10%', -10000, null, 0)`, [t.org, req]);
    const ev = await asUser(db, t.org, 'user_appr', () => db.query<{ e: string }>(`select pm.approve_and_emit_billing($1) e`, [req]));
    const emitted = await db.query<{ id: string; payload: Record<string, unknown> }>(`select id, payload from core.events where org_id = $1 and event_id = $2`, [t.org, ev.rows[0].e]);
    billEvent = emitted.rows[0].id;
    expect(emitted.rows[0].payload).toMatchObject({ schema_version: 2, retainage_cents: 10000, gross_earned_cents: 100000 });

    const r = await processBillingEvents(sb, t.org);
    expect(r).toMatchObject({ processed: 1, rejected: 0 });
    const ack = await eventRow(db, billEvent);
    expect(ack.status).toBe('processed');

    expect(await balance(db, t.acct.AR)).toBe(90_000);
    expect(await balance(db, t.acct.RET)).toBe(10_000);
    expect(await balance(db, t.acct.REV)).toBe(-100_000);
    expect((await balance(db, t.acct.AR)) + (await balance(db, t.acct.RET))).toBe(-(await balance(db, t.acct.REV)));
    const inv = (await db.query<{ subtotal_cents: number; retainage_cents: number; total_cents: number }>(
      `select subtotal_cents::int, retainage_cents::int, total_cents::int from public.invoices where id = $1`, [ack.invoice_id])).rows[0];
    expect(inv).toEqual({ subtotal_cents: 100_000, retainage_cents: 10_000, total_cents: 90_000 });

    // Projects reads the ack in place and marks its request ISSUED with Books' number.
    await db.query(`select pm.reconcile_billing_requests($1)`, [t.org]);
    const br = (await db.query<{ status: string; invoice_number: string; invoice_id: string; gl_entry_id: string }>(
      `select status, invoice_number, invoice_id, gl_entry_id from pm.billing_requests where id = $1`, [req])).rows[0];
    expect(br).toEqual({ status: 'ISSUED', invoice_number: ack.invoice_number, invoice_id: ack.invoice_id, gl_entry_id: ack.gl_entry_id });
    // ...and its retainage shadow ties to Books' RETAINAGE_RECEIVABLE.
    const shadow = await db.query<{ outstanding_cents: string }>(`select outstanding_cents from pm.v_job_retainage where org_id = $1 and job_id = $2`, [t.org, t.job]);
    expect(Number(shadow.rows[0].outstanding_cents)).toBe(await balance(db, t.acct.RET));
  });

  it('the retainage release moves AR ↔ Retainage receivable only — zero revenue', async () => {
    const revBefore = await balance(db, t.acct.REV);
    const defBefore = await balance(db, t.acct.DEF);
    const rel = await asUser(db, t.org, 'user_prep', () => db.query<{ id: string }>(`select pm.request_retainage_release($1, null, '2026-07-10') id`, [t.job]));
    const ev = await asUser(db, t.org, 'user_appr', () => db.query<{ e: string }>(`select pm.approve_and_emit_billing($1) e`, [rel.rows[0].id]));
    const evRow = (await db.query<{ id: string; payload: Record<string, unknown> }>(`select id, payload from core.events where org_id = $1 and event_id = $2`, [t.org, ev.rows[0].e])).rows[0];
    expect(evRow.payload).toMatchObject({ billing_subtype: 'RETAINAGE_RELEASE', retainage_released_cents: 10000 });

    await processBillingEvents(sb, t.org);
    const ack = await eventRow(db, evRow.id);
    expect(ack.status).toBe('processed');
    expect(await balance(db, t.acct.RET)).toBe(0);
    expect(await balance(db, t.acct.AR)).toBe(100_000);
    expect(await balance(db, t.acct.REV)).toBe(revBefore);
    expect(await balance(db, t.acct.DEF)).toBe(defBefore);
    const inv = (await db.query<{ billing_subtype: string; tax_cents: number; retainage_cents: number }>(
      `select billing_subtype, tax_cents::int, retainage_cents::int from public.invoices where id = $1`, [ack.invoice_id])).rows[0];
    expect(inv).toEqual({ billing_subtype: 'RETAINAGE_RELEASE', tax_cents: 0, retainage_cents: 0 });
    await db.query(`select pm.reconcile_billing_requests($1)`, [t.org]);
    expect((await db.query<{ status: string }>(`select status from pm.billing_requests where id = $1`, [rel.rows[0].id])).rows[0].status).toBe('ISSUED');
  });

  it('a release is never taxed even where sales tax is configured', async () => {
    const tx = await seedTenant(db, { projects: true, shortCode: 'RTX', taxRatePct: 7 });
    await enqueue(db, tx.org, 'JOB_BILLING', billing(tx, {
      schema_version: 2, billing_subtype: 'RETAINAGE_RELEASE', retainage_released_cents: 5_000,
      lines: [{ description: 'Release', amount_cents: 5_000, item_id: null, line_type: 'RETAINAGE_RELEASE' }],
    }));
    await processBillingEvents(sb, tx.org);
    expect(await balance(db, tx.acct.AR)).toBe(5_000);
    expect(await balance(db, tx.acct.RET)).toBe(-5_000);
    expect(await balance(db, tx.acct.TAX)).toBe(0);
    expect(await balance(db, tx.acct.REV)).toBe(0);
  });

  it('v1 (FROZEN v3) negative line is booked as retainage receivable, not netted out of revenue', async () => {
    const v1 = await seedTenant(db, { projects: true, shortCode: 'RV0' });
    await enqueue(db, v1.org, 'JOB_BILLING', billing(v1, {
      lines: [{ description: 'Work', amount_cents: 50_000, item_id: null }, { description: 'Retainage', amount_cents: -5_000, item_id: null }],
    }));
    await processBillingEvents(sb, v1.org);
    expect(await balance(db, v1.acct.AR)).toBe(45_000);
    expect(await balance(db, v1.acct.RET)).toBe(5_000);
    expect(await balance(db, v1.acct.REV)).toBe(-50_000);
  });
});

// ── JOB_DEPOSIT_REQUEST ──────────────────────────────────────────────────────
describe('deposits — one deposit per request, applied at the final invoice', () => {
  let t: Tenant;
  let depEvent: string;
  let depositRequestId: string;

  beforeAll(async () => {
    t = await seedTenant(db, { projects: true, shortCode: 'DEP', contractCents: 100_000 });
  });

  it('the real pm.request_deposit → exactly one deposit invoice + one HELD deposit (DR AR / CR 2420)', async () => {
    const r = await asUser(db, t.org, 'user_pm', () => db.query<{ id: string }>(`select pm.request_deposit($1, 20000, 'Deposit 20%', '2026-06-01') id`, [t.job]));
    depositRequestId = r.rows[0].id;
    depEvent = (await db.query<{ id: string }>(`select e.id from core.events e join pm.deposit_requests d on d.event_id = e.event_id where d.id = $1`, [depositRequestId])).rows[0].id;

    const res = await processDepositRequestEvents(sb, t.org);
    expect(res).toMatchObject({ processed: 1, rejected: 0 });
    const ack = await eventRow(db, depEvent);
    expect(ack.status).toBe('processed');
    expect(ack.invoice_number).toMatch(/^INV-20260601-/);
    expect(ack.ack_meta).toMatchObject({ amount_cents: 20000 });

    const deps = (await db.query<{ id: string; status: string; amount_cents: number; deposit_invoice_id: string; journal_entry_id: string; source_ref: string }>(
      `select id, status, amount_cents::int, deposit_invoice_id, journal_entry_id, source_ref from public.customer_deposits where org_id = $1`, [t.org])).rows;
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ status: 'HELD', amount_cents: 20_000, deposit_invoice_id: ack.invoice_id, journal_entry_id: ack.gl_entry_id, source_ref: `pm:deposit:${depositRequestId}` });
    expect(ack.ack_meta).toMatchObject({ deposit_id: deps[0].id });
    expect(await balance(db, t.acct.AR)).toBe(20_000);
    expect(await balance(db, t.acct.DEP)).toBe(-20_000);
    expect(await balance(db, t.acct.REV)).toBe(0);
    const inv = (await db.query<{ invoice_type: string; billing_subtype: string; tax_cents: number }>(`select invoice_type, billing_subtype, tax_cents::int from public.invoices where id = $1`, [ack.invoice_id])).rows[0];
    expect(inv).toEqual({ invoice_type: 'Deposit', billing_subtype: 'DEPOSIT', tax_cents: 0 });

    await db.query(`select pm.reconcile_billing_requests($1)`, [t.org]);
    const dr = (await db.query<{ status: string; invoice_number: string }>(`select status, invoice_number from pm.deposit_requests where id = $1`, [depositRequestId])).rows[0];
    expect(dr).toEqual({ status: 'ISSUED', invoice_number: ack.invoice_number });
  });

  it('a re-emitted request (same source_ref, new event) and a lost subledger row self-heal to ONE deposit', async () => {
    const ref = `pm:deposit:${depositRequestId}`;
    await db.query(`delete from public.customer_deposits where org_id = $1 and source_ref = $2`, [t.org, ref]);
    const again = await enqueue(db, t.org, 'JOB_DEPOSIT_REQUEST', {
      job_id: t.job, location_id: t.loc, customer_id: t.cust, amount_cents: 20000, memo: 'Deposit 20%',
      occurred_on: '2026-06-01', source_ref: ref, schema_version: 1,
    }, '2026-06-01');
    await processDepositRequestEvents(sb, t.org);
    const ack = await eventRow(db, again);
    expect(ack).toMatchObject({ status: 'processed', invoice_id: (await eventRow(db, depEvent)).invoice_id });
    expect(await count(db, `select count(*) n from public.customer_deposits where org_id = $1`, [t.org])).toBe(1);
    expect(await count(db, `select count(*) n from public.invoices where org_id = $1`, [t.org])).toBe(1);
    expect(await balance(db, t.acct.DEP)).toBe(-20_000);
  });

  it('final invoice: the COLLECTED deposit is applied through the existing apply flow', async () => {
    const depInvoice = (await eventRow(db, depEvent)).invoice_id!;
    // Customer pays the deposit invoice.
    await recordCustomerPayment(sb, {
      orgId: t.org, customerId: t.cust, locationId: t.loc, paymentDate: '2026-06-05', amountCents: 20_000,
      method: 'ACH', applications: [{ invoice_id: depInvoice, amount_cents: 20_000 }],
    });
    // The billing that reaches the contract value (100,000) is the final one.
    const id = await enqueue(db, t.org, 'JOB_BILLING', billing(t, { lines: [{ description: 'Complete', amount_cents: 100_000, item_id: null }] }));
    await processBillingEvents(sb, t.org);
    const ack = await eventRow(db, id);
    expect(ack.status).toBe('processed');
    expect(ack.ack_meta?.deposit_errors).toBeUndefined();
    expect((ack.ack_meta?.applied_deposits as unknown[] | undefined)?.length).toBe(1);
    const fin = (await db.query<{ amount_paid_cents: number; balance_cents: number }>(`select amount_paid_cents::int, balance_cents::int from public.invoices where id = $1`, [ack.invoice_id])).rows[0];
    expect(fin).toEqual({ amount_paid_cents: 20_000, balance_cents: 80_000 });
    expect(await balance(db, t.acct.DEP)).toBe(0);
    const dep = (await db.query<{ status: string; applied_cents: number }>(`select status, applied_cents::int from public.customer_deposits where org_id = $1`, [t.org])).rows[0];
    expect(dep).toEqual({ status: 'APPLIED', applied_cents: 20_000 });
    // AR: 20k deposit invoice billed and paid (0) + 100k final − 20k applied = 80k.
    expect(await balance(db, t.acct.AR)).toBe(80_000);
  });

  it('an UNPAID deposit is not applied at the final invoice (it stays HELD)', async () => {
    const u = await seedTenant(db, { projects: true, shortCode: 'DPU', contractCents: 50_000 });
    await enqueue(db, u.org, 'JOB_DEPOSIT_REQUEST', {
      job_id: u.job, location_id: u.loc, customer_id: u.cust, amount_cents: 10_000, memo: null,
      occurred_on: '2026-06-01', source_ref: `pm:deposit:${crypto.randomUUID()}`, schema_version: 1,
    }, '2026-06-01');
    await processDepositRequestEvents(sb, u.org);
    await enqueue(db, u.org, 'JOB_BILLING', billing(u, { lines: [{ description: 'All', amount_cents: 50_000, item_id: null }] }));
    await processBillingEvents(sb, u.org);
    expect((await db.query<{ status: string }>(`select status from public.customer_deposits where org_id = $1`, [u.org])).rows[0].status).toBe('HELD');
    expect(await balance(db, u.acct.DEP)).toBe(-10_000);
  });
});

// ── Migration 173 itself ─────────────────────────────────────────────────────
describe('migration 173 — idempotent; backfill + seam-version data step', () => {
  it('re-applies cleanly, backfills source_ref from the event, and advertises v2 for existing Projects orgs', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'M73' });
    // An invoice issued by the pre-173 consumer: source_event_id set, no source_ref.
    const ev = await enqueue(db, t.org, 'JOB_BILLING', billing(t, { source_ref: 'pm:bill:legacy' }));
    await db.query(
      `insert into public.invoices (org_id, location_id, customer_id, invoice_number, invoice_date, due_date, source_event_id)
       values ($1, $2, $3, 'INV-LEGACY-1', '2026-06-15', '2026-07-15', $4)`, [t.org, t.loc, t.cust, ev]);
    // An org that had Projects switched on before the trigger existed.
    await db.exec(`alter table core.organizations disable trigger trg_m173_books_seam_version`);
    await db.query(`update core.organizations set entitlements = '{"books": true, "projects": true}'::jsonb where id = $1`, [t.org]);
    await db.exec(`alter table core.organizations enable trigger trg_m173_books_seam_version`);
    expect((await db.query<{ v: number }>(`select pm.books_seam_version($1) v`, [t.org])).rows[0].v).toBe(1);

    await applyMigrationFile(db, '173_projects_seam_billing_v2.sql');

    const inv = await db.query<{ source_ref: string }>(`select source_ref from public.invoices where invoice_number = 'INV-LEGACY-1' and org_id = $1`, [t.org]);
    expect(inv.rows[0].source_ref).toBe('pm:bill:legacy');
    expect((await db.query<{ v: number }>(`select pm.books_seam_version($1) v`, [t.org])).rows[0].v).toBe(2);
    // Books never lowers a higher advertised version.
    await db.query(`update core.organizations set entitlements = entitlements || '{"books_seam_version": 3}'::jsonb where id = $1`, [t.org]);
    expect((await db.query<{ v: number }>(`select pm.books_seam_version($1) v`, [t.org])).rows[0].v).toBe(3);
  });
});
