export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dcall, downs, dwrite } from '@/lib/pm/dealer/rpc';
import { Cents, Day, PartNumber, Qty4, Text, Uuid, attrs } from '@/lib/pm/dealer/schemas';

const Qty = z.number().min(0).max(1e8);

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('stocking'), stockLocationId: Uuid, bin: Text(24).nullish(), min: Qty, max: Qty.nullish() }),
  z.object({ op: z.literal('supersede'), newPartId: Uuid.nullish(), newPartNumber: PartNumber.nullish() }),
  z.object({
    op: z.literal('update'),
    description: Text(200).optional(),
    category: Text(40).nullish(),
    uom: Text(12).optional(),
    costCents: Cents.nullish(),
    listPriceCents: Cents.nullish(),
    priceCents: Cents.nullish(),
    coreChargeCents: Cents.optional(),
    isActive: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('special_order'),
    qty: Qty4,
    customerId: Uuid.nullish(),
    workOrderId: Uuid.nullish(),
    dealId: Uuid.nullish(),
    vendorId: Uuid.nullish(),
    neededBy: Day.nullish(),
    notes: Text(300).nullish(),
  }),
]);

/** Part actions: bin and min/max per stock location, supersession, prices, special order. */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: 'part', body: Op }, async ({ db, params, body, tenant }) => {
  const p = await downs<{ id: string; location_id: string; manufacturer: string | null }>(db, 'parts', 'id, location_id, manufacturer', params.partId!, 'That part was not found.');
  assertCompany(tenant, p.location_id);
  switch (body.op) {
    case 'stocking':
      if (body.max != null && body.max < body.min) throw new HttpError(422, 'The maximum must be at least the minimum.', 'VALIDATION');
      await dcall(db, 'set_part_stocking', { p_part: p.id, p_stock_location: body.stockLocationId, p_bin: body.bin || null, p_min: body.min, p_max: body.max ?? null });
      return { ok: true };
    case 'supersede': {
      let target = body.newPartId ?? null;
      if (!target && body.newPartNumber) {
        const r = await db.schema('pm').from('parts').select('id').eq('location_id', p.location_id).eq('part_number', body.newPartNumber).limit(2);
        const list = (r.data ?? []) as Array<{ id: string }>;
        if (list.length !== 1) throw new HttpError(422, list.length ? 'That number is carried for more than one manufacturer. Pick the part.' : `${body.newPartNumber} is not in the catalog. Add it first.`, 'VALIDATION');
        target = list[0]!.id;
      }
      if (!target) throw new HttpError(422, 'Give the replacement part number.', 'VALIDATION');
      if (target === p.id) throw new HttpError(422, 'A part cannot replace itself.', 'VALIDATION');
      await dcall(db, 'supersede_part', { p_old: p.id, p_new: target });
      return { ok: true, newPartId: target };
    }
    case 'update': {
      const patch: Record<string, unknown> = {};
      if (body.description !== undefined && body.description) patch.description = body.description;
      if (body.category !== undefined) patch.category = body.category || null;
      if (body.uom !== undefined && body.uom) patch.uom = body.uom;
      if (body.costCents !== undefined) patch.cost_cents = body.costCents;
      if (body.listPriceCents !== undefined) patch.list_price_cents = body.listPriceCents;
      if (body.priceCents !== undefined) patch.price_cents = body.priceCents;
      if (body.coreChargeCents !== undefined) patch.core_charge_cents = body.coreChargeCents;
      if (body.isActive !== undefined) patch.is_active = body.isActive;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await dwrite(db.schema('pm').from('parts').update(patch).eq('id', p.id).select('id'), 'update part');
      return { ok: true };
    }
    case 'special_order': {
      if (!body.customerId && !body.workOrderId && !body.dealId) throw new HttpError(422, 'A special order is for a customer, a repair order or a deal.', 'VALIDATION');
      const id = await dcall<string>(db, 'request_special_order', {
        p_part: p.id, p_qty: body.qty,
        p_attrs: attrs({ customer_id: body.customerId, work_order_id: body.workOrderId, deal_id: body.dealId, vendor_id: body.vendorId, needed_by: body.neededBy, notes: body.notes }),
      });
      return { ok: true, specialOrderId: id };
    }
  }
});
