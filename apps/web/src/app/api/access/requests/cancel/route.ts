export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { accessRequestCancelSchema } from '@/lib/validations/access-governance';
import { dbErrorResponse, resolveGovActor } from '@/lib/access-governance/server';

/** POST /api/access/requests/cancel { requestId } — the requester withdraws an open request. */
export const POST = apiHandler(accessRequestCancelSchema, async (body, ctx) => {
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

  const { error } = await admin.schema('core').rpc('access_request_cancel', { p_request: body.requestId, p_user: actor.userId });
  if (error) return dbErrorResponse(error);
  return NextResponse.json({ data: { status: 'cancelled' } });
});
