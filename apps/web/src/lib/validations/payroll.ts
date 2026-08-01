/**
 * Payroll run API validation (GATE 12.3 Phase A).
 *
 * Money is bigint cents (never floats). No PII is accepted anywhere — SSN / bank
 * / withholding elections live only at the licensed provider + the Core vault
 * (FPB-payroll §2). These schemas describe the workflow inputs, not the wage math
 * (the provider computes gross-to-net; Books only records the amounts it returns).
 */

import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)');

const uuid = z.string().uuid();

/**
 * One employee line the runner keys/pulls for a draft run. These are INPUTS to
 * the provider's calculation (hours, earnings, dimension stamp) — never computed
 * dollars and never PII. The provider returns the gross-to-net.
 */
export const employeePayInputSchema = z.object({
  employeeId: uuid,
  hours: z.number().nonnegative().optional(),
  // Earnings breakdown (hourly/salary/bonus/reimbursement...) — amounts in cents,
  // opaque to the run workflow, consumed by the PayrollEngine.
  earnings: z.array(z.record(z.unknown())).optional(),
  // Cost dimensions that make the eventual GL post job-costed (FPB §11).
  departmentId: uuid.nullish(),
  jobId: uuid.nullish(),
  classId: uuid.nullish(),
  locationId: uuid.nullish(),
});

export const createRunSchema = z.object({
  locationId: uuid,
  payScheduleId: uuid.optional(),
  periodStart: isoDate,
  periodEnd: isoDate,
  payDate: isoDate,
  memo: z.string().max(500).optional(),
  employeeInputs: z.array(employeePayInputSchema).min(1, 'At least one employee is required'),
});

export type CreateRunBody = z.infer<typeof createRunSchema>;
export type EmployeePayInputBody = z.infer<typeof employeePayInputSchema>;
