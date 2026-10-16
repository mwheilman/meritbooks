/**
 * Pure logic behind <InviteHelper/> (FPB-onboarding §5, principle 8 "Delegate
 * anything"): which roles can actually finish onboarding, the default, the request
 * body sent to POST /api/team/invitations, and plain-English error mapping.
 *
 * Kept out of the component so it is unit-tested and so the role list is DERIVED from
 * permissions.ts (never a hard-coded guess that drifts).
 */

import { ALL_ROLES, ROLE_DEFINITIONS, hasPermission, type UserRole } from '@/lib/rbac/permissions';

/** The onboarding wizard's page gate (app/(app)/onboarding/page.tsx). */
const RUN_SETUP: [string, 'edit'] = ['settings_acct', 'edit'];
/** The go-live post's gate (api/onboarding/conversion/[id]/post). */
const POST_OPENING: [string, 'post'] = ['journal_entries', 'post'];

export const DEFAULT_ONBOARDING_ROLE: UserRole = 'accounting_manager';

export interface OnboardingRoleOption {
  role: UserRole;
  label: string;
  /** One plain-English line on what this person will be able to do. */
  hint: string;
  /** Can also approve + post the opening balances (go-live). */
  canGoLive: boolean;
}

/** Display order: the bookkeeper-shaped role first, the owner-shaped role last. */
const ORDER: UserRole[] = ['accounting_manager', 'cfo', 'company_admin'];

function hintFor(role: UserRole, canGoLive: boolean): string {
  if (role === 'company_admin') return 'Full access, including inviting people and billing.';
  return canGoLive
    ? 'Can finish setup and approve your opening balances.'
    : 'Can finish setup, but someone else approves the opening balances.';
}

/** Roles that can run the onboarding wizard — derived from the live permission map. */
export function onboardingCapableRoles(): OnboardingRoleOption[] {
  const capable = ALL_ROLES.filter((r) => hasPermission(r, RUN_SETUP[0], RUN_SETUP[1]));
  const ordered = [
    ...ORDER.filter((r) => capable.includes(r)),
    ...capable.filter((r) => !ORDER.includes(r)),
  ];
  return ordered.map((role) => {
    const canGoLive = hasPermission(role, POST_OPENING[0], POST_OPENING[1]);
    return { role, label: ROLE_DEFINITIONS[role].label, hint: hintFor(role, canGoLive), canGoLive };
  });
}

/** The caller's requested default if it can run onboarding; otherwise the safe default. */
export function resolveDefaultRole(requested: string | null | undefined): UserRole {
  const options = onboardingCapableRoles();
  const hit = options.find((o) => o.role === requested);
  if (hit) return hit.role;
  if (options.some((o) => o.role === DEFAULT_ONBOARDING_ROLE)) return DEFAULT_ONBOARDING_ROLE;
  return options[0]?.role ?? DEFAULT_ONBOARDING_ROLE;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isPlausibleEmail(v: string): boolean {
  return EMAIL_RE.test(v.trim());
}

export interface InviteRequestBody {
  email: string;
  firstName?: string;
  role: UserRole;
  companyIds: string[];
  onboardingCompanyIds: string[];
  context: string;
}

/**
 * Body for POST /api/team/invitations. With a company, the invitee gets access to it
 * AND is named its onboarding owner (materialized on first login); `context` tells
 * them what they were asked to finish (email body + action log).
 */
export function buildInviteRequest(input: {
  email: string;
  firstName?: string | null;
  role: UserRole;
  companyId?: string | null;
  context: string;
}): InviteRequestBody {
  const companyIds = input.companyId ? [input.companyId] : [];
  const firstName = input.firstName?.trim();
  return {
    email: input.email.trim().toLowerCase(),
    ...(firstName ? { firstName } : {}),
    role: input.role,
    companyIds,
    onboardingCompanyIds: companyIds,
    context: input.context.trim().slice(0, 200),
  };
}

/** Plain-English message for a failed invite (status + API error code). */
export function inviteErrorMessage(status: number, code: string | undefined, fallback?: string): string {
  if (status === 403) return 'Only a Company Admin can invite people. Ask your admin to send this invite.';
  if (code === 'ALREADY_MEMBER') return 'That person is already on your team — they can sign in and pick this up now.';
  if (code === 'DUPLICATE_INVITE') return 'That person already has an invite waiting. You can resend it from Team.';
  if (code === 'INVITATIONS_UNAVAILABLE' || status === 503) return 'Invitations aren’t switched on for this workspace yet.';
  if (code === 'VALIDATION_ERROR' || status === 422) return 'Check the email address and try again.';
  if (code === 'NETWORK_ERROR' || status === 0) return 'Couldn’t reach MeritBooks — check your connection and try again.';
  return fallback || 'The invite couldn’t be sent. Please try again.';
}
