export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { dashboardQuery } from '@/lib/validations/vendor-compliance';
import { buildDashboard } from '@/lib/vendor-compliance/dashboard';
import { noOrg, vcView } from '@/lib/vendor-compliance/route-auth';

/**
 * GET /api/vendor-compliance/dashboard?location_id= — compliant / expiring / missing /
 * on hold / waiting for review / bank changes, by company, with each vendor's requirement
 * strip. Read AS THE MEMBER (RLS: org + client scope). compliance:view.
 */
export const GET = apiQueryHandler(dashboardQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await vcView(userId, '/api/vendor-compliance/dashboard');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const d = await buildDashboard(supabase, orgId, { locationId: q.location_id ?? null });
  return NextResponse.json(d);
});
