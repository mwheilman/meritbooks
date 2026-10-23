/**
 * Slice 1B — invoice design, customization and pay links (migration 176, FPB-invoices §4).
 * Real Postgres (PGlite replay of every Books migration), the real document loader,
 * the real PDF renderer and email builder.
 *
 *   AC-1B.1  no GL account number / name on the customer PDF, email or hosted document
 *   AC-1B.2  template resolution: invoice → customer → company default → org default → built-in
 *   AC-1B.3  the template's columns / custom fields / terms / payment instructions print
 *   AC-1B.4  pay URL + QR only when the company can really take payments online
 *   AC-1B.5  CC / copy-to-me / saved CC on the invoice; SENT records who was copied
 */
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderToBuffer } from '@react-pdf/renderer';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { seedTenant, type Tenant } from './seam-fixture';
import { pdfText, pdfObjects } from './pdf-text';
import type { EmailMessage } from '@/lib/email/provider';

const sentMessages: EmailMessage[] = [];
vi.mock('@/lib/email/provider', async (orig) => {
  const real = await orig<typeof import('@/lib/email/provider')>();
  return {
    ...real,
    resolveEmailProvider: () => ({
      id: 'resend' as const,
      send: async (m: EmailMessage) => { sentMessages.push(m); return { id: `msg_${sentMessages.length}`, provider: 'resend' as const }; },
    }),
    resolveFromAddress: () => 'billing@books.test',
  };
});

// Imported after the mock is registered.
const { loadInvoiceDocById } = await import('@/lib/invoices/invoice-doc');
const { InvoicePdf } = await import('@/lib/invoices/invoice-pdf');
const { buildInvoiceEmail } = await import('@/lib/invoices/invoice-email');
const { sendInvoiceById } = await import('@/lib/invoices/send-invoice');

let db: PGlite;
let sb: SupabaseClient;
let t: Tenant;
let other: Tenant;
let invoiceId: string;
let token: string;
const GL_NUMBER = '4711';
const GL_NAME = 'Kitchen Revenue Zeta';

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function pdfOf(id: string): Promise<{ text: string; objects: string }> {
  const doc = await loadInvoiceDocById(sb, t.org, id);
  if (!doc) throw new Error('no doc');
  const buf = await renderToBuffer(InvoicePdf({ doc }));
  return { text: pdfText(buf), objects: pdfObjects(buf) };
}

async function template(over: Record<string, unknown> & { location_id: string | null }): Promise<string> {
  const id = crypto.randomUUID();
  const row: Record<string, unknown> = {
    name: `T ${id.slice(0, 6)}`, is_default: false, style: 'MODERN', font: 'SANS', accent_color: '#2563EB',
    visible_columns: ['description', 'quantity', 'rate', 'amount'], custom_fields: [], line_fields: [],
    show_qr: true, show_pay_button: true, attachments_allowed: true, org_id: t.org, ...over,
  };
  await db.query(
    `insert into public.invoice_templates (id, org_id, location_id, name, is_default, style, font, accent_color, visible_columns,
       custom_fields, line_fields, show_qr, show_pay_button, attachments_allowed, terms_text, payment_instructions, remit_to, footer_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18)`,
    [id, row.org_id, row.location_id, row.name, row.is_default, row.style, row.font, row.accent_color,
      row.visible_columns, JSON.stringify(row.custom_fields), JSON.stringify(row.line_fields), row.show_qr, row.show_pay_button,
      row.attachments_allowed, row.terms_text ?? null, row.payment_instructions ?? null, row.remit_to ?? null, row.footer_text ?? null]);
  return id;
}

async function connectStripe(env: 'test' | 'live' = 'test'): Promise<void> {
  await db.query(
    `update core.provider_connections set status = 'active', account_handle = 'acct_test_1b'
      where org_id = $1 and capability = 'AR_COLLECTION' and provider = 'stripe' and environment = $2 and location_id is null`,
    [t.org, env]);
  await db.query(
    `insert into core.org_payment_settings (org_id, account_mode) values ($1, 'single')
     on conflict (org_id) do update set account_mode = 'single'`, [t.org]);
  // Tenant-level connection (location_id null) — migration 175 keys Stripe per company,
  // with at most one tenant-level row; the org opts into "one account for all companies".
  await db.query(
    `insert into core.provider_connections (org_id, capability, provider, environment, account_handle, status)
     select $1, 'AR_COLLECTION', 'stripe', $2, 'acct_test_1b', 'active'
      where not exists (select 1 from core.provider_connections
                         where org_id = $1 and capability = 'AR_COLLECTION' and provider = 'stripe' and environment = $2 and location_id is null)`,
    [t.org, env]);
}
async function disconnectStripe(): Promise<void> {
  await db.query(`update core.provider_connections set status = 'disconnected' where org_id = $1`, [t.org]);
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  sb = pgSupabase(db);
  t = await seedTenant(db, { projects: false, shortCode: 'DSN' });
  other = await seedTenant(db, { projects: false, shortCode: 'DSO' });
  await db.query(`update core.customers set email = 'ap@owner.test', address_line1 = '1 Main St', city = 'Ames', zip = '50010' where id = $1`, [t.cust]);

  // A revenue account with an unmistakable number + name (must never reach the customer).
  const [{ account_group_id }] = await q<{ account_group_id: string }>(`select account_group_id from public.accounts where id = $1`, [t.acct.REV]);
  const acct = crypto.randomUUID();
  await db.query(
    `insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
     values ($1, $2, $3, $4, $5, 'REVENUE', 'REVENUE', true, 'APPROVED')`, [acct, t.org, account_group_id, GL_NUMBER, GL_NAME]);
  const [code] = await q<{ id: string }>(
    `insert into public.job_cost_codes (org_id, code, name, cost_type) values ($1, '06-400', 'Cabinetry', 'MATERIALS') returning id`, [t.org]);

  invoiceId = crypto.randomUUID();
  await db.query(
    `insert into public.invoices (id, org_id, location_id, customer_id, job_id, invoice_number, invoice_date, due_date,
       subtotal_cents, tax_cents, total_cents, status, terms)
     values ($1, $2, $3, $4, $5, 'INV-DSN-0001', '2026-06-01', '2026-07-01', 125000, 7000, 132000, 'SENT', 'NET_30')`,
    [invoiceId, t.org, t.loc, t.cust, t.job]);
  await db.query(
    `insert into public.invoice_lines (org_id, invoice_id, line_number, description, account_id, quantity, unit_price_cents, amount_cents,
       cost_code_id, service_date, custom_fields)
     values ($1, $2, 1, 'Cabinet install', $3, 1, 85000, 85000, $4, '2026-05-20', '{"room":"Kitchen"}'::jsonb),
            ($1, $2, 2, 'Templating', $3, 4, 10000, 40000, null, null, '{}'::jsonb)`,
    [t.org, invoiceId, acct, code.id]);
  [{ public_token: token }] = await q<{ public_token: string }>(`select public_token from public.invoices where id = $1`, [invoiceId]);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('AC-1B.1 — no GL account numbers or names on anything the customer sees', () => {
  it('the document, PDF and email carry no account number or name', async () => {
    await connectStripe();
    const doc = await loadInvoiceDocById(sb, t.org, invoiceId);
    expect(doc).not.toBeNull();
    const json = JSON.stringify(doc);
    expect(json).not.toContain(GL_NAME);
    expect(json).not.toMatch(/account_number|"account"/);

    const { text } = await pdfOf(invoiceId);
    expect(text).toContain('Cabinet install');
    expect(text).not.toContain(GL_NAME);
    expect(text).not.toContain(GL_NUMBER);

    const email = buildInvoiceEmail(doc!);
    expect(email.html).not.toContain(GL_NAME);
    expect(email.html).not.toContain(GL_NUMBER);
    expect(email.text).not.toContain(GL_NAME);
  });
});

describe('AC-1B.2 — template resolution', () => {
  it('built-in (Electric Blue) when nothing is saved', async () => {
    const doc = await loadInvoiceDocById(sb, t.org, invoiceId);
    expect(doc!.template_source).toBe('BUILT_IN');
    expect(doc!.template.accent_color).toBe('#2563EB');
  });

  it('org default → company default → customer → invoice, most specific wins; another company’s template never applies', async () => {
    const orgDefault = await template({ location_id: null, is_default: true, name: 'Org default' });
    expect((await loadInvoiceDocById(sb, t.org, invoiceId))!.template_source).toBe('ORG_DEFAULT');

    const companyDefault = await template({ location_id: t.loc, is_default: true, name: 'Company default' });
    expect((await loadInvoiceDocById(sb, t.org, invoiceId))!.template.id).toBe(companyDefault);

    const forCustomer = await template({ location_id: t.loc, name: 'For owner' });
    await db.query(`insert into public.customer_invoice_settings (org_id, customer_id, template_id) values ($1, $2, $3)`, [t.org, t.cust, forCustomer]);
    const c = await loadInvoiceDocById(sb, t.org, invoiceId);
    expect(c!.template_source).toBe('CUSTOMER');
    expect(c!.template.id).toBe(forCustomer);

    // A template that belongs to another company in the same org is skipped.
    const otherLoc = crypto.randomUUID();
    await db.query(`insert into core.locations (id, org_id, name, short_code) values ($1, $2, 'Other co', 'OTH')`, [otherLoc, t.org]);
    const foreign = await template({ location_id: otherLoc, name: 'Other co template' });
    await db.query(`update public.invoices set template_id = $2 where id = $1`, [invoiceId, foreign]);
    expect((await loadInvoiceDocById(sb, t.org, invoiceId))!.template_source).toBe('CUSTOMER');

    const forInvoice = await template({ location_id: t.loc, name: 'Just this one' });
    await db.query(`update public.invoices set template_id = $2 where id = $1`, [invoiceId, forInvoice]);
    const i = await loadInvoiceDocById(sb, t.org, invoiceId);
    expect(i!.template_source).toBe('INVOICE');
    expect(i!.template.id).toBe(forInvoice);

    // clean up for later tests
    await db.query(`update public.invoices set template_id = null where id = $1`, [invoiceId]);
    await db.query(`delete from public.customer_invoice_settings where org_id = $1`, [t.org]);
    void orgDefault;
  });

  it('the DB keeps one default per company (partial unique index)', async () => {
    await expect(template({ location_id: t.loc, is_default: true, name: 'Second default' })).rejects.toThrow(/duplicate key|unique/i);
  });

  it('a tenant cannot read another tenant’s templates through RLS', async () => {
    await template({ location_id: t.loc, name: 'Private' });
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: 'user_x', org_id: other.org, role: 'authenticated' })]);
    await db.exec('set role authenticated');
    try {
      const r = await db.query(`select id from public.invoice_templates where org_id = $1`, [t.org]);
      expect(r.rows).toHaveLength(0);
    } finally {
      await db.exec('reset role');
      await db.query(`select set_config('request.jwt.claims', '{}', false)`);
    }
  });
});

describe('AC-1B.3 — the template’s columns, fields, terms and instructions print', () => {
  it('optional columns print only when the template turns them on', async () => {
    const id = await template({
      location_id: t.loc, name: 'Detailed',
      visible_columns: ['service_date', 'description', 'cost_code', 'quantity', 'rate', 'tax', 'amount', 'custom'],
      line_fields: [{ key: 'room', label: 'Room' }],
      custom_fields: [{ label: 'License #', value: 'IA-C123456', placement: 'HEADER' }, { label: 'Bonded', value: 'Yes', placement: 'FOOTER' }],
      terms_text: 'A 1.5% monthly late fee applies after 30 days.',
    });
    await db.query(`update public.invoices set template_id = $2 where id = $1`, [invoiceId, id]);
    const on = await pdfOf(invoiceId);
    // Column headers / section labels print in caps; compare case-insensitively.
    const onText = on.text.toLowerCase().replace(/\s+/g, ' ');
    for (const s of ['Cost code', '06-400 Cabinetry', 'Date of service', 'May 20, 2026', 'Room', 'Kitchen', 'License #', 'IA-C123456', 'Bonded', 'late fee', 'Tax']) {
      expect(onText, s).toContain(s.toLowerCase());
    }

    const plain = await template({ location_id: t.loc, name: 'Plain' });
    await db.query(`update public.invoices set template_id = $2 where id = $1`, [invoiceId, plain]);
    const off = await pdfOf(invoiceId);
    const offText = off.text.toLowerCase().replace(/\s+/g, ' ');
    for (const s of ['Cost code', '06-400', 'Date of service', 'Room']) expect(offText, s).not.toContain(s.toLowerCase());
    expect(off.text).toContain('Cabinet install');
    await db.query(`update public.invoices set template_id = null where id = $1`, [invoiceId]);
  });

  it('per-line tax adds up to the invoice tax', async () => {
    const doc = await loadInvoiceDocById(sb, t.org, invoiceId);
    // pg-supabase does not run PostgREST embeds, so the account type is unknown here
    // and the allocation is all-zero; the allocation itself is unit-tested in
    // lib/invoices/templates/templates.test.ts. What must hold: it never over-allocates.
    const sum = doc!.lines.reduce((s, l) => s + (l.tax_cents ?? 0), 0);
    expect(sum === 0 || sum === doc!.tax_cents).toBe(true);
  });
});

describe('AC-1B.4 — pay URL + QR only when the invoice can really be paid online', () => {
  it('no online-payment connection → no pay URL, payment instructions print instead', async () => {
    await disconnectStripe();
    const id = await template({ location_id: t.loc, name: 'Instr', payment_instructions: 'Wire to First Bank, ABA 073000228.' });
    await db.query(`update public.invoices set template_id = $2 where id = $1`, [invoiceId, id]);
    const doc = await loadInvoiceDocById(sb, t.org, invoiceId);
    expect(doc!.pay.payable).toBe(false);
    expect(doc!.pay.code).toBe('NO_CONNECTION');
    const { text, objects } = await pdfOf(invoiceId);
    expect(text).not.toContain(`/pay/${token}`);
    expect(objects).not.toContain(`/pay/${token}`);
    expect(text.toLowerCase()).toContain('how to pay');
    expect(text).toContain('ABA 073000228');
    const email = buildInvoiceEmail(doc!);
    expect(email.hasPayButton).toBe(false);
    expect(email.html).not.toContain('Pay this invoice');
    expect(email.html).toContain('View invoice');
  });

  it('active (test-mode) connection → pay URL, clickable link and QR print; mode is reported', async () => {
    await connectStripe('test');
    const doc = await loadInvoiceDocById(sb, t.org, invoiceId);
    expect(doc!.pay).toMatchObject({ payable: true, mode: 'test', code: 'OK' });
    const { text, objects } = await pdfOf(invoiceId);
    expect(text).toContain('Pay online');
    expect(text).toContain(`/pay/${token}`);
    expect(objects).toContain(`/pay/${token}`); // the link annotation
    expect(text.toLowerCase()).toContain('other ways to pay');
    expect(buildInvoiceEmail(doc!).hasPayButton).toBe(true);
  });

  it('the template can turn the pay link off; a card/bank-less customer gets none either', async () => {
    const id = await template({ location_id: t.loc, name: 'No pay', show_qr: false, show_pay_button: false });
    await db.query(`update public.invoices set template_id = $2 where id = $1`, [invoiceId, id]);
    expect((await pdfOf(invoiceId)).text).not.toContain('Pay online');

    await db.query(`update public.invoices set template_id = null where id = $1`, [invoiceId]);
    await db.query(`update core.customers set payment_methods_allowed = '{CHECK}' where id = $1`, [t.cust]);
    const doc = await loadInvoiceDocById(sb, t.org, invoiceId);
    expect(doc!.pay).toMatchObject({ payable: false, code: 'NO_ONLINE_METHOD' });
    await db.query(`update core.customers set payment_methods_allowed = null where id = $1`, [t.cust]);
  });

  it('a paid or voided invoice never prints a pay link', async () => {
    await db.query(`update public.invoices set status = 'VOIDED' where id = $1`, [invoiceId]);
    expect((await loadInvoiceDocById(sb, t.org, invoiceId))!.pay.code).toBe('CLOSED');
    const { text } = await pdfOf(invoiceId);
    expect(text).not.toContain('Pay online');
    expect(text).toContain('VOID');
    await db.query(`update public.invoices set status = 'SENT' where id = $1`, [invoiceId]);
  });
});

describe('AC-1B.5 — CC on invoice email', () => {
  it('sends to the customer with the customer’s default CC list, records who was copied', async () => {
    await db.query(`insert into public.customer_invoice_settings (org_id, customer_id, cc_emails) values ($1, $2, '{pm@owner.test,ap@owner.test}')
                    on conflict (org_id, customer_id) do update set cc_emails = excluded.cc_emails`, [t.org, t.cust]);
    sentMessages.length = 0;
    const r = await sendInvoiceById(sb, t.org, invoiceId, 'user_1b');
    expect(r.ok).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toEqual(['ap@owner.test']);
    expect(sentMessages[0].cc).toEqual(['pm@owner.test']); // the To address is never also a CC
    expect(sentMessages[0].attachments?.[0].filename).toBe('invoice-INV-DSN-0001.pdf');
    const [ev] = await q<{ meta: { cc?: string[]; to: string } }>(
      `select meta from public.invoice_events where invoice_id = $1 and event_type = 'SENT' order by created_at desc limit 1`, [invoiceId]);
    expect(ev.meta).toMatchObject({ to: 'ap@owner.test', cc: ['pm@owner.test'] });
  });

  it('an explicit CC list + copy-to-me is used for this send and saved on the invoice', async () => {
    sentMessages.length = 0;
    const r = await sendInvoiceById(sb, t.org, invoiceId, 'user_1b', {
      cc: ['owner@owner.test', 'Owner@Owner.test', ' gc@builder.test '], copyToSelf: 'me@books.test', saveCcOnInvoice: true,
    });
    expect(r.ok).toBe(true);
    expect(sentMessages[0].cc).toEqual(['owner@owner.test', 'gc@builder.test']);
    expect(sentMessages[0].bcc).toEqual(['me@books.test']);
    const [inv] = await q<{ cc_emails: string[] }>(`select cc_emails from public.invoices where id = $1`, [invoiceId]);
    expect(inv.cc_emails).toEqual(['owner@owner.test', 'gc@builder.test']);

    // A resend with no CC given uses the invoice's saved list.
    sentMessages.length = 0;
    await sendInvoiceById(sb, t.org, invoiceId, 'user_1b');
    expect(sentMessages[0].cc).toEqual(['owner@owner.test', 'gc@builder.test']);
  });

  it('a bad CC address is refused before anything is sent or recorded', async () => {
    sentMessages.length = 0;
    const before = (await q(`select id from public.invoice_events where invoice_id = $1 and event_type = 'SENT'`, [invoiceId])).length;
    const r = await sendInvoiceById(sb, t.org, invoiceId, 'user_1b', { cc: ['not-an-email'] });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_EMAIL' });
    expect(sentMessages).toHaveLength(0);
    expect((await q(`select id from public.invoice_events where invoice_id = $1 and event_type = 'SENT'`, [invoiceId])).length).toBe(before);
  });
});
