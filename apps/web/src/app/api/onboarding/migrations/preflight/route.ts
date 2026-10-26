export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { preflightAction, projectQuery } from '@/lib/validations/onboarding-migration';
import { migrationErrorResponse } from '@/lib/onboarding/migration/server/guard';
import { withProject } from '@/lib/onboarding/migration/server/route-support';
import { clientReport, decideFinding, loadFindings, runAndStore, PREFLIGHT_CHECKS } from '@/lib/onboarding/migration/server/preflight';
import { refreshProject } from '@/lib/onboarding/migration/server/projects';
import type { PreflightCheckId } from '@/lib/onboarding/migration/types';

/**
 * "Check data quality" — the 24 checks.
 *   GET  ?id=   the stored findings (one per check), the check list, the client report split.
 *   POST run    (re)run all 24 on what is staged · decide {check_id, disposition, note}.
 * Gates: view / work (journal_entries:create) + client scope.
 */
export const GET = apiQueryHandler(projectQuery, async (q, ctx) => {
  const pc = await withProject(ctx, q.id, 'view', '/api/onboarding/migrations/preflight');
  if (pc instanceof NextResponse) return pc;
  try {
    const findings = await loadFindings(pc.supabase, pc.project.id);
    return NextResponse.json({ checks: PREFLIGHT_CHECKS, findings, report: clientReport(findings) });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not load the checks');
  }
});

export const POST = apiHandler(preflightAction, async (body, ctx) => {
  const pc = await withProject(ctx, body.id, 'work', '/api/onboarding/migrations/preflight');
  if (pc instanceof NextResponse) return pc;
  try {
    if (body.action === 'run') {
      const findings = await runAndStore(pc.supabase, pc.orgId, pc.project, pc.userId);
      await refreshProject(pc.supabase, pc.orgId, pc.project, { withTies: false });
      return NextResponse.json({ findings, report: clientReport(findings), message: '24 checks ran.' });
    }
    const f = await decideFinding(pc.supabase, pc.orgId, pc.project, pc.userId, { checkId: body.check_id as PreflightCheckId, disposition: body.disposition, note: body.note ?? null });
    await refreshProject(pc.supabase, pc.orgId, pc.project, { withTies: false });
    return NextResponse.json({ finding: f, message: 'Decision saved.' });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not save the check');
  }
});
