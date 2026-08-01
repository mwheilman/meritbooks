export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * GET /api/payroll/runs/[id] — a single run with its per-employee lines.
 * Read-only; RLS scopes to the caller's org and payroll:view gates access.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'view');
  if (!guard.ok) return guard.response;

  const { data: run, error } = await supabase
    .from('payroll_runs')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: employees, error: empErr } = await supabase
    .from('payroll_run_employees')
    .select('*')
    .eq('org_id', orgId)
    .eq('payroll_run_id', params.id);
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 });

  return NextResponse.json({ run, employees: employees ?? [] });
}
