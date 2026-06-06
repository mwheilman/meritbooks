export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { isCapabilityEntitled } from '@/lib/money/connections';
import { createLinkToken, type PlaidEnv } from '@/lib/money/providers/plaid';

const ENV: PlaidEnv = process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox';

/**
 * POST /api/integrations/plaid/link-token
 *   -> { link_token } for opening Plaid Link in the browser.
 * Requires auth + the BANK_FEED entitlement (fails closed otherwise).
 */
export async function POST() {
  const a = await auth().catch(() => null);
  const userId = (a as { userId?: string | null } | null)?.userId ?? null;
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase);
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
