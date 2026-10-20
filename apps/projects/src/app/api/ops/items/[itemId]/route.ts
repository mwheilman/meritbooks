export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { loadItemApprovals } from '@/lib/pm/ops/selection-queries';
import { Cents, Day, MethodZ, Qty, Text, Uuid } from '@/lib/pm/ops/schemas';

const Attrs = z.object({
  approverName: Text(200).nullish(),
  approverEmail: Text(200).nullish(),
  method: MethodZ.nullish(),
  poNumber: Text(60).nullish(),
  expectedOn: Day.nullish(),
  trackingRef: Text(120).nullish(),
  receivedQty: z.number().min(0).max(1e9).nullish(),
  receivedCondition: z.enum(['GOOD', 'DAMAGED', 'PARTIAL', 'WRONG_ITEM']).nullish(),
  storageLocationId: Uuid.nullish(),
  note: Text(2000).nullish(),
});

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('advance'),
    to: z.enum(['SPECIFIED', 'PROPOSED', 'APPROVED', 'ORDERED', 'ACKNOWLEDGED', 'BACK_ORDERED', 'SHIPPED', 'RECEIVED', 'DAMAGED', 'STORED', 'DELIVERED', 'INSTALLED', 'RETURNED', 'CANCELLED']),
    on: Day.nullish(),
    attrs: Attrs.default({}),
  }),
  z.object({
    op: z.literal('update'),
    description: Text(300).optional(),
    vendorId: Uuid.nullish(),
    vendorSku: Text(80).nullish(),
    sidemark: Text(120).nullish(),
    qty: Qty.optional(),
    unitCostCents: Cents.nullish(),
    markupPct: z.number().min(0).max(100).nullish(),
    unitSellCents: Cents.nullish(),
    freightCents: Cents.optional(),
    expectedOn: Day.nullish(),
    trackingRef: Text(120).nullish(),
    installOn: Day.nullish(),
    notes: Text(2000).nullish(),
  }),
  z.object({ op: z.literal('delete') }),
]);

export const GET = route({}, async ({ db, params }) => {
  await own(db, 'procurement_items', 'id', { id: params.itemId! }, 'That item was not found.');
  return { approvals: await loadItemApprovals(db, params.itemId!) };
});

export const POST = route({ body: Op }, async ({ db, params, body }) => {
  const it = await own<{ id: string; status: string }>(db, 'procurement_items', 'id, status', { id: params.itemId! }, 'That item was not found.');
  const pm = db.schema('pm');
  switch (body.op) {
    case 'advance': {
      const a = body.attrs;
      // keys exactly as pm.advance_procurement_item reads p_attrs
      const attrs: Record<string, unknown> = {};
      if (a.approverName) attrs.approver_name = a.approverName;
      if (a.approverEmail) attrs.approver_email = a.approverEmail;
      if (a.method) attrs.method = a.method;
      if (a.poNumber) attrs.po_number = a.poNumber;
      if (a.expectedOn) attrs.expected_on = a.expectedOn;
      if (a.trackingRef) attrs.tracking_ref = a.trackingRef;
      if (a.receivedQty != null) attrs.received_qty = a.receivedQty;
      if (a.receivedCondition) attrs.received_condition = a.receivedCondition;
      if (a.storageLocationId !== undefined) attrs.storage_location_id = a.storageLocationId ?? '';
      if (a.note) attrs.note = a.note;
      await call(db, 'advance_procurement_item', { p_item: it.id, p_to: body.to, p_on: body.on ?? null, p_attrs: attrs });
      return { ok: true };
    }
    case 'update': {
      const map: Array<[keyof typeof body, string]> = [
        ['description', 'description'], ['vendorId', 'vendor_id'], ['vendorSku', 'vendor_sku'], ['sidemark', 'sidemark'], ['qty', 'qty'],
        ['unitCostCents', 'unit_cost_cents'], ['markupPct', 'markup_pct'], ['unitSellCents', 'unit_sell_cents'], ['freightCents', 'freight_cents'],
        ['expectedOn', 'expected_on'], ['trackingRef', 'tracking_ref'], ['installOn', 'install_on'], ['notes', 'notes'],
      ];
      const patch: Record<string, unknown> = {};
      for (const [k, col] of map) if (body[k] !== undefined) patch[col] = body[k] === '' ? null : body[k];
      if (patch.description === null) throw new HttpError(422, 'An item needs a description.', 'VALIDATION');
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(pm.from('procurement_items').update(patch).eq('id', it.id).select('id'), 'update item');
      return { ok: true };
    }
    case 'delete':
      if (it.status !== 'SPECIFIED') throw new HttpError(422, 'Only a specified item can be deleted. Cancel it instead.', 'VALIDATION');
      await write(pm.from('procurement_items').delete().eq('id', it.id).select('id'), 'delete item');
      return { ok: true };
  }
});
