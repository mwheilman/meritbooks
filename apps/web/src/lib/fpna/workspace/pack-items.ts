/**
 * Dashboards in report packs (AC-W11, migration 191 `report_packs.fpna_items`). PURE.
 *
 * An item stores the dashboard's LAYOUT as it was when added (cards + period basis + scope),
 * never figures: scheduled delivery recomputes it for the last complete month, governed as a
 * non-finance reader (released months only), and attaches it as a PDF. Stored jsonb is
 * untrusted on read (`parsePackItems` drops anything malformed).
 */

import { z } from 'zod';
import { cardsSchema, PACK_KEYS, parseCards, settingsSchema } from './dashboard-model';
import type { EffectiveDashboardSummary } from './types';

export const MAX_PACK_ITEMS = 12;

export const packItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  packKey: z.enum(PACK_KEYS),
  cards: cardsSchema,
  settings: settingsSchema,
  companies: z.array(z.string().regex(/^[0-9a-f-]{36}$/i)).max(100),
  weighting: z.enum(['full', 'ownership']),
  sourceRef: z.string().max(64),
  addedBy: z.string().max(120),
  addedAt: z.string().max(40),
});
export type PackItem = z.infer<typeof packItemSchema>;

export const addToPackSchema = z
  .object({
    /** The dashboard as the reader sees it (ref + layout — never figures). */
    dashboardRef: z.string().max(64),
    name: z.string().trim().min(1).max(80),
    packKey: z.enum(PACK_KEYS),
    cards: cardsSchema,
    settings: settingsSchema,
    companies: z.array(z.string().regex(/^[0-9a-f-]{36}$/i)).max(100),
    weighting: z.enum(['full', 'ownership']),
    packId: z.string().uuid().optional(),
    newPackName: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => Boolean(v.packId) !== Boolean(v.newPackName), { message: 'Choose an existing pack or name a new one' });
export type AddToPackInput = z.infer<typeof addToPackSchema>;

export function parsePackItems(raw: unknown): PackItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PackItem[] = [];
  for (const r of raw) {
    const cards = parseCards((r as { cards?: unknown })?.cards);
    const res = packItemSchema.safeParse({ ...(r as object), cards });
    if (res.success) out.push(res.data);
  }
  return out.slice(0, MAX_PACK_ITEMS);
}

export function itemDashboard(item: PackItem): EffectiveDashboardSummary {
  return { id: null, ref: `pack-item:${item.id}`, name: item.name, packKey: item.packKey, cards: item.cards, settings: item.settings, source: 'pack', lock: null, canPersonalize: false, overridden: false, version: 1 };
}

/** The specs a NEW pack starts with (the compiler needs at least one): last month's P&L and balance sheet. */
export const NEW_PACK_SPECS = [
  { report: 'INCOME_STATEMENT', basis: 'ACCRUAL', periods: [{ type: 'LAST_N_MONTHS', n: 1 }] },
  { report: 'BALANCE_SHEET', basis: 'ACCRUAL', periods: [{ type: 'LAST_N_MONTHS', n: 1 }] },
] as const;
