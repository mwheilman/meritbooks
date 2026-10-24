export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { runTieOut } from '@/lib/reports/engine/adapter';
import { engineErrorResponse } from '@/lib/reports/engine/http';

/**
 * GET /api/reports/engine/tie-out — admin check that the maintained balances store
 * (period_balances, mig 185) equals Σ POSTED gl_entry_lines for every company × account ×
 * month × dimension × entry kind (service-role read pinned to the caller's org; mismatch rows
 * limited to the companies in the caller's scope). { tied, mismatches[≤200] }.
 * Gated on close_mgmt:manage (controllers). Read-only. A mismatch is repaired by the
 * service-role rebuild_period_balances(org) (lead / ops).
 */
export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(userId, 'close_mgmt', 'manage', { route: '/api/reports/engine/tie-out' });
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ data: await runTieOut({ supabase, orgId, userId }) });
  } catch (e) {
    return engineErrorResponse(e);
  }
}
