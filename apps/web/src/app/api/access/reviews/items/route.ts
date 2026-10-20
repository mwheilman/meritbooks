export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { reviewItemsQuerySchema } from '@/lib/validations/access-governance';
import { memberNames, resolveGovActor, userNames } from '@/lib/access-governance/server';
import { scopeLabel } from '@/lib/access-governance/describe';
import type { AccessReviewItem, ReviewDecision } from '@/lib/access-governance/types';

/**
 * GET /api/access/reviews/items?reviewId= — the items of one campaign the caller may see
 * (RLS: their own items as reviewer; every item for access admins). Each item is the
 * assignment as it stood when the campaign started, plus evidence.
 */

interface ItemRow {
  id: string;
  review_id: string;
  membership_id: string | null;
  reviewer_membership_id: string | null;
  snapshot: Record<string, unknown>;
  evidence: Record<string, unknown>;
  decision: ReviewDecision | null;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export const GET = apiQueryHandler(reviewItemsQuerySchema, async (q, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  const { data, error } = await ctx.supabase
    .schema('core')
    .from('access_review_items')
    .select('id, review_id, membership_id, reviewer_membership_id, snapshot, evidence, decision, decision_note, decided_by, decided_at')
    .eq('org_id', actor.orgId)
    .eq('review_id', q.reviewId)
    .order('created_at')
    .limit(2000);
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  const rows = (data ?? []) as ItemRow[];

  const [reviewers, deciders] = await Promise.all([
    memberNames(admin, actor.orgId, rows.map((r) => r.reviewer_membership_id).filter((x): x is string => !!x)),
    userNames(
      admin,
      actor.orgId,
      rows.flatMap((r) => [r.decided_by, str(r.evidence.granted_by)]).filter((x): x is string => !!x),
    ),
  ]);

  const items: AccessReviewItem[] = rows.map((r) => {
    const s = r.snapshot;
    const where = scopeLabel(s);
    const source = str(s.source_name) ?? 'Access';
    const grantedBy = str(r.evidence.granted_by);
    return {
      id: r.id,
      reviewId: r.review_id,
      membershipId: r.membership_id,
      personName: str(s.person_name) ?? str(s.person_email) ?? 'Unknown person',
      personEmail: str(s.person_email),
      reviewerMembershipId: r.reviewer_membership_id,
      reviewerName: r.reviewer_membership_id ? reviewers.get(r.reviewer_membership_id) ?? null : null,
      isMine: r.reviewer_membership_id === actor.membershipId,
      title: `${source} on ${where}`,
      sourceName: source,
      scopeLabel: where,
      grantedAt: str(r.evidence.granted_at),
      grantedByName: grantedBy ? deciders.get(grantedBy) ?? null : null,
      endsAt: str(r.evidence.effective_to),
      legacy: r.evidence.legacy === true,
      reason: str(r.evidence.reason),
      decision: r.decision,
      decisionNote: r.decision_note,
      decidedAt: r.decided_at,
      decidedByName: r.decided_by ? deciders.get(r.decided_by) ?? null : null,
    };
  });
  return NextResponse.json({ data: { items } });
});
