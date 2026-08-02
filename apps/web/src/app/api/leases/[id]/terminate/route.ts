export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { terminateLeaseSchema } from '@/lib/leases/schema';
import { previewTermination, confirmTermination } from '@/lib/leases/modify-posting';
import { PostingError } from '@/lib/posting/account-roles';
import { LeaseInputError } from '@/lib/leases/schedule';

/**
 * POST /api/leases/[id]/terminate — early termination (ASC 842).
 *
 * `confirm=false` previews the write-off of the remaining ROU + liability, any cash
 * penalty, and the balancing gain/loss. `confirm=true` posts the balanced write-off
 * entry through the deterministic engine (accounts by ROLE), drops the remaining
 * unposted schedule, and marks the lease TERMINATED. Idempotent on a deterministic
 * source_ref.
 */

interface Params {
  params: { id: string };
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const body = await request.json().catch(() => null);
  const parsed = terminateLeaseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' }, { status: 400 });
  }

  try {
    if (!parsed.data.confirm) {
      const preview = await previewTermination(ctx.supabase, ctx.orgId, params.id, parsed.data.penalty_cents);
      return NextResponse.json({ data: preview }, { status: 200 });
    }
    const result = await confirmTermination(ctx.supabase, ctx.orgId, ctx.userId, params.id, parsed.data.penalty_cents);
    return NextResponse.json({ data: result }, { status: result.applied ? 201 : 200 });
  } catch (e) {
    if (e instanceof LeaseInputError) return NextResponse.json({ error: e.message, code: 'INVALID_TERMS' }, { status: 400 });
    if (e instanceof PostingError) return NextResponse.json({ error: e.message, code: 'TERMINATE_FAILED' }, { status: 422 });
    console.error('[leases/terminate] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to terminate lease', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
