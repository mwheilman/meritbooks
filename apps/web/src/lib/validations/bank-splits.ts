import { z } from 'zod';
import { FULL_BP, MAX_SPLIT_LINES } from '@/lib/bank/splits/allocate';

/** One split line as sent by the edit panel / card drawer (FPB-bank-feed-splits §7). */
export const splitLineInputSchema = z.object({
  amount_cents: z.number().int().positive('Each split line must be more than $0.00'),
  /** Set when the line was entered as a percentage (basis points, 10000 = 100%). */
  percent_bp: z.number().int().min(1).max(FULL_BP).nullable().optional(),
  account_id: z.string().uuid('Each split line needs a GL account'),
  /** The company this line books to; defaults to the transaction's company. */
  allocation_location_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  class_id: z.string().uuid().nullable().optional(),
  job_id: z.string().uuid().nullable().optional(),
  cost_code_id: z.string().uuid().nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
});
export type SplitLineInput = z.infer<typeof splitLineInputSchema>;

export const splitLinesSchema = z.array(splitLineInputSchema).min(1).max(MAX_SPLIT_LINES);

/** POST /api/bank-feed/splits — save a draft split (lines: [] = unsplit). */
export const saveSplitDraftSchema = z.object({
  transaction_id: z.string().uuid(),
  lines: z.array(splitLineInputSchema).max(MAX_SPLIT_LINES),
  split_rule_id: z.string().uuid().nullable().optional(),
});
export type SaveSplitDraftInput = z.infer<typeof saveSplitDraftSchema>;

/** GET /api/bank-feed/splits?transaction_id= */
export const splitQuerySchema = z.object({
  transaction_id: z.string().uuid(),
});
export type SplitQuery = z.infer<typeof splitQuerySchema>;

/** POST /api/bank-feed/reverse — reversal-on-edit for a posted feed line. */
export const reverseBankTransactionSchema = z.object({
  transaction_id: z.string().uuid(),
  reason: z.string().trim().min(3, 'Say why the posting is being reversed').max(500),
});
export type ReverseBankTransactionInput = z.infer<typeof reverseBankTransactionSchema>;

/** POST /api/bank-feed/split-rules — forget (deactivate) a remembered split. */
export const updateSplitRuleSchema = z.object({
  id: z.string().uuid(),
  is_active: z.literal(false),
});
export type UpdateSplitRuleInput = z.infer<typeof updateSplitRuleSchema>;
