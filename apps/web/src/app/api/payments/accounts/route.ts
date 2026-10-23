export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { buildPaymentsOverview } from '@/lib/money/payments-overview';
import { listTestRuns } from '@/lib/money/test-payment';
import { paymentsOverviewQuery } from '@/lib/validations/payments';

/**
 * GET /api/payments/accounts[?refresh=1] — Settings → Payments read model: every company
 * with its Stripe account status, payout bank (last 4), TEST/LIVE badge, accepted methods
 * and who pays each fee, plus the Plaid environment and recent $1 test payments.
 *
 * Reads run AS THE USER (RLS: tenant + client scope). `refresh=1` asks Stripe for each
 * account's current status and stores it (service role, after the view check); payout
 * bank changes found that way are audited. Requires settings_system:view.
 */
export const GET = apiQueryHandler(paymentsOverviewQuery, async (q, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'settings_system', 'view');
  if (!guard.ok) return guard.response;

  const admin = createAdminSupabase();
  const [overview, testRuns, configure, editOptions] = await Promise.all([
    buildPaymentsOverview(ctx.supabase, admin, guard.orgId, { refresh: q.refresh === '1', actor: ctx.userId }),
    listTestRuns(ctx.supabase, guard.orgId).catch(() => []),
    requirePermission(ctx.userId, 'settings_system', 'edit'),
    requirePermission(ctx.userId, 'settings_acct', 'edit'),
  ]);

  return NextResponse.json({
    ...overview,
    testRuns,
    can: { configure: configure.ok, editOptions: editOptions.ok },
  });
});
