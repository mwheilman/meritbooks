/**
 * Zod schemas for the covenant API. Kept inside lib/covenants/* (owned by this
 * slice) rather than the shared validations dir to avoid touching reserved spine.
 */

import { z } from 'zod';

export const COVENANT_TYPES = ['DSCR', 'FCCR', 'LEVERAGE', 'CURRENT_RATIO', 'MIN_LIQUIDITY', 'TNW', 'CUSTOM'] as const;
export const COVENANT_DIRECTIONS = ['MIN', 'MAX'] as const;
export const COVENANT_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;
export const COVENANT_STATUSES = ['ACTIVE', 'WAIVED', 'CURED', 'INACTIVE'] as const;

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected yyyy-mm-dd');

/** Measurement config — all optional; type-based defaults drive the ledger resolver. */
export const measurementSchema = z
  .object({
    trailingMonths: z.number().int().min(1).max(60).optional(),
    annualPrincipalCents: z.number().int().min(0).optional(),
    fixedChargeAddonCents: z.number().int().min(0).optional(),
    revolverAvailabilityCents: z.number().int().min(0).optional(),
    intangiblesCents: z.number().int().min(0).optional(),
    netOfCash: z.boolean().optional(),
    numeratorCents: z.number().int().optional(),
    denominatorCents: z.number().int().optional(),
  })
  .strict();

const covenantShape = z.object({
  loan_name: z.string().min(1).max(200),
  facility: z.string().max(200).optional(),
  lender_name: z.string().max(200).optional(),
  location_id: z.string().uuid().nullable().optional(),
  covenant_type: z.enum(COVENANT_TYPES),
  threshold: z.number().finite(),
  direction: z.enum(COVENANT_DIRECTIONS).default('MIN'),
  test_frequency: z.enum(COVENANT_FREQUENCIES).default('QUARTERLY'),
  warn_headroom_pct: z.number().min(0).max(1).default(0.1),
  measurement: measurementSchema.default({}),
  status: z.enum(COVENANT_STATUSES).default('ACTIVE'),
  effective_date: ISO_DATE.nullable().optional(),
  maturity_date: ISO_DATE.nullable().optional(),
  notes: z.string().max(2000).optional(),
  /** Retained drop-and-parse source doc to link to this covenant (task #71). */
  source_document_id: z.string().uuid().nullable().optional(),
});

/** The fully-parsed covenant create payload (defaults applied). */
export type CreateCovenantInput = z.infer<typeof covenantShape>;

/**
 * apiHandler<T> constrains its schema to ZodSchema<T> — i.e. ZodType<T, _, T>,
 * where the parse INPUT equals the parse OUTPUT. Because this schema has
 * `.default()` fields, its input type (those fields optional) differs from its
 * output type (those fields present), so the raw ZodObject isn't assignable to
 * ZodSchema<CreateCovenantInput>. Re-type the export to its Output shape — the
 * runtime schema is untouched, so defaults still apply on parse; this only tells
 * the type system "callers receive CreateCovenantInput," which is exactly true.
 */
export const createCovenantSchema =
  covenantShape as unknown as z.ZodType<CreateCovenantInput>;

export const updateCovenantSchema = covenantShape.partial();

export const certificateSchema = z.object({
  period_end: ISO_DATE.optional(),
  as_of_note: z.string().max(500).optional(),
});

export type UpdateCovenantInput = z.infer<typeof updateCovenantSchema>;
