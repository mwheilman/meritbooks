export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { listOutstanding } from '@/lib/receipts/bookkeeper';
import { loadReceiptPolicyContext, chaseEnabledFor } from '@/lib/receipts/policy';
import { chaseListQuery } from '@/lib/validations/receipts';

/**
 * GET /api/receipts/chase — the bookkeeper's board: outstanding card charges grouped by
 * cardholder (age, amount, asks, last opened, escalated) + the strip. receipts:view.
 * Reads go through the caller's RLS client (org + client scope enforced by the DB).
 */
export const GET = apiQueryHandler(chaseListQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await requirePermission(userId, 'receipts', 'view', { route: '/api/receipts/chase' });
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const now = new Date();
  const [{ groups, strip }, ctx] = await Promise.all([
    listOutstanding(supabase, orgId, { locationId: q.location_id ?? null, now, q: q.q ?? null }),
    loadReceiptPolicyContext(supabase, orgId),
  ]);
  return NextResponse.json({
    groups,
    strip,
    chase: {
      tenantEnabled: ctx.switches.tenantEnabled,
      clientEnabled: q.location_id ? chaseEnabledFor(ctx.switches, q.location_id) : null,
    },
  });
});
