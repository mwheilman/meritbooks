export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { IsoDate, PosCents, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * The yard (1125): OEM shipment receiving with serial scans (DLR-03), the lot count / floor-plan
 * audit (DLR-09) and used-unit recon (DLR-10). Every operation is one pm definer function; the
 * database guard decides (Dealer store), cost on shipment lines needs Job financials.
 */
const views = {
  board: view('dlr_yard_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  shipment: view('dlr_shipment_detail', z.object({ id: Uuid }), (q) => ({ p_shipment: q.id })),
  audit: view('dlr_lot_audit_report', z.object({ id: Uuid }), (q) => ({ p_audit: q.id })),
  recons: view('dlr_recon_board', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
};

export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'dealer_unit', query: deskQuery(views) }, async ({ db, query, tenant }) =>
  runView(views, query, db, tenant));

const Line = z.object({
  make: Text(60).nullish(), model: Text(80).nullish(), model_year: z.number().int().min(1900).max(2200).nullish(), serial_number: Text(80).nullish(),
  description: Text(300).nullish(), category: Text(60).nullish(), cost_cents: PosCents.nullish(),
});

const ops = {
  create_shipment: op('dlr_create_shipment', z.object({
    companyId: Uuid, vendorId: Uuid.nullish(), lenderId: Uuid.nullish(), floorProgram: Text(80).nullish(), stockLocationId: Uuid.nullish(),
    invoiceRef: Text(80).nullish(), shipRef: Text(80).nullish(), source: z.enum(['EDI_856', 'CSV', 'PDF', 'MANUAL']).default('MANUAL'),
    fileName: Text(200).nullish(), expectedOn: IsoDate.nullish(), lines: z.array(Line).min(1).max(500),
  }), (b) => ({
    p_location: b.companyId,
    p_attrs: { vendor_id: b.vendorId ?? null, floor_lender_vendor_id: b.lenderId ?? null, floor_program: b.floorProgram ?? null, stock_location_id: b.stockLocationId ?? null,
      invoice_ref: b.invoiceRef ?? null, ship_ref: b.shipRef ?? null, source: b.source, source_file_name: b.fileName ?? null, expected_on: b.expectedOn ?? null },
    p_lines: b.lines,
  })),
  scan: op('dlr_scan_shipment', z.object({ shipmentId: Uuid, code: Text(80).min(1), model: Text(80).nullish(), damaged: z.boolean().default(false), damageNote: Text(500).nullish(), photoIds: z.array(Uuid).max(10).default([]) }),
    (b) => ({ p_shipment: b.shipmentId, p_code: b.code, p_attrs: { model: b.model ?? null, damaged: b.damaged, damage_note: b.damageNote ?? null, photo_document_ids: b.photoIds } })),
  mark_line: op('dlr_mark_shipment_line', z.object({ lineId: Uuid, status: z.enum(['DAMAGED', 'SHORT', 'EXPECTED', 'SCANNED']), note: Text(500).nullish(), photoIds: z.array(Uuid).max(10).nullish() }),
    (b) => ({ p_line: b.lineId, p_status: b.status, p_note: b.note ?? null, p_photos: b.photoIds ?? null })),
  receive: op('dlr_receive_shipment', z.object({ shipmentId: Uuid }), (b) => ({ p_shipment: b.shipmentId })),
  start_audit: op('dlr_start_lot_audit', z.object({ companyId: Uuid, purpose: z.enum(['ROUTINE', 'LENDER_AUDIT']).default('ROUTINE'), lenderId: Uuid.nullish() }),
    (b) => ({ p_location: b.companyId, p_purpose: b.purpose, p_lender: b.lenderId ?? null })),
  lot_scan: op('dlr_lot_scan', z.object({ auditId: Uuid, code: Text(80).min(1), lat: z.number().min(-90).max(90).nullish(), lng: z.number().min(-180).max(180).nullish(), photoId: Uuid.nullish(), note: Text(300).nullish() }),
    (b) => ({ p_audit: b.auditId, p_code: b.code, p_lat: b.lat ?? null, p_lng: b.lng ?? null, p_photo: b.photoId ?? null, p_note: b.note ?? null })),
  close_audit: op('dlr_close_lot_audit', z.object({ auditId: Uuid, cancel: z.boolean().default(false) }), (b) => ({ p_audit: b.auditId, p_cancel: b.cancel })),
  open_recon: op('dlr_open_recon', z.object({ unitId: Uuid, jobId: Uuid.nullish(), checklist: z.array(z.object({ label: Text(300).min(1), hours: z.number().min(0).max(200).nullish() })).max(60).default([]) }),
    (b) => ({ p_unit: b.unitId, p_job: b.jobId ?? null, p_checklist: b.checklist })),
  complete_recon: op('dlr_complete_recon', z.object({ reconId: Uuid, waiveReason: Text(500).nullish() }), (b) => ({ p_recon: b.reconId, p_waive_reason: b.waiveReason ?? null })),
};

export const POST = route({
  access: { cap: 'projects.store', action: 'edit' },
  ops: { create_shipment: { cap: 'projects.store', action: 'create' }, receive: { cap: 'projects.store', action: 'create' } },
  mask: 'dealer_unit', body: deskBody(ops),
}, async ({ db, body, tenant }) => runOp(ops, body, db, tenant));
