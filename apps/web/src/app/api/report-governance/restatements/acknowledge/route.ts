import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { acknowledgeRestatement } from '@/lib/reports/governance/restatements';
import { governanceError, noOrg } from '@/lib/reports/governance/http';

export const dynamic = 'force-dynamic';

const body = z.object({
  id: z.string().uuid(),
  note: z.string().trim().min(4, 'Say what changed and why (at least 4 characters)').max(1000),
});

/** POST /api/report-governance/restatements/acknowledge — finance explains a restatement. */
export const POST = apiHandler(body, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'manage', { route: '/api/report-governance/restatements/acknowledge' });
  if (!guard.ok) return guard.response;
  try {
    const r = await acknowledgeRestatement(ctx.supabase, ctx.orgId, ctx.userId, b.id, b.note);
    await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
      action: 'reports.restatement.acknowledge',
      subjectTable: 'report_restatements',
      subjectId: b.id,
      locationId: r.locationId,
      summary: `Explained the restatement of ${r.year}-${String(r.month).padStart(2, '0')}: ${b.note}`,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return governanceError(e);
  }
});
