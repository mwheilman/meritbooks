import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { checkRestatements } from '@/lib/reports/governance/restatements';
import { governanceError, noOrg } from '@/lib/reports/governance/http';

export const dynamic = 'force-dynamic';

const body = z.object({ location_ids: z.array(z.string().uuid()).max(200).optional() });

/** POST /api/report-governance/restatements/check — re-check released months now. */
export const POST = apiHandler(body, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'manage', { route: '/api/report-governance/restatements/check' });
  if (!guard.ok) return guard.response;
  try {
    const r = await checkRestatements(ctx.supabase, ctx.orgId, { locationIds: b.location_ids, detection: 'MANUAL', actor: ctx.userId });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return governanceError(e);
  }
});
