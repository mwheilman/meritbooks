/**
 * Product lockups (Style Guide §1.3). The product word is part of the logo —
 * always the kit's SVG file, never live HTML text.
 *
 * Aspect ratios are measured from the SVG viewBoxes in assets/lockups/ (they
 * are identical across the four colour variants). test/brand.test.ts re-reads
 * every file and fails if this table drifts.
 */

export type LockupModule =
  | 'merit'
  | 'books'
  | 'projects'
  | 'crm'
  | 'fpa'
  | 'hr'
  | 'inventory'
  | 'payroll'
  | 'platform';

export type LockupForm = 'horizontal' | 'vertical' | 'icon';

/** File suffix → background: full-color → Warm/white · on-dark → Midnight · white → Electric fills/photos · midnight → one-colour print. */
export type LockupVariant = 'on-dark' | 'midnight' | 'white' | 'full-color';

export const LOCKUP_VARIANTS: ReadonlyArray<LockupVariant> = ['on-dark', 'midnight', 'white', 'full-color'];

/** Written product names — two words, matching the lockup (§1.3 "Written name"). */
export const PRODUCT_NAMES: Readonly<Record<LockupModule, string>> = {
  merit: 'Merit',
  books: 'Merit Books',
  projects: 'Merit Projects',
  crm: 'Merit CRM',
  fpa: 'Merit FP&A',
  hr: 'Merit HR',
  inventory: 'Merit Inventory',
  payroll: 'Merit Payroll',
  platform: 'Merit Platform',
};

/** viewBox width × height of each lockup stem (variant suffix stripped). */
export const LOCKUP_VIEWBOX: Readonly<Record<string, { w: number; h: number }>> = {
  'merit-horizontal': { w: 399.4, h: 120 },
  'merit-vertical': { w: 257.35, h: 223.38 },
  'merit-icon': { w: 134.85, h: 120 },
  'merit-books-horizontal': { w: 705.96, h: 120 },
  'merit-books-vertical': { w: 588.77, h: 223.38 },
  'merit-crm-horizontal': { w: 655.07, h: 120 },
  'merit-crm-vertical': { w: 533.76, h: 223.38 },
  'merit-fpa-horizontal': { w: 682.48, h: 120 },
  'merit-fpa-vertical': { w: 563.39, h: 223.38 },
  'merit-hr-horizontal': { w: 561.15, h: 120 },
  'merit-hr-vertical': { w: 432.22, h: 223.38 },
  'merit-inventory-horizontal': { w: 857.69, h: 120 },
  'merit-inventory-vertical': { w: 752.8, h: 223.38 },
  'merit-payroll-horizontal': { w: 736.87, h: 120 },
  'merit-payroll-vertical': { w: 622.19, h: 223.38 },
  'merit-platform-horizontal': { w: 832.67, h: 120 },
  'merit-platform-vertical': { w: 725.76, h: 223.38 },
  'merit-projects-horizontal': { w: 803.22, h: 120 },
  'merit-projects-vertical': { w: 693.91, h: 223.38 },
};

/** Default public path an app serves the lockups from (scripts/sync-brand.mjs copies them there). */
export const LOCKUP_BASE_PATH = '/brand/lockups';

/** File stem without the variant: "merit-projects-horizontal", "merit-icon". */
export function lockupStem(module: LockupModule, form: LockupForm): string {
  if (form === 'icon') return 'merit-icon';
  return module === 'merit' ? `merit-${form}` : `merit-${module}-${form}`;
}

/** "merit-projects-horizontal-on-dark.svg". */
export function lockupFile(module: LockupModule, form: LockupForm, variant: LockupVariant): string {
  return `${lockupStem(module, form)}-${variant}.svg`;
}

/** Rendered size at a given height, width from the viewBox ratio (rounded to whole px). */
export function lockupSize(module: LockupModule, form: LockupForm, height: number): { width: number; height: number } {
  const vb = LOCKUP_VIEWBOX[lockupStem(module, form)];
  if (!vb) throw new Error(`No lockup for ${module}/${form}`);
  return { width: Math.round((vb.w / vb.h) * height), height };
}

/** Minimum on-screen height for a lockup; below it use the icon (§1.3 Sizing). */
export const LOCKUP_MIN_HEIGHT = 20;
