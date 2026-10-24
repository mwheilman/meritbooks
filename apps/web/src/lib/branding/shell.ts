/**
 * The tenant brand as the app shell shows it (FPB-branding §4.1): ONLY the brand area at
 * the top of the rail — never the product chrome. Pure.
 */

import type { ResolvedBrand } from './types';

export interface ShellBrand {
  name: string;
  /** Logo for the Midnight rail: the dark-background logo, else the light logo on a chip. */
  logoUrl: string;
  /** True when `logoUrl` is a light-background logo (needs a white chip on Midnight). */
  onChip: boolean;
  /** Square mark for the mini rail (falls back to the logo). */
  markUrl: string;
  /** The brand colour — used only as the brand-area rule. */
  accent: string;
}

/** null = show the Merit lockup exactly as today (no tenant logo yet). */
export function shellBrandOf(b: ResolvedBrand, orgName: string): ShellBrand | null {
  if (b.source === 'MERIT_DEFAULT') return null;
  const logo = b.logoDarkUrl ?? b.logoUrl;
  if (!logo) return null;
  return {
    name: orgName || 'Your organization',
    logoUrl: logo,
    onChip: !b.logoDarkUrl,
    markUrl: b.markUrl ?? logo,
    accent: b.palette.primary,
  };
}
