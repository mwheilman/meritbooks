import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { Cents, Day, Text } from '@/lib/pm/ops/schemas';

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('advance'),
    to: z.enum(['SUBMITTED', 'RETURNED', 'APPROVED', 'PAID', 'REJECTED', 'WRITTEN_OFF']),
    amountCents: Cents.nullish(),
    claimNumber: Text(60).nullish(),
    reason: Text(500).nullish(),
  }),
  z.object({
    op: z.literal('update'),
    claimNumber: Text(60).nullish(),
    failureCode: Text(60).nullish(),
    laborOp: Text(60).nullish(),
    claimedLaborCents: Cents.optional(),
    claimedPartsCents: Cents.optional(),
    claimedOtherCents: Cents.optional(),
    filingDeadline: Day.nullish(),
    notes: Text(2000).nullish(),
  }),
  z.object({ op: z.literal('delete') }),
]);

export const POST = route({ body: Op }, async ({ db, params, body }) => {
  const c = await own<{ id: string; status: string }>(db, 'warranty_claims', 'id, status', { id: params.claimId! }, 'That claim was not found.');
  const pm = db.schema('pm');
  switch (body.op) {
    case 'advance':
      await call(db, 'advance_warranty_claim', { p_claim: c.id, p_to: body.to, p_amount_cents: body.amountCents ?? null, p_claim_number: body.claimNumber || null, p_reason: body.reason || null });
      return { ok: true };
    case 'update': {
      if (c.status !== 'DRAFT') throw new HttpError(422, 'Submitted claims are locked. Move them through the claim steps.', 'PM_CLAIM_LOCKED');
      const map: Array<[keyof typeof body, string]> = [
        ['claimNumber', 'claim_number'], ['failureCode', 'failure_code'], ['laborOp', 'labor_op'], ['claimedLaborCents', 'claimed_labor_cents'],
        ['claimedPartsCents', 'claimed_parts_cents'], ['claimedOtherCents', 'claimed_other_cents'], ['filingDeadline', 'filing_deadline'], ['notes', 'notes'],
      ];
      const patch: Record<string, unknown> = {};
      for (const [k, col] of map) if (body[k] !== undefined) patch[col] = body[k] === '' ? null : body[k];
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(pm.from('warranty_claims').update(patch).eq('id', c.id).select('id'), 'update claim');
      return { ok: true };
    }
    case 'delete':
      if (c.status !== 'DRAFT') throw new HttpError(422, 'Only a draft claim can be deleted.', 'VALIDATION');
      await write(pm.from('warranty_claims').delete().eq('id', c.id).select('id'), 'delete claim');
      return { ok: true };
  }
});
