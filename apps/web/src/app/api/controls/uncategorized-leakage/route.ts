export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { scanUncategorizedLeakage } from '@/lib/controls/uncategorized-leakage';

/**
 * Financial Control Exception EC-4 — uncategorized / unposted cost-leakage scan.
 *
 * POST /api/controls/uncategorized-leakage
 *   Scans the caller's org for real economic activity not yet in the GL —
 *   uncoded bank/card lines, captured-but-unposted receipts, and approved-but-
 *   unposted bills — aggregates the aged items by company + period, and queues
 *   them into /exceptions (as PROPOSED ai_decisions rows, feature
 *   'UNCATEGORIZED_LEAKAGE'). Idempotent — a second call REFRESHES the open
 *   buckets (never duplicates), leaves human-resolved buckets alone, and expires
 *   buckets that have since been cleaned up. Returns a close-readiness summary
 *   (count + $ of uncategorized items blocking a clean close, per company/period).
 *
 *   ?dryRun=1  — compute + return close-readiness WITHOUT persisting any rows
 *                (a read-only close-readiness check).
 *
 * Read/write both run through the RLS-scoped client, so the database enforces
 * org isolation; the route never filters org_id by hand. This detects and DRAFTS
 * remediations only — it never codes, posts, pays, or edits the ledger (canon §3:
 * AI proposes; a human with the right role acts).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1';
  const summary = await scanUncategorizedLeakage(supabase, orgId, { dryRun });
  return NextResponse.json({ data: summary });
}
