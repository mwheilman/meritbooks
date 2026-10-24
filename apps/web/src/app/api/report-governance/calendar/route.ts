import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { permissionProbe, resolveGovernanceAudience } from '@/lib/reports/governance/audience';
import { loadCalendar } from '@/lib/reports/governance/calendar-service';
import { governanceError, noOrg } from '@/lib/reports/governance/http';

export const dynamic = 'force-dynamic';

const query = z.object({ months: z.coerce.number().int().min(3).max(36).optional() });

/**
 * GET /api/report-governance/calendar — the reporting calendar: per company × month release
 * status, closed-through / released-through, freshness cards, deadline tiles, the restatement
 * log. Close-management view required. Callers who can release first catch the books up
 * (auto releases + restatement check, best effort).
 */
export const GET = apiQueryHandler(query, async (q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'view', { route: '/api/report-governance/calendar' });
  if (!guard.ok) return guard.response;
  try {
    const aud = await resolveGovernanceAudience(permissionProbe(ctx.userId));
    const data = await loadCalendar(ctx.supabase, ctx.orgId, {
      audience: aud.audience,
      canRelease: aud.canRelease,
      actor: ctx.userId,
      months: q.months ?? 12,
    });
    return NextResponse.json(data);
  } catch (e) {
    return governanceError(e);
  }
});
