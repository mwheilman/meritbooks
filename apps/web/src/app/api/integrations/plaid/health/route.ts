export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getBankFeedHealth } from '@/lib/money/plaid-sync';
import { bankFeedHealthQuery } from '@/lib/validations/payments';

/**
 * GET /api/integrations/plaid/health[?location_id=] — bank-feed freshness for the banner on
 * the bank feed and cash screens: Plaid environment (Sandbox / Production), last successful
 * sync, and stale / needs-attention. Read-only, AS THE USER (RLS: tenant + client scope);
 * no Item ids, tokens or account numbers leave the server beyond the institution name.
 * Requires bank_feed:view.
 */
export const GET = apiQueryHandler(bankFeedHealthQuery, async (q, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'bank_feed', 'view', { locationId: q.location_id ?? null });
  if (!guard.ok) return guard.response;
  const health = await getBankFeedHealth(ctx.supabase, ctx.orgId, { locationId: q.location_id ?? null });
  return NextResponse.json(health);
});
