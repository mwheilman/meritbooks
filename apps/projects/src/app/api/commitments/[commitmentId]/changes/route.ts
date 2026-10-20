export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm } from '@/lib/pm/db';
import { callRpc, wrote } from '@/lib/pm/money/rpc';
import { Cents, Text200, Text2000, Uuid } from '@/lib/pm/money/schemas';
import { loadCommitment } from '@/lib/pm/money/load';

const Body = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    lineId: Uuid.nullish(),
    costCodeId: Uuid.nullish(),
    description: Text200.min(1, 'Describe the change.'),
    reason: Text200.nullish(),
    amountCents: Cents.refine((n) => n !== 0, 'Enter an amount other than zero.'),
    ownerCoId: Uuid.nullish(),
  }),
  z.object({ op: z.literal('approve'), changeId: Uuid }),
  z.object({ op: z.literal('reject'), changeId: Uuid, reason: Text2000.nullish() }),
  z.object({ op: z.literal('delete'), changeId: Uuid }),
]);

/** Commitment change orders: draft (member insert), approve_commitment_change (tier + SoD; re-sends), reject_commitment_change. */
export const POST = route({ body: Body }, async ({ db, params, body }) => {
  const c = await loadCommitment(db, params.commitmentId!);
  if (body.op === 'create') {
    if (c.status !== 'APPROVED' && c.status !== 'EXECUTED') {
      throw new HttpError(422, 'Changes apply to approved or signed commitments. Edit a draft commitment directly.', 'PM_CCO_COMMITMENT_STATE');
    }
    if (!body.lineId && (!body.costCodeId || body.amountCents <= 0)) {
      throw new HttpError(422, 'A change that adds a line needs a cost code and an amount above zero.', 'PM_CCO_NEW_LINE');
    }
    const x = wrote<{ id: string; number: string }>(
      await pm(db).from('commitment_changes').insert({
        commitment_id: c.id, commitment_line_id: body.lineId ?? null, cost_code_id: body.lineId ? null : body.costCodeId ?? null,
        description: body.description, reason: body.reason ?? null, amount_cents: body.amountCents, owner_co_id: body.ownerCoId ?? null,
      }).select('id, number').single(),
      'commitment change',
    );
    return { changeId: x.id, number: x.number };
  }
  const x = one<{ id: string; commitment_id: string; status: string }>(await pm(db).from('commitment_changes').select('id, commitment_id, status').eq('id', body.changeId).maybeSingle(), 'change');
  if (!x || x.commitment_id !== c.id) throw new HttpError(404, 'That change was not found on this commitment.', 'NOT_FOUND');
  if (body.op === 'approve') {
    const eventId = await callRpc<string | null>(db, 'approve_commitment_change', { p_change: x.id }, 'commitment change');
    return { sent: !!eventId };
  }
  if (body.op === 'reject') {
    await callRpc(db, 'reject_commitment_change', { p_change: x.id, p_reason: body.reason ?? null }, 'commitment change');
    return { ok: true };
  }
  if (x.status !== 'DRAFT') throw new HttpError(422, 'Only a draft change can be deleted.', 'PM_CCO_NOT_DRAFT');
  wrote(await pm(db).from('commitment_changes').delete().eq('id', x.id).select('id'), 'commitment change');
  return { ok: true };
});
