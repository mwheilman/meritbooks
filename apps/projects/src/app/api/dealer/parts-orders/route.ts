export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { dcall, dwrite } from '@/lib/pm/dealer/rpc';
import { Text, Uuid } from '@/lib/pm/dealer/schemas';
import type { SuggestedLine } from '@/lib/pm/dealer/types';

const Query = z.object({ stockLocationId: z.string().uuid() });

/** Suggested stock order for a stock location: below min after on-order, ordered up to max (pm.suggest_parts_order). */
export const GET = route({ query: Query }, async ({ db, query, tenant }) => {
  const sl = await db.schema('pm').from('stock_locations').select('location_id').eq('id', query.stockLocationId).maybeSingle();
  const loc = (sl.data as { location_id: string } | null)?.location_id;
  if (!loc) throw new HttpError(404, 'That stock location was not found.', 'NOT_FOUND');
  assertCompany(tenant, loc);
  const lines = await dcall<SuggestedLine[]>(db, 'suggest_parts_order', { p_stock_location: query.stockLocationId });
  return { lines: (lines ?? []).map((l) => ({ ...l, on_hand: Number(l.on_hand), on_order: Number(l.on_order), min_qty: Number(l.min_qty), max_qty: l.max_qty == null ? null : Number(l.max_qty), suggested_qty: Number(l.suggested_qty) })) };
});

const Body = z.object({
  companyId: Uuid,
  vendorId: Uuid,
  stockLocationId: Uuid.nullish(),
  kind: z.enum(['STOCK', 'EMERGENCY', 'SPECIAL']).default('STOCK'),
  vendorRef: Text(60).nullish(),
  /** Lines to add at once (a suggestion, or open special orders). */
  lines: z.array(z.object({ partId: Uuid, qty: z.number().positive().max(1e8), unitCostCents: z.number().int().min(0).max(1e11).nullish(), specialOrderId: Uuid.nullish() })).max(500).default([]),
});

/** Start an OEM parts order (pm.create_parts_order), optionally with its lines. */
export const POST = route({ body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const id = await dcall<string | null>(db, 'create_parts_order', {
    p_location: body.companyId, p_vendor: body.vendorId, p_stock_location: body.stockLocationId ?? null, p_kind: body.kind, p_vendor_ref: body.vendorRef || null,
  });
  if (!id) throw new HttpError(500, 'The order was not started. Try again.', 'CREATE_FAILED');
  if (body.lines.length) {
    await dwrite(db.schema('pm').from('parts_order_lines').insert(body.lines.map((l, i) => ({
      order_id: id, line_no: i + 1, part_id: l.partId, qty_ordered: l.qty, unit_cost_cents: l.unitCostCents ?? null, special_order_id: l.specialOrderId ?? null,
    }))).select('id'), 'add order lines');
  }
  const row = rows<{ number: string }>(await db.schema('pm').from('parts_orders').select('number').eq('id', id), 'order');
  return { orderId: id, number: row[0]?.number ?? null };
});
