/**
 * Brand profile reads + writes (FPB-branding §8). brand_profiles is SELECT-only for
 * members (migration 190): every write goes through the service role AFTER the route's
 * settings_system:edit check, with org_id pinned to the session org and the company
 * asserted in the caller's client scope (lib/db/scoped-writer).
 *
 * The server never trusts the browser's contrast report: it re-validates every colour,
 * recomputes the report, and refuses a palette whose required checks fail.
 *
 * After a successful replace / reset, the logo objects the row no longer uses are deleted
 * from storage (best-effort, logged) — unless any brand profile, invoice template or check
 * stock in the org still references them.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { assertWriteScope, isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { BRANDING_BUCKET, isTenantLogoUrl, LOGO_URL_ERROR } from '@/lib/invoices/templates/logo-url';
import { orphanedLogoPaths } from './logo-upload';
import { ratioLabel } from './color';
import { contrastReport, type ContrastReport } from './palette';
import { pickBrand } from './resolve';
import { BRAND_SELECT, brandFromRow, paletteColumns, type BrandProfile, type ResolvedBrand } from './types';
import type { SaveBrandInput } from './schema';

export class BrandError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: Record<string, string>) {
    super(message);
    this.name = 'BrandError';
  }
}

export interface BrandWriteCtx {
  /** The caller's member (RLS) client — used for the client-scope check. */
  caller: SupabaseClient;
  orgId: string;
  userId: string;
  /** Test seam: a service-role stand-in. */
  writer?: SupabaseClient | null;
}

/** Validate a save: logos must be this org's own uploads; the palette must pass AA. */
export function validateBrandInput(orgId: string, input: SaveBrandInput): ContrastReport {
  for (const [k, v] of [['logo_url', input.logo_url], ['logo_dark_url', input.logo_dark_url], ['mark_url', input.mark_url]] as const) {
    if (v && !isTenantLogoUrl(v, orgId)) throw new BrandError(LOGO_URL_ERROR, 422, 'LOGO_URL_NOT_ALLOWED', { [k]: LOGO_URL_ERROR });
  }
  const report = contrastReport(input.palette);
  if (!report.ok) {
    const failing = report.checks.filter((c) => c.required && !c.pass);
    const details: Record<string, string> = {};
    for (const c of failing) details[c.id] = `${c.label}: ${ratioLabel(c.ratio)} — needs ${c.min}:1`;
    throw new BrandError(
      `These colours are hard to read: ${failing.map((c) => c.label.toLowerCase()).join('; ')}. Use “Fix contrast” or pick darker colours.`,
      422,
      'CONTRAST_TOO_LOW',
      details,
    );
  }
  return report;
}

async function loadRow(w: SupabaseClient, orgId: string, locationId: string | null): Promise<BrandProfile | null> {
  let q = w.from('brand_profiles').select(BRAND_SELECT).eq('org_id', orgId);
  q = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
  const { data, error } = await q.maybeSingle();
  if (error) throw new BrandError(error.message, 500, 'LOAD_FAILED');
  return brandFromRow(data as unknown as Record<string, unknown> | null);
}

const logoUrlsOf = (p: Pick<BrandProfile, 'logo_url' | 'logo_dark_url' | 'mark_url'> | null | undefined): Array<string | null> =>
  p ? [p.logo_url, p.logo_dark_url, p.mark_url] : [];

/** Every logo URL any row in the org still points at (brand profiles, invoice templates, check stock). */
async function referencedLogoUrls(w: SupabaseClient, orgId: string): Promise<string[]> {
  const [brands, templates, stock] = await Promise.all([
    w.from('brand_profiles').select('logo_url, logo_dark_url, mark_url').eq('org_id', orgId),
    w.from('invoice_templates').select('logo_url').eq('org_id', orgId),
    w.from('check_stock_profiles').select('logo_url').eq('org_id', orgId),
  ]);
  // A failed reference read must NOT read as "unreferenced" — refuse to delete anything.
  for (const r of [brands, templates, stock]) if (r.error) throw new Error(`reference check: ${r.error.message}`);
  const out: string[] = [];
  for (const r of (brands.data ?? []) as Array<Record<string, string | null>>) out.push(...[r.logo_url, r.logo_dark_url, r.mark_url].filter((u): u is string => !!u));
  for (const r of [...((templates.data ?? []) as Array<{ logo_url: string | null }>), ...((stock.data ?? []) as Array<{ logo_url: string | null }>)]) {
    if (r.logo_url) out.push(r.logo_url);
  }
  return out;
}

/**
 * Best-effort: delete the brand-logo objects `before` held that `after` no longer does and
 * nothing in the org references. Never throws (the save already succeeded); returns the
 * removed paths (for tests / logging).
 */
export async function deleteReplacedLogos(
  w: SupabaseClient,
  orgId: string,
  before: ReadonlyArray<string | null | undefined>,
  after: ReadonlyArray<string | null | undefined>,
): Promise<string[]> {
  try {
    if (!before.some(Boolean)) return [];
    const storage = (w as { storage?: SupabaseClient['storage'] }).storage;
    if (!storage || typeof storage.from !== 'function') return [];
    const paths = orphanedLogoPaths(before, after, await referencedLogoUrls(w, orgId), orgId);
    if (paths.length === 0) return [];
    const { error } = await storage.from(BRANDING_BUCKET).remove(paths);
    if (error) {
      console.warn('[brand] replaced-logo delete failed (non-fatal):', error.message, paths);
      return [];
    }
    console.info('[brand] deleted replaced logo objects', { orgId, paths });
    return paths;
  } catch (e) {
    console.warn('[brand] replaced-logo cleanup skipped (non-fatal):', e instanceof Error ? e.message : e);
    return [];
  }
}

/** Create or replace the tenant brand (location_id null) or one company's brand. */
export async function saveBrand(ctx: BrandWriteCtx, input: SaveBrandInput): Promise<BrandProfile> {
  const report = validateBrandInput(ctx.orgId, input);
  await assertWriteScope(ctx.caller, ctx.orgId, [input.location_id], { writer: ctx.writer });
  const w = serviceWriter(ctx.writer);
  const row = {
    use_tenant_brand: input.location_id ? input.use_tenant_brand : true,
    logo_url: input.logo_url,
    logo_dark_url: input.logo_dark_url,
    mark_url: input.mark_url,
    ...paletteColumns(input.palette),
    font: input.font,
    palette_source: input.palette_source,
    extracted_colors: input.extracted_colors,
    contrast_report: report,
    updated_by: ctx.userId,
    updated_at: new Date().toISOString(),
  };
  const existing = await loadRow(w, ctx.orgId, input.location_id);
  const res = existing?.id
    ? await w.from('brand_profiles').update(row).eq('org_id', ctx.orgId).eq('id', existing.id).select(BRAND_SELECT).single()
    : await w.from('brand_profiles').insert({ ...row, org_id: ctx.orgId, location_id: input.location_id }).select(BRAND_SELECT).single();
  if (res.error) throw new BrandError(res.error.message, 500, existing ? 'UPDATE_FAILED' : 'INSERT_FAILED');
  const saved = brandFromRow(res.data as unknown as Record<string, unknown>);
  if (!saved) throw new BrandError('The brand could not be saved.', 500, 'SAVE_FAILED');
  await deleteReplacedLogos(w, ctx.orgId, logoUrlsOf(existing), [row.logo_url, row.logo_dark_url, row.mark_url]);
  return saved;
}

/** Remove a brand row (tenant → back to the Merit default; company → back to the tenant brand). */
export async function deleteBrand(ctx: BrandWriteCtx, locationId: string | null): Promise<void> {
  await assertWriteScope(ctx.caller, ctx.orgId, [locationId], { writer: ctx.writer });
  const w = serviceWriter(ctx.writer);
  const existing = await loadRow(w, ctx.orgId, locationId);
  let q = w.from('brand_profiles').delete().eq('org_id', ctx.orgId);
  q = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
  const { error } = await q;
  if (error) throw new BrandError(error.message, 500, 'DELETE_FAILED');
  await deleteReplacedLogos(w, ctx.orgId, logoUrlsOf(existing), []);
}

export interface CompanyBrandRow {
  locationId: string;
  name: string;
  shortCode: string | null;
  profile: BrandProfile | null;
  resolved: ResolvedBrand;
}

export interface BrandOverview {
  orgName: string;
  tenant: BrandProfile | null;
  tenantResolved: ResolvedBrand;
  companies: CompanyBrandRow[];
}

/** Everything Settings → Brand shows, read through the caller's RLS client. */
export async function loadBrandOverview(db: SupabaseClient, orgId: string): Promise<BrandOverview> {
  const [org, locs, rows] = await Promise.all([
    db.schema('core').from('organizations').select('name').eq('id', orgId).maybeSingle(),
    db.schema('core').from('locations').select('id, name, short_code').eq('org_id', orgId).eq('is_active', true).order('name'),
    db.from('brand_profiles').select(BRAND_SELECT).eq('org_id', orgId),
  ]);
  if (locs.error) throw new BrandError(locs.error.message, 500, 'LOAD_FAILED');
  if (rows.error) throw new BrandError(rows.error.message, 500, 'LOAD_FAILED');
  const profiles = ((rows.data ?? []) as unknown as Record<string, unknown>[])
    .map(brandFromRow)
    .filter((p): p is BrandProfile => !!p);
  const tenant = profiles.find((p) => p.location_id === null) ?? null;
  const companies = ((locs.data ?? []) as Array<{ id: string; name: string; short_code: string | null }>).map((l) => {
    const profile = profiles.find((p) => p.location_id === l.id) ?? null;
    return { locationId: l.id, name: l.name, shortCode: l.short_code, profile, resolved: pickBrand(tenant, profile) };
  });
  return {
    orgName: ((org.data as { name?: string } | null)?.name ?? '').trim() || 'Your organization',
    tenant,
    tenantResolved: pickBrand(tenant, null),
    companies,
  };
}

export function brandErrorResponse(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (e instanceof BrandError) return { status: e.status, body: { error: e.message, code: e.code, details: e.details } };
  if (isWriteScopeError(e)) return { status: 403, body: { error: e.message, code: 'FORBIDDEN_SCOPE' } };
  return null;
}
