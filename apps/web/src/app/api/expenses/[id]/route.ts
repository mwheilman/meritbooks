export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadReport } from '@/lib/expenses/expense-reports';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * GET    /api/expenses/[id]  — report header + lines (stitched category + entity).
 * DELETE /api/expenses/[id]  — delete a DRAFT report (cascades its lines).
 */

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'view');
  if (!guard.ok) return guard.response;

  let report, lines;
  try {
    ({ report, lines } = await loadReport(supabase, orgId, params.id));
  } catch {
    return NextResponse.json({ error: 'Expense report not found' }, { status: 404 });
  }

  // Stitch GL account names + the submitting employee (cross-schema embeds fail).
  const accountIds = lines.map((l) => l.account_id).filter((x): x is string => !!x);
  let acctMap = new Map<string, { id: string; account_number: string; name: string }>();
  if (accountIds.length > 0) {
    const { data: accts } = await supabase
      .from('accounts')
      .select('id, account_number, name')
      .eq('org_id', orgId)
      .in('id', accountIds);
    acctMap = new Map((accts ?? []).map((a: { id: string; account_number: string; name: string }) => [a.id, a]));
  }

  const empMap = report.employee_id
    ? await fetchCoreMap<{ id: string; first_name: string; last_name: string }>(
        supabase,
        'employees',
        'id, first_name, last_name',
        [report.employee_id]
      )
    : new Map();
  const emp = report.employee_id ? empMap.get(report.employee_id) ?? null : null;

  return NextResponse.json({
    report: {
      ...report,
      employee_name: emp ? `${emp.first_name} ${emp.last_name}`.trim() : null,
    },
    lines: lines.map((l) => ({
      ...l,
      account: l.account_id ? acctMap.get(l.account_id) ?? null : null,
    })),
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'create');
  if (!guard.ok) return guard.response;

  let report;
  try {
    ({ report } = await loadReport(supabase, orgId, params.id));
  } catch {
    return NextResponse.json({ error: 'Expense report not found' }, { status: 404 });
  }
  if (report.status !== 'DRAFT') {
    return NextResponse.json({ error: 'Only a draft report can be deleted' }, { status: 409 });
  }

  const { error } = await supabase.from('expense_reports').delete().eq('id', params.id).eq('org_id', orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
