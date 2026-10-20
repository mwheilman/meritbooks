export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { applyFieldMasksAll, maskMeta, resolveFieldAccess } from '@/lib/rbac/field-masks';

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

  // The run itself was read on the caller's RLS client above (org + client scope), so
  // the caller may see THIS run. Its per-person amount columns are not member-readable
  // at all (mig 170 column mask), so the lines are read with the service role — pinned
  // to the org and to the run just authorized — and serialized through the comp mask.
  const admin = createAdminSupabase();
  const { data: employees, error: empErr } = await admin
    .from('payroll_run_employees')
    .select('*')
    .eq('org_id', orgId)
    .eq('payroll_run_id', (run as { id: string }).id);
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 });

  // Per-person payroll is the `comp` field class (05 R-6): only comp=visible sees
  // each employee's amounts; `grouped` / `hidden` callers get the run totals (on the
  // run row) and per-person lines with amounts nulled.
  const fieldAccess = await resolveFieldAccess(admin, orgId, userId);
  const masked = applyFieldMasksAll((employees ?? []) as Array<Record<string, unknown>>, {
    gross_cents: 'comp', net_cents: 'comp', employee_tax_cents: 'comp', employer_tax_cents: 'comp',
    deductions_cents: 'comp', benefits_cents: 'comp', earnings: 'comp',
  }, fieldAccess);

  return NextResponse.json({ run, employees: masked.rows, fieldMasks: maskMeta(fieldAccess, masked.masked) });
}
