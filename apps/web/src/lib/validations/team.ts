import { z } from 'zod';

// =============================================================
// TEAM & ACCESS — member management
// =============================================================
// Kept in lock-step with UserRole in lib/rbac/permissions.ts. The literal tuple
// (rather than casting ALL_ROLES) keeps the inferred type identical to UserRole
// so a divergence is a compile error, not a silent runtime miss.

export const memberRoleSchema = z.enum([
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

export const createMemberSchema = z.object({
  email: z.string().email().max(200),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  role: memberRoleSchema,
  companyIds: z.array(z.string().uuid()).default([]),
});

export const updateMemberSchema = z
  .object({
    role: memberRoleSchema.optional(),
    companyIds: z.array(z.string().uuid()).optional(),
    /** Companies this member OWNS the onboarding for. A subset of the companies they
     *  can access; recorded as core.practice_assignments(function='onboarding'). When
     *  present it replaces this member's onboarding ownership wholesale. */
    onboardingCompanyIds: z.array(z.string().uuid()).optional(),
  })
  .refine(
    (v) => v.role !== undefined || v.companyIds !== undefined || v.onboardingCompanyIds !== undefined,
    { message: 'Provide at least one of role, companyIds, or onboardingCompanyIds' },
  );

export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
