export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
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
      hourly_rate_cents,
      annual_salary_cents,
      department:departments(id, name, code)
    `)
    .eq('org_id', orgId)
    .order('last_name')
    .order('first_name');

  if (error) {
    console.error('[team] Query error:', error);
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
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
    hourlyRateCents: e.hourly_rate_cents,
    annualSalaryCents: e.annual_salary_cents,
    department: e.department,
  }));

  const activeCount = employees.filter((e) => e.isActive === true).length;

  return NextResponse.json({
    data: employees,
    summary: { total: employees.length, active: activeCount },
  });
}
