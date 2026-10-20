/** Zod building blocks for the ops routes (validated before any database call). */
import { z } from 'zod';

export const Uuid = z.string().uuid();
export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-20');
export const Instant = z.string().datetime({ offset: true });
export const Cents = z.number().int().min(0).max(1e13);
export const SignedCents = z.number().int().min(-1e13).max(1e13);
export const Text = (max: number) => z.string().trim().max(max);
export const Need = (max: number, msg: string) => z.string().trim().min(1, msg).max(max);
export const Fraction = z.number().min(0).max(1);
export const Qty = z.number().positive().max(1e9);
export const SkillCode = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, 'Lower-case letters, digits and _');

export const WoKindZ = z.enum(['SERVICE', 'MAINTENANCE_VISIT', 'INSTALL', 'MEASURE', 'DELIVERY', 'REPAIR_ORDER', 'PDI', 'INSPECTION']);
export const OutcomeZ = z.enum(['FIXED', 'COMPLETED', 'PARTIAL', 'NOT_FIXED', 'NEEDS_PARTS', 'NEEDS_QUOTE', 'NO_PROBLEM_FOUND', 'DECLINED', 'NO_ACCESS']);
export const MethodZ = z.enum(['IN_PERSON', 'PORTAL', 'EMAIL', 'PHONE', 'E_SIGNATURE']);
export const PayerZ = z.enum(['CUSTOMER', 'OEM', 'INTERNAL', 'THIRD_PARTY']);
export const LineKindZ = z.enum(['SERVICE', 'PART', 'LABOR', 'EQUIPMENT', 'FEE', 'DISCOUNT', 'SUBLET', 'FREIGHT']);

/** A new job created inline (Jobber-style: one form for the call and the visit). */
export const NewJobZ = z.object({
  companyId: Uuid,
  jobTypeKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, 'Pick a job type'),
  name: Need(120, 'Name the job'),
  customerId: Uuid.nullish(),
  customerName: Text(120).nullish(),
});

/** Loan terms of a draw schedule (editable while DRAFT). */
export const ScheduleTerms = z.object({
  lenderName: Need(160, 'Name the lender'),
  lenderCustomerId: Uuid.nullish(),
  loanNumber: Text(60).nullish(),
  loanCommitmentCents: Cents,
  equityRequiredCents: Cents.default(0),
  interestReserveCents: Cents.default(0),
  interestRate: z.number().min(0).max(1).nullish(),
  projectedMonthlyInterestCents: Cents.nullish(),
  retainagePct: z.number().min(0).max(0.25).default(0.1),
  requiresInspection: z.boolean().default(true),
  equityFirst: z.boolean().default(true),
  loanClosedOn: Day.nullish(),
  maturityOn: Day.nullish(),
  notes: Text(2000).nullish(),
});

