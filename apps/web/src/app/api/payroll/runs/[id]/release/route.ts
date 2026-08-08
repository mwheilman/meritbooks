export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireMoneyMovement, PAYMENTS_EXECUTE, PAYROLL_RELEASE_FEATURE } from '@/lib/rbac/payments-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { releaseRun, InvalidRunTransitionError, RunStateError } from '@/lib/payroll/run';

/**
 * POST /api/payroll/runs/[id]/release — THE money-movement step.
 *
 * This is the ONLY payroll endpoint that instructs the provider to move money
 * (debit the tenant's bank, pay employees / agencies / garnishment recipients).
 * It requires an APPROVED run (enforced in releaseRun via the transition guard)
 * and an explicit human actor holding payroll:approve. There is no auto-run:
 * automation prepares, a human commits (CANON §3, FPB §9).
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // THE money-movement step → GRANULAR `payroll_release` key (distinct from
  // check_run / ap_disbursement_release / payments_execute so releasing payroll is
  // its OWN authority, not shared with check running). Degrades to the coarse
  // `payments` superset, then to payroll:approve — never looser than today. SoD +
  // APPROVED-run transition guard still enforced inside releaseRun().
  const guard = await requireMoneyMovement(
    userId,
    PAYMENTS_EXECUTE,
    { feature: 'payroll', action: 'approve' },
    PAYROLL_RELEASE_FEATURE,
  );
  if (!guard.ok) return guard.response;

  try {
    const run = await releaseRun(supabase, orgId, params.id, userId);
    await logHumanAction(supabase, userId, orgId, {
      action: 'payroll.run.release',
      subjectTable: 'payroll_runs',
      subjectId: params.id,
      summary: `Released payroll run ${params.id} to provider (${run.provider_run_id ?? 'n/a'}); status ${run.status}`,
      metadata: { runId: params.id, providerRunId: run.provider_run_id, status: run.status, grossCents: run.gross_cents },
    });
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    if (e instanceof InvalidRunTransitionError) return NextResponse.json({ error: e.message, code: 'INVALID_TRANSITION' }, { status: 409 });
    if (e instanceof RunStateError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Release failed' }, { status: 500 });
  }
}
