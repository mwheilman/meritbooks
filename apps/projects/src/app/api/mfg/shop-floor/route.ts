export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * Shop floor (1125): sheet-goods inventory, allocations and counts (MFG-40), issue from nests (MFG-42),
 * outside processing with its own PO (MFG-43), shipping tickets, load check and proof of delivery
 * (MFG-44). Quantities only; Books values inventory and the moves.
 */
const views = {
  sheets: view('mfg_sheet_inventory', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  outside: view('mfg_outside_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  shipments: view('mfg_shipment_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  shipment: view('mfg_shipment_detail', z.object({ id: Uuid }), (q) => ({ p_shipment: q.id })),
};

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: 'work_order', query: deskQuery(views) }, async ({ db, query, tenant }) =>
  runView(views, query, db, tenant));

const ops = {
  sheet_spec: op('mfg_save_sheet_spec', z.object({ companyId: Uuid, material: Req(120, 'The material'), materialKey: Text(80).nullish(), kind: z.enum(['SHEET', 'EDGEBAND', 'HARDWARE', 'LUMBER', 'FINISH', 'OTHER']).default('SHEET'),
    thicknessMm: z.number().positive().max(200).nullish(), lengthMm: z.number().positive().max(10000).nullish(), widthMm: z.number().positive().max(10000).nullish(), grain: z.enum(['LENGTH', 'WIDTH', 'NONE']).nullish(),
    finish: Text(60).nullish(), core: Text(40).nullish(), uom: Text(10).nullish() }),
  (b) => ({ p_location: b.companyId, p_attrs: { material: b.material, material_key: b.materialKey ?? null, kind: b.kind, thickness_mm: b.thicknessMm ?? null, length_mm: b.lengthMm ?? null, width_mm: b.widthMm ?? null,
    grain: b.grain ?? null, finish: b.finish ?? null, core: b.core ?? null, uom: b.uom ?? null } })),
  allocate: op('mfg_allocate', z.object({ jobId: Uuid, itemId: Uuid, stockLocationId: Uuid, qty: z.number().positive().max(1e6).nullish(), woId: Uuid.nullish(), release: z.boolean().default(false) }),
    (b) => ({ p_job: b.jobId, p_item: b.itemId, p_stock_location: b.stockLocationId, p_qty: b.qty ?? null, p_wo: b.woId ?? null, p_release: b.release })),
  start_count: op('mfg_start_count', z.object({ stockLocationId: Uuid, itemIds: z.array(Uuid).max(500).nullish() }), (b) => ({ p_stock_location: b.stockLocationId, p_items: b.itemIds ?? null })),
  record_count: op('mfg_record_count', z.object({ countId: Uuid, itemId: Uuid, qty: z.number().min(0).max(1e6) }), (b) => ({ p_count: b.countId, p_item: b.itemId, p_qty: b.qty })),
  post_count: op('mfg_post_count', z.object({ countId: Uuid }), (b) => ({ p_count: b.countId })),
  issue_nest: op('mfg_issue_from_nest', z.object({ woId: Uuid, stockLocationId: Uuid, lines: z.array(z.object({ material_key: Req(80, 'The material'), qty: z.number().min(0).max(1e6), uom: Text(10).nullish() })).max(100).nullish(),
    reason: Text(500).nullish(), tolerance: z.number().min(0).max(1).default(0.05) }),
  (b) => ({ p_wo: b.woId, p_stock_location: b.stockLocationId, p_lines: b.lines ?? null, p_reason: b.reason ?? null, p_tolerance: b.tolerance })),
  send_outside: op('mfg_send_outside', z.object({ operationId: Uuid, vendorId: Uuid, amountCents: PosCents.default(0), qty: z.number().positive().max(1e5).default(1), dueBackOn: IsoDate.nullish(), sent: z.boolean().default(true),
    createPo: z.boolean().default(true), notes: Text(1000).nullish() }),
  (b) => ({ p_operation: b.operationId, p_vendor: b.vendorId, p_attrs: { amount_cents: b.amountCents, qty: b.qty, due_back_on: b.dueBackOn ?? null, sent: b.sent, create_po: b.createPo, notes: b.notes ?? null } })),
  receive_outside: op('mfg_receive_outside', z.object({ outsideId: Uuid, backOn: IsoDate.nullish() }), (b) => ({ p_outside: b.outsideId, p_back_on: b.backOn ?? null })),
  create_shipment: op('mfg_create_shipment', z.object({ jobId: Uuid, wbsIds: z.array(Uuid).max(100).default([]), shipOn: IsoDate.nullish(), promisedOn: IsoDate.nullish(), truck: Text(60).nullish(), driver: Text(80).nullish() }),
    (b) => ({ p_job: b.jobId, p_wbs: b.wbsIds, p_attrs: { ship_on: b.shipOn ?? null, promised_on: b.promisedOn ?? null, truck: b.truck ?? null, driver: b.driver ?? null } })),
  mark_items: op('mfg_mark_items', z.object({ shipmentId: Uuid, itemIds: z.array(Uuid).min(1).max(1000), field: z.enum(['loaded', 'delivered', 'exception']), value: z.boolean().default(true), exception: z.enum(['MISSING', 'DAMAGED', 'SHORT']).nullish() }),
    (b) => ({ p_shipment: b.shipmentId, p_items: b.itemIds, p_field: b.field, p_value: b.value, p_exception: b.exception ?? null })),
  check_load: op('mfg_check_load', z.object({ shipmentId: Uuid }), (b) => ({ p_shipment: b.shipmentId })),
  deliver: op('mfg_deliver_shipment', z.object({ shipmentId: Uuid, signer: Req(120, 'Who received it'), signatureDocumentId: Uuid.nullish(), photoIds: z.array(Uuid).max(30).default([]), notes: Text(1000).nullish() }),
    (b) => ({ p_shipment: b.shipmentId, p_signer: b.signer, p_signature_document: b.signatureDocumentId ?? null, p_photos: b.photoIds, p_notes: b.notes ?? null })),
};

export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, ops: { sheet_spec: { cap: 'projects.production', action: 'edit' } }, mask: 'work_order', body: deskBody(ops) },
  async ({ db, body, tenant }) => runOp(ops, body, db, tenant));
