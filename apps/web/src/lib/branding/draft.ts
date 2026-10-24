/**
 * The Settings → Brand editor's state, as pure functions (so the preview the owner sees
 * and the payload the server validates come from the same place).
 */

import { isHex } from './color';
import { MERIT_PALETTE, contrastReport, type BrandPalette, type ContrastReport } from './palette';
import { BRAND_FONT_STACKS, type BrandFont, type BrandProfile, type PaletteSource, type ResolvedBrand } from './types';
import type { SaveBrandInput } from './schema';

export interface BrandDraft {
  use_tenant_brand: boolean;
  logo_url: string | null;
  logo_dark_url: string | null;
  mark_url: string | null;
  palette: BrandPalette;
  font: BrandFont;
  palette_source: PaletteSource;
  extracted_colors: string[];
}

/** A draft from the saved row; with no row, start from what the scope shows today. */
export function draftFromProfile(p: BrandProfile | null, showing: ResolvedBrand | null): BrandDraft {
  if (p) {
    return {
      use_tenant_brand: p.use_tenant_brand,
      logo_url: p.logo_url,
      logo_dark_url: p.logo_dark_url,
      mark_url: p.mark_url,
      palette: { ...p.palette },
      font: p.font,
      palette_source: p.palette_source,
      extracted_colors: [...p.extracted_colors],
    };
  }
  return {
    use_tenant_brand: true,
    logo_url: null,
    logo_dark_url: null,
    mark_url: null,
    palette: { ...(showing?.palette ?? MERIT_PALETTE) },
    font: showing?.font ?? 'DM_SANS',
    palette_source: 'derived',
    extracted_colors: [],
  };
}

export function draftsEqual(a: BrandDraft, b: BrandDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every colour field is a valid #RRGGBB. */
export function paletteErrors(p: BrandPalette): Partial<Record<keyof BrandPalette, string>> {
  const out: Partial<Record<keyof BrandPalette, string>> = {};
  for (const [k, v] of Object.entries(p) as Array<[keyof BrandPalette, string]>) {
    if (!isHex(v)) out[k] = 'Use a colour like #2563EB';
  }
  return out;
}

export function draftReport(d: BrandDraft): ContrastReport {
  return contrastReport(d.palette);
}

/** Can this draft be saved? (the server re-checks the same rules) */
export function draftIsSavable(d: BrandDraft, kind: 'tenant' | 'company'): boolean {
  if (kind === 'company' && d.use_tenant_brand) return true;
  return Object.keys(paletteErrors(d.palette)).length === 0 && draftReport(d).ok;
}

/**
 * What the surfaces will show if this draft is saved: a company that uses the tenant brand
 * shows the tenant's; otherwise the draft, with empty logo slots falling back to the
 * tenant's (same rule as lib/branding/resolve.ts pickBrand).
 */
export function previewBrand(d: BrandDraft, kind: 'tenant' | 'company', tenant: ResolvedBrand): ResolvedBrand {
  if (kind === 'company' && d.use_tenant_brand) return tenant;
  const fallback = kind === 'company' && tenant.source !== 'MERIT_DEFAULT' ? tenant : null;
  const palette = Object.keys(paletteErrors(d.palette)).length ? tenant.palette : d.palette;
  return {
    source: kind === 'company' ? 'COMPANY' : 'TENANT',
    logoUrl: d.logo_url ?? fallback?.logoUrl ?? null,
    logoDarkUrl: d.logo_dark_url ?? fallback?.logoDarkUrl ?? null,
    markUrl: d.mark_url ?? fallback?.markUrl ?? null,
    palette,
    font: d.font,
    fontStack: BRAND_FONT_STACKS[d.font],
  };
}

export function draftToPayload(d: BrandDraft, locationId: string | null): SaveBrandInput {
  return {
    location_id: locationId,
    use_tenant_brand: locationId ? d.use_tenant_brand : true,
    logo_url: d.logo_url,
    logo_dark_url: d.logo_dark_url,
    mark_url: d.mark_url,
    palette: d.palette,
    font: d.font,
    palette_source: d.palette_source,
    extracted_colors: d.extracted_colors.filter(isHex).slice(0, 12),
  };
}
