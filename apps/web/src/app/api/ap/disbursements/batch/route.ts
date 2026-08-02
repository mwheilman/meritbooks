export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { assembleApprovedBatch } from '@/lib/ap/assemble-batch';
import { buildDisbursementBatch } from '@/lib/ap/disbursement-batch';

/**
 * GET /api/ap/disbursements/batch — the APPROVED, ready-to-release batch.
 *
 * Assembles the AP_DISBURSEMENT approvals a human has already APPROVED into a
 * vendor-grouped batch with per-vendor + total controls and an intra-batch
 * duplicate-payment guard. READ-ONLY: no money moves, nothing posts to the GL,
 * no bank/payment API is contacted. RLS scopes every read to the caller's org.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  try {
    const { items, unresolved } = await assembleApprovedBatch(supabase);
    if (items.length === 0) {
      return NextResponse.json({
        groups: [],
        controls: { itemCount: 0, vendorCount: 0, totalCents: 0, byMethod: { ACH: { count: 0, totalCents: 0 }, CHECK: { count: 0, totalCents: 0 } }, hasBlockingDuplicates: false },
        duplicateWarnings: [],
        unresolved,
      });
    }
    const batch = buildDisbursementBatch(items);
    return NextResponse.json({ ...batch, unresolved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to assemble batch' }, { status: 500 });
  }
}
