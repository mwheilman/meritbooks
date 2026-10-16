export const dynamic = "force-dynamic";
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveFrontDoor } from '@/lib/onboarding/flow';
import { PageHeader } from '@/components/ui';
import { CompanyBoardGrid } from './company-board';
import { ActivityFeed } from './activity-feed';

function BoardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="card h-20 animate-pulse" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card h-56 animate-pulse" />
        ))}
      </div>
    </div>
  );
}

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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  const stayParam = searchParams?.stay;
  const target = await firstRunRedirect((Array.isArray(stayParam) ? stayParam[0] : stayParam) === '1');
  // redirect() throws a control-flow signal — keep it outside the try.
  if (target) redirect(target);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your cross-company work and status board. Consolidated totals up top, then a card per company — select one to pin it and start working."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Suspense fallback={<BoardSkeleton />}>
            <CompanyBoardGrid />
          </Suspense>
        </div>
        <div>
          <Suspense fallback={<div className="card h-64 animate-pulse" />}>
            <ActivityFeed />
          </Suspense>
        </div>
      </div>
    </>
  );
}
