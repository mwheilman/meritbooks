export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireMoneyMovement, PAYMENTS_EXECUTE, AP_DISBURSEMENT_RELEASE_FEATURE } from '@/lib/rbac/payments-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { resolveOriginationProvider, refreshOriginationBatch } from '@/lib/money/origination';

/**
 * POST /api/ap/origination/refresh-status — poll the rail for a submitted batch and
 * persist the returned lifecycle (SETTLED / RETURNED / FAILED).
 *
 * On a RETURN the item is stamped RETURNED with its ACH return code and the batch
 * rolls up to RETURNED — SURFACED for a human. NOTHING is reversed in the GL: a real
 * return needs a human-authorized reversing entry.
 *
 * `simulate` is honored ONLY by the SANDBOX adapter — it lets the operator drive a
 * deterministic RETURN/FAILURE for testing/demo without a live rail. Gated on the
 * EXISTING `ap_disbursement_release` money-movement permission. RLS scopes to org.
 */
interface RefreshBody {
  batchId?: string;
  simulate?: {
    returns?: Array<{ itemId: string; returnCode: string }>;
    fail?: boolean;
  };
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

  let body: RefreshBody = {};
  try {
    body = (await request.json()) as RefreshBody;
  } catch {
    /* fallthrough — batchId required below */
  }
  if (!body.batchId) return NextResponse.json({ error: 'batchId is required' }, { status: 400 });

  const provider = await resolveOriginationProvider(supabase, orgId);

  try {
    const batch = await refreshOriginationBatch(supabase, orgId, body.batchId, provider, body.simulate);

    if (batch.status === 'RETURNED' || batch.status === 'FAILED') {
      const returned = batch.items.filter((i) => i.status === 'RETURNED' || i.status === 'FAILED');
      await logHumanAction(supabase, userId, orgId, {
        action: 'ap.origination.return',
        subjectTable: 'payment_origination_batches',
        subjectId: batch.id,
        summary: `Origination batch ${batch.status}: ${returned.length} item(s) need review (no GL reversal was made automatically)`,
        metadata: {
          status: batch.status,
          returned: returned.map((i) => ({ itemId: i.id, returnCode: i.returnCode, billPaymentId: i.billPaymentId })),
        },
      }).catch(() => {});
    }

    return NextResponse.json({ batch });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Refresh failed' }, { status: 500 });
  }
}
