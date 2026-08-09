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
  /** Companies this invitee will OWN the onboarding for. Stashed on the invitation and
   *  materialized as core.practice_assignments(function='onboarding') when the seat is
   *  claimed on first login. A subset of companyIds. */
  onboardingCompanyIds: z.array(z.string().uuid()).default([]),
  /** Delegated-admin responsibility (only meaningful for admin-level roles). Omitted
   *  / empty / both-selected => full admin (today's behavior). A single capability
   *  restricts: MANAGEMENT (delegates the books) or PREPARER (does the books). */
  adminScope: z.array(z.enum(['MANAGEMENT', 'PREPARER'])).optional(),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
