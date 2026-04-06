export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET() {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('employees')
    .select(`
      id,
      first_name,
      last_name,
      email,
      phone,
      labor_type,
      title,
      hire_date,
      termination_date,
      is_active,
      hourly_rate_cents,
      annual_salary_cents,
      weekly_target_hours,
      utilization_flag_threshold,
      consecutive_low_periods,
      assigned_location_ids,
      department:departments(id, name, code),
      direct_assigned_target:locations!employees_direct_assigned_target_location_id_fkey(id, name, short_code)
    `)
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
    laborType: e.labor_type,
    title: e.title,
    hireDate: e.hire_date,
    terminationDate: e.termination_date,
    isActive: e.is_active,
    hourlyRateCents: e.hourly_rate_cents,
    annualSalaryCents: e.annual_salary_cents,
    weeklyTargetHours: e.weekly_target_hours,
    utilizationFlagThreshold: e.utilization_flag_threshold,
    consecutiveLowPeriods: e.consecutive_low_periods,
    assignedLocationCount: Array.isArray(e.assigned_location_ids) ? (e.assigned_location_ids as string[]).length : 0,
    department: e.department,
    directAssignedTarget: e.direct_assigned_target,
  }));

  const activeCount = employees.filter((e: Record<string, unknown>) => e.isActive).length;
  const byType: Record<string, number> = {};
  for (const e of employees) {
    const lt = e.laborType as string;
    byType[lt] = (byType[lt] ?? 0) + 1;
  }

  return NextResponse.json({
    data: employees,
    summary: { total: employees.length, active: activeCount, byLaborType: byType },
  });
}
