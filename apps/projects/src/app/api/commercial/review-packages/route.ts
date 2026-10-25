export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { ReviewAction } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** POST /api/commercial/review-packages — build the monthly project review package, submit it, sign it (CGC-111). */
export const POST = route({ access: { cap: 'projects.financials', action: 'edit' }, mask: ['job', 'budget'], body: ReviewAction }, async ({ db, body }) => {
  switch (body.op) {
    case 'build':
      return { id: await cmRpc<string>(db, 'cm_build_review_package', { p_job: body.jobId, p_period_end: body.periodEnd, p_commentary: body.commentary }) };
    case 'submit':
      return { id: await cmRpc<string>(db, 'cm_submit_review_package', { p_package: body.packageId, p_commentary: body.commentary }) };
    case 'sign':
      return { id: await cmRpc<string>(db, 'cm_sign_review_package', { p_package: body.packageId }) };
  }
});
