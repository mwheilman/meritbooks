export const dynamic = 'force-dynamic';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveFrontDoor } from '@/lib/onboarding/flow';
import { readInitialCompany } from '@/lib/company-scope-server';
import { isSpecificCompany } from '@/lib/company-scope';
import { WorkspaceHome } from './workspace-home';
import { ClientHome } from './client-home';
import { HomeSkeleton } from './home-skeleton';

export const metadata = { title: 'Home' };

/**
 * First-run redirect (FPB B6): the org's setup owner with a company that isn't live yet
 * belongs in onboarding, not an empty dashboard. Uses the SAME decision as the `/`
 * router (lib/onboarding/flow `resolveFrontDoor`) so the two never fork. Established
 * orgs are grandfathered (never redirected), invitees are never sent to setup, any
 * failure stays on the dashboard, and `?stay=1` (the wizard's "Go to dashboard" link)
 * always stays — no one is ever trapped.
 */
async function firstRunRedirect(stay: boolean): Promise<string | null> {
  if (stay) return null;
  try {
    const authed = await requireAuth();
    if (authed instanceof NextResponse || !authed.orgId) return null;
    const db = await createAuthedServerSupabase();
    if (!db) return null;
    const dest = await resolveFrontDoor({
      db, admin: createAdminSupabase(), orgId: authed.orgId, clerkUserId: authed.userId,
    });
    return dest === '/onboarding' ? '/onboarding' : null;
  } catch {
    return null;
  }
}

/**
 * HOME (Redesign R1, merit-ui). Two homes behind one route, picked by the ⌘J context:
 *
 *   - No client picked → the WORKSPACE home (board S1): your clients ranked by work
 *     left, the cross-client queues, cash/AR/AP and close progress. Read-only; every
 *     row and count enters a client.
 *   - A client picked  → that CLIENT's home (board S2): the four-step books-review loop
 *     (Review · Reconcile · Check · Close), the open feed in Decide / Check / Ready
 *     bands with the Decide list, money and the latest activity.
 *
 * All figures are live, RLS-scoped reads (dashboard/actions.ts). No banner, no greeting:
 * the context line, then the primary module top-left.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  const stayParam = searchParams?.stay;
  const target = await firstRunRedirect((Array.isArray(stayParam) ? stayParam[0] : stayParam) === '1');
  // redirect() throws a control-flow signal — keep it outside the try.
  if (target) redirect(target);

  // The same cookie-backed context the shell shows (validated against the caller's
  // client scope in readInitialCompany).
  const company = await readInitialCompany();
  const clientId = isSpecificCompany(company.id) ? company.id : null;

  return (
    <Suspense key={clientId ?? 'workspace'} fallback={<HomeSkeleton kind={clientId ? 'client' : 'workspace'} />}>
      {clientId ? <ClientHome locationId={clientId} /> : <WorkspaceHome />}
    </Suspense>
  );
}
