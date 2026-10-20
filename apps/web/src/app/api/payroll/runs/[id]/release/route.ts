export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { assertSessionMeetsPolicy } from '@/lib/auth/assert-session-policy';
import { requireMoneyMovement, PAYMENTS_EXECUTE, PAYROLL_RELEASE_FEATURE } from '@/lib/rbac/payments-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  releaseRun,
  runVisibleToCaller,
  InvalidRunTransitionError,
  RunStateError,
  RunReleaserCannotApproveError,
  RunPreparerCannotApproveError,
  RunReleaseConflictError,
  RunTamperedError,
  RunReleaseRecordingError,
} from '@/lib/payroll/run';
import { SodViolationError } from '@/lib/rbac/sod';
import { PayrollProviderNotConfiguredError } from '@/lib/payroll/engine/types';
import { PayrollCapabilityUnsupportedError } from '@/lib/payroll/providers/types';
import { MockPayrollInProductionError } from '@/lib/payroll/providers/mock';

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

  // R-7 (05 §3.8): the tenant's authentication policy — MFA / step-up re-verification
  // / session age / IP allowlist — is checked before any money is released. With every
  // policy off this passes (Settings → Security shows the warning); with a policy on
  // and the Clerk factor data missing it FAILS CLOSED with a structured step-up error.
  const sessionPolicy = await assertSessionMeetsPolicy({ orgId, userId }, { action: 'money_release' });
  if (!sessionPolicy.ok) return sessionPolicy.response;

  // The admin client bypasses client-scope RLS: the caller must be able to see this run.
  if (!(await runVisibleToCaller(supabase, orgId, params.id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    // Service role (mig 170 write lock): the authority is the money-approval record +
    // the gates above; releaseRun claims the approval before the provider is called.
    const run = await releaseRun(createAdminSupabase(), orgId, params.id, userId);
    await logHumanAction(supabase, userId, orgId, {
      action: 'payroll.run.release',
      subjectTable: 'payroll_runs',
      subjectId: params.id,
      summary: `Released payroll run ${params.id} to provider (${run.provider_run_id ?? 'n/a'}); status ${run.status}`,
      metadata: { runId: params.id, providerRunId: run.provider_run_id, status: run.status, grossCents: run.gross_cents },
    });
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    if (e instanceof RunReleaserCannotApproveError || e instanceof RunPreparerCannotApproveError || e instanceof SodViolationError) {
      return NextResponse.json({ error: e.message, code: 'SOD_VIOLATION' }, { status: 403 });
    }
    if (e instanceof RunReleaseConflictError) return NextResponse.json({ error: e.message, code: 'RELEASE_IN_PROGRESS' }, { status: 409 });
    if (e instanceof RunTamperedError) return NextResponse.json({ error: e.message, code: 'RUN_CHANGED_SINCE_APPROVAL' }, { status: 409 });
    if (e instanceof RunReleaseRecordingError) {
      // Money moved; recording failed. Leave an audit trail with the provider reference.
      await logHumanAction(supabase, userId, orgId, {
        action: 'payroll.run.release_unrecorded',
        subjectTable: 'payroll_runs',
        subjectId: params.id,
        summary: `Payroll run ${params.id} was accepted by the provider (${e.providerRunId}) but Books could not record the release — reconcile manually`,
        metadata: { runId: params.id, providerRunId: e.providerRunId, error: e.message },
      }).catch(() => undefined);
      return NextResponse.json({ error: e.message, code: 'RELEASE_NOT_RECORDED', providerRunId: e.providerRunId }, { status: 500 });
    }
    if (e instanceof InvalidRunTransitionError) return NextResponse.json({ error: e.message, code: 'INVALID_TRANSITION' }, { status: 409 });
    if (e instanceof RunStateError) return NextResponse.json({ error: e.message }, { status: 400 });
    // Provider seam: an unconfigured provider or a file-based payroll system (runs
    // outside Books) is a setup state, not a server fault — no money moved.
    if (e instanceof MockPayrollInProductionError) return NextResponse.json({ error: e.message, code: 'PROVIDER_NOT_CONNECTED' }, { status: 409 });
    if (e instanceof PayrollProviderNotConfiguredError) return NextResponse.json({ error: e.message, code: 'PROVIDER_NOT_CONFIGURED' }, { status: 409 });
    if (e instanceof PayrollCapabilityUnsupportedError) return NextResponse.json({ error: e.message, code: 'PROVIDER_CAPABILITY_UNSUPPORTED' }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Release failed' }, { status: 500 });
  }
}
