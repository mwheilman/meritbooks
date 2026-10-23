export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { reverseBankTransactionSchema, type ReverseBankTransactionInput } from '@/lib/validations/bank-splits';
import { loadFeedTxn, reverseFeedPosting, SplitError } from '@/lib/bank/splits/service';

/**
 * POST /api/bank-feed/reverse
 * Reversal-on-edit for a POSTED bank / card feed line (Posting Engine Spec Part G;
 * posted-GL immutability, migration 153): voids every journal entry the line produced
 * (all companies of a cross-company split — refused as a whole in a hard-closed period),
 * voids the job cost it cleared, and returns the line to review with its split as an
 * editable draft. Nothing is silently mutated; the voided entries stay in the audit trail.
 * Bill-settling lines are reversed from the bill instead.
 */
export const POST = apiHandler(reverseBankTransactionSchema, async (body: ReverseBankTransactionInput, ctx) => {
  // Reversing touches the GL exactly like approving does.
  const guard = await requirePermission(ctx.userId, 'bank_feed', 'approve');
  if (!guard.ok) return guard.response;
  const orgId = ctx.orgId;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const txn = await loadFeedTxn(ctx.supabase, orgId, body.transaction_id);
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

  try {
    const res = await reverseFeedPosting(ctx.supabase, { orgId, txn, reason: body.reason });
    await logHumanAction(ctx.supabase, ctx.userId, orgId, {
      action: 'bankfeed.reverse',
      subjectTable: 'bank_transactions',
      subjectId: txn.id,
      summary: `Reversed ${res.voided.join(', ')} to edit: ${body.reason}`.slice(0, 500),
      locationId: txn.location_id,
    });
    return NextResponse.json({ success: true, voided: res.voided, transaction_id: txn.id });
  } catch (e) {
    if (e instanceof SplitError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
});
