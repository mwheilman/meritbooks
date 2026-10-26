export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { buyInQuery } from '@/lib/validations/onboarding-migration';
import { migrationErrorResponse } from '@/lib/onboarding/migration/server/guard';
import { today, withProject } from '@/lib/onboarding/migration/server/route-support';
import { buyInView } from '@/lib/onboarding/migration/server/buyin';

/**
 * GET /api/onboarding/migrations/buy-in?id=&role= — what changes / what stays for this role
 * coming from this client's old system, time saved from the client's own volumes, the words
 * that changed, and the first-week checklist computed from real rows. (journal_entries:view)
 */
export const GET = apiQueryHandler(buyInQuery, async (q, ctx) => {
  const pc = await withProject(ctx, q.id, 'view', '/api/onboarding/migrations/buy-in');
  if (pc instanceof NextResponse) return pc;
  try {
    return NextResponse.json(await buyInView(pc.supabase, pc.orgId, pc.project, q.role ?? 'bookkeeper', today()));
  } catch (e) {
    return migrationErrorResponse(e, 'Could not load the team guide');
  }
});
