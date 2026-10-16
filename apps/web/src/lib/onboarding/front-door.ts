/**
 * Front-door decisions — PURE (no I/O), unit-tested. Used by the root router
 * (`app/(app)/page.tsx`), the dashboard first-run redirect, and the onboarding
 * company-state router (`lib/onboarding/flow.ts`) so the three can never disagree.
 *
 * Who is the SETUP OWNER of an org's onboarding?
 *   • someone who can run setup (settings_acct:edit), AND
 *   • either joined the org on their own (not via an invitation — i.e. the person who
 *     created it / started setup), or was invited AS an onboarding owner (the
 *     "Invite my bookkeeper to finish this" path materializes a practice_assignments
 *     'onboarding' row for them).
 *
 * Everyone else is an INVITEE: they're joining an org whose company is live, or is
 * being set up by somebody else. An invitee never gets dropped into setup (they'd be
 * bounced by the page guard, or would trample the owner's work) — they get the
 * first-login tour once, then the dashboard.
 */

export type FrontDoorDestination = '/onboarding' | '/onboarding/tour' | '/dashboard';

export interface CallerOnboardingRole {
  /** settings_acct:edit — may run the setup wizard. */
  canRunSetup: boolean;
  /** Joined this org by accepting an invitation. */
  isInvitee: boolean;
  /** Assigned as the onboarding owner of at least one company in this org. */
  ownsOnboarding: boolean;
}

export interface FrontDoorInput extends CallerOnboardingRole {
  /** The org has a company that is not yet live (first run; established orgs are grandfathered). */
  needsOnboarding: boolean;
  /** The caller has already seen (or skipped) the first-login tour. */
  hasSeenTour: boolean;
}

export function isSetupOwner(role: CallerOnboardingRole): boolean {
  return role.canRunSetup && (!role.isInvitee || role.ownsOnboarding);
}

/** Where sign-in (the `/` router) sends this caller. Never traps: the fallback is the dashboard. */
export function decideFrontDoor(input: FrontDoorInput): FrontDoorDestination {
  if (isSetupOwner(input)) return input.needsOnboarding ? '/onboarding' : '/dashboard';
  return input.hasSeenTour ? '/dashboard' : '/onboarding/tour';
}

/**
 * The `/onboarding` route's company-state decision for a caller.
 *   setup     — render the wizard (company not live and this caller can run it)
 *   live      — render the wizard (live company, caller can run setup: an admin revisiting)
 *   tour      — the guided tour (a member who can't run setup, first time)
 *   dashboard — a member who can't run setup and has already seen the tour
 * A caller who can't run setup is NEVER sent to `setup` (they'd be bounced by the page
 * guard) — whether or not the company is live yet.
 */
export type OnboardingFlowDecision = 'setup' | 'tour' | 'live' | 'dashboard';

export function decideOnboardingFlow(input: {
  companyLive: boolean;
  canRunSetup: boolean;
  hasSeenTour: boolean;
  tourForced?: boolean;
}): OnboardingFlowDecision {
  if (input.tourForced && input.companyLive) return 'tour';
  if (input.canRunSetup) return input.companyLive ? 'live' : 'setup';
  if (input.tourForced) return 'tour';
  return input.hasSeenTour ? 'dashboard' : 'tour';
}
