export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError } from '@/lib/budgets/route-support';
import { actOnComment, addComment, listComments } from '@/lib/budgets/service/comments';
import { addCommentSchema, commentActionSchema, commentsQuery, deptOf } from '@/lib/validations/budgets';

/**
 * GET   /api/budgets/comments?location_id[&version_id&department_id&account_id&kind&period_key]
 * POST  — a comment, a "please justify" request (finance), or a variance explanation (≥ 10 chars).
 * PATCH — resolve / reopen, or review a variance explanation (finance, never its author).
 */
export const GET = apiQueryHandler(commentsQuery, async (q, ctx) => {
  const b = await budgetCtx(ctx, q.location_id);
  if (b instanceof NextResponse) return b;
  try {
    const comments = await listComments(b, {
      locationId: q.location_id,
      versionId: q.version_id ?? null,
      departmentId: q.department_id === undefined ? undefined : deptOf(q.department_id),
      accountId: q.account_id ?? null,
      kind: q.kind,
      periodKey: q.period_key ?? null,
    });
    return NextResponse.json({ comments, userId: ctx.userId });
  } catch (e) {
    return budgetError(e, 'comments GET');
  }
});

export const POST = apiHandler(addCommentSchema, async (i, ctx) => {
  const b = await budgetCtx(ctx, i.location_id);
  if (b instanceof NextResponse) return b;
  try {
    const comment = await addComment(b, {
      locationId: i.location_id,
      versionId: i.version_id ?? null,
      departmentId: i.department_id,
      accountId: i.account_id ?? null,
      periodNumber: i.period_number ?? null,
      parentId: i.parent_id ?? null,
      kind: i.kind,
      body: i.body,
      periodKey: i.period_key ?? null,
      varianceWindow: i.variance_window ?? null,
      varianceCents: i.variance_cents ?? null,
    });
    return NextResponse.json({ comment }, { status: 201 });
  } catch (e) {
    return budgetError(e, 'comments POST');
  }
});

export const PATCH = apiHandler(commentActionSchema, async (i, ctx) => {
  const { data } = await ctx.supabase.from('budget_comments').select('location_id').eq('id', i.comment_id).maybeSingle();
  const loc = (data as { location_id?: string } | null)?.location_id;
  if (!loc) return NextResponse.json({ error: 'That comment was not found.', code: 'NOT_FOUND' }, { status: 404 });
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    return NextResponse.json({ comment: await actOnComment(b, i.comment_id, i.action, i.note ?? null) });
  } catch (e) {
    return budgetError(e, 'comments PATCH');
  }
});
