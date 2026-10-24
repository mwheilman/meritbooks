export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadAccounts, loadCompanies, resolveCompanies } from '@/lib/reports/engine/adapter';
import { listLayouts } from '@/lib/reports/engine/layouts-store';
import { engineErrorResponse } from '@/lib/reports/engine/http';

/**
 * GET /api/reports/engine/meta — everything the viewer's pickers and the row designer
 * need in one round-trip: companies in the caller's client scope, departments, classes,
 * account groups / roles (designer), saved layouts, and the org fiscal-year start.
 */
export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(userId, 'reports', 'view', { route: '/api/reports/engine/meta' });
  if (!guard.ok) return guard.response;
  try {
    const [companies, accounts, depts, classes, layouts, org] = await Promise.all([
      loadCompanies(supabase),
      loadAccounts(supabase),
      supabase.schema('core').from('departments').select('id, name, code, is_active').order('name'),
      supabase.from('classes').select('id, name, code, is_active').order('name'),
      listLayouts(supabase),
      supabase.schema('core').from('organizations').select('fiscal_year_start_month').eq('id', orgId).maybeSingle(),
    ]);
    const inScope = new Set(await resolveCompanies({ supabase, orgId, userId }, [], companies));
    const groups = new Map<string, { id: string; name: string; type: string; subType: string }>();
    const roles = new Set<string>();
    for (const a of accounts) {
      if (!groups.has(a.groupId)) groups.set(a.groupId, { id: a.groupId, name: a.groupName, type: a.type, subType: a.subType });
      for (const r of a.roles) roles.add(r);
    }
    const active = <T extends { is_active?: boolean | null }>(rows: T[] | null) => (rows ?? []).filter((r) => r.is_active !== false);
    return NextResponse.json({
      data: {
        companies: companies.filter((c) => inScope.has(c.id)),
        departments: active(depts.data as Array<{ id: string; name: string; code: string; is_active: boolean }> | null).map((d) => ({ id: d.id, name: d.name, code: d.code })),
        classes: active(classes.data as Array<{ id: string; name: string; code: string; is_active: boolean }> | null).map((d) => ({ id: d.id, name: d.name, code: d.code })),
        accountGroups: [...groups.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
        accounts: accounts.filter((a) => a.isActive).map((a) => ({ id: a.id, number: a.number, name: a.name, type: a.type, groupId: a.groupId })),
        roles: [...roles].sort(),
        layouts,
        fyStartMonth: Number((org.data as { fiscal_year_start_month?: number } | null)?.fiscal_year_start_month ?? 1) || 1,
      },
    });
  } catch (e) {
    return engineErrorResponse(e);
  }
}
