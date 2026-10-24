/**
 * Brand profiles (migration 190, FPB-branding §6). Pure types + row parsing, shared by the
 * resolver, the routes, the settings screen and every customer-facing renderer.
 */

import { isHex, onColorFor } from './color';
import { MERIT_PALETTE, PALETTE_ROLES, type BrandPalette, type ContrastReport } from './palette';
import { tenantLogoOrNull } from '@/lib/invoices/templates/logo-url';

export const BRAND_FONTS = ['DM_SANS', 'SYSTEM', 'SERIF'] as const;
export type BrandFont = (typeof BRAND_FONTS)[number];

export const BRAND_FONT_LABELS: Record<BrandFont, string> = {
  DM_SANS: 'DM Sans',
  SYSTEM: 'System sans',
  SERIF: 'Serif',
};

/** CSS / email font stacks — safe, no font download required beyond DM Sans (already shipped). */
export const BRAND_FONT_STACKS: Record<BrandFont, string> = {
  DM_SANS: "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
  SYSTEM: "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif",
  SERIF: "Georgia,'Times New Roman',Times,serif",
};

/** The two built-in PDF faces (deterministic bytes, no network fetch). */
export function pdfFontFor(font: BrandFont): 'SANS' | 'SERIF' {
  return font === 'SERIF' ? 'SERIF' : 'SANS';
}

export type PaletteSource = 'derived' | 'manual';
export type LogoSlot = 'logo' | 'logo_dark' | 'mark';
export const LOGO_SLOTS: readonly LogoSlot[] = ['logo', 'logo_dark', 'mark'];

/** One saved brand_profiles row, parsed. */
export interface BrandProfile {
  id: string | null;
  org_id: string | null;
  /** null = the tenant brand. */
  location_id: string | null;
  use_tenant_brand: boolean;
  logo_url: string | null;
  logo_dark_url: string | null;
  mark_url: string | null;
  palette: BrandPalette;
  font: BrandFont;
  palette_source: PaletteSource;
  extracted_colors: string[];
  contrast_report: ContrastReport | null;
  updated_by: string | null;
  updated_at: string | null;
}

export type BrandSource = 'COMPANY' | 'TENANT' | 'MERIT_DEFAULT';

/** What a renderer uses — always fully populated. */
export interface ResolvedBrand {
  source: BrandSource;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  markUrl: string | null;
  palette: BrandPalette;
  font: BrandFont;
  fontStack: string;
}

/** Rule 11: matches migration 190 exactly. */
export const BRAND_SELECT =
  'id, org_id, location_id, use_tenant_brand, logo_url, logo_dark_url, mark_url, primary_color, secondary_color, ' +
  'accent_color, ink_color, surface_color, on_primary_color, font, palette_source, extracted_colors, contrast_report, ' +
  'updated_by, updated_at';

export const MERIT_DEFAULT_BRAND: ResolvedBrand = {
  source: 'MERIT_DEFAULT',
  logoUrl: null,
  logoDarkUrl: null,
  markUrl: null,
  palette: MERIT_PALETTE,
  font: 'DM_SANS',
  fontStack: BRAND_FONT_STACKS.DM_SANS,
};

const hexOr = (v: unknown, d: string) => (isHex(v) ? v.toUpperCase() : d);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const isFont = (v: unknown): v is BrandFont => typeof v === 'string' && (BRAND_FONTS as readonly string[]).includes(v);

/** A DB row (any PostgREST shape) → a profile. Logos that are not the org's own upload are dropped. */
export function brandFromRow(row: Record<string, unknown> | null | undefined): BrandProfile | null {
  if (!row) return null;
  const orgId = typeof row.org_id === 'string' ? row.org_id : null;
  const primary = hexOr(row.primary_color, MERIT_PALETTE.primary);
  const palette: BrandPalette = {
    primary,
    secondary: hexOr(row.secondary_color, MERIT_PALETTE.secondary),
    accent: hexOr(row.accent_color, MERIT_PALETTE.accent),
    ink: hexOr(row.ink_color, MERIT_PALETTE.ink),
    surface: hexOr(row.surface_color, MERIT_PALETTE.surface),
    on_primary: isHex(row.on_primary_color) ? (row.on_primary_color as string).toUpperCase() : onColorFor(primary),
  };
  const report = row.contrast_report && typeof row.contrast_report === 'object' && !Array.isArray(row.contrast_report)
    && Array.isArray((row.contrast_report as { checks?: unknown }).checks)
    ? (row.contrast_report as ContrastReport)
    : null;
  return {
    id: typeof row.id === 'string' ? row.id : null,
    org_id: orgId,
    location_id: typeof row.location_id === 'string' ? row.location_id : null,
    use_tenant_brand: row.use_tenant_brand !== false,
    logo_url: tenantLogoOrNull(str(row.logo_url), orgId),
    logo_dark_url: tenantLogoOrNull(str(row.logo_dark_url), orgId),
    mark_url: tenantLogoOrNull(str(row.mark_url), orgId),
    palette,
    font: isFont(row.font) ? row.font : 'DM_SANS',
    palette_source: row.palette_source === 'manual' ? 'manual' : 'derived',
    extracted_colors: Array.isArray(row.extracted_colors) ? (row.extracted_colors as unknown[]).filter(isHex).slice(0, 12) : [],
    contrast_report: report,
    updated_by: str(row.updated_by),
    updated_at: str(row.updated_at),
  };
}

/** Palette → DB columns. */
export function paletteColumns(p: BrandPalette): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of PALETTE_ROLES) out[`${role}_color`] = p[role].toUpperCase();
  return out;
}

/**
 * CSS custom properties for a customer-facing page (and — later — the full white-label
 * token override of merit-ui: map --electric / --signal from these, FPB §4.1).
 */
export function brandCssVars(b: ResolvedBrand): Record<string, string> {
  return {
    '--brand': b.palette.primary,
    '--on-brand': b.palette.on_primary,
    '--brand-2': b.palette.secondary,
    '--brand-accent': b.palette.accent,
    '--brand-ink': b.palette.ink,
    '--brand-surface': b.palette.surface,
    '--brand-font': b.fontStack,
  };
}
