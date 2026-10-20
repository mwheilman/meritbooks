export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { accessRequestDecideSchema } from '@/lib/validations/access-governance';
import { dbErrorResponse, requestIp, resolveGovActor } from '@/lib/access-governance/server';

/**
 * POST /api/access/requests/decide { requestId, decision: approve | deny | confirm, note?, roleId?, durationDays? }
 *
 * approve  creates the assignment — core.access_request_decide runs the delegation ceiling
 *          (05 §4.2): you hold the right to grant on that scope, hold everything you grant with
 *          limits ≥ the grant's, the role's band admits you, it can't outlast your own time box,
 *          and it isn't your own request (H1). High-risk grants come back
 *          `needs_second_approval: true` and stay pending.
 * deny     closes it with a note.
 * confirm  a DIFFERENT grantor completes a high-risk approval (core.access_request_confirm).
 */
export const POST = apiHandler(accessRequestDecideSchema, async (body, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  const { data: req } = await admin
    .schema('core')
    .from('access_requests')
    .select('id')
    .eq('id', body.requestId)
    .eq('org_id', actor.orgId)
    .maybeSingle();
  if (!req) return NextResponse.json({ error: 'Request not found', code: 'NOT_FOUND' }, { status: 404 });

  const ip = requestIp();
  const { data, error } =
    body.decision === 'confirm'
      ? await admin.schema('core').rpc('access_request_confirm', { p_request: body.requestId, p_user: actor.userId, p_ip: ip })
      : await admin.schema('core').rpc('access_request_decide', {
          p_request: body.requestId,
          p_decider_user: actor.userId,
          p_decision: body.decision,
          p_note: body.note ?? null,
          p_role_override: body.roleId ?? null,
          p_duration_days: body.durationDays ?? null,
          p_ip: ip,
        });
  if (error) return dbErrorResponse(error);
  return NextResponse.json({ data });
});
