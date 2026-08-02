export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { cpiResetSchema } from '@/lib/leases/schema';
import { previewCpiReset, confirmRemeasurement, loadCarryingContext } from '@/lib/leases/modify-posting';
import { PostingError } from '@/lib/posting/account-roles';
import { LeaseInputError } from '@/lib/leases/schedule';

/**
 * POST /api/leases/[id]/cpi — apply a CPI / index-based payment reset (ASC 842).
 *
 * Only the payment changes; the ORIGINAL discount rate and the remaining term hold. For
 * an operating lease this is a liability remeasurement with a matching ROU adjustment
 * (no P&L). `confirm=false` previews; `confirm=true` posts + rebuilds the forward
 * schedule. Idempotent on a deterministic source_ref.
 */

interface Params {
  params: { id: string };
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const body = await request.json().catch(() => null);
  const parsed = cpiResetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid input', code: 'INVALID_INPUT' }, { status: 400 });
  }

  try {
    if (!parsed.data.confirm) {
      const preview = await previewCpiReset(ctx.supabase, ctx.orgId, params.id, parsed.data.payment_cents);
      return NextResponse.json({ data: preview }, { status: 200 });
    }
    // Resolve the CPI reset to concrete revised terms (original rate + same remaining term).
    const c = await loadCarryingContext(ctx.supabase, ctx.orgId, params.id);
    const result = await confirmRemeasurement(
      ctx.supabase,
      ctx.orgId,
      ctx.userId,
      params.id,
      {
        paymentCents: parsed.data.payment_cents,
        remainingPeriods: c.currentRemainingPeriods,
        annualDiscountRate: Number(c.lease.discount_rate),
        scopeReduction: false,
      },
      'CPI',
    );
    return NextResponse.json({ data: result }, { status: result.applied ? 201 : 200 });
  } catch (e) {
    if (e instanceof LeaseInputError) return NextResponse.json({ error: e.message, code: 'INVALID_TERMS' }, { status: 400 });
    if (e instanceof PostingError) return NextResponse.json({ error: e.message, code: 'REMEASURE_FAILED' }, { status: 422 });
    console.error('[leases/cpi] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to apply CPI reset', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
