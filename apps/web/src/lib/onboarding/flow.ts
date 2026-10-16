/**
 * Onboarding company-state router (server-side).
 *
 * The onboarding surface a user gets is decided by the COMPANY's state, never by the
 * user self-selecting (design spec §2):
 *
 *   - Company not yet set up (no GL activity / not flagged complete) → FULL SETUP for
 *     anyone who can run it (admin OR delegated staff). A member who CAN'T run setup
 *     (an invitee joining a company someone else is setting up) gets the tour, then
 *     the dashboard — never a setup surface the page guard would bounce them out of.
 *   - Already-live company + a member who cannot run setup (a brand-new teammate) →
 *     a guided TOUR, never a setup surface they'd be bounced out of.
 *   - Otherwise (a live company + someone who CAN run setup, e.g. an admin revisiting
 *     to add a company or teammates) → the wizard renders as it does today.
 *
 * FAIL-SAFE: an unresolved org is treated as complete/live and NEVER routed to the
 * tour or trapped in setup — exactly the existing status-route fail-safe. Any lookup
 * error degrades to `live` (the wizard's existing page guards then govern), so this
 * router can only ever ADD the tour branch; it can never trap a user.
 *
 * This reuses the SAME org resolution as the RBAC page guard (verified Clerk `org_id`
 * claim → Books tenant uuid, with a single-active-membership fallback) and the SAME
 * first-run signal the status route derives — no new schema, no new source of truth.
 */

import { auth, clerkClient } from '@clerk/nextjs/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTenantOrgId } from '@/lib/rbac/resolve-tenant';
import { createAdminSupabase } from '@/lib/supabase/server';
import { effectivePermission } from '@/lib/rbac/resolve-permissions';
import { hasSeenTour } from '@/app/(app)/onboarding/tour/tour-seen';
import { loadRouterOnboarding } from './status';
import {
  decideFrontDoor,
  decideOnboardingFlow,
  isSetupOwner,
  type CallerOnboardingRole,
  type FrontDoorDestination,
} from './front-door';

/**
 * The flows the onboarding route can resolve to. `tour` and `dashboard` redirect;
 * `setup` / `live` render the wizard behind its page guards.
 */
export type OnboardingFlow = 'setup' | 'tour' | 'live' | 'dashboard';

/** Query overrides accepted by the onboarding route (Next.js searchParams shape). */
export interface OnboardingFlowSearchParams {
  tour?: string | string[];
  setup?: string | string[];
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Resolve the caller's org from the single active membership, when unambiguous. */
async function singleActiveMembershipOrg(admin: SupabaseClient, clerkUserId: string): Promise<string | null> {
  const { data: user, error: userErr } = await admin
    .schema('core').from('users').select('id').eq('clerk_user_id', clerkUserId).maybeSingle();
  if (userErr || !user?.id) return null;
  const { data: memberships, error: memErr } = await admin
    .schema('core').from('memberships').select('org_id').eq('user_id', user.id).eq('status', 'active').limit(2);
  if (memErr || !memberships || memberships.length !== 1) return null;
  const orgId = (memberships[0] as { org_id?: unknown }).org_id;
  return typeof orgId === 'string' && orgId.length > 0 ? orgId : null;
}

/**
 * Is the company already live? Mirrors the status route's `complete` signal without
 * needing an RLS-scoped client: an explicit `onboarding_state.complete` flag OR any
 * posted GL activity (org-scoped count on the admin client — org_id is a real column
 * on gl_entries, so this is correct even though admin bypasses RLS).
 */
async function isCompanyLive(admin: SupabaseClient, orgId: string): Promise<boolean> {
  const { data: org } = await admin
    .schema('core').from('organizations').select('onboarding_state').eq('id', orgId).maybeSingle();
  const state = (org as { onboarding_state?: unknown } | null)?.onboarding_state;
  if (state && typeof state === 'object' && (state as { complete?: unknown }).complete === true) return true;

  const { count } = await admin
    .from('gl_entries').select('id', { count: 'exact', head: true }).eq('org_id', orgId);
  return (count ?? 0) > 0;
}

/**
 * Can this caller run the setup wizard (settings_acct:edit)? Reads the role from the
 * canonical spine (memberships) with the interim employees fallback — the SAME
 * resolution the page guard uses — then evaluates the permission (custom-role-aware,
 * degrade-safe). Fails closed to `false` on any absence/error, which correctly routes
 * a brand-new teammate to the tour rather than a wizard they can't use.
 */
async function callerCanRunSetup(admin: SupabaseClient, orgId: string, clerkUserId: string): Promise<boolean> {
  try {
    const { data: user } = await admin
      .schema('core').from('users').select('id').eq('clerk_user_id', clerkUserId).maybeSingle();

    let rawRole: string | null = null;
    if (user?.id) {
      const { data: membership } = await admin
        .schema('core').from('memberships')
        .select('role').eq('user_id', user.id).eq('org_id', orgId).eq('status', 'active').maybeSingle();
      rawRole = (membership?.role as string | undefined) ?? null;
    }
    if (!rawRole) {
      const { data: emp } = await admin
        .schema('core').from('employees')
        .select('role').eq('org_id', orgId).eq('clerk_user_id', clerkUserId).eq('is_active', true).maybeSingle();
      rawRole = (emp?.role as string | undefined) ?? null;
    }
    if (!rawRole) return false;
    return await effectivePermission(admin, orgId, rawRole, 'settings_acct', 'edit');
  } catch {
    return false;
  }
}

/**
 * Who is this caller in the org's onboarding? (see lib/onboarding/front-door.ts)
 *   canRunSetup    — settings_acct:edit
 *   isInvitee      — joined by accepting a core.membership_invitations row
 *   ownsOnboarding — named onboarding owner of a company (practice_assignments
 *                    function 'onboarding' → their employee row)
 * Best-effort: a missing table/column reads as "not an invitee / owns nothing", which
 * keeps pre-invitation tenants behaving exactly as before.
 */
export async function loadCallerOnboardingRole(
  admin: SupabaseClient,
  orgId: string,
  clerkUserId: string,
): Promise<CallerOnboardingRole> {
  const [canRunSetup, isInvitee, ownsOnboarding] = await Promise.all([
    callerCanRunSetup(admin, orgId, clerkUserId),
    (async () => {
      try {
        const { data, error } = await admin
          .schema('core').from('membership_invitations')
          .select('id').eq('org_id', orgId).eq('status', 'accepted').eq('accepted_clerk_id', clerkUserId)
          .limit(1);
        return !error && Array.isArray(data) && data.length > 0;
      } catch {
        return false;
      }
    })(),
    (async () => {
      try {
        const { data: emp } = await admin
          .schema('core').from('employees')
          .select('id').eq('org_id', orgId).eq('clerk_user_id', clerkUserId).eq('is_active', true).maybeSingle();
        const empId = (emp as { id?: unknown } | null)?.id;
        if (typeof empId !== 'string') return false;
        const { data, error } = await admin
          .schema('core').from('practice_assignments')
          .select('id').eq('org_id', orgId).eq('function', 'onboarding').eq('assignee_employee_id', empId)
          .limit(1);
        return !error && Array.isArray(data) && data.length > 0;
      } catch {
        return false;
      }
    })(),
  ]);
  return { canRunSetup, isInvitee, ownsOnboarding };
}

/** Has this Clerk user seen the first-login tour? (Clerk publicMetadata; false on any error.) */
export async function readHasSeenTour(clerkUserId: string): Promise<boolean> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(clerkUserId);
    return hasSeenTour(user.publicMetadata as Record<string, unknown> | null);
  } catch {
    return false;
  }
}

/**
 * THE front-door decision (root router + dashboard first-run redirect share it, so the
 * logic never forks). Setup owners go to onboarding while a company isn't live, else
 * the dashboard; invitees / members who can't run setup get the tour once, then the
 * dashboard. Degrade-safe: any failure → '/dashboard' (never trap a user).
 */
export async function resolveFrontDoor(opts: {
  db: SupabaseClient;
  orgId: string;
  clerkUserId: string;
  admin?: SupabaseClient;
}): Promise<FrontDoorDestination> {
  try {
    const admin = opts.admin ?? createAdminSupabase();
    const [{ needsOnboarding }, role] = await Promise.all([
      loadRouterOnboarding(opts.db, admin, opts.orgId),
      loadCallerOnboardingRole(admin, opts.orgId, opts.clerkUserId),
    ]);
    // Only a non-owner can be sent to the tour — skip the Clerk read for owners.
    const seen = isSetupOwner(role) ? true : await readHasSeenTour(opts.clerkUserId);
    return decideFrontDoor({ ...role, needsOnboarding, hasSeenTour: seen });
  } catch {
    return '/dashboard';
  }
}

/**
 * The "brand-new member" signal, best-effort. Returns the age (ms) of the caller's
 * membership in this org, or null when it can't be derived. Exposed for later waves;
 * the Wave-0 tour gate does NOT depend on it (see `resolveOnboardingFlow`).
 *
 * NOTE (reported): membership recency is a proxy, not a true "first login" flag — it
 * re-reads true across repeat visits inside the window. A durable per-user signal
 * (a `tour_seen_at` on core.memberships, or a `?tour=1` invite link) is the clean
 * source we'd want; see the Wave-0 report.
 */
export async function membershipAgeMs(admin: SupabaseClient, orgId: string, clerkUserId: string): Promise<number | null> {
  try {
    const { data: user } = await admin
      .schema('core').from('users').select('id').eq('clerk_user_id', clerkUserId).maybeSingle();
    if (!user?.id) return null;
    const { data: membership } = await admin
      .schema('core').from('memberships')
      .select('created_at').eq('user_id', user.id).eq('org_id', orgId).maybeSingle();
    const createdAt = (membership as { created_at?: unknown } | null)?.created_at;
    if (typeof createdAt !== 'string') return null;
    const ms = Date.now() - new Date(createdAt).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Decide the onboarding flow from company state. Only `tour` triggers a redirect;
 * `setup` and `live` both fall through to the wizard's existing page guards (so
 * behavior for admins/first-run is unchanged).
 */
export async function resolveOnboardingFlow(sp?: OnboardingFlowSearchParams): Promise<OnboardingFlow> {
  try {
    const a = await auth().catch(() => null);
    const clerkUserId = a?.userId ?? null;
    if (!clerkUserId) return 'setup'; // unauthenticated → let the wizard's sign-in guard handle it; never tour

    const setupForced = firstParam(sp?.setup) === '1';
    const tourForced = firstParam(sp?.tour) === '1';
    if (setupForced) return 'setup';

    const admin = createAdminSupabase();
    const claims = (a?.sessionClaims ?? null) as Record<string, unknown> | null;
    const claimOrgId = typeof claims?.org_id === 'string' ? claims.org_id : null;
    const orgId = (await resolveTenantOrgId(claimOrgId, admin)) ?? (await singleActiveMembershipOrg(admin, clerkUserId));

    // Fail-safe: unresolved org → treated as complete/live; never trap in tour or setup.
    if (!orgId) return 'live';

    const [live, canRunSetup] = await Promise.all([
      isCompanyLive(admin, orgId),
      callerCanRunSetup(admin, orgId, clerkUserId),
    ]);
    // A caller who CAN run setup gets the wizard (setup while not live, else as an
    // admin revisiting). A caller who CAN'T — e.g. an invitee joining a company that's
    // still being set up by someone else — is never routed into setup (the page guard
    // would only bounce them): they get the tour, or the dashboard once it's seen.
    // Explicit ?tour=1 on a live company always shows the tour.
    const seen = canRunSetup || tourForced ? true : await readHasSeenTour(clerkUserId);
    return decideOnboardingFlow({ companyLive: live, canRunSetup, hasSeenTour: seen, tourForced });
  } catch {
    // Any failure degrades to `live` — the router can only ADD the tour branch, never
    // trap a user. The wizard's own page guards then govern.
    return 'live';
  }
}
