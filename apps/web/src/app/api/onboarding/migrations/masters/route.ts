export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { mastersAction, projectQuery } from '@/lib/validations/onboarding-migration';
import { migrationErrorResponse } from '@/lib/onboarding/migration/server/guard';
import { withProject } from '@/lib/onboarding/migration/server/route-support';
import { decideMasters, masterViews, runMasterMatching } from '@/lib/onboarding/migration/server/masters';

/**
 * Customers, vendors, items and classes — "Already in Merit" matching.
 *   GET  ?id=  per kind: counts and rows (proposals first).
 *   POST run · link · keep_new · ignore · accept_all_matches  (journal_entries:create + scope)
 */
export const GET = apiQueryHandler(projectQuery, async (q, ctx) => {
  const pc = await withProject(ctx, q.id, 'view', '/api/onboarding/migrations/masters');
  if (pc instanceof NextResponse) return pc;
  try {
    return NextResponse.json({ kinds: await masterViews(pc.supabase, pc.orgId, pc.project) });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not load customers and vendors');
  }
});

export const POST = apiHandler(mastersAction, async (body, ctx) => {
  const pc = await withProject(ctx, body.id, 'work', '/api/onboarding/migrations/masters');
  if (pc instanceof NextResponse) return pc;
  try {
    if (body.action === 'run') {
      const out: Record<string, unknown> = {};
      for (const k of ['customer', 'vendor', 'item', 'dimension'] as const) out[k] = await runMasterMatching(pc.supabase, pc.orgId, pc.project, k);
      return NextResponse.json({ results: out, message: 'Matched against what’s already in Merit.' });
    }
    const d =
      body.action === 'accept_all_matches' ? { kind: 'accept_all_matches' as const, entity: body.entity }
      : { kind: body.action, stagedIds: body.staged_ids };
    const r = await decideMasters(pc.supabase, pc.orgId, pc.project, pc.userId, d);
    return NextResponse.json({ ...r, message: `${r.changed} updated.` });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not save');
  }
});
