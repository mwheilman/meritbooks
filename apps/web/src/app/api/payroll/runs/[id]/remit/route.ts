export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { remitRun, RunStateError } from '@/lib/payroll/run';
import { PostingError } from '@/lib/posting/account-roles';

/**
 * POST /api/payroll/runs/[id]/remit — clear the posted run's payroll payables.
 *
 * DR each payroll payable (FEDERAL / FICA / HEALTH / GARNISHMENT — resolved by ROLE)
 * / CR cash for the total, balanced (check_journal_balance()) and IDEMPOTENT per run
 * via source_ref `payroll_remit:<runId>` (migration 064's UNIQUE index is the DB
 * double-post guarantor). Allowed only once the run is posted to the GL — the payables
 * must exist to be cleared. Gated on the existing payroll:approve permission (same
 * authority as posting the run; no new permission is invented).
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'approve');
  if (!guard.ok) return guard.response;

  try {
    const result = await remitRun(supabase, orgId, params.id);
    if (!result.alreadyRemitted) {
      await logHumanAction(supabase, userId, orgId, {
        action: 'payroll.run.remit',
        subjectTable: 'payroll_runs',
        subjectId: params.id,
        summary: `Remitted payroll payables for run ${params.id} (${result.totalCents}¢ cleared, entry ${result.glEntryId})`,
        metadata: { runId: params.id, glEntryId: result.glEntryId, totalCents: result.totalCents },
      });
    }
    return NextResponse.json({
      ok: true,
      glEntryId: result.glEntryId,
      totalCents: result.totalCents,
      alreadyRemitted: result.alreadyRemitted,
    });
  } catch (e) {
    if (e instanceof PostingError) return NextResponse.json({ error: e.message, code: 'POSTING_ERROR' }, { status: 400 });
    if (e instanceof RunStateError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Remittance failed' }, { status: 500 });
  }
}
