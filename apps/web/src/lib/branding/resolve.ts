/**
 * Which brand a customer-facing surface wears (FPB-branding §7) — ONE resolver for the
 * invoice PDF / email / pay page, statements, estimates, dunning, the customer and vendor
 * portals, request emails + magic-link pages, Merit Workforce and the shell brand area.
 *
 *   1. the company's own brand (brand_profiles row for the company, use_tenant_brand = false)
 *   2. the tenant brand (brand_profiles row with location_id null)
 *   3. the Merit default (Electric Blue, Midnight ink, DM Sans, no logo)
 *
 * A logo slot left empty on a company's own brand falls back to the tenant's logo for that
 * slot, so a company that only changes colours keeps the group logo.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InvoiceTemplate } from '@/lib/invoices/templates/types';
import {
  BRAND_FONT_STACKS,
  BRAND_SELECT,
  MERIT_DEFAULT_BRAND,
  brandFromRow,
  pdfFontFor,
  type BrandProfile,
  type ResolvedBrand,
} from './types';

function fromProfile(p: BrandProfile, source: 'COMPANY' | 'TENANT', fallback: BrandProfile | null): ResolvedBrand {
  return {
    source,
    logoUrl: p.logo_url ?? fallback?.logo_url ?? null,
    logoDarkUrl: p.logo_dark_url ?? fallback?.logo_dark_url ?? null,
    markUrl: p.mark_url ?? fallback?.mark_url ?? null,
    palette: p.palette,
    font: p.font,
    fontStack: BRAND_FONT_STACKS[p.font],
  };
}

/** Pure resolution over the (at most two) rows that can apply. */
export function pickBrand(tenant: BrandProfile | null, company: BrandProfile | null): ResolvedBrand {
  if (company && company.location_id && !company.use_tenant_brand) return fromProfile(company, 'COMPANY', tenant);
  if (tenant) return fromProfile(tenant, 'TENANT', null);
  return MERIT_DEFAULT_BRAND;
}

/** Load the tenant row + (optionally) the company row. Never throws: a failed read is the Merit default. */
export async function loadBrandProfiles(
  db: SupabaseClient,
  orgId: string,
  locationId: string | null,
): Promise<{ tenant: BrandProfile | null; company: BrandProfile | null }> {
  let q = db.from('brand_profiles').select(BRAND_SELECT).eq('org_id', orgId);
  q = locationId ? q.or(`location_id.is.null,location_id.eq.${locationId}`) : q.is('location_id', null);
  const { data, error } = await q;
  if (error) {
    // Before migration 190 is applied the table doesn't exist: render the Merit default.
    if (!/brand_profiles/.test(error.message ?? '')) console.error('[brand] load failed', error.message);
    return { tenant: null, company: null };
  }
  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).map(brandFromRow).filter((r): r is BrandProfile => !!r);
  return {
    tenant: rows.find((r) => r.location_id === null) ?? null,
    company: locationId ? rows.find((r) => r.location_id === locationId) ?? null : null,
  };
}

/** The resolved brand of a company (or of the tenant when `locationId` is null). */
export async function loadBrand(db: SupabaseClient, orgId: string, locationId: string | null): Promise<ResolvedBrand> {
  try {
    const { tenant, company } = await loadBrandProfiles(db, orgId, locationId);
    return pickBrand(tenant, company);
  } catch (e) {
    console.error('[brand] resolve failed', e);
    return MERIT_DEFAULT_BRAND;
  }
}

/** A tiny per-request memo for loops that resolve many companies (request dispatch, portals). */
export function brandCache(db: SupabaseClient, orgId: string): (locationId: string | null) => Promise<ResolvedBrand> {
  const m = new Map<string, Promise<ResolvedBrand>>();
  return (locationId) => {
    const k = locationId ?? '';
    let p = m.get(k);
    if (!p) {
      p = loadBrand(db, orgId, locationId);
      m.set(k, p);
    }
    return p;
  };
}

/**
 * The template as it prints under the company brand (FPB §4.3): when the template inherits
 * the brand AND a brand profile exists, its logo, accent and font come from the brand. A
 * template that switched inheritance off, or an org with no brand yet, prints unchanged.
 */
export function applyBrandToTemplate(t: InvoiceTemplate, brand: ResolvedBrand): InvoiceTemplate {
  if (!t.inherit_brand || brand.source === 'MERIT_DEFAULT') return t;
  return {
    ...t,
    logo_url: brand.logoUrl ?? t.logo_url,
    accent_color: brand.palette.primary,
    font: pdfFontFor(brand.font),
  };
}
