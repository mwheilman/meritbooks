export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireMoneyMovement, PAYMENTS_EXECUTE, AP_DISBURSEMENT_RELEASE_FEATURE } from '@/lib/rbac/payments-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { resolveOriginationProvider, submitOriginationBatch } from '@/lib/money/origination';

/**
 * POST /api/ap/origination/submit — hand a CREATED batch to the active rail.
 *
 * IDEMPOTENT: a batch that is no longer CREATED (already submitted/settled) is
 * returned unchanged; the rail hand-off is never duplicated. This does NOT post to
 * the GL and does NOT move money — the SANDBOX adapter simulates the submission.
 *
 * Gated on the EXISTING `ap_disbursement_release` money-movement permission (SoD:
 * only a role that can release AP may originate). RLS scopes to the caller's org.
 */
interface SubmitBody {
  batchId?: string;
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

  let body: SubmitBody = {};
  try {
    body = (await request.json()) as SubmitBody;
  } catch {
    /* fallthrough — batchId required below */
  }
  if (!body.batchId) return NextResponse.json({ error: 'batchId is required' }, { status: 400 });

  const provider = await resolveOriginationProvider(supabase, orgId);

  try {
    const outcome = await submitOriginationBatch(supabase, orgId, body.batchId, provider, userId);

    if (outcome.submitted) {
      await logHumanAction(supabase, userId, orgId, {
        action: 'ap.origination.submit',
        subjectTable: 'payment_origination_batches',
        subjectId: outcome.batch.id,
        summary: `Submitted origination batch to ${provider.name} (${outcome.batch.rail}): ${outcome.batch.itemCount} payment(s), ${(outcome.batch.totalCents / 100).toFixed(2)}`,
        metadata: { provider: provider.name, providerBatchRef: outcome.batch.providerBatchRef, status: outcome.batch.status },
      }).catch(() => {});
    }

    return NextResponse.json({ batch: outcome.batch, submitted: outcome.submitted });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Submit failed' }, { status: 500 });
  }
}
