import { z } from 'zod';

// =============================================================
// JOURNAL ENTRY
// =============================================================

export const glEntryLineSchema = z.object({
  account_id: z.string().uuid('Invalid account ID'),
  debit_cents: z.number().int().min(0, 'Debit cannot be negative'),
  credit_cents: z.number().int().min(0, 'Credit cannot be negative'),
  location_id: z.string().uuid('Invalid location ID'),
  department_id: z.string().uuid().optional().nullable(),
  class_id: z.string().uuid().optional().nullable(),
  item_id: z.string().uuid().optional().nullable(),
  memo: z.string().max(500).optional().nullable(),
  quantity: z.number().optional().nullable(),
  unit_cost_cents: z.number().int().optional().nullable(),
}).refine(
  (line) => (line.debit_cents > 0) !== (line.credit_cents > 0),
  { message: 'Each line must have either a debit or credit, not both or neither' }
);

export const postJournalEntrySchema = z.object({
  location_id: z.string().uuid('Invalid location ID'),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  entry_type: z.enum(['STANDARD', 'ADJUSTING', 'CLOSING', 'REVERSING', 'RECURRING', 'SYSTEM']).default('STANDARD'),
  memo: z.string().max(1000).optional(),
  source_module: z.string().max(50).optional(),
  source_id: z.string().uuid().optional(),
  lines: z.array(glEntryLineSchema)
    .min(2, 'Journal entry must have at least 2 lines')
    .max(200, 'Too many lines'),
}).refine(
  (entry) => {
    const totalDebits = entry.lines.reduce((s, l) => s + l.debit_cents, 0);
    const totalCredits = entry.lines.reduce((s, l) => s + l.credit_cents, 0);
    return totalDebits === totalCredits;
  },
  { message: 'Total debits must equal total credits' }
);

export const voidJournalEntrySchema = z.object({
  entry_id: z.string().uuid('Invalid entry ID'),
  reason: z.string().min(1, 'Void reason is required').max(500),
});

// =============================================================
// TRIAL BALANCE & REPORTS
// =============================================================

export const trialBalanceQuerySchema = z.object({
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// =============================================================
// TYPE EXPORTS
// =============================================================

export type PostJournalEntryInput = z.infer<typeof postJournalEntrySchema>;
export type GlEntryLineInput = z.infer<typeof glEntryLineSchema>;
export type VoidJournalEntryInput = z.infer<typeof voidJournalEntrySchema>;
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;
