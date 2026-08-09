import { z } from 'zod';

// =============================================================
// CUSTOMIZABLE RBAC — custom roles + per-cell permission overrides
// =============================================================
// The action enum is kept in lock-step (a literal tuple, not a cast) with FeatureAction
// in lib/rbac/permissions.ts so a divergence is a COMPILE error, not a silent runtime
// miss. Feature ids and (feature, action) validity are additionally checked at runtime
// against FEATURE_CATALOG via isValidCell() in the route — fail closed on anything the
// catalog does not know.

export const featureActionSchema = z.enum([
  'view',
  'create',
  'edit',
  'approve',
  'delete',
  'export',
  'request',
  'post',
  'resolve',
  'reconcile',
  'manage',
  'generate',
  'run',
  'assign',
]);

/** A base role to clone from — one of the 9 system roles, or null for a deny-all base. */
export const baseRoleSchema = z.enum([
  'company_admin',
  'cfo',
  'merit_controller',
  'assistant_cfo',
  'accounting_manager',
  'accounting_specialist',
  'check_processor',
  'general_admin',
  'business_user',
]);

export const createCustomRoleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  /** Clone the shipped grants of this system role as the starting point. Null/omitted =
   *  start from deny-all (every permission explicit). */
  baseRole: baseRoleSchema.nullable().optional(),
});

/** Upsert (grant/deny) a single (role, feature, action) cell. */
export const setOverrideSchema = z.object({
  roleKey: z.string().trim().min(1).max(120),
  feature: z.string().trim().min(1).max(120),
  action: featureActionSchema,
  allowed: z.boolean(),
});

/** Reset a cell back to the system default (delete any stored override). */
export const resetOverrideSchema = z.object({
  roleKey: z.string().trim().min(1).max(120),
  feature: z.string().trim().min(1).max(120),
  action: featureActionSchema,
});

export type CreateCustomRoleInput = z.infer<typeof createCustomRoleSchema>;
export type SetOverrideInput = z.infer<typeof setOverrideSchema>;
export type ResetOverrideInput = z.infer<typeof resetOverrideSchema>;

/**
 * Derive a stable, collision-proof custom-role key from a display name. The 'custom_'
 * prefix GUARANTEES the key can never equal one of the 9 system role keys, so the
 * resolver's system-role-first classification can never be shadowed by a custom role.
 */
export function deriveCustomRoleKey(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `custom_${slug || 'role'}`;
}
