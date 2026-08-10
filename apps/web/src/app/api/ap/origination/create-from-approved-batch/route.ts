export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireMoneyMovement, PAYMENTS_EXECUTE, AP_DISBURSEMENT_RELEASE_FEATURE } from '@/lib/rbac/payments-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { resolveOriginationProvider } from '@/lib/money/origination';
import { createOriginationBatch, NothingToOriginateError } from '@/lib/money/origination';
import type { OriginationRail } from '@/lib/money/origination';

/**
 * POST /api/ap/origination/create-from-approved-batch
 *
 * Create a rail hand-off batch from already-RELEASED (posted) AP disbursements. This
 * NEVER posts to the GL and NEVER moves money — the release already posted DR A/P /
 * CR Cash. It only records that these posted disbursements are being handed to a
 * rail (SANDBOX today). Idempotent: a released disbursement already placed in an
 * origination batch is skipped, so it can't be originated twice.
 *
 * Gated on the EXISTING `ap_disbursement_release` money-movement permission (the same
 * authority that released the batch) — no new permission is invented. RLS scopes
 * every read/write to the caller's org.
 */
interface CreateBody {
  approvalIds?: string[];
  rail?: OriginationRail;
  effectiveDate?: string | null;
}

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requireMoneyMovement(
    userId,
    PAYMENTS_EXECUTE,
    { feature: 'checks', action: 'create' },
    AP_DISBURSEMENT_RELEASE_FEATURE,
  );
  if (!guard.ok) return guard.response;

  let body: CreateBody = {};
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    /* empty body ok — originate all eligible released disbursements */
  }
  const rail: OriginationRail = body.rail === 'WIRE' ? 'WIRE' : 'ACH';
  const approvalIds = Array.isArray(body.approvalIds) && body.approvalIds.length > 0 ? body.approvalIds : undefined;

  const provider = await resolveOriginationProvider(supabase, orgId);

  try {
    const batch = await createOriginationBatch(supabase, orgId, {
      provider: provider.name,
      rail,
      approvalIds,
      effectiveDate: body.effectiveDate ?? null,
    });

    await logHumanAction(supabase, userId, orgId, {
      action: 'ap.origination.create',
      subjectTable: 'payment_origination_batches',
      subjectId: batch.id,
      summary: `Created ${provider.name} origination batch: ${batch.itemCount} payment(s), ${(batch.totalCents / 100).toFixed(2)} on ${batch.rail}`,
      metadata: { provider: provider.name, rail: batch.rail, itemCount: batch.itemCount, totalCents: batch.totalCents },
    }).catch(() => {});

    return NextResponse.json({ batch });
  } catch (e) {
    if (e instanceof NothingToOriginateError) {
      return NextResponse.json({ error: e.message, code: 'NOTHING_TO_ORIGINATE' }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to create origination batch' }, { status: 500 });
  }
}
