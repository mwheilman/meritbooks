export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm } from '@/lib/pm/db';
import { callRpc, wrote } from '@/lib/pm/money/rpc';
import { IsoDate, PosCents, Text2000, Uuid } from '@/lib/pm/money/schemas';
import { loadCommitment } from '@/lib/pm/money/load';

const DocType = z.enum(['COI', 'LIEN_WAIVER_CONDITIONAL', 'LIEN_WAIVER_UNCONDITIONAL', 'LIEN_WAIVER_FINAL', 'W9', 'CERTIFIED_PAYROLL', 'OTHER']);
const Fields = {
  required: z.boolean().optional(),
  expiresOn: IsoDate.nullish(),
  coversThrough: IsoDate.nullish(),
  amountCents: PosCents.nullish(),
  notes: Text2000.nullish(),
  /** Members record MISSING / RECEIVED / REJECTED; VERIFIED only through verify_compliance_doc. */
  status: z.enum(['MISSING', 'RECEIVED', 'REJECTED']).optional(),
};
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), docType: DocType, ...Fields }),
  z.object({ op: z.literal('update'), docId: Uuid, ...Fields }),
  z.object({ op: z.literal('verify'), docId: Uuid, expiresOn: IsoDate.nullish() }),
  z.object({ op: z.literal('remove'), docId: Uuid }),
]);

/**
 * Certificates of insurance and lien waivers on a commitment. A required document that is
 * missing, unverified or expired holds payment on the commitment in Merit Books.
 */
export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, ops: { verify: { cap: 'projects.commitments', action: 'approve' } }, mask: 'commitment', body: Body }, async ({ db, params, body }) => {
  const c = await loadCommitment(db, params.commitmentId!);
  if (body.op === 'add') {
    const d = wrote<{ id: string }>(
      await pm(db).from('compliance_docs').insert({
        job_id: c.job_id, commitment_id: c.id, vendor_id: c.vendor_id, doc_type: body.docType, status: body.status ?? 'MISSING',
        required: body.required ?? true, expires_on: body.expiresOn ?? null, covers_through: body.coversThrough ?? null,
        amount_cents: body.amountCents ?? null, notes: body.notes ?? null,
      }).select('id').single(),
      'record',
    );
    return { docId: d.id };
  }
  const doc = one<{ id: string; commitment_id: string | null; status: string }>(await pm(db).from('compliance_docs').select('id, commitment_id, status').eq('id', body.docId).maybeSingle(), 'document');
  if (!doc || doc.commitment_id !== c.id) throw new HttpError(404, 'That document was not found on this commitment.', 'NOT_FOUND');
  if (body.op === 'verify') {
    await callRpc(db, 'verify_compliance_doc', { p_doc: doc.id, p_expires_on: body.expiresOn ?? null }, 'record');
    return { ok: true };
  }
  if (doc.status === 'VERIFIED') throw new HttpError(422, 'A verified document is locked. Add a new one when it is renewed.', 'COMPLIANCE_VERIFIED');
  if (body.op === 'remove') {
    wrote(await pm(db).from('compliance_docs').delete().eq('id', doc.id).select('id'), 'record');
    return { ok: true };
  }
  const patch: Record<string, unknown> = {};
  if (body.required !== undefined) patch.required = body.required;
  if (body.expiresOn !== undefined) patch.expires_on = body.expiresOn;
  if (body.coversThrough !== undefined) patch.covers_through = body.coversThrough;
  if (body.amountCents !== undefined) patch.amount_cents = body.amountCents;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.status !== undefined) patch.status = body.status;
  wrote(await pm(db).from('compliance_docs').update(patch).eq('id', doc.id).select('id'), 'record');
  return { ok: true };
});
