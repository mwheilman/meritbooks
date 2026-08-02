import { z } from 'zod';

/** Start a new agent run. `input` is recipe-specific (the recipe's init validates it). */
export const startAgentRunSchema = z.object({
  recipe: z.string().min(1, 'A recipe key is required.'),
  input: z.record(z.unknown()).default({}),
});
export type StartAgentRunInput = z.infer<typeof startAgentRunSchema>;

/** Advance a WAITING run at its current human gate. */
export const advanceAgentRunSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().max(1000).optional().nullable(),
});
export type AdvanceAgentRunInput = z.infer<typeof advanceAgentRunSchema>;
