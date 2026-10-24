export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { setFluxWaiver } from '@/lib/close/flux/service';
import { fluxErrorResponse, noOrg } from '@/lib/close/flux/route-support';

/**
 * POST /api/close/flux/waiver — a controller lets the "Flux review" close task pass without
 * every material line reviewed ({ waive: true, reason ≥ 10 chars }), or withdraws that
 * waiver ({ waive: false }). close_mgmt:manage only; logged to core.action_log.
 */
const schema = z.object({
  location_id: z.string().uuid(),
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  waive: z.boolean(),
  reason: z.string().max(1000).nullable().optional(),
});

export const POST = apiHandler(schema, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'manage', { locationId: b.location_id });
  if (!guard.ok) return guard.response;
  try {
    const res = await setFluxWaiver(ctx.supabase, { orgId: ctx.orgId, userId: ctx.userId, locationId: b.location_id, year: b.year, month: b.month, waive: b.waive, reason: b.reason ?? null });
    await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
      action: b.waive ? 'close.flux.waive' : 'close.flux.unwaive',
      subjectTable: 'flux_reviews',
      subjectId: null,
      summary: b.waive
        ? `Waived the flux review for ${b.year}-${String(b.month).padStart(2, '0')}: ${res.reason}`
        : `Withdrew the flux review waiver for ${b.year}-${String(b.month).padStart(2, '0')}`,
      locationId: b.location_id,
      metadata: { reason: res.reason },
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return fluxErrorResponse(e, 'close/flux/waiver');
  }
});
