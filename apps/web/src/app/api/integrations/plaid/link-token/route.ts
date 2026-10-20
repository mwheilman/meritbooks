export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { isCapabilityEntitled } from '@/lib/money/connections';
import { createLinkToken, type PlaidEnv } from '@/lib/money/providers/plaid';
import { requirePermission } from '@/lib/rbac/require-permission';

const ENV: PlaidEnv = process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox';

/**
 * POST /api/integrations/plaid/link-token
 *   -> { link_token } for opening Plaid Link in the browser.
 * Requires auth + the BANK_FEED entitlement (fails closed otherwise).
 */
export async function POST() {
  // Caller + tenant via the app-wide resolver (06 §L.3 L2: explicit `org_id` claim OR
  // Clerk's native `o.id`); an unresolved org fails CLOSED with 400.
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  // Authorize — opening Plaid Link starts a bank connection (system integration);
  // same gate as the exchange step and payments/connect.
  const guard = await requirePermission(userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;

  const supabase = createAdminSupabase();
  try {
    if (!(await isCapabilityEntitled(supabase, orgId, 'BANK_FEED'))) {
      return NextResponse.json({ error: 'Bank feed is not enabled for this tenant.' }, { status: 403 });
    }
    const linkToken = await createLinkToken(supabase, ENV, {
      clientUserId: `${orgId}:${userId}`,
      clientName: 'MeritBooks',
    });
    return NextResponse.json({ ok: true, link_token: linkToken });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
