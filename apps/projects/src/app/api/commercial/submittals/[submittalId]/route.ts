export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { SubmittalAction } from '@/lib/commercial/schemas';
import { cmRpc, cmWrote, loadSubmittalReviews } from '@/lib/commercial/server';

/** GET /api/commercial/submittals/:id — the review path, every revision. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false }, async ({ db, params }) => {
  return { reviews: await loadSubmittalReviews(db, params.submittalId!) };
});

/** POST /api/commercial/submittals/:id — submit through a review path, record a reviewer's stamp, revise, release for fabrication, set the dates. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: SubmittalAction }, async ({ db, body, params }) => {
  const id = params.submittalId!;
  switch (body.op) {
    case 'submit':
      return { id: await cmRpc<string>(db, 'cm_submittal_submit', { p_submittal: id, p_reviewers: body.reviewers.map((r, i) => ({ ...r, step: i + 1 })) }) };
    case 'respond':
      return { id: await cmRpc<string>(db, 'cm_submittal_respond', { p_review: body.reviewId, p_code: body.code, p_comments: body.comments, p_stamp: body.stamp }) };
    case 'revise':
      return { id: await cmRpc<string>(db, 'cm_submittal_revise', { p_submittal: id }) };
    case 'release':
      return { id: await cmRpc<string>(db, 'cm_submittal_release_fab', { p_submittal: id, p_on: body.on }) };
    case 'dates':
      return cmWrote<{ id: string; submit_by: string | null }>(await db.schema('pm').from('cm_submittals')
        .update({ required_on_site: body.requiredOnSite, lead_time_days: body.leadTimeDays, review_days: body.reviewDays }).eq('id', id).select('id, submit_by').single());
  }
});
