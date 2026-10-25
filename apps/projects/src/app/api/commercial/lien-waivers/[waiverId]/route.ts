export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { WaiverAction } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/**
 * POST /api/commercial/lien-waivers/:id — sent for signature, received (with what the signed
 * form says), verified (amount, through-date and statutory form checked; a verified waiver
 * releases the payment hold on JOB_COMMITMENT).
 */
export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, ops: { verify: { cap: 'projects.commitments', action: 'approve' } }, mask: ['commitment'], body: WaiverAction }, async ({ db, body, params }) => {
  const id = params.waiverId!;
  switch (body.op) {
    case 'sent':
      return { id: await cmRpc<string>(db, 'cm_lien_waiver_sent', { p_waiver: id, p_envelope: body.envelopeId }, 'commitment') };
    case 'receive': {
      const signed: Record<string, string | number> = {};
      if (body.amountCents !== null) signed.amount_cents = body.amountCents;
      if (body.throughDate !== null) signed.through_date = body.throughDate;
      if (body.formKey !== null) signed.form_key = body.formKey;
      return { id: await cmRpc<string>(db, 'cm_receive_lien_waiver', { p_waiver: id, p_document: body.documentId, p_signed: signed }, 'commitment') };
    }
    case 'verify':
      return cmRpc<Record<string, unknown>>(db, 'cm_verify_lien_waiver', { p_waiver: id }, 'commitment');
  }
});
