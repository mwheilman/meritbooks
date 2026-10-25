export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { SubcontractAction } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/**
 * POST /api/commercial/subcontracts/:id — record a payment Merit Books made (requests the
 * unconditional waiver that ties to it), or release the sub's retainage (needs a verified final waiver).
 */
export const POST = route({ access: { cap: 'projects.commitments', action: 'approve' }, ops: { release_retainage: { cap: 'projects.financials', action: 'view' } }, mask: ['commitment', 'billing'], body: SubcontractAction }, async ({ db, body, params }) => {
  const id = params.commitmentId!;
  if (body.op === 'record_payment') {
    return { waiverId: await cmRpc<string>(db, 'cm_record_sub_payment', { p_commitment: id, p_amount_cents: body.amountCents, p_paid_on: body.paidOn, p_payment_ref: body.paymentRef, p_final: body.final }, 'commitment') };
  }
  return { outboxId: await cmRpc<string>(db, 'cm_release_sub_retainage', { p_commitment: id, p_amount_cents: body.amountCents }, 'commitment') };
});
