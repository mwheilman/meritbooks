export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { computeReadiness } from '@/lib/onboarding/readiness';

/**
 * GET /api/onboarding/readiness
 *
 * Read-only "Readiness Ledger" for the caller's org: a live checklist of how populated
 * the book of record is (counts per domain) plus the single "next best action". Thin
 * wrapper — all aggregation lives in lib/onboarding/readiness.ts. Fails closed (400)
 * when the token carries no org claim; never writes.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  try {
    const summary = await computeReadiness(supabase, orgId);
    return NextResponse.json(summary);
  } catch (error) {
    console.error('[onboarding/readiness] Failed to compute readiness:', error);
    return NextResponse.json(
      { error: 'Failed to compute readiness', code: 'READINESS_ERROR' },
      { status: 500 },
    );
  }
}
