export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * GET /api/payroll/employees — the active-employee roster the payroll run wizard
 * picks from. Thin identity + comp basis ONLY; NO payroll PII (SSN/bank/withholding)
 * — that lives at the provider + Core vault, never surfaced here. RLS-scoped.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId } = ctx;

  const guard = await requirePermission(userId, 'payroll', 'view');
  if (!guard.ok) return guard.response;

  const { data: emps, error } = await supabase
    .schema('core')
    .from('employees')
    .select('id, first_name, last_name, title, department_id, hourly_rate_cents, annual_salary_cents')
    .eq('is_active', true)
    .order('last_name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (emps ?? []) as Array<{
    id: string; first_name: string | null; last_name: string | null; title: string | null;
    department_id: string | null; hourly_rate_cents: number | null; annual_salary_cents: number | null;
  }>;

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
      baseRateCents: r.hourly_rate_cents ?? null,
      annualSalaryCents: r.annual_salary_cents ?? null,
      standardHours: null as number | null,
      isContractor: false,
      departmentName: r.department_id ? (deptMap.get(r.department_id)?.name ?? null) : null,
    };
  });

  return NextResponse.json({ employees });
}
