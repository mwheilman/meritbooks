/**
 * Zod schemas for the Autonomy control-plane API (M10). Owned here (not in the
 * shared validations dir) so the control-plane slice stays self-contained.
 */

import { z } from 'zod';
import { AUTONOMY_FEATURE_KEYS } from './catalog';

/** PUT /api/autonomy — change one feature's dial. */
export const updateAutonomySchema = z
  .object({
    feature: z.enum(AUTONOMY_FEATURE_KEYS as [string, ...string[]]),
    mode: z.enum(['OFF', 'PROPOSE', 'AUTO_UNDER_LIMIT']),
    // bigint cents; null clears the cap. Non-negative integer.
    materialityLimitCents: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional()
      .default(null),
  })
  .strict();

export type UpdateAutonomyInput = z.infer<typeof updateAutonomySchema>;

/** POST /api/autonomy — engage / disengage the global kill switch. */
export const killSwitchSchema = z
  .object({
    engaged: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export type KillSwitchInput = z.infer<typeof killSwitchSchema>;
