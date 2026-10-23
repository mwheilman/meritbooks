export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * GET /api/bank-feed/cost-codes
 * The tenant's job cost codes (org-level, public.job_cost_codes) for the split grid's
 * cost-code picker. Read-only, RLS-scoped.
 */
export const GET = apiQueryHandler(null, async (_params: Record<string, never>, ctx) => {
  const guard = await requirePermission(ctx.userId, 'bank_feed', 'view');
  if (!guard.ok) return guard.response;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const { data, error } = await ctx.supabase
    .from('job_cost_codes')
    .select('id, code, name, cost_type')
    .eq('org_id', ctx.orgId)
    .order('code', { ascending: true })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ cost_codes: data ?? [] });
});
