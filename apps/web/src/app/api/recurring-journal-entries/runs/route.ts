export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { listProposedRuns } from '@/lib/recurring-je/store';

/**
 * GET /api/recurring-journal-entries/runs — the review-and-post queue: every
 * PROPOSED recurring entry (period, date, amount, and the balanced line snapshot)
 * awaiting a human approve/reject. Read-only; RLS-scoped.
 */
export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  try {
    const runs = await listProposedRuns(ctx.supabase);
    return NextResponse.json({
      data: runs,
      summary: { total: runs.length, amount_cents: runs.reduce((s, r) => s + r.amount_cents, 0) },
    });
  } catch (e) {
    console.error('[recurring-je/runs] list failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to load proposed entries', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
