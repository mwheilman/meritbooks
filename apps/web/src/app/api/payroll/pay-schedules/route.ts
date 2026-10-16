export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * GET /api/payroll/pay-schedules — active pay schedules for the run wizard's
 * optional schedule picker. Org-scoped (RLS + explicit org filter). Read-only.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'view');
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from('pay_schedules')
    .select('id, name, frequency')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Array<{ id: string; name: string; frequency: string }>;
  const FREQ: Record<string, string> = {
    WEEKLY: 'Weekly', BIWEEKLY: 'Every 2 weeks', SEMIMONTHLY: 'Twice a month', MONTHLY: 'Monthly',
  };
  return NextResponse.json({
    paySchedules: rows.map((r) => ({
      id: r.id,
      label: `${r.name} · ${FREQ[r.frequency] ?? r.frequency}`,
      frequency: r.frequency,
    })),
  });
}
