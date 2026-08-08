import { z } from 'zod';
import { memberRoleSchema } from '@/lib/validations/team';

// =============================================================
// TEAM INVITATIONS — invite a teammate by email + assign a role
// =============================================================
// The role tuple is reused from team.ts (memberRoleSchema), which is kept in
// lock-step with UserRole in lib/rbac/permissions.ts — so an invite can only ever
// carry one of the 9 canonical Books roles. A role that the permission catalog
// doesn't understand can never be minted here, and therefore can never reconcile
// to core.memberships as something un-normalizable.

export const createInvitationSchema = z.object({
  email: z.string().email().max(200),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  role: memberRoleSchema,
  /** Per-company grants, applied to the employee record when the invite is accepted.
   *  Ignored for "all"/"portcos" scopes (they see every company without rows). */
  companyIds: z.array(z.string().uuid()).default([]),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
