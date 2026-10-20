export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { templateUpdateDecideSchema } from '@/lib/validations/access-governance';
import { dbErrorResponse, requestIp, resolveGovActor } from '@/lib/access-governance/server';

/**
 * POST /api/access/template-updates/decide { updateId, add[], skip[], publish?, reason? }
 *
 * Add puts each chosen MeritBooks suggestion into the role's Proposed changes (its single
 * draft, created on demand); Skip drops it for this role. Skipping everything = keep Current
 * (no new version). `publish: true` (with a reason) makes the Proposed changes Current now.
 * Authority: core.template_update_decide (tenant admin or core.access.roles:configure).
 */
export const POST = apiHandler(templateUpdateDecideSchema, async (body, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  const { data: upd } = await admin
    .schema('core')
    .from('template_updates')
    .select('id')
    .eq('id', body.updateId)
    .eq('org_id', actor.orgId)
    .maybeSingle();
  if (!upd) return NextResponse.json({ error: 'Suggestion not found', code: 'NOT_FOUND' }, { status: 404 });

  const { data, error } = await admin.schema('core').rpc('template_update_decide', {
    p_update: body.updateId,
    p_user: actor.userId,
    p_add: body.add,
    p_skip: body.skip,
    p_publish: body.publish,
    p_reason: body.reason ?? null,
    p_ip: requestIp(),
  });
  if (error) return dbErrorResponse(error);
  return NextResponse.json({ data });
});
