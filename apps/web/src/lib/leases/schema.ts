/**
 * Zod schemas for the leases API. Kept inside lib/leases/* (owned by this slice)
 * rather than the reserved shared validations dir. All money is bigint-range CENTS.
 */

import { z } from 'zod';

export const LEASE_CLASSIFICATIONS = ['OPERATING', 'FINANCE'] as const;
export const LEASE_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;
export const LEASE_TIMINGS = ['ARREARS', 'ADVANCE'] as const;
export const LEASE_STATUSES = ['ACTIVE', 'ENDED', 'TERMINATED'] as const;

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected yyyy-mm-dd');

export const createLeaseSchema = z
  .object({
    lessor: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    location_id: z.string().uuid(),
    classification: z.enum(LEASE_CLASSIFICATIONS).default('OPERATING'),
    commencement_date: ISO_DATE,
    end_date: ISO_DATE,
    /** Per-period payment in integer CENTS. */
    payment_cents: z.number().int().positive(),
    payment_frequency: z.enum(LEASE_FREQUENCIES).default('MONTHLY'),
    payment_timing: z.enum(LEASE_TIMINGS).default('ARREARS'),
    /** Whole-month term; must be a multiple of the payment-period length (checked in the engine). */
    term_months: z.number().int().positive().max(1200),
    /** Discount / incremental borrowing rate as a decimal (0.06 = 6%). */
    discount_rate: z.number().min(0).max(1),
    ai_decision_id: z.string().uuid().nullable().optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.end_date > v.commencement_date, {
    message: 'end_date must be after commencement_date',
    path: ['end_date'],
  });

export type CreateLeaseInput = z.infer<typeof createLeaseSchema>;

/**
 * Modification remeasurement (ASC 842). `confirm=false` (default) previews the numbers;
 * `confirm=true` posts the adjusting entry + rebuilds the forward schedule. Revised terms
 * describe the REMAINING lease from the effective (next unposted) period forward.
 */
export const modifyLeaseSchema = z.object({
  confirm: z.boolean().default(false),
  /** Revised per-period payment in integer CENTS. */
  payment_cents: z.number().int().positive(),
  /** Revised number of REMAINING periods (from the effective period forward). */
  remaining_periods: z.number().int().positive().max(1200),
  /** Revised annual discount / IBR as a decimal (0.06 = 6%). */
  discount_rate: z.number().min(0).max(1),
  /** Force partial-termination (scope-reduction) treatment; inferred when omitted. */
  scope_reduction: z.boolean().optional(),
});
export type ModifyLeaseInput = z.infer<typeof modifyLeaseSchema>;

/** CPI / index reset — only the payment changes; original rate + remaining term hold. */
export const cpiResetSchema = z.object({
  confirm: z.boolean().default(false),
  /** New index-based per-period payment in integer CENTS. */
  payment_cents: z.number().int().positive(),
});
export type CpiResetInput = z.infer<typeof cpiResetSchema>;

/** Early termination — optional cash penalty in integer CENTS. */
export const terminateLeaseSchema = z.object({
  confirm: z.boolean().default(false),
  penalty_cents: z.number().int().min(0).default(0),
});
export type TerminateLeaseInput = z.infer<typeof terminateLeaseSchema>;
