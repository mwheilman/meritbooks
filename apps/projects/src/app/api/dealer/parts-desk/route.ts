export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { parseAck, prepareOrder, PROVIDERS, type OrderLine } from '@/lib/dealer/parts-ordering';
import { xcall, xone, xrows } from '@/lib/dealer/rpc';
import { Text, Uuid } from '@/lib/dealer/schemas';

/**
 * Parts additions (1125): special-order texts (DLR-32), suggested stock levels + the stock order
 * (DLR-33), electronic ordering records with the per-provider adapters (DLR-34: X12 850 / CSV files,
 * 855 / CSV acks; API providers stubbed to a portal upload) and inter-store transfers + the locator
 * (DLR-39). Part cost is masked without Job financials.
 */
const Num = z.coerce.number();
const views = {
  special_orders: view('dlr_special_order_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  suggestions: view('dlr_stock_suggestions', z.object({ stockLocation: Uuid, leadDays: Num.int().min(0).max(180).optional(), reviewDays: Num.int().min(1).max(180).optional(), serviceZ: Num.min(0).max(3.5).optional(), vendor: Uuid.optional() }),
    (q) => ({ p_stock_location: q.stockLocation, p_opts: { lead_days: q.leadDays ?? null, review_days: q.reviewDays ?? null, service_z: q.serviceZ ?? null, vendor_id: q.vendor ?? null } })),
  backorders: view('dlr_backorder_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  locator: view('dlr_part_locator', z.object({ partNumber: Text(40).min(1), manufacturer: Text(40).optional() }), (q) => ({ p_part_number: q.partNumber, p_manufacturer: q.manufacturer ?? null })),
  transfers: view('dlr_transfer_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
};

const Q = deskQuery(views).or(z.object({ view: z.literal('providers') }));

export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'part', query: Q }, async ({ db, query, tenant }) => {
  if (query.view === 'providers') return { providers: PROVIDERS };
  return runView(views, query, db, tenant);
});

const ops = {
  text_special_order: op('dlr_text_special_order', z.object({ soId: Uuid }), (b) => ({ p_so: b.soId })),
  apply_stocking: op('dlr_apply_stocking', z.object({ stockLocationId: Uuid, rows: z.array(z.object({ part_id: Uuid, min_qty: z.number().min(0).max(1e6), max_qty: z.number().min(0).max(1e6).nullish(), bin: Text(30).nullish() })).min(1).max(2000) }),
    (b) => ({ p_stock_location: b.stockLocationId, p_rows: b.rows })),
  stock_order: op('dlr_create_stock_order', z.object({ stockLocationId: Uuid, vendorId: Uuid, kind: z.enum(['STOCK', 'EMERGENCY']).default('STOCK'), lines: z.array(z.object({ part_id: Uuid, qty: z.number().min(0).max(1e6) })).min(1).max(500) }),
    (b) => ({ p_stock_location: b.stockLocationId, p_vendor: b.vendorId, p_lines: b.lines, p_kind: b.kind })),
  request_transfer: op('dlr_request_transfer', z.object({ partId: Uuid, fromStockLocationId: Uuid, toStockLocationId: Uuid, qty: z.number().positive().max(1e6), note: Text(300).nullish() }),
    (b) => ({ p_from_part: b.partId, p_from_stock_location: b.fromStockLocationId, p_to_stock_location: b.toStockLocationId, p_qty: b.qty, p_note: b.note ?? null })),
  advance_transfer: op('dlr_advance_transfer', z.object({ transferId: Uuid, to: z.enum(['SHIPPED', 'RECEIVED', 'CANCELLED']) }), (b) => ({ p_transfer: b.transferId, p_to: b.to })),
};

const Transmit = z.object({ op: z.literal('transmit'), orderId: Uuid, provider: z.string().regex(/^[A-Z0-9_]{2,30}$/), dealerAccount: Text(30).min(1), sent: z.boolean().default(false) });
const AckBody = z.object({ op: z.literal('ack'), transmissionId: Uuid, text: z.string().min(1).max(500000) });
const Body = deskBody(ops).or(Transmit).or(AckBody);

interface OrderRow { id: string; number: string; location_id: string; kind: string; status: string; vendor_id: string | null }
interface LineRow { line_no: number; qty_ordered: number; unit_cost_cents: number | null; part_id: string }
interface PartRow { id: string; part_number: string; description: string; uom: string | null }

export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, ops: { stock_order: { cap: 'projects.store', action: 'create' } }, mask: 'part', body: Body }, async ({ db, body, tenant }) => {
  if (body.op === 'transmit') {
    const b = Transmit.parse(body);
    const pm = db.schema('pm');
    const o = await xone<OrderRow>(pm.from('parts_orders').select('id, number, location_id, kind, status, vendor_id').eq('id', b.orderId).maybeSingle(), 'parts order', 'That parts order was not found.');
    assertCompany(tenant, o.location_id);
    const lines = await xrows<LineRow>(pm.from('v_parts_order_lines_masked').select('line_no, qty_ordered, unit_cost_cents, part_id').eq('order_id', o.id).order('line_no'), 'order lines');
    if (!lines.length) throw new HttpError(422, 'The order has no lines yet.', 'VALIDATION');
    const parts = await xrows<PartRow>(pm.from('parts').select('id, part_number, description, uom').in('id', lines.map((l) => l.part_id)), 'parts');
    const byId = new Map(parts.map((p) => [p.id, p]));
    const company = tenant.companies.find((c) => c.id === o.location_id)?.name ?? 'Store';
    const orderLines: OrderLine[] = lines.map((l) => ({ line_no: l.line_no, part_number: byId.get(l.part_id)?.part_number ?? '?', description: byId.get(l.part_id)?.description ?? null, qty: Number(l.qty_ordered), unit_cost_cents: l.unit_cost_cents, uom: byId.get(l.part_id)?.uom ?? 'EA' }));
    const prepared = prepareOrder(b.provider, { po_number: o.number, dealer_account: b.dealerAccount, ship_to_name: company, order_date: new Date().toISOString().slice(0, 10), kind: o.kind === 'EMERGENCY' ? 'EMERGENCY' : 'STOCK' }, orderLines);
    const rec = await xcall<{ transmission_id: string; status: string; order_status: string }>(db, 'dlr_record_order_transmission', {
      p_order: o.id, p_provider: prepared.provider, p_channel: prepared.channel, p_format: prepared.format, p_file_name: prepared.file_name, p_payload: prepared.payload, p_sent: b.sent, p_error: null,
    });
    return { ...rec, fileName: prepared.file_name, payload: prepared.payload, format: prepared.format, instructions: prepared.instructions };
  }
  if (body.op === 'ack') {
    const b = AckBody.parse(body);
    const ack = parseAck(b.text);
    if (!ack.lines.length) throw new HttpError(422, 'No order lines were found in that acknowledgment.', 'VALIDATION');
    return xcall(db, 'dlr_record_order_ack', { p_transmission: b.transmissionId, p_ack: ack });
  }
  return runOp(ops, body, db, tenant);
});
