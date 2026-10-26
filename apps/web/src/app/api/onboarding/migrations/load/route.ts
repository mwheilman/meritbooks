export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { loadAction } from '@/lib/validations/onboarding-migration';
import { migrationErrorResponse } from '@/lib/onboarding/migration/server/guard';
import { withProject } from '@/lib/onboarding/migration/server/route-support';
import { openItemsPayload, stageOpeningSession } from '@/lib/onboarding/migration/server/load';
import { refreshProject } from '@/lib/onboarding/migration/server/projects';

/**
 * Load into the EXISTING engines (journal_entries:create + client scope):
 *   stage_opening   staged TB + accepted matches → the historical-conversion session
 *                   (reviewed, tied out and posted at /onboarding/conversion?sessionId=…)
 *   open_items      staged A/R or A/P aging, parties named as the linked existing records,
 *                   shaped for POST /api/onboarding/import/{ar,ap} (action commit, source manual)
 */
export const POST = apiHandler(loadAction, async (body, ctx) => {
  const pc = await withProject(ctx, body.id, 'work', '/api/onboarding/migrations/load');
  if (pc instanceof NextResponse) return pc;
  try {
    if (body.action === 'stage_opening') {
      const r = await stageOpeningSession(pc.supabase, pc.orgId, pc.project, pc.userId);
      await refreshProject(pc.supabase, pc.orgId, { ...pc.project, conversion_session_id: r.sessionId }, { withTies: false });
      return NextResponse.json({ ...r, reviewHref: `/onboarding/conversion?sessionId=${encodeURIComponent(r.sessionId)}`, message: r.created ? 'Opening balances staged — review and post them.' : 'Opening balances refreshed.' });
    }
    const payload = await openItemsPayload(pc.supabase, pc.project, body.kind);
    return NextResponse.json(payload);
  } catch (e) {
    return migrationErrorResponse(e, 'Could not load');
  }
});
