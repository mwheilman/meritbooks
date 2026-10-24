import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadPeriodDetail } from '@/lib/reports/governance/calendar-service';
import { governanceError, noOrg } from '@/lib/reports/governance/http';

export const dynamic = 'force-dynamic';

const query = z.object({
  location_id: z.string().uuid(),
  year: z.coerce.number().int().min(1900).max(9999),
  month: z.coerce.number().int().min(1).max(12),
});

/** GET /api/report-governance/period — one company-month: release row + the reported snapshot. */
export const GET = apiQueryHandler(query, async (q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'view', { locationId: q.location_id, route: '/api/report-governance/period' });
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(await loadPeriodDetail(ctx.supabase, ctx.orgId, q.location_id, q.year, q.month));
  } catch (e) {
    return governanceError(e);
  }
});
