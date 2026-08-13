/**
 * Onboarding company-state router (server-side).
 *
 * The onboarding surface a user gets is decided by the COMPANY's state, never by the
 * user self-selecting (design spec §2):
 *
 *   - Company not yet set up (no GL activity / not flagged complete) → FULL SETUP.
 *     Whoever runs the inaugural login runs it — admin OR delegated staff.
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

import { auth } from '@clerk/nextjs/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTenantOrgId } from '@/lib/rbac/resolve-tenant';
import { createAdminSupabase } from '@/lib/supabase/server';
import { effectivePermission } from '@/lib/rbac/resolve-permissions';

/** The three flows the onboarding route can resolve to. Only `tour` redirects. */
export type OnboardingFlow = 'setup' | 'tour' | 'live';

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

    // Company not set up → full setup, regardless of who is logging in.
    const live = await isCompanyLive(admin, orgId);
    if (!live) return 'setup';

    // Live company. Explicit ?tour=1 always shows the tour. Otherwise: a caller who
    // CANNOT run setup (a brand-new teammate) gets the tour; anyone who can (an admin
    // revisiting) falls through to the wizard exactly as today.
    if (tourForced) return 'tour';
    const canRunSetup = await callerCanRunSetup(admin, orgId, clerkUserId);
    return canRunSetup ? 'live' : 'tour';
  } catch {
    // Any failure degrades to `live` — the router can only ADD the tour branch, never
    // trap a user. The wizard's own page guards then govern.
    return 'live';
  }
}
