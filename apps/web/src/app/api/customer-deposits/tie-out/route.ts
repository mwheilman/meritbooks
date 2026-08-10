export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import {
  listDeposits,
  getDepositsGlBalanceCents,
  computeTieOut,
} from '@/lib/customer-deposits/service';

/**
 * GET /api/customer-deposits/tie-out?location_id=<uuid>
 * Reconciliation: the sum of open deposit remainders (subledger) vs the 2420
 * Customer Deposits net credit balance in the GL. They must tie. RLS-scoped.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id') || undefined;

  try {
    const [deposits, glBalance] = await Promise.all([
      listDeposits(supabase, orgId, { locationId }),
      getDepositsGlBalanceCents(supabase, orgId, locationId),
    ]);
    const tie = computeTieOut(deposits, glBalance);
    return NextResponse.json({ data: tie });
  } catch (e) {
    // A missing 2420 account (unresolved role) is an expected setup condition, not
    // a 500 — surface it as a soft, out-of-balance tie-out so the UI can explain.
    const msg = e instanceof Error ? e.message : 'Failed to compute tie-out';
    return NextResponse.json({ error: msg, code: 'TIEOUT_ERROR' }, { status: 422 });
  }
}
