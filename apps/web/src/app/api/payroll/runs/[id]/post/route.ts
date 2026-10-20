export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { logHumanAction } from '@/lib/trust/action-log';
import { runVisibleToCaller, postRun, RunStateError } from '@/lib/payroll/run';
import { PostingError } from '@/lib/posting/account-roles';

/**
 * POST /api/payroll/runs/[id]/post — post the released run to the GL.
 *
 * Balanced (recordPayrollRun -> check_journal_balance()), PAYROLL_RUN entry_type,
 * and IDEMPOTENT (returns the existing gl_entry_id without re-posting). Allowed
 * only once the run is released (the money is committed). No money moves here —
 * this records the accounting for money already released. Gated payroll:approve.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'approve');
  if (!guard.ok) return guard.response;

  // The admin client bypasses client-scope RLS: the caller must be able to see this run.
  if (!(await runVisibleToCaller(supabase, orgId, params.id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    // payroll_runs.gl_entry_id is written here: service role after the payroll:approve
    // check (mig 170 write lock), org-pinned.
    const result = await postRun(createAdminSupabase(), orgId, params.id);
    if (!result.alreadyPosted) {
      await logHumanAction(supabase, userId, orgId, {
        action: 'payroll.run.post',
        subjectTable: 'payroll_runs',
        subjectId: params.id,
        summary: `Posted payroll run ${params.id} to GL (entry ${result.glEntryId})`,
        metadata: { runId: params.id, glEntryId: result.glEntryId },
      });
    }
    return NextResponse.json({ ok: true, glEntryId: result.glEntryId, alreadyPosted: result.alreadyPosted });
  } catch (e) {
    if (e instanceof PostingError) return NextResponse.json({ error: e.message, code: 'POSTING_ERROR' }, { status: 400 });
    if (e instanceof RunStateError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Post failed' }, { status: 500 });
  }
}
