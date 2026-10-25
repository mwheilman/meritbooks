export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { companyJobIds, inList, xcall, xrows } from '@/lib/dealer/rpc';
import { CompanyQ, PosCents, Qty, Req, Text, Uuid } from '@/lib/dealer/schemas';

const REMAKE_REASONS = ['MACHINING', 'MATERIAL_DEFECT', 'ASSEMBLY', 'FINISH', 'DAMAGE_SHOP', 'DAMAGE_FIELD', 'MEASURE', 'DESIGN', 'MISSING', 'OTHER'] as const;

/** Remake requests and cost of quality by reason (remake minutes, share of shop time, material where visible). */
export const GET = route({ access: { cap: 'projects.production', action: 'view' }, mask: 'cost', query: CompanyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const pm = db.schema('pm');
  const jobs = await companyJobIds(db, query.company);
  const [remakes, coq] = await Promise.all([
    xrows<Record<string, unknown>>(pm.from('v_mfg_remakes_masked').select('id, job_id, work_order_id, operation_id, part_label, reason_code, source, qty, notes, status, remake_work_order_id, est_material_cents, decided_at, decision_note, created_at').in('job_id', inList(jobs)).order('created_at', { ascending: false }).limit(200), 'remakes'),
    xcall<Record<string, unknown>>(db, 'mfg_cost_of_quality', { p_location: query.company, p_from: query.from ?? null, p_to: query.to ?? null }),
  ]);
  return { remakes, coq };
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('request'), workOrderId: Uuid, partLabel: Req(60, 'The part label'), reason: z.enum(REMAKE_REASONS), qty: Qty.default(1), notes: Text(1000).nullish(), photoIds: z.array(Uuid).max(20).default([]), operationId: Uuid.nullish(), source: z.enum(['STATION', 'FIELD', 'QC']).default('QC') }),
  z.object({ op: z.literal('decide'), remakeId: Uuid, approve: z.boolean(), note: Text(500).nullish(), estMaterialCents: PosCents.nullish() }),
]);

/** Ask for a remake (from the office or the station) and decide it (someone other than the requester). */
export const POST = route({ access: { cap: 'projects.production', action: 'edit' }, mask: 'cost', body: Op }, async ({ db, body }) => {
  if (body.op === 'request') {
    return { id: await xcall<string>(db, 'mfg_request_remake', { p_wo: body.workOrderId, p_part_label: body.partLabel, p_reason: body.reason, p_qty: body.qty, p_notes: body.notes ?? null, p_photos: body.photoIds, p_source: body.source, p_op: body.operationId ?? null }) };
  }
  return xcall(db, 'mfg_decide_remake', { p_remake: body.remakeId, p_approve: body.approve, p_note: body.note ?? null, p_est_material_cents: body.estMaterialCents ?? null });
});
