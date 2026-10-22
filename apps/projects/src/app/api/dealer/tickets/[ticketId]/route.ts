export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { loadTicket } from '@/lib/pm/dealer/parts-queries';
import { dcall, downs, dwrite } from '@/lib/pm/dealer/rpc';
import { Cents, PaymentZ, Rate, Text, Uuid } from '@/lib/pm/dealer/schemas';

const Q = z.number().min(0).max(1e8);

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_line'), partId: Uuid, qty: z.number().positive().max(1e8), qtyFilled: Q, qtySpecialOrder: Q.default(0), unitPriceCents: Cents.nullish(), taxable: z.boolean().default(true) }),
  z.object({ op: z.literal('update_line'), lineId: Uuid, qty: z.number().positive().max(1e8).optional(), qtyFilled: Q.optional(), qtySpecialOrder: Q.optional(), unitPriceCents: Cents.optional(), taxable: z.boolean().optional() }),
  z.object({ op: z.literal('remove_line'), lineId: Uuid }),
  z.object({ op: z.literal('header'), customerId: Uuid.nullish(), poNumber: Text(40).nullish(), taxExempt: z.boolean().optional(), taxExemptRef: Text(60).nullish(), taxRateEstimate: Rate.nullish(), notes: Text(1000).nullish() }),
  z.object({ op: z.literal('close'), paymentMethod: PaymentZ }),
  z.object({ op: z.literal('void'), reason: Text(300).nullish() }),
]);

export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'parts_ticket' }, async ({ db, params }) => {
  const t = await loadTicket(db, params.ticketId!);
  if (!t) throw new HttpError(404, 'That counter ticket was not found.', 'NOT_FOUND');
  return t;
});

/** Counter ticket lines and the close (pm.close_parts_ticket: stock issues, special orders, DEALER_PARTS_SALE). */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: 'parts_ticket', body: Op }, async ({ db, params, body, tenant }) => {
  const t = await downs<{ id: string; location_id: string; status: string }>(db, 'parts_tickets', 'id, location_id, status', params.ticketId!, 'That counter ticket was not found.');
  assertCompany(tenant, t.location_id);
  const pm = db.schema('pm');
  switch (body.op) {
    case 'add_line': {
      if (body.qtyFilled + body.qtySpecialOrder > body.qty + 1e-9) throw new HttpError(422, 'Filled plus special-ordered cannot be more than the quantity asked for.', 'VALIDATION');
      const last = rows<{ line_no: number; sort: number }>(await pm.from('parts_ticket_lines').select('line_no, sort').eq('ticket_id', t.id).order('line_no', { ascending: false }).limit(1), 'last line');
      const r = await dwrite<Array<{ id: string }>>(pm.from('parts_ticket_lines').insert({
        ticket_id: t.id, line_no: (last[0]?.line_no ?? 0) + 1, sort: (last[0]?.sort ?? -1) + 1, part_id: body.partId,
        qty_requested: body.qty, qty_filled: body.qtyFilled, qty_special_order: body.qtySpecialOrder, unit_price_cents: body.unitPriceCents ?? null, taxable: body.taxable,
      }).select('id'), 'add line');
      return { ok: true, lineId: r[0]?.id ?? null };
    }
    case 'update_line': {
      const patch: Record<string, unknown> = {};
      if (body.qty !== undefined) patch.qty_requested = body.qty;
      if (body.qtyFilled !== undefined) patch.qty_filled = body.qtyFilled;
      if (body.qtySpecialOrder !== undefined) patch.qty_special_order = body.qtySpecialOrder;
      if (body.unitPriceCents !== undefined) patch.unit_price_cents = body.unitPriceCents;
      if (body.taxable !== undefined) patch.taxable = body.taxable;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await dwrite<unknown[]>(pm.from('parts_ticket_lines').update(patch).eq('id', body.lineId).eq('ticket_id', t.id).select('id'), 'update line');
      if (!r.length) throw new HttpError(404, 'That line was not found on this ticket.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'remove_line': {
      const r = await dwrite<unknown[]>(pm.from('parts_ticket_lines').delete().eq('id', body.lineId).eq('ticket_id', t.id).select('id'), 'remove line');
      if (!r.length) throw new HttpError(404, 'That line was not found on this ticket.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'header': {
      const map: Array<[keyof typeof body, string]> = [['customerId', 'customer_id'], ['poNumber', 'po_number'], ['taxExempt', 'tax_exempt'], ['taxExemptRef', 'tax_exempt_ref'], ['taxRateEstimate', 'tax_rate_estimate'], ['notes', 'notes']];
      const patch: Record<string, unknown> = {};
      for (const [k, col] of map) if (body[k] !== undefined) patch[col] = body[k] === '' ? null : body[k];
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await dwrite<unknown[]>(pm.from('parts_tickets').update(patch).eq('id', t.id).select('id'), 'update ticket');
      if (!r.length) throw new HttpError(422, 'This counter ticket is closed or void.', 'PM_TICKET_LOCKED');
      return { ok: true };
    }
    case 'close': {
      const out = await dcall<string | null>(db, 'close_parts_ticket', { p_ticket: t.id, p_payment_method: body.paymentMethod });
      const row = await pm.from('parts_tickets').select('number, totals').eq('id', t.id).maybeSingle();
      return { ok: true, outboxId: out, ticket: row.data };
    }
    case 'void':
      await dcall(db, 'void_parts_ticket', { p_ticket: t.id, p_reason: body.reason || null });
      return { ok: true };
  }
});
