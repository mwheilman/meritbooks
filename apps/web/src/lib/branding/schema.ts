/**
 * Validation for brand profiles (FPB-branding §8) — shared by the routes (server truth)
 * and the settings screen (inline errors). Limits match migration 190's CHECKs.
 */

import { z } from 'zod';
import { BRAND_FONTS } from './types';

export const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #2563EB')
  .transform((v) => v.toUpperCase());

export const paletteSchema = z.object({
  primary: hexColor,
  secondary: hexColor,
  accent: hexColor,
  ink: hexColor,
  surface: hexColor,
  on_primary: hexColor,
});

const logoUrl = z.string().url('Upload the logo here').max(1000).nullable();

export const saveBrandSchema = z.object({
  /** null = the tenant brand. */
  location_id: z.string().uuid().nullable(),
  use_tenant_brand: z.boolean().default(true),
  logo_url: logoUrl.default(null),
  logo_dark_url: logoUrl.default(null),
  mark_url: logoUrl.default(null),
  palette: paletteSchema,
  font: z.enum(BRAND_FONTS).default('DM_SANS'),
  palette_source: z.enum(['derived', 'manual']).default('derived'),
  extracted_colors: z.array(hexColor).max(12).default([]),
});

export type SaveBrandInput = z.infer<typeof saveBrandSchema>;

export const brandScopeQuery = z.object({
  location_id: z.string().uuid().optional(),
});

export const logoSlotSchema = z.enum(['logo', 'logo_dark', 'mark']);
