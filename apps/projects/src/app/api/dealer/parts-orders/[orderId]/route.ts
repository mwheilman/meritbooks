export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { dcall, downs, dwrite } from '@/lib/pm/dealer/rpc';
import { Text, Uuid } from '@/lib/pm/dealer/schemas';

const Line = z.object({ partId: Uuid, qty: z.number().positive().max(1e8), unitCostCents: z.number().int().min(0).max(1e11).nullish(), specialOrderId: Uuid.nullish() });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_lines'), lines: z.array(Line).min(1).max(500) }),
  z.object({ op: z.literal('update_line'), lineId: Uuid, qty: z.number().positive().max(1e8).optional(), unitCostCents: z.number().int().min(0).max(1e11).nullish() }),
  z.object({ op: z.literal('remove_line'), lineId: Uuid }),
  z.object({ op: z.literal('notes'), vendorRef: Text(60).nullish(), notes: Text(1000).nullish() }),
  z.object({ op: z.literal('submit') }),
  /** null lines = receive everything still open. */
  z.object({ op: z.literal('receive'), lines: z.array(z.object({ lineId: Uuid, qty: z.number().min(0).max(1e8) })).max(500).nullish() }),
]);

/** OEM stock order: lines while DRAFT, submit, receive (all open, or per line). */
export const POST = route({ body: Op }, async ({ db, params, body, tenant }) => {
  const o = await downs<{ id: string; location_id: string }>(db, 'parts_orders', 'id, location_id', params.orderId!, 'That parts order was not found.');
  assertCompany(tenant, o.location_id);
  const pm = db.schema('pm');
  switch (body.op) {
    case 'add_lines': {
      const last = rows<{ line_no: number }>(await pm.from('parts_order_lines').select('line_no').eq('order_id', o.id).order('line_no', { ascending: false }).limit(1), 'last line');
      const start = (last[0]?.line_no ?? 0) + 1;
      await dwrite(pm.from('parts_order_lines').insert(body.lines.map((l, i) => ({ order_id: o.id, line_no: start + i, part_id: l.partId, qty_ordered: l.qty, unit_cost_cents: l.unitCostCents ?? null, special_order_id: l.specialOrderId ?? null }))).select('id'), 'add order lines');
      return { ok: true };
    }
    case 'update_line': {
      const patch: Record<string, unknown> = {};
      if (body.qty !== undefined) patch.qty_ordered = body.qty;
      if (body.unitCostCents !== undefined) patch.unit_cost_cents = body.unitCostCents;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await dwrite<unknown[]>(pm.from('parts_order_lines').update(patch).eq('id', body.lineId).eq('order_id', o.id).select('id'), 'update line');
      if (!r.length) throw new HttpError(404, 'That line was not found on this order.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'remove_line': {
      const r = await dwrite<unknown[]>(pm.from('parts_order_lines').delete().eq('id', body.lineId).eq('order_id', o.id).select('id'), 'remove line');
      if (!r.length) throw new HttpError(404, 'That line was not found on this order.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'notes': {
      const r = await dwrite<unknown[]>(pm.from('parts_orders').update({ vendor_ref: body.vendorRef || null, notes: body.notes || null }).eq('id', o.id).select('id'), 'update order');
      if (!r.length) throw new HttpError(422, 'A submitted order is locked.', 'PM_ORDER_LOCKED');
      return { ok: true };
    }
    case 'submit':
      await dcall(db, 'submit_parts_order', { p_order: o.id });
      return { ok: true };
    case 'receive': {
      const r = await dcall<{ lines_received: number; open_qty: number; status: string }>(db, 'receive_parts_order', {
        p_order: o.id, p_lines: body.lines ? body.lines.filter((l) => l.qty > 0).map((l) => ({ line_id: l.lineId, qty: l.qty })) : null,
      });
      return { ok: true, ...r };
    }
  }
});
