export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { createRun, RunStateError } from '@/lib/payroll/run';
import { createRunSchema } from '@/lib/validations/payroll';

/**
 * POST /api/payroll/runs — create a DRAFT payroll run (roster + inputs).
 * GET  /api/payroll/runs — list runs for the caller's org.
 *
 * SAFETY: creating/listing NEVER moves money and never posts to the GL. Money
 * moves only at /release. Guarded by RLS (org scope) + payroll:create/view.
 */
export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = createRunSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 });
  }

  try {
    const run = await createRun(supabase, orgId, { ...parsed.data, preparedBy: userId });
    await logHumanAction(supabase, userId, orgId, {
      action: 'payroll.run.create',
      subjectTable: 'payroll_runs',
      subjectId: run.id,
      summary: `Created payroll run for ${run.period_start}..${run.period_end} (pay ${run.pay_date}), ${parsed.data.employeeInputs.length} employee(s)`,
      metadata: { runId: run.id, employees: parsed.data.employeeInputs.length },
    });
    return NextResponse.json({ ok: true, run }, { status: 201 });
  } catch (e) {
    if (e instanceof RunStateError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to create run' }, { status: 500 });
  }
}

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'view');
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from('payroll_runs')
    .select('id, location_id, period_start, period_end, pay_date, status, gross_cents, net_cents, gl_entry_id, provider_run_id, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ runs: data ?? [] });
}
