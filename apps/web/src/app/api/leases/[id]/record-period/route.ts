export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { recordLeasePeriod } from '@/lib/leases/lease-posting';
import { PostingError } from '@/lib/posting/account-roles';

/**
 * POST /api/leases/[id]/record-period — the monthly "record this period" action.
 *
 * Posts the next unposted schedule line as a balanced journal entry through the
 * deterministic posting engine (accounts resolved by ROLE). Idempotent: a period
 * already carrying a gl_entry_id is skipped, and the posted entry stamps
 * `source_id = line.id` so a retry can't double-post. Degrade-safe: an unresolved
 * account role returns a 422 with an actionable message rather than a wrong post.
 */

interface Params {
  params: { id: string };
}

export async function POST(_request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  try {
    const result = await recordLeasePeriod(ctx.supabase, ctx.orgId, ctx.userId, params.id);
    if (!result.posted) {
      return NextResponse.json({ ...result, code: 'NOTHING_TO_POST' }, { status: 200 });
    }
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof PostingError) {
      return NextResponse.json({ error: e.message, code: 'POST_FAILED' }, { status: 422 });
    }
    console.error('[leases/record-period] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to record lease period', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
