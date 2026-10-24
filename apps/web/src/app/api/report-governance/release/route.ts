import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { releasePeriod } from '@/lib/reports/governance/releases';
import { governanceError, noOrg } from '@/lib/reports/governance/http';
import { monthLabel, periodKey } from '@/lib/reports/governance/periods';

export const dynamic = 'force-dynamic';

const body = z.object({
  location_id: z.string().uuid(),
  year: z.number().int().min(1900).max(9999),
  month: z.number().int().min(1).max(12),
  note: z.string().trim().max(500).optional().nullable(),
});

/**
 * POST /api/report-governance/release — release one company-month to non-finance audiences
 * (owner / partner / lender / department head). Requires close_mgmt:manage. The month must
 * have ended and be soft- or hard-closed. Captures the baseline snapshot; a re-release first
 * compares against the previous one (restatement). Logged to the action log.
 */
export const POST = apiHandler(body, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'manage', { locationId: b.location_id, route: '/api/report-governance/release' });
  if (!guard.ok) return guard.response;
  try {
    const r = await releasePeriod(ctx.supabase, ctx.orgId, ctx.userId, { locationId: b.location_id, year: b.year, month: b.month, note: b.note ?? null });
    if (!r.alreadyReleased) {
      await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
        action: 'reports.release',
        subjectTable: 'report_releases',
        subjectId: r.releaseId,
        locationId: b.location_id,
        summary: `Released ${monthLabel(periodKey(b.year, b.month))} to partners${r.restatementId ? ' (numbers changed since last release — restatement logged)' : ''}`,
        metadata: { year: b.year, month: b.month, snapshotId: r.snapshotId, restatementId: r.restatementId, note: b.note ?? null },
      });
    }
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return governanceError(e);
  }
});
