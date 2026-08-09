export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { assembleApprovedBatch } from '@/lib/ap/assemble-batch';
import { buildDisbursementBatch } from '@/lib/ap/disbursement-batch';
import { loadVendorPaymentProfiles, loadCheckNumbers } from '@/lib/ap/vendor-payment-details';

/**
 * GET /api/ap/disbursements/batch — the APPROVED, ready-to-release batch.
 *
 * Assembles the AP_DISBURSEMENT approvals a human has already APPROVED into a
 * vendor-grouped batch with per-vendor + total controls and an intra-batch
 * duplicate-payment guard, then joins each vendor's MASKED payment profile and
 * any assigned check numbers so the pay-run review can show remittance readiness.
 * READ-ONLY: no money moves, nothing posts to the GL, no bank/payment API is
 * contacted. RLS scopes every read to the caller's org.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const emptyControls = {
    itemCount: 0,
    vendorCount: 0,
    totalCents: 0,
    byMethod: { ACH: { count: 0, totalCents: 0 }, CHECK: { count: 0, totalCents: 0 } },
    hasBlockingDuplicates: false,
  };

  try {
    const { items, unresolved } = await assembleApprovedBatch(supabase);
    if (items.length === 0) {
      return NextResponse.json({
        groups: [],
        controls: emptyControls,
        duplicateWarnings: [],
        profiles: [],
        checkNumbers: {},
        unresolved,
      });
    }
    const batch = buildDisbursementBatch(items);

    const vendorIds = Array.from(new Set(batch.groups.map((g) => g.vendorId)));
    const approvalIds = batch.groups.flatMap((g) => g.items.map((i) => i.approvalId));
    const [profileMap, checkMap] = await Promise.all([
      loadVendorPaymentProfiles(supabase, vendorIds),
      loadCheckNumbers(supabase, approvalIds),
    ]);

    return NextResponse.json({
      ...batch,
      profiles: Array.from(profileMap.values()),
      checkNumbers: Object.fromEntries(checkMap),
      unresolved,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to assemble batch' }, { status: 500 });
  }
}
