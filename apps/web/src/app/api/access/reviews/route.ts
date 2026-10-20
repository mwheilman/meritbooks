export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { reviewStartSchema } from '@/lib/validations/access-governance';
import { dbErrorResponse, resolveGovActor, userNames } from '@/lib/access-governance/server';
import type { AccessReview, ReviewScopeKind, ReviewStatus, ReviewSummaryCounts } from '@/lib/access-governance/types';

/**
 * Access reviews / recertification (05-RBAC-SPEC §6.8 A8, R-9).
 *
 * GET  /api/access/reviews  campaigns the caller can see (RLS: access admins see all; a
 *                           reviewer sees the campaigns they have items in) + progress.
 * POST /api/access/reviews  start a campaign — core.access_review_start (definer) checks the
 *                           caller is a tenant admin or holds core.access.reviews:create.
 */

interface ReviewRow {
  id: string;
  name: string;
  scope_kind: ReviewScopeKind;
  location_id: string | null;
  role_id: string | null;
  due_at: string;
  status: ReviewStatus;
  auto_revoke_unreviewed: boolean;
  created_at: string;
  created_by: string | null;
  closed_at: string | null;
  summary: ReviewSummaryCounts | null;
}

export const GET = apiQueryHandler(null, async (_q, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  const { data, error } = await ctx.supabase
    .schema('core')
    .from('access_reviews')
    .select('id, name, scope_kind, location_id, role_id, due_at, status, auto_revoke_unreviewed, created_at, created_by, closed_at, summary')
    .eq('org_id', actor.orgId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  const rows = (data ?? []) as ReviewRow[];
  if (!rows.length) return NextResponse.json({ data: { reviews: [] } });

  const ids = rows.map((r) => r.id);
  const [items, creators, locs, roles] = await Promise.all([
    admin.schema('core').from('access_review_items').select('review_id, decision, reviewer_membership_id').in('review_id', ids),
    userNames(admin, actor.orgId, rows.map((r) => r.created_by).filter((x): x is string => !!x)),
    ctx.supabase.schema('core').from('locations').select('id, name').eq('org_id', actor.orgId).in('id', rows.map((r) => r.location_id).filter((x): x is string => !!x)),
    ctx.supabase.schema('core').from('role_definitions').select('id, name').in('id', rows.map((r) => r.role_id).filter((x): x is string => !!x)),
  ]);
  const itemRows = (items.data ?? []) as Array<{ review_id: string; decision: string | null; reviewer_membership_id: string | null }>;
  const locName = new Map(((locs.data ?? []) as Array<{ id: string; name: string }>).map((l) => [l.id, l.name]));
  const roleName = new Map(((roles.data ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));

  const reviews: AccessReview[] = rows.map((r) => {
    const mine = itemRows.filter((i) => i.review_id === r.id);
    return {
      id: r.id,
      name: r.name,
      scopeKind: r.scope_kind,
      scopeLabel:
        r.scope_kind === 'client'
          ? `Everyone with access to ${locName.get(r.location_id ?? '') ?? 'a client'}`
          : r.scope_kind === 'role'
            ? `Everyone holding ${roleName.get(r.role_id ?? '') ?? 'a role'}`
            : 'Everyone, every client',
      dueAt: r.due_at,
      status: r.status,
      autoRevokeUnreviewed: r.auto_revoke_unreviewed,
      createdAt: r.created_at,
      createdByName: r.created_by ? creators.get(r.created_by) ?? null : null,
      closedAt: r.closed_at,
      summary: r.summary,
      progress: {
        total: mine.length,
        decided: mine.filter((i) => i.decision !== null).length,
        mine: mine.filter((i) => i.reviewer_membership_id === actor.membershipId).length,
        mineUndecided: mine.filter((i) => i.reviewer_membership_id === actor.membershipId && i.decision === null).length,
      },
    };
  });
  return NextResponse.json({ data: { reviews } });
});

export const POST = apiHandler(reviewStartSchema, async (body, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  const { data, error } = await admin.schema('core').rpc('access_review_start', {
    p_org: actor.orgId,
    p_actor_user: actor.userId,
    p_name: body.name,
    p_scope_kind: body.scopeKind,
    p_location: body.scopeKind === 'client' ? body.locationId ?? null : null,
    p_role: body.scopeKind === 'role' ? body.roleId ?? null : null,
    p_due_at: new Date(body.dueAt).toISOString(),
    p_reviewer_membership: body.reviewerMembershipId ?? null,
    p_auto_revoke: body.autoRevokeUnreviewed,
  });
  if (error) return dbErrorResponse(error);
  return NextResponse.json({ data: { id: data as string } }, { status: 201 });
});
