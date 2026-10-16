export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveFrontDoor } from '@/lib/onboarding/flow';

/**
 * Root router — "one front door" (FPB-onboarding §2 principle 1, §4 B6).
 *
 * Sign-in lands here and the user is sent to their NEXT UNFINISHED THING, decided on
 * the server in one pass (no client round-trips, no flash):
 *   - Not signed in                        → /sign-in
 *   - No resolvable organization           → /setup (create the organization — or,
 *                                            for an existing member whose session has
 *                                            no active org, re-activate it)
 *   - The org's SETUP OWNER, with a company
 *     that is not yet live                 → /onboarding (per-company first run)
 *   - An INVITEE / member who can't run
 *     setup, first login (tour not seen)   → /onboarding/tour
 *   - Otherwise                            → /dashboard
 * (Decision: lib/onboarding/front-door.ts — shared with the dashboard first-run redirect.)
 *
 * The org is the SAME one every API route resolves (requireAuth → resolveTenantOrgId,
 * claim-first, no first-org fallback). Liveness is per company (lib/onboarding/status
 * `loadRouterOnboarding`): opening balances posted, an explicit start-fresh choice, or
 * — in an established org — real posted books. Any failure degrades to /dashboard;
 * the router can never trap a user.
 */
export default async function RootPage() {
  let destination = '/dashboard';

  try {
    const authed = await requireAuth();
    if (authed instanceof NextResponse) {
      destination = '/sign-in';
    } else if (!authed.orgId) {
      destination = '/setup';
    } else {
      const db = await createAuthedServerSupabase();
      if (db) {
        destination = await resolveFrontDoor({
          db, admin: createAdminSupabase(), orgId: authed.orgId, clerkUserId: authed.userId,
        });
      }
    }
  } catch {
    destination = '/dashboard';
  }

  // redirect() throws a control-flow signal — keep it outside the try.
  redirect(destination);
}
