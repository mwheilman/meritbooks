import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { withdrawRelease } from '@/lib/reports/governance/releases';
import { governanceError, noOrg } from '@/lib/reports/governance/http';
import { monthLabel, periodKey } from '@/lib/reports/governance/periods';

export const dynamic = 'force-dynamic';

const body = z.object({
  location_id: z.string().uuid(),
  year: z.number().int().min(1900).max(9999),
  month: z.number().int().min(1).max(12),
  reason: z.string().trim().min(4, 'Give a reason (at least 4 characters)').max(500),
});

/**
 * POST /api/report-governance/withdraw — take a released month back from non-finance
 * audiences (also stops the auto rule from releasing it). Reason required; close_mgmt:manage.
 */
export const POST = apiHandler(body, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'manage', { locationId: b.location_id, route: '/api/report-governance/withdraw' });
  if (!guard.ok) return guard.response;
  try {
    const r = await withdrawRelease(ctx.supabase, ctx.orgId, ctx.userId, { locationId: b.location_id, year: b.year, month: b.month, reason: b.reason });
    await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
      action: 'reports.release.withdraw',
      subjectTable: 'report_releases',
      subjectId: r.releaseId,
      locationId: b.location_id,
      summary: `Withdrew ${monthLabel(periodKey(b.year, b.month))} from partners: ${b.reason}`,
      metadata: { year: b.year, month: b.month, reason: b.reason },
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return governanceError(e);
  }
});
