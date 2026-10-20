/** Zod request schemas shared by the plan and apply routes. */
import { z } from 'zod';

const Key = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/);
const Answer = z.union([z.boolean(), z.number(), z.string().max(80), z.array(z.string().max(80)).max(20)]);

export const PlanInputsSchema = z.object({
  companyId: z.string().uuid(),
  packKey: Key,
  addons: z.array(Key).max(4).default([]),
  params: z.record(z.string().max(48), z.union([z.boolean(), z.number(), z.string().max(48)])).optional(),
  answers: z.record(z.string().max(100), Answer).default({}),
  moduleOverrides: z.record(z.string().max(48), z.boolean()).default({}),
  aiDecisionId: z.string().uuid().nullable().optional(),
  mode: z.enum(['first', 'change']).default('first'),
});

export const ApplySchema = PlanInputsSchema.extend({
  /** the plan_hash the user previewed; apply refuses anything else */
  expectedPlanHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type PlanBody = z.infer<typeof PlanInputsSchema>;
export type ApplyBody = z.infer<typeof ApplySchema>;
