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

// -----------------------------------------------------------------------------
// Premium amortization (prepaid insurance -> insurance expense)
// -----------------------------------------------------------------------------

/**
 * Set up straight-line amortization of a policy's up-front premium. `total_cents`,
 * `start_date`, and the term (months, OR a coverage `end_date` to derive it) are
 * required — the UI pre-fills them from the policy. Account legs are optional
 * overrides; when omitted the server resolves them by ROLE (INSURANCE_EXPENSE /
 * PREPAID_INSURANCE), coverage-type aware, and fails closed if unresolved.
 */
export const createAmortizationSchema = z
  .object({
    policy_id: z.string().uuid(),
    total_cents: z.number().int().positive(),
    start_date: ISO_DATE,
    months: z.number().int().min(1).max(600).optional(),
    end_date: ISO_DATE.optional(),
    location_id: z.string().uuid().nullable().optional(),
    expense_account_id: z.string().uuid().optional(),
    prepaid_account_id: z.string().uuid().optional(),
    department_id: z.string().uuid().nullable().optional(),
    memo: z.string().max(500).nullable().optional(),
  })
  .refine((v) => v.months != null || v.end_date != null, {
    message: 'Provide either a term (months) or a coverage end date',
    path: ['months'],
  })
  .refine((v) => v.end_date == null || v.end_date >= v.start_date, {
    message: 'Coverage end must be on or after the start date',
    path: ['end_date'],
  });
export type CreateAmortizationInput = z.infer<typeof createAmortizationSchema>;

export const runAmortizationSchema = z.object({
  as_of: ISO_DATE.optional(),
  schedule_id: z.string().uuid().optional(),
});
export type RunAmortizationInput = z.infer<typeof runAmortizationSchema>;
