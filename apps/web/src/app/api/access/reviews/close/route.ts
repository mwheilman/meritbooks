export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { reviewCloseSchema } from '@/lib/validations/access-governance';
import { dbErrorResponse, requestIp, resolveGovActor } from '@/lib/access-governance/server';

/**
 * POST /api/access/reviews/close { reviewId } — close a campaign and return its completion
 * summary. If the campaign was set to auto-revoke unreviewed access, undecided items are
 * revoked now. Authority: core.access_review_close (tenant admin or core.access.reviews:create).
 */
export const POST = apiHandler(reviewCloseSchema, async (body, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  const { data: review } = await admin
    .schema('core')
    .from('access_reviews')
    .select('id')
    .eq('id', body.reviewId)
    .eq('org_id', actor.orgId)
    .maybeSingle();
  if (!review) return NextResponse.json({ error: 'Review not found', code: 'NOT_FOUND' }, { status: 404 });

  const { data, error } = await admin.schema('core').rpc('access_review_close', {
    p_review: body.reviewId,
    p_user: actor.userId,
    p_ip: requestIp(),
  });
  if (error) return dbErrorResponse(error);
  return NextResponse.json({ data: { summary: data } });
});
