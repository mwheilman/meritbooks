/**
 * Zod validation for the recurring-JE API surface. Money is bigint cents; a line
 * is a debit OR a credit (never both, never neither); a template needs >= 2 lines
 * that balance. The balance check is enforced again in the pure `validateBalance`
 * and finally by the DB `check_journal_balance()` trigger at post time.
 */

import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const cadenceSchema = z.enum(['MONTHLY', 'QUARTERLY']);

export const recurringLineSchema = z
  .object({
    account_id: z.string().uuid(),
    debit_cents: z.number().int().min(0),
    credit_cents: z.number().int().min(0),
    location_id: z.string().uuid().nullable().optional(),
    department_id: z.string().uuid().nullable().optional(),
    class_id: z.string().uuid().nullable().optional(),
    memo: z.string().max(500).nullable().optional(),
  })
  .refine((l) => !(l.debit_cents > 0 && l.credit_cents > 0), {
    message: 'A line is a debit or a credit, not both',
  })
  .refine((l) => l.debit_cents > 0 || l.credit_cents > 0, {
    message: 'A line needs a debit or a credit amount',
  });

const balancedLines = z
  .array(recurringLineSchema)
  .min(2, 'A journal entry needs at least two lines')
  .refine(
    (lines) =>
      lines.reduce((s, l) => s + l.debit_cents, 0) === lines.reduce((s, l) => s + l.credit_cents, 0),
    { message: 'Debits must equal credits' },
  )
  .refine((lines) => lines.reduce((s, l) => s + l.debit_cents, 0) > 0, {
    message: 'Entry has no amounts',
  });

export const createTemplateSchema = z
  .object({
    location_id: z.string().uuid(),
    name: z.string().min(1).max(200),
    cadence: cadenceSchema,
    start_date: isoDate,
    end_date: isoDate.nullable().optional(),
    entry_type: z.enum(['STANDARD', 'ADJUSTING', 'CLOSING', 'REVERSING']).optional(),
    memo: z.string().max(1000).nullable().optional(),
    lines: balancedLines,
  })
  .refine((v) => v.end_date == null || v.end_date >= v.start_date, {
    message: 'End date must be on or after the start date',
    path: ['end_date'],
  });

export type CreateTemplateBody = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  cadence: cadenceSchema.optional(),
  start_date: isoDate.optional(),
  end_date: isoDate.nullable().optional(),
  entry_type: z.enum(['STANDARD', 'ADJUSTING', 'CLOSING', 'REVERSING']).optional(),
  memo: z.string().max(1000).nullable().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
  lines: balancedLines.optional(),
});
export type UpdateTemplateBody = z.infer<typeof updateTemplateSchema>;

export const generateSchema = z.object({
  as_of: isoDate.optional(),
  template_id: z.string().uuid().optional(),
});
export type GenerateBody = z.infer<typeof generateSchema>;

export const approveSchema = z.object({
  run_id: z.string().uuid(),
  action: z.enum(['approve', 'reject']).default('approve'),
});
export type ApproveBody = z.infer<typeof approveSchema>;
