/**
 * Guard: the event-driven JOB_BILLING → invoice/AR path (services/billing-consumer.ts).
 *
 * Since migration 173 the consumer is a thin adapter over the standard invoice creator,
 * so these run against a REAL Postgres (PGlite migration replay + the pm chain) through
 * a service-role-like client (test/pg-supabase.ts) — the GL balance / numbering triggers,
 * the claim RPC and the unique indexes are the real ones. The seam-v2 cases (retainage,
 * deposits, version rejection, business-key exactly-once) live in test/projects-seam.test.ts.
 *
 *   rev-rec parity   AS_BILLED → Revenue · a deferral method → Deferred Revenue (2410, by
 *                    role) · a per-job override beats the company default
 *   per-event org    one drain over two tenants books each under its OWN org
 *   M5 / wave 2G     concurrent drains → one invoice; a lapsed claim books nothing; the
 *                    new owner finalizes from the invoice a previous drain booked
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { processBillingEvents, type BillingPayload } from './billing-consumer';
import type { ClaimedEvent } from '@/lib/events/claim';
import { balance, count, enqueue, eventRow, seamDb, seedTenant, type Tenant } from '@/test/seam-fixture';

let db: PGlite;
let sb: SupabaseClient;

beforeAll(async () => {
  ({ db, sb } = await seamDb());
}, 300_000);

afterAll(async () => {
  await db?.close();
});

const AMOUNT = 100_000;
let refSeq = 0;
const payload = (t: Tenant): Record<string, unknown> => ({
  job_id: t.job, location_id: t.loc, billing_type: 'PROGRESS', occurred_on: '2026-06-15',
  source_ref: `ref-${++refSeq}`, memo: null,
  lines: [{ description: 'Framing', amount_cents: AMOUNT, item_id: null }],
});

describe('billing-consumer — rev-rec routing parity with the manual path', () => {
  it('(a) AS_BILLED recognizes at billing → GL credits Revenue (not deferred)', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'BCA', revRec: 'AS_BILLED' });
    await enqueue(db, t.org, 'JOB_BILLING', payload(t));
    const res = await processBillingEvents(sb, t.org);
    expect(res).toMatchObject({ processed: 1, rejected: 0 });
    expect(await balance(db, t.acct.AR)).toBe(AMOUNT);
    expect(await balance(db, t.acct.REV)).toBe(-AMOUNT);
    expect(await balance(db, t.acct.DEF)).toBe(0);
    // The invoice line references the revenue account, not the deferred liability.
    const line = await db.query<{ account_id: string }>(`select account_id from public.invoice_lines where org_id = $1`, [t.org]);
    expect(line.rows[0].account_id).toBe(t.acct.REV);
  });

  it('(b) a deferral method (PCT_COSTS_INCURRED) → GL credits Deferred Revenue (2410)', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'BCB', revRec: 'PCT_COSTS_INCURRED' });
    await enqueue(db, t.org, 'JOB_BILLING', payload(t));
    expect(await processBillingEvents(sb, t.org)).toMatchObject({ processed: 1, rejected: 0 });
    expect(await balance(db, t.acct.DEF)).toBe(-AMOUNT);
    expect(await balance(db, t.acct.REV)).toBe(0);
  });

  it('(c) a per-job override beats the company default', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'BCC', revRec: 'PCT_COSTS_INCURRED', jobOverride: 'POINT_OF_SALE' });
    await enqueue(db, t.org, 'JOB_BILLING', payload(t));
    expect(await processBillingEvents(sb, t.org)).toMatchObject({ processed: 1, rejected: 0 });
    expect(await balance(db, t.acct.REV)).toBe(-AMOUNT);
    expect(await balance(db, t.acct.DEF)).toBe(0);
  });
});

// ── Per-event org resolution (gate #9 / cross-tenant posting) ──────────────────
describe('billing-consumer — per-event org resolution (no cross-tenant posting)', () => {
  it('drains two tenants in one pass and books each event under its OWN org', async () => {
    const A = await seedTenant(db, { projects: true, shortCode: 'PEA' });
    const B = await seedTenant(db, { projects: true, shortCode: 'PEB' });
    const ea = await enqueue(db, A.org, 'JOB_BILLING', payload(A));
    const eb = await enqueue(db, B.org, 'JOB_BILLING', payload(B));
    // No org argument → drain ALL tenants; per-event org_id drives every write.
    await processBillingEvents(sb);
    expect((await eventRow(db, ea)).status).toBe('processed');
    expect((await eventRow(db, eb)).status).toBe('processed');
    expect(await balance(db, B.acct.REV)).toBe(-AMOUNT);
    expect(await balance(db, B.acct.AR)).toBe(AMOUNT);
    expect(await balance(db, A.acct.REV)).toBe(-AMOUNT);
    // Nothing of org B's posted against org A's accounts (or the reverse).
    expect(await count(db, `select count(*) n from public.gl_entry_lines where org_id = $1 and account_id = any($2::uuid[])`, [B.org, [A.acct.AR, A.acct.REV]])).toBe(0);
    expect(await count(db, `select count(*) n from public.invoices where org_id = $1`, [B.org])).toBe(1);
  });
});

// ── M5: atomic claim (migration 167) ───────────────────────────────────────────
describe('billing-consumer — concurrent drains claim disjoint batches (M5)', () => {
  it('two concurrent drains issue exactly one invoice for one pending event', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'M5A' });
    const id = await enqueue(db, t.org, 'JOB_BILLING', payload(t));
    const [a, b] = await Promise.all([processBillingEvents(sb, t.org), processBillingEvents(sb, t.org)]);
    expect(a.processed + b.processed).toBe(1);
    expect(await count(db, `select count(*) n from public.invoices where org_id = $1`, [t.org])).toBe(1);
    expect(await count(db, `select count(*) n from public.gl_entries where org_id = $1`, [t.org])).toBe(1);
    expect((await eventRow(db, id)).status).toBe('processed');
  });

  it('a pre-claimed batch is left to its owner (a fresh drain finds nothing to do)', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'M5B' });
    const id = await enqueue(db, t.org, 'JOB_BILLING', payload(t));
    await db.query(`update core.events set claimed_by = 'scheduler:other', claimed_at = now() where id = $1`, [id]);
    const res = await processBillingEvents(sb, t.org);
    expect(res.processed).toBe(0);
    expect(await count(db, `select count(*) n from public.invoices where org_id = $1`, [t.org])).toBe(0);
  });
});

// ── Wave 2G: a lapsed lease can't double-finalize ──────────────────────────────
describe('billing-consumer — claim renewal + claim-conditional finalize (wave 2G)', () => {
  async function claimedRow(id: string): Promise<ClaimedEvent<BillingPayload>> {
    const r = await db.query<ClaimedEvent<BillingPayload>>(
      `select id, event_id, org_id, event_type, source_module, payload, occurred_on::text, created_at::text, claimed_by from core.events where id = $1`, [id]);
    return r.rows[0];
  }

  it('a drain whose claim was taken over books nothing and finalizes nothing', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'G2A' });
    const id = await enqueue(db, t.org, 'JOB_BILLING', payload(t));
    const ev = await claimedRow(id);
    // The lease lapsed: drain B reclaimed the row; drain A still holds its stale batch.
    await db.query(`update core.events set claimed_by = 'drain:B', claimed_at = now() where id = $1`, [id]);
    const res = await processBillingEvents(sb, t.org, { claimed: { token: 'drain:A', rows: [ev] } });
    expect(res).toMatchObject({ processed: 0, rejected: 0, skipped: 1 });
    expect(await count(db, `select count(*) n from public.invoices where org_id = $1`, [t.org])).toBe(0);
    const row = await db.query<{ status: string; claimed_by: string }>(`select status, claimed_by from core.events where id = $1`, [id]);
    expect(row.rows[0]).toEqual({ status: 'pending', claimed_by: 'drain:B' });
  });

  it('the new owner finalizes from the invoice a previous drain already booked — no second invoice', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'G2B' });
    const id = await enqueue(db, t.org, 'JOB_BILLING', payload(t));
    await processBillingEvents(sb, t.org);
    const first = await eventRow(db, id);
    // The previous drain booked it but died before finalizing.
    await db.query(`update core.events set status = 'pending', invoice_id = null, invoice_number = null, gl_entry_id = null, claimed_by = null, claimed_at = null where id = $1`, [id]);
    const res = await processBillingEvents(sb, t.org);
    expect(res).toMatchObject({ processed: 1, rejected: 0 });
    expect(await count(db, `select count(*) n from public.invoices where org_id = $1`, [t.org])).toBe(1);
    expect(await count(db, `select count(*) n from public.gl_entries where org_id = $1`, [t.org])).toBe(1);
    expect(await eventRow(db, id)).toMatchObject({ status: 'processed', invoice_id: first.invoice_id, gl_entry_id: first.gl_entry_id });
  });

  it('stamps the source event + business key on the invoice and the GL entry (the DB unique guarantors)', async () => {
    const t = await seedTenant(db, { projects: true, shortCode: 'G2C' });
    const p = payload(t);
    const id = await enqueue(db, t.org, 'JOB_BILLING', p);
    await processBillingEvents(sb, t.org);
    const inv = await db.query<{ source_event_id: string; source_ref: string }>(`select source_event_id, source_ref from public.invoices where org_id = $1`, [t.org]);
    expect(inv.rows[0]).toEqual({ source_event_id: id, source_ref: p.source_ref });
    const gl = await db.query<{ source_ref: string }>(`select source_ref from public.gl_entries where org_id = $1`, [t.org]);
    expect(gl.rows[0].source_ref).toBe(`job_billing:${String(p.source_ref)}`);
  });
});
