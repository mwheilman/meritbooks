export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { logHumanAction } from '@/lib/trust/action-log';
import { runVisibleToCaller, previewRun, InvalidRunTransitionError, RunStateError } from '@/lib/payroll/run';
import { PayrollProviderNotConfiguredError } from '@/lib/payroll/engine/types';
import { PayrollCapabilityUnsupportedError } from '@/lib/payroll/providers/types';

/**
 * POST /api/payroll/runs/[id]/preview — ask the provider engine for gross-to-net
 * and persist per-employee results + run totals (DRAFT/PREVIEWED -> PREVIEWED).
 *
 * SAFETY: read-only against the tenant's bank — NO money moves at preview.
 * Gated on payroll:create (same authority that prepares a run).
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'create');
  if (!guard.ok) return guard.response;

  // The admin client bypasses client-scope RLS: the caller must be able to see this run.
  if (!(await runVisibleToCaller(supabase, orgId, params.id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    // Service-role write after the payroll:create check (mig 170 write lock), org-pinned.
    const run = await previewRun(createAdminSupabase(), orgId, params.id, userId);
    await logHumanAction(supabase, userId, orgId, {
      action: 'payroll.run.preview',
      subjectTable: 'payroll_runs',
      subjectId: params.id,
      summary: `Previewed payroll run ${params.id}: gross ${run.gross_cents}c, net ${run.net_cents}c`,
      metadata: { runId: params.id, grossCents: run.gross_cents, netCents: run.net_cents },
    });
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    if (e instanceof InvalidRunTransitionError) return NextResponse.json({ error: e.message, code: 'INVALID_TRANSITION' }, { status: 409 });
    if (e instanceof RunStateError) return NextResponse.json({ error: e.message }, { status: 400 });
    // Provider seam: an unconfigured provider or a file-based payroll system (runs
    // outside Books) is a setup state, not a server fault — no money moved.
    if (e instanceof PayrollProviderNotConfiguredError) return NextResponse.json({ error: e.message, code: 'PROVIDER_NOT_CONFIGURED' }, { status: 409 });
    if (e instanceof PayrollCapabilityUnsupportedError) return NextResponse.json({ error: e.message, code: 'PROVIDER_CAPABILITY_UNSUPPORTED' }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Preview failed' }, { status: 500 });
  }
}
