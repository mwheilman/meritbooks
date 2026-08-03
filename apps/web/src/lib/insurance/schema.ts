/**
 * Zod schemas for the insurance-register API. Kept inside lib/insurance/* (owned by
 * this slice) rather than the shared validations dir to avoid touching reserved spine.
 * Money fields are integer cents.
 */

import { z } from 'zod';

export const COVERAGE_TYPES = [
  'GL',
  'PROPERTY',
  'AUTO',
  'WC',
  'CYBER',
  'UMBRELLA',
  'PROFESSIONAL',
  'OTHER',
] as const;

export const PREMIUM_FREQUENCIES = [
  'ANNUAL',
  'SEMIANNUAL',
  'QUARTERLY',
  'MONTHLY',
  'ONE_TIME',
] as const;

export const POLICY_STATUSES = ['ACTIVE', 'EXPIRED', 'CANCELLED', 'PENDING'] as const;

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected yyyy-mm-dd');
const CENTS = z.number().int().min(0);

export const createPolicySchema = z.object({
  location_id: z.string().uuid().nullable().optional(),
  carrier: z.string().max(200).nullable().optional(),
  policy_number: z.string().max(120).nullable().optional(),
  coverage_type: z.enum(COVERAGE_TYPES).optional(),
  coverage_limit_cents: CENTS.nullable().optional(),
  deductible_cents: CENTS.nullable().optional(),
  premium_cents: CENTS.nullable().optional(),
  premium_frequency: z.enum(PREMIUM_FREQUENCIES).optional(),
  effective_date: ISO_DATE.nullable().optional(),
  expiration_date: ISO_DATE.nullable().optional(),
  status: z.enum(POLICY_STATUSES).optional(),
  broker: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const updatePolicySchema = createPolicySchema.partial();

export type CreatePolicyInput = z.infer<typeof createPolicySchema>;
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;
