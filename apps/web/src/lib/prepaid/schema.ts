/**
 * Zod validation for the prepaid API surface. Money is bigint cents; the term is
 * given as a month count OR a coverage end date (at least one is required, and the
 * end date must be on/after the start).
 */

import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const createPrepaidSchema = z
  .object({
    location_id: z.string().uuid(),
    expense_account_id: z.string().uuid(),
    prepaid_account_id: z.string().uuid().optional(),
    total_cents: z.number().int().positive(),
    start_date: isoDate,
    months: z.number().int().min(1).max(600).optional(),
    end_date: isoDate.optional(),
    department_id: z.string().uuid().nullable().optional(),
    memo: z.string().max(500).nullable().optional(),
    source_type: z.enum(['BILL', 'INVOICE', 'MANUAL', 'PREPAID_DOC']).optional(),
    source_id: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.months != null || v.end_date != null, {
    message: 'Provide either a term (months) or a coverage end date',
    path: ['months'],
  })
  .refine((v) => v.end_date == null || v.end_date >= v.start_date, {
    message: 'Coverage end must be on or after the start date',
    path: ['end_date'],
  });

export type CreatePrepaidBody = z.infer<typeof createPrepaidSchema>;

export const runPrepaidSchema = z.object({
  as_of: isoDate.optional(),
  schedule_id: z.string().uuid().optional(),
});
export type RunPrepaidBody = z.infer<typeof runPrepaidSchema>;

export const proposeFromBillSchema = z.object({
  bill_id: z.string().uuid(),
  bill_line_id: z.string().uuid(),
  term_months: z.number().int().min(1).max(600).optional(),
});
export type ProposeFromBillBody = z.infer<typeof proposeFromBillSchema>;
