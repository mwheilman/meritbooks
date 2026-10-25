export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { IsoDate, PosCents, Req, Uuid } from '@/lib/dealer/schemas';

/**
 * Manufacturing money (1125): job cost est vs committed vs actual by area and bucket (MFG-48), billing
 * incl. stored materials and bill-on-ship (MFG-50), WIP (MFG-52) and the owner dashboard (MFG-53).
 * Actual cost is Books job cost; Books owns AR, WIP posting and revenue. The pm functions require
 * Job financials / Billing / Reports; the route masks money on top.
 */
const views = {
  job_cost: view('mfg_job_cost', z.object({ job: Uuid }), (q) => ({ p_job: q.job })),
  billing: view('mfg_billing_board', z.object({ job: Uuid }), (q) => ({ p_job: q.job })),
  wip: view('mfg_wip', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
  dashboard: view('mfg_owner_dashboard', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
};

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['billing', 'wip', 'cost', 'estimate'], query: deskQuery(views) }, async ({ db, query, tenant }) =>
  runView(views, query, db, tenant));

const ops = {
  cost_buckets: op('mfg_set_cost_buckets', z.object({ companyId: Uuid, rows: z.array(z.object({ cost_code_id: Uuid, bucket: z.enum(['MATERIAL', 'SHOP_LABOR', 'ENGINEERING', 'INSTALL', 'OUTSIDE', 'FREIGHT', 'COST_OF_QUALITY', 'OTHER']).nullable() })).min(1).max(500) }),
    (b) => ({ p_location: b.companyId, p_rows: b.rows })),
  add_stored: op('mfg_add_stored_material', z.object({ jobId: Uuid, wbsId: Uuid.nullish(), description: Req(300, 'What is stored'), storedAt: Req(200, 'Where it is stored'), valueCents: PosCents.refine((n) => n > 0, 'The value is above zero'),
    insured: z.boolean().default(false), storedOn: IsoDate.nullish(), photoIds: z.array(Uuid).max(20).default([]) }),
  (b) => ({ p_job: b.jobId, p_attrs: { wbs_id: b.wbsId ?? null, description: b.description, stored_at: b.storedAt, value_cents: b.valueCents, insured: b.insured, stored_on: b.storedOn ?? null, photo_document_ids: b.photoIds } })),
  bill_stored: op('mfg_bill_stored_materials', z.object({ jobId: Uuid, ids: z.array(Uuid).min(1).max(200) }), (b) => ({ p_job: b.jobId, p_ids: b.ids })),
  bill_shipment: op('mfg_bill_shipment', z.object({ shipmentId: Uuid }), (b) => ({ p_shipment: b.shipmentId })),
  pin_wip: op('mfg_pin_wip', z.object({ companyId: Uuid, periodEnd: IsoDate }), (b) => ({ p_location: b.companyId, p_period_end: b.periodEnd })),
};

export const POST = route({
  access: { cap: 'projects.billing', action: 'view' },
  ops: { cost_buckets: { cap: 'projects.financials', action: 'edit' }, pin_wip: { cap: 'projects.financials', action: 'edit' }, add_stored: { cap: 'projects.billing', action: 'create' }, bill_stored: { cap: 'projects.billing', action: 'create' }, bill_shipment: { cap: 'projects.billing', action: 'create' } },
  mask: ['billing', 'wip'], body: deskBody(ops),
}, async ({ db, body, tenant }) => runOp(ops, body, db, tenant));

