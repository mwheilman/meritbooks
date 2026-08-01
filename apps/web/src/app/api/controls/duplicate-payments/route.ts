export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { scanDuplicatePayments } from '@/lib/controls/duplicate-payments';

/**
 * Financial Control Exception EC-1 — duplicate payment / duplicate-vendor scan.
 *
 * POST /api/controls/duplicate-payments
 *   Runs the AP duplicate detector for the caller's org and returns a summary of
 *   what was scanned and how many NEW exceptions were queued into /exceptions
 *   (as PROPOSED ai_decisions rows, feature 'DUPLICATE_PAYMENT'). Idempotent — a
 *   second call queues nothing new because each hit carries a stable dedup_key.
 *
 * Read/write both run through the RLS-scoped client, so the database enforces
 * org isolation; the route never filters org_id by hand. This detects and DRAFTS
 * remediations only — it never voids a payment, merges a vendor, or posts to the
 * ledger (canon §3: AI proposes; a human with the right role acts).
 */
export async function POST(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const summary = await scanDuplicatePayments(supabase, orgId);
  return NextResponse.json({ data: summary });
}
