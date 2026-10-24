/**
 * Brand from logo (migration 190, FPB-branding) against the REAL schema (PGlite replay):
 *
 *   AC-9  brand_profiles: RLS on, members SELECT-only (and only their own org), one tenant
 *         row per org / one row per company, hex + font CHECKs; invoice_templates.inherit_brand
 *         defaults true; the migration is idempotent.
 *   AC-5  inheritance through the DB-backed resolver: company → tenant → Merit default.
 *   AC-6/7 every customer-facing renderer reads the resolved brand: the invoice doc / PDF /
 *         email, statements + estimates (loadBrandTemplate), dunning letter, request email;
 *         a template that opted out keeps its own colour; another tenant never sees it.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderToBuffer } from '@react-pdf/renderer';
import { applyMigrationFile, createTestDb, listMigrationFiles } from './pg';
import { pgSupabase } from './pg-supabase';
import { seedTenant, type Tenant } from './seam-fixture';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { InvoicePdf } from '@/lib/invoices/invoice-pdf';
import { buildInvoiceEmail } from '@/lib/invoices/invoice-email';
import { loadBrandTemplate } from '@/lib/invoices/templates/resolve';
import { buildRequestEmail } from '@/lib/notify/request-email';
import { brandedLetterHtml, emailBrandOf } from '@/lib/branding/email';
import { loadBrand } from '@/lib/branding/resolve';
import { deleteBrand, loadBrandOverview, saveBrand } from '@/lib/branding/service';
import { saveBrandSchema } from '@/lib/branding/schema';
import type { BrandPalette } from '@/lib/branding/palette';

const SUPA = 'https://brand.supabase.co';
const GREEN: BrandPalette = { primary: '#15803D', secondary: '#14532D', accent: '#B45309', ink: '#102A1A', surface: '#F0FDF4', on_primary: '#FFFFFF' };
const RED: BrandPalette = { primary: '#B91C1C', secondary: '#7F1D1D', accent: '#1D4ED8', ink: '#1F0A0A', surface: '#FEF2F2', on_primary: '#FFFFFF' };

let db: PGlite;
let sb: SupabaseClient;
let t: Tenant;
let other: Tenant;
let invoiceId: string;

const logo = (org: string, f: string) => `${SUPA}/storage/v1/object/public/branding/${org}/${f}`;
const ctx = () => ({ caller: sb, orgId: t.org, userId: 'user_brand_admin', writer: sb });

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Every RGB colour (`r g b rg` / `r g b scn`) in the PDF's content streams, as 0–255 triples. */
function pdfFills(buf: Uint8Array | Buffer): Array<[number, number, number]> {
  const bin = Buffer.from(buf).toString('latin1');
  const out: Array<[number, number, number]> = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin))) {
    const start = m.index + m[0].length;
    const end = bin.indexOf('endstream', start);
    if (end < 0) break;
    let content: string;
    try {
      content = zlib.inflateSync(Buffer.from(bin.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const f of content.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(?:rg|scn|sc)\b/g)) {
      out.push([Number(f[1]) * 255, Number(f[2]) * 255, Number(f[3]) * 255]);
    }
  }
  return out;
}

function hasFill(buf: Uint8Array | Buffer, hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return pdfFills(buf).some(([x, y, z]) => Math.abs(x - r) < 2 && Math.abs(y - g) < 2 && Math.abs(z - b) < 2);
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPA;
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  sb = pgSupabase(db);
  t = await seedTenant(db, { projects: false, shortCode: 'BRD' });
  other = await seedTenant(db, { projects: false, shortCode: 'BRO' });
  invoiceId = crypto.randomUUID();
  await db.query(
    `insert into public.invoices (id, org_id, location_id, customer_id, invoice_number, invoice_date, due_date,
       subtotal_cents, tax_cents, total_cents, status, terms)
     values ($1, $2, $3, $4, 'INV-BRD-0001', '2026-06-01', '2026-07-01', 50000, 0, 50000, 'SENT', 'NET_30')`,
    [invoiceId, t.org, t.loc, t.cust]);
  await db.query(
    `insert into public.invoice_lines (org_id, invoice_id, line_number, description, account_id, quantity, unit_price_cents, amount_cents)
     values ($1, $2, 1, 'Design work', $3, 1, 50000, 50000)`,
    [t.org, invoiceId, t.acct.REV]);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('AC-9 — schema, RLS and grants (migration 190)', () => {
  it('brand_profiles has RLS on, members may SELECT only, service writes', async () => {
    const r = await db.query<{ rls: boolean; sel: boolean; ins: boolean; upd: boolean; del: boolean; anon_sel: boolean; svc_ins: boolean }>(
      `select c.relrowsecurity rls,
              has_table_privilege('authenticated', c.oid, 'SELECT') sel,
              has_table_privilege('authenticated', c.oid, 'INSERT') ins,
              has_table_privilege('authenticated', c.oid, 'UPDATE') upd,
              has_table_privilege('authenticated', c.oid, 'DELETE') del,
              has_table_privilege('anon', c.oid, 'SELECT') anon_sel,
              has_table_privilege('service_role', c.oid, 'INSERT') svc_ins
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'brand_profiles'`);
    expect(r.rows[0]).toEqual({ rls: true, sel: true, ins: false, upd: false, del: false, anon_sel: false, svc_ins: true });
  });

  it('a member cannot write over PostgREST; reads only their own org', async () => {
    await db.query(`insert into public.brand_profiles (org_id, location_id, primary_color) values ($1, null, '#15803D'), ($2, null, '#B91C1C')`, [t.org, other.org]);
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: 'member', org_id: t.org, role: 'authenticated' })]);
    await db.exec('set role authenticated');
    try {
      expect(await errorOf(`insert into public.brand_profiles (org_id) values ($1)`, [t.org])).toMatch(/permission denied/);
      expect(await errorOf(`update public.brand_profiles set primary_color = '#000000'`)).toMatch(/permission denied/);
      const seen = await db.query<{ org_id: string }>(`select org_id from public.brand_profiles`);
      expect(seen.rows.map((x) => x.org_id)).toEqual([t.org]);
    } finally {
      await db.exec('reset role');
      await db.query(`select set_config('request.jwt.claims', '{}', false)`);
      await db.query(`delete from public.brand_profiles where org_id in ($1, $2)`, [t.org, other.org]);
    }
  });

  it('one tenant row per org, one row per company; CHECKs refuse bad colours and fonts', async () => {
    await db.query(`insert into public.brand_profiles (org_id, location_id) values ($1, null)`, [t.org]);
    expect(await errorOf(`insert into public.brand_profiles (org_id, location_id) values ($1, null)`, [t.org])).toMatch(/duplicate key|unique/);
    await db.query(`insert into public.brand_profiles (org_id, location_id) values ($1, $2)`, [t.org, t.loc]);
    expect(await errorOf(`insert into public.brand_profiles (org_id, location_id) values ($1, $2)`, [t.org, t.loc])).toMatch(/duplicate key|unique/);
    expect(await errorOf(`insert into public.brand_profiles (org_id, location_id, primary_color) values ($1, $2, 'red')`, [other.org, other.loc])).toMatch(/brand_profiles_colors_chk/);
    expect(await errorOf(`insert into public.brand_profiles (org_id, location_id, font) values ($1, $2, 'COMIC')`, [other.org, other.loc])).toMatch(/brand_profiles_font_chk/);
    await db.query(`delete from public.brand_profiles where org_id = $1`, [t.org]);
  });

  it('invoice_templates.inherit_brand exists and defaults to true; 190 re-applies cleanly', async () => {
    const r = await db.query<{ column_default: string; is_nullable: string }>(
      `select column_default, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'invoice_templates' and column_name = 'inherit_brand'`);
    expect(r.rows[0]).toEqual({ column_default: 'true', is_nullable: 'NO' });
    const f = listMigrationFiles().find((x) => x.startsWith('190_'))!;
    await applyMigrationFile(db, f);
    await applyMigrationFile(db, f);
  });
});

describe('AC-5/6/7 — the resolved brand reaches every customer-facing renderer', () => {
  it('no brand: the invoice prints the template colour (Merit Electric Blue)', async () => {
    const doc = await loadInvoiceDocById(sb, t.org, invoiceId);
    expect(doc!.brand!.source).toBe('MERIT_DEFAULT');
    expect(doc!.template.accent_color).toBe('#2563EB');
  });

  it('tenant brand → invoice doc, PDF and email wear it', async () => {
    await saveBrand(ctx(), saveBrandSchema.parse({ location_id: null, palette: GREEN, logo_url: logo(t.org, 'brand-org-logo-1.png'), font: 'SERIF' }));
    const doc = (await loadInvoiceDocById(sb, t.org, invoiceId))!;
    expect(doc.brand!.source).toBe('TENANT');
    expect(doc.template.accent_color).toBe(GREEN.primary);
    expect(doc.template.logo_url).toBe(logo(t.org, 'brand-org-logo-1.png'));
    expect(doc.template.font).toBe('SERIF');

    const html = buildInvoiceEmail(doc, 'https://pay.test/x').html;
    expect(html).toContain(`background:${GREEN.primary}`);
    expect(html).toContain(logo(t.org, 'brand-org-logo-1.png'));
    expect(html).toContain('Georgia'); // the serif stack

    // The PDF never fetches the logo in this harness: drop it, keep the colour.
    const buf = await renderToBuffer(InvoicePdf({ doc: { ...doc, template: { ...doc.template, logo_url: null } } }));
    expect(hasFill(buf, GREEN.primary)).toBe(true);
    expect(hasFill(buf, '#2563EB')).toBe(false);
  });

  it('a company with its own brand overrides the tenant; switching back restores the tenant', async () => {
    await saveBrand(ctx(), saveBrandSchema.parse({ location_id: t.loc, use_tenant_brand: false, palette: RED }));
    let doc = (await loadInvoiceDocById(sb, t.org, invoiceId))!;
    expect(doc.brand!.source).toBe('COMPANY');
    expect(doc.template.accent_color).toBe(RED.primary);
    // empty company logo slot → the tenant's logo
    expect(doc.template.logo_url).toBe(logo(t.org, 'brand-org-logo-1.png'));

    await saveBrand(ctx(), saveBrandSchema.parse({ location_id: t.loc, use_tenant_brand: true, palette: RED }));
    doc = (await loadInvoiceDocById(sb, t.org, invoiceId))!;
    expect(doc.template.accent_color).toBe(GREEN.primary);

    await saveBrand(ctx(), saveBrandSchema.parse({ location_id: t.loc, use_tenant_brand: false, palette: RED }));
    await deleteBrand(ctx(), t.loc);
    doc = (await loadInvoiceDocById(sb, t.org, invoiceId))!;
    expect(doc.brand!.source).toBe('TENANT');
  });

  it('a template that opted out of the brand keeps its own colour', async () => {
    const id = crypto.randomUUID();
    await db.query(
      `insert into public.invoice_templates (id, org_id, location_id, name, is_default, accent_color, inherit_brand)
       values ($1, $2, $3, 'Own look', true, '#7C3AED', false)`, [id, t.org, t.loc]);
    const doc = (await loadInvoiceDocById(sb, t.org, invoiceId))!;
    expect(doc.template.accent_color).toBe('#7C3AED');
    await db.query(`update public.invoice_templates set inherit_brand = true where id = $1`, [id]);
    expect((await loadInvoiceDocById(sb, t.org, invoiceId))!.template.accent_color).toBe(GREEN.primary);
    await db.query(`delete from public.invoice_templates where id = $1`, [id]);
  });

  it('statements / estimates (loadBrandTemplate), dunning and request emails read the same brand', async () => {
    expect((await loadBrandTemplate(sb, t.org, t.loc)).accent_color).toBe(GREEN.primary);
    const brand = await loadBrand(sb, t.org, t.loc);
    const eb = emailBrandOf(brand);
    expect(eb).not.toBeNull();

    const letter = brandedLetterHtml({ bodyText: 'Hello,\n\nInvoice 1 is past due.', senderName: 'Co BRD', accent: '#2563EB', brand: eb, cta: { url: 'https://pay.test/1', label: 'Pay online' } });
    expect(letter).toContain(`background:${GREEN.primary}`);
    expect(letter).toContain(logo(t.org, 'brand-org-logo-1.png'));

    const req = buildRequestEmail({
      senderName: 'Co BRD', recipientName: 'Pat Vendor', kind: 'w9', title: 'Your W-9', message: null, step: 1,
      dueDate: null, ctaUrl: 'https://app.test/r/x', unsubscribeUrl: 'https://app.test/r/x/unsubscribe', brand: eb,
    });
    expect(req.html).toContain(`background:${GREEN.primary}`);
    expect(req.html).toContain(logo(t.org, 'brand-org-logo-1.png'));
    // Without a brand the Merit request look (Electric button) is unchanged.
    const plain = buildRequestEmail({
      senderName: 'Co BRD', recipientName: null, kind: 'w9', title: 'Your W-9', message: null, step: 1,
      dueDate: null, ctaUrl: 'https://app.test/r/x', unsubscribeUrl: 'https://app.test/r/x/unsubscribe',
    });
    expect(plain.html).toContain('background:#2563EB');
    expect(plain.html).not.toContain(GREEN.primary);
  });

  it('another tenant never sees this brand', async () => {
    const b = await loadBrand(sb, other.org, other.loc);
    expect(b.source).toBe('MERIT_DEFAULT');
    expect((await loadBrandTemplate(sb, other.org, other.loc)).accent_color).toBe('#2563EB');
  });

  it('the overview lists the tenant + each company with what it resolves to; the server recomputed contrast', async () => {
    const ov = await loadBrandOverview(sb, t.org);
    expect(ov.tenant?.palette.primary).toBe(GREEN.primary);
    expect(ov.tenant?.contrast_report?.ok).toBe(true);
    const co = ov.companies.find((c) => c.locationId === t.loc)!;
    expect(co.resolved.source).toBe('TENANT');
  });

  it('save refuses another org’s logo and an unreadable palette (nothing written)', async () => {
    await expect(saveBrand(ctx(), saveBrandSchema.parse({ location_id: null, palette: GREEN, logo_url: logo(other.org, 'brand-org-logo-1.png') }))).rejects.toThrow(/Upload the logo here/);
    await expect(saveBrand(ctx(), saveBrandSchema.parse({ location_id: null, palette: { ...GREEN, primary: '#FDE047' } }))).rejects.toThrow(/hard to read/);
    expect((await loadBrand(sb, t.org, null)).palette.primary).toBe(GREEN.primary);
  });

  it('save refuses a company from another org', async () => {
    await expect(saveBrand(ctx(), saveBrandSchema.parse({ location_id: other.loc, use_tenant_brand: false, palette: RED }))).rejects.toThrow(/not part of this organization/);
  });
});
