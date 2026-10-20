export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { maskMeta, maskValue, resolveFieldAccess } from '@/lib/rbac/field-masks';

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data, error } = await supabase
    .schema('core').from('employees')
    .select(`
      id,
      first_name,
      last_name,
      email,
      phone,
      title,
      hire_date,
      termination_date,
      is_active,
      department:departments(id, name, code)
    `)
    .eq('org_id', orgId)
    .order('last_name')
    .order('first_name');

  if (error) {
    console.error('[team] Query error:', error);
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  // Compensation (05 R-6 `comp`): pay rates are not member-readable (migration 167
  // column revoke). Only a caller whose field level for comp is `visible` gets them —
  // read server-side, pinned to the org; everyone else gets null.
  const admin = createAdminSupabase();
  const fieldAccess = await resolveFieldAccess(admin, orgId, userId);
  const comp = new Map<string, { hourly: number | null; salary: number | null }>();
  if (fieldAccess.policy.comp === 'visible') {
    const { data: compRows } = await admin
      .schema('core').from('employees')
      .select('id, hourly_rate_cents, annual_salary_cents')
      .eq('org_id', orgId);
    for (const r of (compRows ?? []) as Array<{ id: string; hourly_rate_cents: number | null; annual_salary_cents: number | string | null }>) {
      comp.set(r.id, { hourly: r.hourly_rate_cents, salary: r.annual_salary_cents == null ? null : Number(r.annual_salary_cents) });
    }
  }

  const employees = (data ?? []).map((e: Record<string, unknown>) => ({
    id: e.id,
    firstName: e.first_name,
    lastName: e.last_name,
    fullName: `${e.first_name} ${e.last_name}`,
    email: e.email,
    phone: e.phone,
    title: e.title,
    hireDate: e.hire_date,
    terminationDate: e.termination_date,
    isActive: e.is_active,
    hourlyRateCents: maskValue('comp', comp.get(e.id as string)?.hourly ?? null, fieldAccess),
    annualSalaryCents: maskValue('comp', comp.get(e.id as string)?.salary ?? null, fieldAccess),
    department: e.department,
  }));

  const activeCount = employees.filter((e) => e.isActive === true).length;

  return NextResponse.json({
    data: employees,
    summary: { total: employees.length, active: activeCount },
    fieldMasks: maskMeta(fieldAccess, fieldAccess.policy.comp === 'visible' ? [] : ['hourlyRateCents', 'annualSalaryCents']),
  });
}
