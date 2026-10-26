/**
 * Zod schemas for the cash workspace API (Wave 4C, migration 192). Amounts are integer cents,
 * rates basis points, dates YYYY-MM-DD. Mirrors the 192 CHECK constraints so a bad request is a
 * 422 with a field message, never a database error.
 */
import { z } from 'zod';

const uuid = z.string().uuid();
const optUuid = z.union([z.string().uuid(), z.literal(''), z.null()]).optional().transform((v) => (v ? v : null));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const positiveCents = z.number().int().min(1, 'Enter an amount above zero').max(100_000_000_000_000);
const optCents = z.number().int().min(0).max(100_000_000_000_000).nullable().optional();

/** Query: optional company (blank / 'all' = every company in scope). */
export const scopeQuery = z.object({
  location_id: z.union([z.string().uuid(), z.literal(''), z.literal('all')]).optional(),
  scenario_id: z.union([z.string().uuid(), z.literal(''), z.literal('base')]).optional(),
});

export const historyQuery = scopeQuery.extend({
  grain: z.enum(['day', 'week', 'month']).optional().default('week'),
  points: z.coerce.number().int().min(4).max(120).optional(),
});

export const accuracyQuery = scopeQuery.extend({
  lead: z.coerce.number().int().min(1).max(4).optional().default(1),
  weeks: z.coerce.number().int().min(4).max(26).optional().default(12),
});

export const exportQuery = scopeQuery.extend({ view: z.enum(['weeks', 'items']).optional().default('weeks') });

export const idQuery = z.object({ id: uuid });

export const SCENARIO_KINDS = ['BASE', 'DOWNSIDE', 'UPSIDE', 'CUSTOM'] as const;

export const createScenarioSchema = z.object({
  name: z.string().trim().min(1, 'Name the scenario').max(80),
  kind: z.enum(SCENARIO_KINDS).default('CUSTOM'),
  location_id: optUuid,
  description: z.string().trim().max(1000).nullable().optional(),
  /** Seed the kind's preset levers (Downside / Upside). */
  with_presets: z.boolean().optional().default(true),
});

export const updateScenarioSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  is_archived: z.boolean().optional(),
});

export const ADJUSTMENT_KINDS = ['DELAY_RECEIPTS', 'RECEIPT_HAIRCUT', 'DELAY_DISBURSEMENTS', 'REMOVE_ITEM', 'PAYROLL_GROWTH', 'LINE_DRAW', 'LINE_PAYDOWN'] as const;

export const createAdjustmentSchema = z
  .object({
    scenario_id: uuid,
    kind: z.enum(ADJUSTMENT_KINDS),
    location_id: optUuid,
    customer_id: optUuid,
    vendor_id: optUuid,
    instrument_id: optUuid,
    item_key: z.string().trim().min(1).max(200).nullable().optional(),
    days: z.number().int().min(-90).max(180).nullable().optional(),
    bps: z.number().int().min(-5000).max(10000).nullable().optional(),
    amount_cents: optCents,
    effective_date: isoDate.nullable().optional(),
    label: z.string().trim().max(120).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .superRefine((v, c) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) c.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    if (v.kind === 'DELAY_RECEIPTS' || v.kind === 'DELAY_DISBURSEMENTS') need(!!v.days && v.days !== 0, 'days', 'Enter how many days (negative = sooner)');
    if (v.kind === 'RECEIPT_HAIRCUT') need(!!v.bps && v.bps > 0 && v.bps <= 10000, 'bps', 'Enter a cut between 0.01% and 100%');
    if (v.kind === 'PAYROLL_GROWTH') need(!!v.bps && v.bps !== 0, 'bps', 'Enter a change other than 0%');
    if (v.kind === 'REMOVE_ITEM') need(!!v.item_key, 'item_key', 'Pick the item to remove');
    if (v.kind === 'LINE_DRAW' || v.kind === 'LINE_PAYDOWN') {
      need(!!v.amount_cents && v.amount_cents > 0, 'amount_cents', 'Enter an amount above zero');
      need(!!v.effective_date, 'effective_date', 'Pick a date');
      need(!!v.location_id, 'location_id', 'Pick the company whose line this is');
    }
  });

export const ITEM_CATEGORIES_IN = ['DEPOSIT', 'OTHER_IN', 'TRANSFER_IN', 'LINE_DRAW'] as const;
export const ITEM_CATEGORIES_OUT = ['CAPEX', 'OPEX', 'TAX', 'DISTRIBUTION', 'TRANSFER_OUT', 'LINE_PAYDOWN', 'OTHER_OUT'] as const;
export const ITEM_RECURRENCE = ['NONE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY'] as const;

const itemFields = {
  location_id: uuid,
  scenario_id: optUuid,
  direction: z.enum(['IN', 'OUT']),
  category: z.enum([...ITEM_CATEGORIES_IN, ...ITEM_CATEGORIES_OUT]),
  label: z.string().trim().min(1, 'Describe the item').max(120),
  expected_date: isoDate,
  amount_cents: positiveCents,
  probability_bps: z.number().int().min(1).max(10000).optional().default(10000),
  recurrence: z.enum(ITEM_RECURRENCE).optional().default('NONE'),
  recurrence_end: isoDate.nullable().optional(),
  counterparty_location_id: optUuid,
  account_id: optUuid,
  note: z.string().trim().max(2000).nullable().optional(),
};

function refineItem(v: { direction: string; category: string; recurrence?: string; recurrence_end?: string | null; expected_date: string; counterparty_location_id?: string | null; location_id: string }, c: z.RefinementCtx) {
  const ins: readonly string[] = ITEM_CATEGORIES_IN;
  if ((v.direction === 'IN') !== ins.includes(v.category)) c.addIssue({ code: z.ZodIssueCode.custom, path: ['category'], message: 'That category does not match the direction' });
  if (v.recurrence_end && (v.recurrence ?? 'NONE') === 'NONE') c.addIssue({ code: z.ZodIssueCode.custom, path: ['recurrence_end'], message: 'Only a recurring item has an end date' });
  if (v.recurrence_end && v.recurrence_end < v.expected_date) c.addIssue({ code: z.ZodIssueCode.custom, path: ['recurrence_end'], message: 'Ends before it starts' });
  if ((v.category === 'TRANSFER_IN' || v.category === 'TRANSFER_OUT') && !v.counterparty_location_id) c.addIssue({ code: z.ZodIssueCode.custom, path: ['counterparty_location_id'], message: 'Pick the other company' });
  if (v.counterparty_location_id && v.counterparty_location_id === v.location_id) c.addIssue({ code: z.ZodIssueCode.custom, path: ['counterparty_location_id'], message: 'Pick a different company' });
}

export const createItemSchema = z.object(itemFields).superRefine(refineItem);
export const updateItemSchema = z.object({ id: uuid, ...itemFields, is_active: z.boolean().optional() }).superRefine(refineItem);

export const settingsSchema = z.object({
  location_id: uuid,
  minimum_cash_cents: optCents,
  alerts_enabled: z.boolean().optional().default(true),
  employer_tax_bps: z.number().int().min(0).max(3000).nullable().optional(),
  estimated_tax_quarterly_cents: optCents,
  runrate_basis: z.enum(['BUDGET', 'TRAILING_3M', 'OFF']).optional().default('BUDGET'),
  include_unapproved_bills: z.boolean().optional().default(true),
});

export const liquidityLineSchema = z
  .object({
    id: z.string().uuid().optional(),
    location_id: uuid,
    instrument_id: optUuid,
    name: z.string().trim().min(1, 'Name the line').max(120),
    commitment_cents: z.number().int().min(0).max(100_000_000_000_000),
    borrowing_base_cents: optCents,
    drawn_cents: optCents,
    as_of_date: isoDate.nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  });

export const snapshotSchema = z.object({ location_id: optUuid });

export type CreateScenarioInput = z.infer<typeof createScenarioSchema>;
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
export type LiquidityLineInput = z.infer<typeof liquidityLineSchema>;
