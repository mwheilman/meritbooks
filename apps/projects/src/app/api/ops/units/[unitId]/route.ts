import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { Cents, Day, Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('status'),
    status: z.enum(['PLANNED', 'ENTITLED', 'AVAILABLE', 'UNDER_CONSTRUCTION', 'COMPLETE', 'UNDER_CONTRACT', 'CLOSED', 'LEASED', 'HELD']),
    on: Day.nullish(),
    buyerId: Uuid.nullish(),
    contractPriceCents: Cents.nullish(),
  }),
  z.object({
    op: z.literal('update'),
    unitNumber: Need(40, 'Number the unit').optional(),
    phase: Text(60).nullish(),
    planName: Text(80).nullish(),
    sqft: z.number().min(0).max(1e7).nullish(),
    listPriceCents: Cents.nullish(),
    lenderReleasePriceCents: Cents.nullish(),
    estCloseOn: Day.nullish(),
    notes: Text(2000).nullish(),
  }),
  z.object({ op: z.literal('delete') }),
]);

export const POST = route({ body: Op }, async ({ db, params, body }) => {
  const u = await own<{ id: string; status: string; buyer_customer_id: string | null; contract_price_cents: number | null }>(db, 'units', 'id, status, buyer_customer_id, contract_price_cents', { id: params.unitId! }, 'That unit was not found.');
  switch (body.op) {
    case 'status':
      if (body.status === 'UNDER_CONTRACT' && !(body.buyerId ?? u.buyer_customer_id)) throw new HttpError(422, 'A unit under contract needs the buyer.', 'VALIDATION');
      if (body.status === 'UNDER_CONTRACT' && (body.contractPriceCents ?? u.contract_price_cents) == null) throw new HttpError(422, 'A unit under contract needs the contract price.', 'VALIDATION');
      await call(db, 'set_unit_status', { p_unit: u.id, p_status: body.status, p_on: body.on ?? null, p_buyer: body.buyerId ?? null, p_contract_price_cents: body.contractPriceCents ?? null });
      return { ok: true };
    case 'update': {
      const map: Array<[keyof typeof body, string]> = [
        ['unitNumber', 'unit_number'], ['phase', 'phase'], ['planName', 'plan_name'], ['sqft', 'sqft'], ['listPriceCents', 'list_price_cents'],
        ['lenderReleasePriceCents', 'lender_release_price_cents'], ['estCloseOn', 'est_close_on'], ['notes', 'notes'],
      ];
      const patch: Record<string, unknown> = {};
      for (const [k, col] of map) if (body[k] !== undefined) patch[col] = body[k] === '' ? null : body[k];
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(db.schema('pm').from('units').update(patch).eq('id', u.id).select('id'), 'update unit');
      return { ok: true };
    }
    case 'delete':
      if (u.status !== 'PLANNED' && u.status !== 'ENTITLED') throw new HttpError(422, 'Only a planned or entitled unit can be deleted.', 'VALIDATION');
      await write(db.schema('pm').from('units').delete().eq('id', u.id).select('id'), 'delete unit');
      return { ok: true };
  }
});
