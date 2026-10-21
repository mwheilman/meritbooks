/** Zod bodies for the labor routes (validated before any database call). Percents are fractions. Pure. */
import { z } from 'zod';

const Fraction4 = z
  .number()
  .min(0, 'At least 0%')
  .max(5, 'Up to 500%')
  .refine((n) => Math.abs(Math.round(n * 10_000) - n * 10_000) < 1e-6, 'Up to two decimals of a percent, like 12.75%');
const Cents = z.number().int().min(0).max(1e9);

export const LaborSettingsBody = z.object({
  companyId: z.string().uuid(),
  burdenPct: Fraction4,
  overheadPct: Fraction4,
  notes: z.string().trim().max(500).nullish(),
});

export const RateCardFields = {
  label: z.string().trim().min(1, 'Name the trade or role').max(80),
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,47}$/, 'Lower-case letters, digits and _').nullish(),
  baseRateCents: Cents.nullish(),
  burdenPct: Fraction4.nullish(),
  overheadPct: Fraction4.nullish(),
  billRateCents: Cents.nullish(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
};
export const NewRateCardBody = z.object({ companyId: z.string().uuid(), ...RateCardFields });
export const EditRateCardBody = z.object({ ...RateCardFields, isActive: z.boolean().default(true) });

export const EmployeeCardBody = z.object({ companyId: z.string().uuid(), employeeId: z.string().uuid(), rateCardId: z.string().uuid().nullable() });

export const ApproveTimeBody = z.object({ ids: z.array(z.string().uuid()).min(1, 'Pick the time to approve').max(500) });

/** "Finish carpenter" → "finish_carpenter" (the card key when none is given). */
export function cardKeyFrom(label: string): string {
  const k = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  const withLetter = /^[a-z]/.test(k) ? k : `r_${k}`;
  return withLetter.length >= 2 ? withLetter.slice(0, 48) : `${withLetter}_x`;
}
