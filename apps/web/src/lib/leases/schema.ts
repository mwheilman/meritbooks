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
