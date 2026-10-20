export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { reviewDecideSchema } from '@/lib/validations/access-governance';
import { dbErrorResponse, requestIp, resolveGovActor } from '@/lib/access-governance/server';

/**
 * POST /api/access/reviews/decide { itemId, decision, note? }
 *
 * keep · reduce · revoke · delegate. A revoke ends the assignment immediately (effective_to =
 * now, status revoked) inside core.access_review_decide, which also enforces: the item's
 * reviewer or an access admin, never your own access (H1), open campaigns only.
 */
export const POST = apiHandler(reviewDecideSchema, async (body, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  // Tenant pin: the item must belong to the session tenant.
  const { data: item } = await admin
    .schema('core')
    .from('access_review_items')
    .select('id')
    .eq('id', body.itemId)
    .eq('org_id', actor.orgId)
    .maybeSingle();
  if (!item) return NextResponse.json({ error: 'Review item not found', code: 'NOT_FOUND' }, { status: 404 });

  const { data, error } = await admin.schema('core').rpc('access_review_decide', {
    p_item: body.itemId,
    p_user: actor.userId,
    p_decision: body.decision,
    p_note: body.note ?? null,
    p_ip: requestIp(),
  });
  if (error) return dbErrorResponse(error);
  return NextResponse.json({ data });
});
