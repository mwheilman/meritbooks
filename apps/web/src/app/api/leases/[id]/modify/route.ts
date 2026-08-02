export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { modifyLeaseSchema } from '@/lib/leases/schema';
import { previewModification, confirmRemeasurement } from '@/lib/leases/modify-posting';
import { PostingError } from '@/lib/posting/account-roles';
import { LeaseInputError } from '@/lib/leases/schedule';

/**
 * POST /api/leases/[id]/modify — remeasure a lease for a modification (ASC 842).
 *
 * `confirm=false` (default) PREVIEWS the remeasured ROU + liability + the resulting
 * balanced entry. `confirm=true` posts the adjusting entry through the deterministic
 * engine (accounts by ROLE), rebuilds the forward schedule (already-posted periods
 * untouched), and updates the lease. Idempotent on a deterministic source_ref.
 */

interface Params {
  params: { id: string };
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const body = await request.json().catch(() => null);
  const parsed = modifyLeaseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' }, { status: 400 });
  }
  const input = {
    paymentCents: parsed.data.payment_cents,
    remainingPeriods: parsed.data.remaining_periods,
    annualDiscountRate: parsed.data.discount_rate,
    scopeReduction: parsed.data.scope_reduction,
  };

  try {
    if (!parsed.data.confirm) {
      const preview = await previewModification(ctx.supabase, ctx.orgId, params.id, input);
      return NextResponse.json({ data: preview }, { status: 200 });
    }
    const result = await confirmRemeasurement(ctx.supabase, ctx.orgId, ctx.userId, params.id, input, 'MOD');
    return NextResponse.json({ data: result }, { status: result.applied ? 201 : 200 });
  } catch (e) {
    if (e instanceof LeaseInputError) return NextResponse.json({ error: e.message, code: 'INVALID_TERMS' }, { status: 400 });
    if (e instanceof PostingError) return NextResponse.json({ error: e.message, code: 'REMEASURE_FAILED' }, { status: 422 });
    console.error('[leases/modify] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to modify lease', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
