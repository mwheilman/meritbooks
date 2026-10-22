export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm } from '@/lib/pm/db';
import { callRpc } from '@/lib/pm/money/rpc';
import { IsoDate, PosCents, Qty, Text200, Uuid } from '@/lib/pm/money/schemas';
import { loadCommitment } from '@/lib/pm/money/load';

const Body = z.object({
  lineId: Uuid,
  qty: Qty.nullish(),
  amountCents: PosCents.nullish(),
  receivedOn: IsoDate.nullish(),
  memo: Text200.nullish(),
  packingSlip: z.string().trim().max(80).nullish(),
}).refine((b) => (b.qty != null && Number(b.qty) > 0) || (b.amountCents != null && b.amountCents > 0), { message: 'Enter the quantity or the amount received.', path: ['qty'] });

/** pm.record_receipt: goods or work received on a line; re-sends the commitment with received to date. */
export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, mask: 'commitment', body: Body }, async ({ db, params, body }) => {
  const c = await loadCommitment(db, params.commitmentId!);
  const line = one<{ id: string }>(await pm(db).from('commitment_lines').select('id').eq('id', body.lineId).eq('commitment_id', c.id).maybeSingle(), 'line');
  if (!line) throw new HttpError(404, 'That line was not found on this commitment.', 'NOT_FOUND');
  const id = await callRpc<string>(db, 'record_receipt', {
    p_commitment_line: line.id,
    p_qty: body.qty != null ? Number(body.qty) : null,
    p_received_on: body.receivedOn ?? null,
    p_memo: body.memo ?? null,
    p_document: null,
    p_amount_cents: body.amountCents ?? null,
    p_packing_slip: body.packingSlip ?? null,
  }, 'record');
  const r = one<{ amount_cents: number; over_receipt: boolean }>(await pm(db).from('receipts').select('amount_cents, over_receipt').eq('id', id).maybeSingle(), 'receipt');
  return { receiptId: id, amountCents: r?.amount_cents ?? null, overReceipt: r?.over_receipt ?? false };
});
