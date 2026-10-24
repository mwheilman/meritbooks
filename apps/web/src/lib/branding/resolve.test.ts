/**
 * FPB-branding AC-5 (inheritance), AC-6 (templates inherit), AC-8 (upload / save
 * validation), AC-10 (shell brand) — pure functions, no DB.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { applyBrandToTemplate, pickBrand } from './resolve';
import { brandFromRow, MERIT_DEFAULT_BRAND, type BrandProfile } from './types';
import { MERIT_PALETTE, type BrandPalette } from './palette';
import { BrandError, validateBrandInput } from './service';
import { saveBrandSchema } from './schema';
import { brandLogoPath, validateLogoBytes } from './logo-upload';
import { shellBrandOf } from './shell';
import { draftFromProfile, draftIsSavable, draftToPayload, previewBrand } from './draft';
import { BUILT_IN_TEMPLATE, templateFromRow } from '@/lib/invoices/templates/types';
import { isTenantLogoUrl } from '@/lib/invoices/templates/logo-url';

const SUPA = 'https://abc.supabase.co';
const ORG = '11111111-1111-4111-8111-111111111111';
const LOC = '22222222-2222-4222-8222-222222222222';
const url = (f: string, org = ORG) => `${SUPA}/storage/v1/object/public/branding/${org}/${f}`;

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPA;
});

const GREEN: BrandPalette = { primary: '#15803D', secondary: '#14532D', accent: '#F59E0B', ink: '#102A1A', surface: '#F0FDF4', on_primary: '#FFFFFF' };
const RED: BrandPalette = { primary: '#B91C1C', secondary: '#7F1D1D', accent: '#2563EB', ink: '#1F0A0A', surface: '#FEF2F2', on_primary: '#FFFFFF' };

function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'r', org_id: ORG, location_id: null, use_tenant_brand: true,
    logo_url: null, logo_dark_url: null, mark_url: null,
    primary_color: GREEN.primary, secondary_color: GREEN.secondary, accent_color: GREEN.accent,
    ink_color: GREEN.ink, surface_color: GREEN.surface, on_primary_color: GREEN.on_primary,
    font: 'DM_SANS', palette_source: 'derived', extracted_colors: [], contrast_report: {},
    ...over,
  };
}

const tenant = (over: Record<string, unknown> = {}) => brandFromRow(row({ logo_url: url('brand-org-logo-1.png'), ...over })) as BrandProfile;
const company = (over: Record<string, unknown> = {}) =>
  brandFromRow(row({
    id: 'c', location_id: LOC, use_tenant_brand: false,
    primary_color: RED.primary, secondary_color: RED.secondary, accent_color: RED.accent,
    ink_color: RED.ink, surface_color: RED.surface, on_primary_color: RED.on_primary,
    ...over,
  })) as BrandProfile;

describe('brandFromRow', () => {
  it('drops a logo that is not the org’s own upload (SSRF guard)', () => {
    const p = brandFromRow(row({ logo_url: 'https://evil.example.com/x.png', mark_url: url('m.png', '99999999-9999-4999-8999-999999999999') }))!;
    expect(p.logo_url).toBeNull();
    expect(p.mark_url).toBeNull();
  });

  it('falls back to Merit colours for bad hex and computes on_primary', () => {
    const p = brandFromRow(row({ primary_color: 'red', on_primary_color: null }))!;
    expect(p.palette.primary).toBe(MERIT_PALETTE.primary);
    expect(p.palette.on_primary).toBe('#FFFFFF');
  });
});

describe('pickBrand — company → tenant → Merit default (AC-5)', () => {
  it('no rows → the Merit default', () => {
    expect(pickBrand(null, null)).toEqual(MERIT_DEFAULT_BRAND);
  });

  it('tenant only → the tenant brand', () => {
    const b = pickBrand(tenant(), null);
    expect(b.source).toBe('TENANT');
    expect(b.palette.primary).toBe(GREEN.primary);
    expect(b.logoUrl).toBe(url('brand-org-logo-1.png'));
  });

  it('company with its own brand → the company brand', () => {
    const b = pickBrand(tenant(), company());
    expect(b.source).toBe('COMPANY');
    expect(b.palette.primary).toBe(RED.primary);
  });

  it('company set to use the tenant brand → the tenant brand (its own row is kept, not used)', () => {
    const b = pickBrand(tenant(), company({ use_tenant_brand: true }));
    expect(b.source).toBe('TENANT');
    expect(b.palette.primary).toBe(GREEN.primary);
  });

  it('company’s empty logo slots fall back to the tenant’s logos', () => {
    const b = pickBrand(tenant({ logo_dark_url: url('brand-org-dark-1.png') }), company({ mark_url: url('brand-c-mark-1.png') }));
    expect(b.logoUrl).toBe(url('brand-org-logo-1.png'));
    expect(b.logoDarkUrl).toBe(url('brand-org-dark-1.png'));
    expect(b.markUrl).toBe(url('brand-c-mark-1.png'));
  });

  it('company brand with no tenant row → the company brand, no logo fallback', () => {
    const b = pickBrand(null, company());
    expect(b.source).toBe('COMPANY');
    expect(b.logoUrl).toBeNull();
  });
});

describe('applyBrandToTemplate (AC-6)', () => {
  const tpl = templateFromRow({ id: 't', org_id: ORG, location_id: LOC, name: 'Standard', accent_color: '#2563EB', font: 'SANS', inherit_brand: true });

  it('an inheriting template takes the brand’s logo, colour and font', () => {
    const out = applyBrandToTemplate(tpl, pickBrand(tenant({ font: 'SERIF' }), null));
    expect(out.accent_color).toBe(GREEN.primary);
    expect(out.logo_url).toBe(url('brand-org-logo-1.png'));
    expect(out.font).toBe('SERIF');
  });

  it('a template that opted out keeps its own look', () => {
    const own = { ...tpl, inherit_brand: false, accent_color: '#7C3AED' };
    expect(applyBrandToTemplate(own, pickBrand(tenant(), null))).toEqual(own);
  });

  it('with no brand (Merit default) the template prints unchanged', () => {
    const own = { ...tpl, accent_color: '#7C3AED' };
    expect(applyBrandToTemplate(own, MERIT_DEFAULT_BRAND)).toEqual(own);
  });

  it('a brand without a logo keeps the template’s own logo', () => {
    const withLogo = { ...tpl, logo_url: url('loc-1.png') };
    const out = applyBrandToTemplate(withLogo, pickBrand(tenant({ logo_url: null }), null));
    expect(out.logo_url).toBe(url('loc-1.png'));
    expect(out.accent_color).toBe(GREEN.primary);
  });

  it('the built-in template inherits', () => {
    expect(BUILT_IN_TEMPLATE.inherit_brand).toBe(true);
    expect(applyBrandToTemplate(BUILT_IN_TEMPLATE, pickBrand(null, company())).accent_color).toBe(RED.primary);
  });

  it('templateFromRow reads inherit_brand (default true when the column is absent)', () => {
    expect(templateFromRow({ id: 'x', name: 'A' }).inherit_brand).toBe(true);
    expect(templateFromRow({ id: 'x', name: 'A', inherit_brand: false }).inherit_brand).toBe(false);
  });
});

describe('validateBrandInput — the server re-checks everything (AC-3, AC-8)', () => {
  const base = () => saveBrandSchema.parse({ location_id: null, palette: GREEN, logo_url: url('brand-org-logo-1.png') });

  it('accepts the org’s own logos and an AA palette, and returns the recomputed report', () => {
    const rep = validateBrandInput(ORG, base());
    expect(rep.ok).toBe(true);
    expect(rep.checks.length).toBeGreaterThan(3);
  });

  it('refuses a logo URL that is not this org’s upload', () => {
    for (const bad of ['https://evil.example.com/logo.png', url('x.png', '99999999-9999-4999-8999-999999999999'), url('x.svg')]) {
      expect(() => validateBrandInput(ORG, { ...base(), logo_url: bad })).toThrow(BrandError);
    }
  });

  it('refuses a palette whose text would be unreadable, naming the failing pair', () => {
    try {
      validateBrandInput(ORG, { ...base(), palette: { ...GREEN, primary: '#FDE047', on_primary: '#FFFFFF' } });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BrandError);
      const be = e as BrandError;
      expect(be.code).toBe('CONTRAST_TOO_LOW');
      expect(Object.keys(be.details ?? {})).toEqual(expect.arrayContaining(['primary_on_white', 'on_primary']));
    }
  });

  it('the schema refuses non-hex colours and unknown fonts', () => {
    expect(saveBrandSchema.safeParse({ location_id: null, palette: { ...GREEN, primary: 'red' } }).success).toBe(false);
    expect(saveBrandSchema.safeParse({ location_id: null, palette: GREEN, font: 'COMIC' }).success).toBe(false);
    expect(saveBrandSchema.parse({ location_id: null, palette: { ...GREEN, primary: '#15803d' } }).palette.primary).toBe('#15803D');
  });
});

describe('logo upload checks (AC-8)', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const enc = (s: string) => new TextEncoder().encode(s);

  it('accepts PNG and JPEG by their bytes', () => {
    expect(validateLogoBytes(png)).toEqual({ ok: true, kind: 'png' });
    expect(validateLogoBytes(jpg)).toEqual({ ok: true, kind: 'jpeg' });
  });

  it('refuses SVG (with a clear reason), WebP, HTML, empty and oversized files', () => {
    const svg = validateLogoBytes(enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    expect(svg.ok).toBe(false);
    if (!svg.ok) expect(svg.error).toMatch(/SVG/);
    expect(validateLogoBytes(enc('RIFF....WEBPVP8 ')).ok).toBe(false);
    expect(validateLogoBytes(enc('<html><img src=x onerror=alert(1)></html>')).ok).toBe(false);
    expect(validateLogoBytes(new Uint8Array(0))).toMatchObject({ ok: false, code: 'EMPTY' });
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(png);
    expect(validateLogoBytes(big)).toMatchObject({ ok: false, code: 'TOO_LARGE' });
  });

  it('stores into the org folder in a shape the renderers accept', () => {
    for (const slot of ['logo', 'logo_dark', 'mark'] as const) {
      const p = brandLogoPath(ORG, LOC, slot, 'png', 1729800000000);
      expect(p.startsWith(`${ORG}/brand-`)).toBe(true);
      expect(isTenantLogoUrl(`${SUPA}/storage/v1/object/public/branding/${p}`, ORG, SUPA)).toBe(true);
      expect(isTenantLogoUrl(`${SUPA}/storage/v1/object/public/branding/${p}`, '99999999-9999-4999-8999-999999999999', SUPA)).toBe(false);
    }
    expect(brandLogoPath(ORG, null, 'logo', 'jpeg', 1)).toBe(`${ORG}/brand-org-logo-1.jpg`);
  });
});

describe('shell brand area (AC-10)', () => {
  it('nothing for the Merit default or a brand without a logo', () => {
    expect(shellBrandOf(MERIT_DEFAULT_BRAND, 'Acme')).toBeNull();
    expect(shellBrandOf(pickBrand(tenant({ logo_url: null }), null), 'Acme')).toBeNull();
  });

  it('prefers the dark-background logo on the Midnight rail; a light logo goes on a chip', () => {
    const light = shellBrandOf(pickBrand(tenant(), null), 'Acme')!;
    expect(light.onChip).toBe(true);
    expect(light.logoUrl).toBe(url('brand-org-logo-1.png'));
    const dark = shellBrandOf(pickBrand(tenant({ logo_dark_url: url('brand-org-dark-1.png') }), null), 'Acme')!;
    expect(dark.onChip).toBe(false);
    expect(dark.logoUrl).toBe(url('brand-org-dark-1.png'));
    expect(dark.accent).toBe(GREEN.primary);
  });
});

describe('editor draft (AC-11)', () => {
  it('a new tenant draft starts from what shows today; payload round-trips through the schema', () => {
    const d = draftFromProfile(null, MERIT_DEFAULT_BRAND);
    expect(d.palette).toEqual(MERIT_PALETTE);
    expect(draftIsSavable(d, 'tenant')).toBe(true);
    expect(saveBrandSchema.safeParse(draftToPayload(d, null)).success).toBe(true);
  });

  it('an unreadable palette cannot be saved; a company using the tenant brand always can', () => {
    const d = { ...draftFromProfile(null, MERIT_DEFAULT_BRAND), palette: { ...MERIT_PALETTE, primary: '#FDE047' } };
    expect(draftIsSavable(d, 'tenant')).toBe(false);
    expect(draftIsSavable({ ...d, use_tenant_brand: true }, 'company')).toBe(true);
  });

  it('preview: a company on the tenant brand shows the tenant brand; its own draft falls back to tenant logos', () => {
    const t = pickBrand(tenant(), null);
    const d = draftFromProfile(company(), t);
    expect(previewBrand({ ...d, use_tenant_brand: true }, 'company', t)).toBe(t);
    const own = previewBrand(d, 'company', t);
    expect(own.palette.primary).toBe(RED.primary);
    expect(own.logoUrl).toBe(t.logoUrl);
  });
});
