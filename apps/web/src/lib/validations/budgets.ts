/**
 * Zod schemas for the department-budget API (Wave 4B, migration 189). Amounts are integer cents,
 * rates basis points. `department_id` in a query string: a uuid, or '' / 'company' for the
 * company-level lines.
 */
import { z } from 'zod';
import { BRIDGE_DRIVERS, BVA_WINDOWS, DEPARTMENT_KINDS, DRIVER_METHODS, VERSION_KINDS } from '@/lib/budgets/types';
import { PATTERN_MAX_LENGTH, patternError } from '@/lib/budgets/templates/pattern';

const uuid = z.string().uuid();
const cents = z.number().int().min(-1e15).max(1e15);
const bps = z.number().int().min(-10000).max(100000);
const year = z.coerce.number().int().min(2000).max(2100);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** Query-string department: a uuid, or '' / 'company' / absent for the company-level lines. */
export const deptParam = z.union([z.literal(''), z.literal('company'), z.literal('null'), z.string().uuid()]).optional();

/** Normalize `deptParam` → a department uuid or null (company level). */
export function deptOf(v: string | undefined): string | null {
  return v === undefined || v === '' || v === 'company' || v === 'null' ? null : v;
}

export const versionsQuery = z.object({ location_id: uuid, fiscal_year: year });

export const createVersionSchema = z.object({
  location_id: uuid,
  fiscal_year: z.number().int().min(2000).max(2100),
  kind: z.enum(VERSION_KINDS),
  start: z.enum(['BLANK', 'COPY', 'PRIOR_YEAR_ACTUALS', 'PRIOR_BUDGET', 'REFORECAST']),
  label: z.string().max(120).optional().nullable(),
  source_version_id: uuid.optional().nullable(),
  growth_bps: bps.optional().nullable(),
  due_date: isoDate.optional().nullable(),
  closed_through: z.number().int().min(0).max(12).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
});

export const versionSettingsSchema = z.object({
  version_id: uuid,
  label: z.string().min(1).max(120).optional(),
  due_date: isoDate.optional().nullable(),
  materiality_cents: z.number().int().min(0).max(1e13).optional(),
  materiality_bps: z.number().int().min(0).max(1000000).optional(),
  notes: z.string().max(4000).optional().nullable(),
});

export const transitionSchema = z.object({
  version_id: uuid,
  action: z.enum(['submit', 'return', 'approve', 'lock', 'delete']),
  note: z.string().max(1000).optional().nullable(),
});

export const compareQuery = z.object({ a: uuid, b: uuid });

export const gridQuery = z.object({ version_id: uuid, department_id: deptParam });

export const saveCellsSchema = z.object({
  version_id: uuid,
  department_id: uuid.nullable(),
  source: z.enum(['MANUAL', 'PASTE']).optional(),
  edits: z
    .array(z.object({ account_id: uuid, period_number: z.number().int().min(1).max(13), amount_cents: cents }))
    .min(1)
    .max(5000),
});

export const driverSchema = z.object({
  version_id: uuid,
  department_id: uuid.nullable(),
  account_id: uuid,
  method: z.enum(DRIVER_METHODS),
  params: z.record(z.number().finite()).default({}),
  bridge_driver: z.enum(BRIDGE_DRIVERS).optional(),
  note: z.string().max(1000).optional().nullable(),
  dry_run: z.boolean().optional(),
});

export const startSchema = z.object({
  version_id: uuid,
  department_id: uuid.nullable(),
  mode: z.enum(['PRIOR_YEAR', 'TEMPLATE']),
  growth_bps: bps.optional().nullable(),
  template_id: z.string().min(3).max(100).optional(),
  template_version: z.number().int().min(1).optional().nullable(),
  preview: z.boolean().optional(),
});

export const boardQuery = z.object({ version_id: uuid });

export const planActionSchema = z.object({
  version_id: uuid,
  department_id: uuid,
  action: z.enum(['submit', 'return', 'approve', 'reopen']),
  note: z.string().max(1000).optional().nullable(),
  gap_note: z.string().max(1000).optional().nullable(),
});

export const planPatchSchema = z.object({
  version_id: uuid,
  department_id: uuid,
  due_date: isoDate.optional().nullable(),
  target_revenue_cents: cents.optional().nullable(),
  target_expense_cents: cents.optional().nullable(),
  gap_note: z.string().max(1000).optional().nullable(),
  template_key: z.string().max(80).optional().nullable(),
  template_version: z.number().int().min(1).optional().nullable(),
});

export const ownersQuery = z.object({ location_id: uuid });

export const setOwnerSchema = z.object({
  location_id: uuid,
  department_id: uuid,
  owner_user_id: z.string().min(1).max(200).nullable(),
  owner_name: z.string().max(200).optional().nullable(),
  owner_email: z.string().max(320).optional().nullable(),
});

export const templatesQuery = z.object({ location_id: uuid });

// Safe account patterns only (lib/budgets/templates/pattern.ts) — never a RegExp.
const safePattern = z.string().max(PATTERN_MAX_LENGTH).refine((s) => s === '' || patternError(s) === null, {
  message: 'Use words separated by | (any of) with * as a wildcard — up to 100 characters.',
});
const selector = z.object({
  types: z.array(z.enum(['REVENUE', 'COGS', 'OPEX', 'OTHER'])).min(1),
  subTypes: z.array(z.string().max(60)).max(20).optional(),
  group: safePattern.optional(),
  name: safePattern.optional(),
  notName: safePattern.optional(),
});

export const saveTemplateSchema = z.object({
  location_id: uuid,
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/).optional().nullable(),
  based_on: z.string().max(100).optional().nullable(),
  name: z.string().min(1).max(120),
  department_kind: z.enum(DEPARTMENT_KINDS),
  description: z.string().max(2000).optional().nullable(),
  kpis: z.array(z.string().max(120)).max(30).optional(),
  lines: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        label: z.string().min(1).max(120),
        selector,
        method: z.enum(DRIVER_METHODS),
        params: z.record(z.number().finite()).default({}),
        bridgeDriver: z.enum(BRIDGE_DRIVERS).optional(),
        required: z.boolean().optional(),
        note: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const departmentViewQuery = z.object({
  location_id: uuid,
  fiscal_year: year,
  month: z.coerce.number().int().min(1).max(12),
  window: z.enum(BVA_WINDOWS).default('YTD'),
  department_id: deptParam,
  version_id: uuid.optional(),
});

export const drillQuery = departmentViewQuery.extend({ account_id: uuid, which: z.enum(['actual', 'py']).default('actual') });

export const commentsQuery = z.object({
  location_id: uuid,
  version_id: uuid.optional(),
  department_id: z.string().optional(),
  account_id: uuid.optional(),
  kind: z.enum(['COMMENT', 'JUSTIFY_REQUEST', 'VARIANCE_EXPLANATION']).optional(),
  period_key: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

export const addCommentSchema = z.object({
  location_id: uuid,
  version_id: uuid.optional().nullable(),
  department_id: uuid.nullable(),
  account_id: uuid.optional().nullable(),
  period_number: z.number().int().min(1).max(13).optional().nullable(),
  parent_id: uuid.optional().nullable(),
  kind: z.enum(['COMMENT', 'JUSTIFY_REQUEST', 'VARIANCE_EXPLANATION']),
  body: z.string().min(1).max(4000),
  period_key: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().nullable(),
  variance_window: z.enum(BVA_WINDOWS).optional().nullable(),
  variance_cents: cents.optional().nullable(),
});

export const commentActionSchema = z.object({
  comment_id: uuid,
  action: z.enum(['resolve', 'reopen', 'review']),
  note: z.string().max(1000).optional().nullable(),
});
