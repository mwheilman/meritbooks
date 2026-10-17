/**
 * Tenant brand — the white-label identity layer.
 *
 * MeritBooks is resold white-label; Merit Management Group is simply the first
 * tenant, so its brand (Feb 2026 Style Guide) ships as the DEFAULT. Nothing in a
 * component may hard-code "Merit" or a brand hex: components read identity from
 * this object (name, monogram, logo) and color/type from CSS variables
 * (`globals.css :root`), which Tailwind consumes via `rgb(var(--…) / <alpha>)`.
 *
 * To re-skin for another tenant you change ONLY this layer:
 *   1. supply a `TenantBrand` (name / monogram / optional logo src / colors), and
 *   2. render `brandCssVars(brand)` as an inline `style` on <html> (root layout),
 *      which overrides the default `:root` color tokens.
 * Fonts are bound via next/font in `app/layout.tsx` to `--font-display`,
 * `--font-sans`, `--font-mono`; a tenant swaps families there.
 *
 * Keep `DEFAULT_TENANT_BRAND.colors` in sync with the `:root` defaults in
 * `styles/globals.css` (the CSS file is the no-JS fallback; this object feeds
 * the SVG monogram / favicon, Clerk's appearance, and per-tenant overrides).
 */

export interface TenantBrandColors {
  /** Dark sections, app shell (sidebar/header), headlines. Merit "Navy / Midnight". */
  navy: string;
  /** The one accent: primary buttons, links, active nav, focus rings. Merit "Electric Blue". */
  accent: string;
  /** Accent hover on dark (navy) surfaces. Merit "Signal Blue". */
  accentBright: string;
  /** Accent pressed / hover-fill on light surfaces (keeps white text ≥ AA). */
  accentStrong: string;
  /** Deepest accent, for emphasized accent text. */
  accentDeep: string;
  /** Tags, badges, selected-row wash. Merit "Blue Wash / Sky". */
  accentWash: string;
  /** Page background. Merit "Warm White". */
  background: string;
  /** Alt background, insets, table headers. Merit "Surface / Canvas". */
  canvas: string;
  /** Body copy. Merit "Body Text / Steel". */
  body: string;
  /** Captions, metadata. Merit "Muted / Slate". */
  muted: string;
}

export interface TenantBrand {
  /** Product name shown in the shell, titles, and wordmark (e.g. "MeritBooks"). */
  productName: string;
  /** Single glyph drawn in the monogram tile when no logo file is supplied. */
  monogram: string;
  /** Optional raster/SVG logo for this tenant; when present it replaces the generated monogram. */
  logoSrc?: string;
  /** One-line descriptor used on auth screens and metadata. */
  tagline: string;
  colors: TenantBrandColors;
}

export const DEFAULT_TENANT_BRAND: TenantBrand = {
  productName: 'MeritBooks',
  monogram: 'M',
  tagline: 'The book of record for multi-entity finance teams',
  colors: {
    navy: '#0A1628',
    accent: '#2563EB',
    accentBright: '#3B82F6',
    accentStrong: '#1D4ED8',
    accentDeep: '#1E40AF',
    accentWash: '#EBF2FE',
    background: '#FDFCFA',
    canvas: '#F5F3EF',
    body: '#3D4F65',
    muted: '#8494A7',
  },
};

/** The brand in effect. Single-tenant today; resolve per-tenant here when white-label ships. */
export function getTenantBrand(): TenantBrand {
  return DEFAULT_TENANT_BRAND;
}

/** "#2563EB" → "37 99 235" (the channel format Tailwind's <alpha-value> needs). */
export function hexToChannels(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/**
 * CSS custom-property overrides for a tenant. Spread onto <html style>. Returns
 * only the brand-owned tokens; neutrals/status colors stay system-owned so a
 * tenant can't accidentally break ledger semantics or contrast.
 */
export function brandCssVars(brand: TenantBrand): Record<string, string> {
  const c = brand.colors;
  return {
    '--brand-navy': hexToChannels(c.navy),
    '--brand-accent': hexToChannels(c.accent),
    '--brand-accent-bright': hexToChannels(c.accentBright),
    '--brand-accent-strong': hexToChannels(c.accentStrong),
    '--brand-accent-deep': hexToChannels(c.accentDeep),
    '--brand-wash': hexToChannels(c.accentWash),
    '--bg': hexToChannels(c.background),
    '--canvas': hexToChannels(c.canvas),
    '--ink': hexToChannels(c.body),
    '--ink-dim': hexToChannels(c.muted),
  };
}
