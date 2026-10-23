export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { loadWritableRow } from '@/lib/db/scoped-writer';
import { updateSplitRuleSchema, type UpdateSplitRuleInput } from '@/lib/validations/bank-splits';

/**
 * POST /api/bank-feed/split-rules
 * "Forget this split rule" — deactivates a remembered split (split_rules is SELECT-only
 * for members, migration 177: the row is loaded through the service role pinned to the
 * caller's verified org and client scope, then updated). Rules are created on approve
 * ("Remember this split") — see /api/bank-feed/approve.
 */
export const POST = apiHandler(updateSplitRuleSchema, async (body: UpdateSplitRuleInput, ctx) => {
  const guard = await requirePermission(ctx.userId, 'bank_feed', 'edit');
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;

  const { createAdminSupabase } = await import('@/lib/supabase/server');
  const rule = await loadWritableRow<{ id: string; name: string; location_id: string | null }>(ctx.supabase, orgId, {
    table: 'split_rules',
    id: body.id,
    select: 'id, name, location_id',
  });
  if (!rule) return NextResponse.json({ error: 'Split rule not found' }, { status: 404 });

  const { error } = await createAdminSupabase()
    .from('split_rules')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', rule.id)
    .eq('org_id', orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logHumanAction(ctx.supabase, ctx.userId, orgId, {
    action: 'bankfeed.split_rule.forget',
    subjectTable: 'split_rules',
    subjectId: rule.id,
    summary: `Forgot split rule "${rule.name}"`,
    locationId: rule.location_id ?? undefined,
  });
  return NextResponse.json({ success: true, id: rule.id });
});
