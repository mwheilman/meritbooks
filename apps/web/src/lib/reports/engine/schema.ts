/**
 * Zod validation for engine requests (API boundary). Shapes mirror ./types.ts exactly.
 */
import { z } from 'zod';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const uuid = z.string().uuid();
const range = z.object({ from: z.string().trim().min(1).max(20), to: z.string().trim().min(1).max(20) });
const kinds = z.array(z.enum(['STANDARD', 'ADJUSTING', 'CLOSING'])).min(1).max(3);

export const reportRequestSchema = z.object({
  statement: z.enum(['income_statement', 'balance_sheet', 'cash_flow', 'equity_changes', 'trial_balance', 'gl_summary']),
  scope: z.object({ companyIds: z.array(uuid).max(200).default([]), consolidate: z.boolean().optional() }),
  period: z.object({
    preset: z.enum(['month', 'quarter', 'year', 'mtd', 'qtd', 'ytd', 'ttm', 'custom']),
    asOf: iso,
    start: iso.optional(),
    end: iso.optional(),
  }),
  columns: z.enum(['single', 'month', 'quarter', 'year', 'company', 'department', 'class', 'job', 'location']).default('single'),
  columnCount: z.number().int().min(1).max(60).optional(),
  totalColumn: z.boolean().optional(),
  ttmColumn: z.boolean().optional(),
  compare: z.array(z.enum(['prior_period', 'prior_year', 'budget', 'forecast'])).max(4).default([]),
  compareEach: z.boolean().optional(),
  variance: z.boolean().optional(),
  basis: z.enum(['ACCRUAL', 'CASH', 'TAX', 'CUSTOM']).default('ACCRUAL'),
  customBasisLabel: z.string().max(80).nullable().optional(),
  rounding: z.enum(['cents', 'units', 'thousands', 'millions']).default('cents'),
  commonSize: z.boolean().optional(),
  showZeroRows: z.boolean().optional(),
  filters: z
    .object({
      accountIds: z.array(uuid).max(500).optional(),
      accountRanges: z.array(range).max(20).optional(),
      departmentIds: z.array(uuid).max(200).optional(),
      classIds: z.array(uuid).max(200).optional(),
      jobIds: z.array(uuid).max(500).optional(),
      itemIds: z.array(uuid).max(500).optional(),
    })
    .optional(),
  layout: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('standard') }),
      z.object({ kind: z.literal('ebitda') }),
      z.object({ kind: z.literal('custom'), layoutId: uuid }),
    ])
    .optional(),
  tbMode: z.enum(['worksheet', 'simple']).optional(),
});

export const runBodySchema = reportRequestSchema.extend({
  /** library key the run is recorded under (recently run) */
  reportKey: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
});

export const drillRequestSchema = z.object({
  accountIds: z.array(uuid).min(1).max(2000),
  companyIds: z.array(uuid).max(200).default([]),
  range: z.object({ start: iso.nullable(), end: iso }),
  dims: z
    .object({
      department: uuid.nullable().optional(),
      class: uuid.nullable().optional(),
      job: uuid.nullable().optional(),
      item: uuid.nullable().optional(),
      counterparty: uuid.nullable().optional(),
    })
    .optional(),
  kinds: kinds.optional(),
  /** per-company in-group date bounds (pre-acquisition exclusion), from the cell's DrillScope */
  windows: z
    .record(uuid, z.object({ from: iso.nullable(), to: iso.nullable() }))
    .refine((w) => Object.keys(w).length <= 200, 'Too many company windows')
    .optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).max(10_000_000).optional(),
});

const selectorSchema = z.object({
  types: z.array(z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'OPEX', 'OTHER'])).max(7).optional(),
  subTypes: z.array(z.string().max(40)).max(20).optional(),
  groupIds: z.array(uuid).max(200).optional(),
  roles: z.array(z.string().regex(/^[A-Z0-9_]{1,60}$/)).max(50).optional(),
  accountIds: z.array(uuid).max(500).optional(),
  ranges: z.array(range).max(20).optional(),
  synthetic: z.array(z.enum(['re_prior', 'ni_current'])).max(2).optional(),
  excludeAccountIds: z.array(uuid).max(500).optional(),
});
const rowId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const goodWhen = z.enum(['up', 'down']).optional();

export const layoutRowSchema = z.discriminatedUnion('kind', [
  z.object({ id: rowId, kind: z.literal('header'), label: z.string().min(1).max(120) }),
  z.object({
    id: rowId, kind: z.literal('accounts'), label: z.string().min(1).max(120), select: selectorSchema,
    sign: z.union([z.literal(1), z.literal(-1)]), expand: z.enum(['accounts', 'groups', 'none']).optional(), goodWhen,
  }),
  z.object({
    id: rowId, kind: z.literal('subtotal'), label: z.string().min(1).max(120),
    of: z.array(z.object({ id: rowId, sign: z.union([z.literal(1), z.literal(-1)]) })).min(1).max(100), goodWhen,
    emphasis: z.enum(['sub', 'grand']).optional(),
  }),
  z.object({ id: rowId, kind: z.literal('formula'), label: z.string().min(1).max(120), expr: z.string().min(1).max(500), format: z.enum(['amount', 'percent']), goodWhen }),
  z.object({ id: rowId, kind: z.literal('spacer') }),
]);

export const layoutBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  statement: z.enum(['PNL', 'BS']),
  description: z.string().max(500).nullable().optional(),
  rows: z.array(layoutRowSchema).min(1).max(300),
});

export const prefsBodySchema = z.object({
  reportKey: z.string().regex(/^[a-z0-9_]{1,64}$/),
  favorite: z.boolean(),
});
