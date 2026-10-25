export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { companyJobIds, inList, xcall, xrows } from '@/lib/dealer/rpc';
import { PosCents, Qty, Req, Text, Uuid } from '@/lib/dealer/schemas';

/** MRP-lite: what released and planned orders need, what is on hand and on order, what is short, when to order by. */
export const GET = route({ access: { cap: 'projects.production', action: 'view' }, mask: 'commitment', query: z.object({ company: Uuid, wo: Uuid.optional() }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const pm = db.schema('pm');
  const jobs = await companyJobIds(db, query.company);
  const [demand, vendors, pos] = await Promise.all([
    xcall<{ rows: unknown[] }>(db, 'mfg_material_demand', { p_location: query.company, p_wo: query.wo ?? null }),
    xrows<{ id: string; name: string; display_name: string | null }>(pm.from('v_core_vendors_masked').select('id, name, display_name').eq('is_active', true).order('name').limit(500), 'vendors'),
    // Open purchase orders on this company's jobs (commitments are money rows: RLS shows them to financials holders).
    xrows<{ id: string; number: string | null; title: string | null; vendor_id: string; job_id: string; status: string }>(pm.from('commitments').select('id, number, title, vendor_id, job_id, status').eq('commitment_type', 'PO').in('status', ['APPROVED', 'EXECUTED']).in('job_id', inList(jobs)).order('created_at', { ascending: false }).limit(100), 'purchase orders'),
  ]);
  const lines = pos.length
    ? await xrows<{ id: string; commitment_id: string; line_no: number; description: string; item_id: string | null; qty: number | null; uom: string | null; received_qty: number | null }>(pm.from('commitment_lines').select('id, commitment_id, line_no, description, item_id, qty, uom, received_qty').in('commitment_id', pos.map((x) => x.id)).order('line_no'), 'purchase order lines')
    : [];
  return { ...demand, vendors: vendors.map((v) => ({ id: v.id, name: v.display_name || v.name })), purchaseOrders: pos, poLines: lines.filter((l) => Number(l.qty ?? 0) > Number(l.received_qty ?? 0)) };
});

const Line = z.object({ item_id: Uuid.nullish(), description: Req(300, 'The description'), qty: z.number().positive().max(1e8), uom: Text(12).nullish(), unit_cost_cents: PosCents.default(0), cost_code_id: Uuid.nullish() });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_po'), jobId: Uuid, vendorId: Uuid, lines: z.array(Line).min(1).max(200), title: Text(200).nullish() }),
  z.object({ op: z.literal('receive'), lineId: Uuid, qty: Qty, stockLocationId: Uuid.nullish(), note: Text(500).nullish(), packingSlip: Text(60).nullish(), documentId: Uuid.nullish() }),
]);

/** Draft a PO from short lines (it goes through Approvals like any PO) and receive against PO lines into stock. */
export const POST = route({ access: { cap: 'projects.commitments', action: 'create' }, ops: { receive: { cap: 'projects.commitments', action: 'edit' } }, mask: 'commitment', body: Op }, async ({ db, body }) => {
  if (body.op === 'create_po') return xcall(db, 'mfg_create_po_from_demand', { p_job: body.jobId, p_vendor: body.vendorId, p_lines: body.lines, p_title: body.title ?? null });
  return xcall(db, 'mfg_receive_po_line', { p_line: body.lineId, p_qty: body.qty, p_stock_location: body.stockLocationId ?? null, p_note: body.note ?? null, p_packing_slip: body.packingSlip ?? null, p_document: body.documentId ?? null });
});
