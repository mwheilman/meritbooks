/**
 * Zod schema for creating a debt instrument (the confirm path). Money arrives as
 * bigint CENTS from the UI; the interest rate is a percent number. The route runs
 * this through `apiHandler`, then the create service generates the schedule.
 */

import { z } from 'zod';

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .nullish();

const FREQUENCY = z.enum(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']);

const debtShape = z
  .object({
    loan_name: z.string().min(1, 'Loan name is required').max(200),
    lender: z.string().max(200).nullish(),
    facility: z.string().max(200).nullish(),
    location_id: z.string().uuid().nullish(),
    principal_cents: z.number().int().positive('Principal must be greater than zero'),
    interest_rate: z.number().min(0).max(100),
    rate_type: z.enum(['FIXED', 'VARIABLE']).default('FIXED'),
    amortization_method: z.enum(['AMORTIZING', 'INTEREST_ONLY']).default('AMORTIZING'),
    payment_frequency: FREQUENCY.default('MONTHLY'),
    compounding: FREQUENCY.default('MONTHLY'),
    term_periods: z.number().int().positive().max(1200).nullish(),
    payment_cents: z.number().int().positive().nullish(),
    origination_date: dateStr,
    maturity_date: dateStr,
    status: z.enum(['ACTIVE', 'PAID_OFF', 'CLOSED', 'INACTIVE']).default('ACTIVE'),
    loan_covenant_id: z.string().uuid().nullish(),
    liability_account_id: z.string().uuid().nullish(),
    interest_expense_account_id: z.string().uuid().nullish(),
    interest_payable_account_id: z.string().uuid().nullish(),
    cash_account_id: z.string().uuid().nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .refine((v) => v.amortization_method !== 'INTEREST_ONLY' || (v.term_periods ?? 0) > 0, {
    message: 'Interest-only loans require a term (number of periods)',
    path: ['term_periods'],
  })
  .refine((v) => (v.term_periods ?? 0) > 0 || (v.payment_cents ?? 0) > 0, {
    message: 'Provide a term (number of periods) or a fixed payment so the schedule can be built',
    path: ['term_periods'],
  });

/** The fully-parsed debt create payload (defaults applied). */
export type CreateDebtInput = z.infer<typeof debtShape>;

/**
 * apiHandler<T> constrains its schema to ZodSchema<T> — i.e. ZodType<T, _, T>,
 * where the parse INPUT equals the parse OUTPUT. Because this schema has
 * `.default()` fields, its input type (those fields optional) differs from its
 * output type (those fields present), so the raw schema isn't assignable to
 * ZodSchema<CreateDebtInput>. Re-type the export to its Output shape — the
 * runtime schema is untouched, so defaults + refinements still run on parse;
 * this only tells the type system "callers receive CreateDebtInput," which is
 * exactly true.
 */
export const createDebtSchema = debtShape as unknown as z.ZodType<CreateDebtInput>;
