export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { approveRun, InvalidRunTransitionError, RunStateError, RunPreparerCannotApproveError } from '@/lib/payroll/run';
import { SeparationOfDutiesError, NotAuthorizedToApproveError } from '@/lib/money/approvals';

/**
 * POST /api/payroll/runs/[id]/approve — SoD-enforced approval of a PREVIEWED run.
 *
 * SAFETY: approves the DOLLAR AMOUNT only; it does NOT release funds or post to
 * the GL. Separation of duties (approver != preparer) is enforced three ways:
 * an early guard in approveRun, the approvals service, and a DB CHECK. The
 * approver must also hold money-approval authority (canApprove, reconciled to
 * core identity). Gated on payroll:approve on top of all that.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'approve');
  if (!guard.ok) return guard.response;

  try {
    const run = await approveRun(supabase, orgId, params.id, userId);
    await logHumanAction(supabase, userId, orgId, {
      action: 'payroll.run.approve',
      subjectTable: 'payroll_runs',
      subjectId: params.id,
      summary: `Approved payroll run ${params.id} (gross ${run.gross_cents}c)`,
      metadata: { runId: params.id, approvalId: run.approval_id, grossCents: run.gross_cents },
    });
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    if (e instanceof RunPreparerCannotApproveError || e instanceof SeparationOfDutiesError) {
      return NextResponse.json({ error: e.message, code: 'SEPARATION_OF_DUTIES' }, { status: 400 });
    }
    if (e instanceof NotAuthorizedToApproveError) return NextResponse.json({ error: e.message, code: 'NOT_AUTHORIZED' }, { status: 403 });
    if (e instanceof InvalidRunTransitionError) return NextResponse.json({ error: e.message, code: 'INVALID_TRANSITION' }, { status: 409 });
    if (e instanceof RunStateError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Approval failed' }, { status: 500 });
  }
}
