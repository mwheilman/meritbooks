export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { fetchCoreMap } from '@/lib/stitch-core';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { maskMeta, maskValue, resolveFieldAccess } from '@/lib/rbac/field-masks';

/**
 * GET /api/payroll/employees — the active-employee roster the payroll run wizard
 * picks from. Thin identity + comp basis ONLY; NO payroll PII (SSN/bank/withholding)
 * — that lives at the provider + Core vault, never surfaced here. RLS-scoped.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'view');
  if (!guard.ok) return guard.response;

  const { data: emps, error } = await supabase
    .schema('core')
    .from('employees')
    .select('id, first_name, last_name, title, department_id')
    .eq('is_active', true)
    .order('last_name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Compensation (05 R-6 `comp`) is not member-readable (migration 167 column
  // revoke): read server-side pinned to the org, and returned only at comp=visible.
  const admin = createAdminSupabase();
  const fieldAccess = await resolveFieldAccess(admin, orgId, userId);
  const comp = new Map<string, { hourly: number | null; salary: number | null }>();
  if (fieldAccess.policy.comp === 'visible') {
    const { data: compRows } = await admin
      .schema('core').from('employees')
      .select('id, hourly_rate_cents, annual_salary_cents')
      .eq('org_id', orgId)
      .eq('is_active', true);
    for (const r of (compRows ?? []) as Array<{ id: string; hourly_rate_cents: number | null; annual_salary_cents: number | string | null }>) {
      comp.set(r.id, { hourly: r.hourly_rate_cents, salary: r.annual_salary_cents == null ? null : Number(r.annual_salary_cents) });
    }
  }

  const rows = ((emps ?? []) as Array<{
    id: string; first_name: string | null; last_name: string | null; title: string | null; department_id: string | null;
  }>).map((r) => ({
    ...r,
    hourly_rate_cents: comp.get(r.id)?.hourly ?? null,
    annual_salary_cents: comp.get(r.id)?.salary ?? null,
  }));

  // Department names live in core — stitch in JS (PostgREST can't embed core<->public).
  const deptIds = [...new Set(rows.map((r) => r.department_id).filter((v): v is string => !!v))];
  const deptMap = deptIds.length
    ? await fetchCoreMap<{ id: string; name: string }>(supabase, 'departments', 'id, name', deptIds)
    : new Map<string, { id: string; name: string }>();

  const employees = rows.map((r) => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'Employee';
    const payBasis: 'HOURLY' | 'SALARY' = r.annual_salary_cents ? 'SALARY' : 'HOURLY';
    return {
      id: r.id,
      name,
      title: r.title ?? null,
      payBasis,
      // The pay BASIS (hourly vs salary) is not sensitive; the amounts are comp.
      baseRateCents: maskValue('comp', r.hourly_rate_cents, fieldAccess),
      annualSalaryCents: maskValue('comp', r.annual_salary_cents, fieldAccess),
      standardHours: null as number | null,
      isContractor: false,
      departmentName: r.department_id ? (deptMap.get(r.department_id)?.name ?? null) : null,
    };
  });

  return NextResponse.json({
    employees,
    fieldMasks: maskMeta(fieldAccess, fieldAccess.policy.comp === 'visible' ? [] : ['baseRateCents', 'annualSalaryCents']),
  });
}
