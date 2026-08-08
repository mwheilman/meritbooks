/**
 * Saved report packs — persistence + re-resolution + schedule math.
 *
 * A saved pack stores the RELATIVE period DESCRIPTORS the user confirmed (report
 * type + basis + descriptor grammar from spec.ts), NOT concrete dates. On every
 * run we re-expand those descriptors against the org's current fiscal calendar,
 * so "last 3 fiscal years" always means the three years ending most recently —
 * a monthly-scheduled pack re-resolves to fresh dates each cycle, deterministically.
 *
 * Nothing here computes money or calls a model: descriptors → concrete dates via
 * the SAME expander (expandParse) the ad-hoc compiler uses, then the ledger
 * engines (run.ts) produce every figure.
 *
 * This module is pure (no DB, no I/O) so the date math and validation are unit
 * testable and identical between the interactive save path and the cron delivery.
 */

import { z } from 'zod';
import {
  reportSpecSchema,
  resolvedPackSchema,
  expandParse,
  type ResolvedPack,
  type ReportSpec,
} from './spec';

// ─────────────────────────────────────────────────────────────────────────────
// Cadence + validation
// ─────────────────────────────────────────────────────────────────────────────

export const CADENCES = ['NONE', 'MONTHLY', 'QUARTERLY'] as const;
export type Cadence = (typeof CADENCES)[number];
export const cadenceSchema = z.enum(CADENCES);

/** The saved descriptor list — the pre-expansion specs (report + basis + descriptors). */
export const savedSpecsSchema = z.array(reportSpecSchema).min(1).max(20);
export type SavedSpecs = z.infer<typeof savedSpecsSchema>;

/** Recipients for scheduled delivery. Deduped, lowercased, capped. */
export const recipientsSchema = z
  .array(z.string().email().max(200))
  .max(20)
  .transform((arr) => Array.from(new Set(arr.map((e) => e.trim().toLowerCase()))).filter(Boolean));

/** Create a saved pack. Schedule fields are OPTIONAL and default to OFF — saving
 *  a pack NEVER schedules anything or emails anyone; that is a separate, explicit
 *  step (see updateScheduleSchema). */
export const createPackSchema = z.object({
  name: z.string().trim().min(1).max(120),
  specs: savedSpecsSchema,
  entity_label: z.string().trim().max(200).optional(),
  location_ids: z.array(z.string().max(80)).max(50).optional(),
});
export type CreatePackInput = z.infer<typeof createPackSchema>;

/** Update name and/or the delivery schedule. Turning a schedule ON requires a
 *  cadence and at least one recipient (enforced in the route), so a pack can
 *  never silently start emailing. */
export const updatePackSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    cadence: cadenceSchema.optional(),
    recipients: recipientsSchema.optional(),
    schedule_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdatePackInput = z.infer<typeof updatePackSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Re-resolution: saved descriptors → a concrete ResolvedPack for the runner.
// ─────────────────────────────────────────────────────────────────────────────

export function resolveSavedPack(
  specs: ReportSpec[],
  entityLabel: string | null | undefined,
  locationIds: string[] | null | undefined,
  fyStartMonth: number,
  refISO?: string,
): ResolvedPack {
  const resolvedSpecs = expandParse({ reports: specs }, fyStartMonth, refISO);
  return resolvedPackSchema.parse({
    entityLabel: entityLabel && entityLabel.trim() ? entityLabel.trim() : 'All Companies (Consolidated)',
    locationIds: locationIds ?? [],
    specs: resolvedSpecs,
  });
}

/** Validate a stored specs blob back into typed ReportSpec[] (defensive — a row
 *  could predate a grammar change). Returns null if it no longer validates. */
export function parseStoredSpecs(raw: unknown): ReportSpec[] | null {
  const res = savedSpecsSchema.safeParse(raw);
  return res.success ? res.data : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic schedule date math (pure — unit tested).
// Dates are plain YYYY-MM-DD, UTC-agnostic. Monthly delivers on the 1st of each
// month; quarterly on the 1st of each calendar quarter (Jan/Apr/Jul/Oct).
// ─────────────────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function parseISO(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
/** Shift a 1-based (year, month) by delta months. */
function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
function firstOf(y: number, m: number): string {
  return `${y}-${pad(m)}-01`;
}

/**
 * The next delivery date STRICTLY AFTER `refISO` for the given cadence.
 * Used both to seed next_run_date when a schedule is switched on and to advance
 * it after a delivery, so a pack fires once per period and never same-instant twice.
 */
export function nextOccurrence(cadence: Cadence, refISO: string): string | null {
  if (cadence === 'NONE') return null;
  const { y, m } = parseISO(refISO);
  if (cadence === 'MONTHLY') {
    const n = shiftMonth(y, m, 1);
    return firstOf(n.y, n.m);
  }
  // QUARTERLY — advance to the start of the next calendar quarter.
  const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1; // 1,4,7,10
  const n = shiftMonth(y, quarterStartMonth, 3);
  return firstOf(n.y, n.m);
}

/** Human label for a cadence (UI + email). */
export function cadenceLabel(cadence: Cadence): string {
  switch (cadence) {
    case 'MONTHLY':
      return 'Monthly';
    case 'QUARTERLY':
      return 'Quarterly';
    default:
      return 'Not scheduled';
  }
}
