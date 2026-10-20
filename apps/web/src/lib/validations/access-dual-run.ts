import { z } from 'zod';

// =============================================================
// R-11 dual-run admin (POST /api/settings/access/dual-run)
// =============================================================

/** The phrase a tenant admin types to switch enforcement to the capability model. */
export const ENFORCE_CONFIRMATION = 'ENFORCE';

export const dualRunFlipSchema = z
  .object({
    op: z.literal('set_mode'),
    mode: z.enum(['legacy', 'dual', 'v2']),
    /** Must equal ENFORCE_CONFIRMATION for mode = v2; `true`-equivalent for the others. */
    confirmation: z.string().trim().max(32),
    reason: z.string().trim().min(3, 'Give a short reason').max(500),
  })
  .refine((v) => v.mode !== 'v2' || v.confirmation === ENFORCE_CONFIRMATION, {
    message: `Type ${ENFORCE_CONFIRMATION} to confirm`,
    path: ['confirmation'],
  })
  .refine((v) => v.mode === 'v2' || v.confirmation.length > 0, {
    message: 'Confirmation required',
    path: ['confirmation'],
  });

export const dualRunExplainSchema = z.object({
  op: z.literal('explain'),
  capability: z.string().trim().min(1).max(200),
  action: z.string().trim().min(1).max(40),
  route: z.string().trim().min(1).max(300),
  note: z.string().trim().min(10, 'Explain why this difference is expected (10+ characters)').max(1000),
});

/** A second tenant admin confirms (or anyone cancels) a pending downgrade (mig 170). */
export const dualRunConfirmSchema = z.object({
  op: z.enum(['confirm_mode', 'cancel_mode']),
  requestId: z.string().uuid(),
});

export const dualRunPostSchema = z.union([dualRunFlipSchema, dualRunExplainSchema, dualRunConfirmSchema]);
export type DualRunPostInput = z.infer<typeof dualRunPostSchema>;
