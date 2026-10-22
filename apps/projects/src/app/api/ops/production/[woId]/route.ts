export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { loadProductionDetail } from '@/lib/pm/ops/production-queries';
import { Day, Need, Qty, Text, Uuid } from '@/lib/pm/ops/schemas';

const Mm = z.number().positive().max(100_000).nullish();

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('apply_routing'), routingId: Uuid, replace: z.boolean().default(false) }),
  z.object({ op: z.literal('approve_drawings') }),
  z.object({ op: z.literal('revoke_drawings') }),
  z.object({ op: z.literal('release') }),
  z.object({ op: z.literal('hold'), reason: Text(300).nullish() }),
  z.object({ op: z.literal('resume') }),
  z.object({ op: z.literal('cancel'), reason: Text(300).nullish() }),
  z.object({ op: z.literal('close') }),
  z.object({
    op: z.literal('add_bom'),
    lineKind: z.enum(['ASSEMBLY', 'PART', 'SHEET', 'LUMBER', 'EDGEBAND', 'HARDWARE', 'FINISH', 'BUYOUT', 'CONSUMABLE']).default('PART'),
    partCode: Text(40).nullish(),
    description: Need(300, 'Describe the part'),
    material: Text(120).nullish(),
    qty: Qty,
    uom: Text(12).nullish(),
    lengthMm: Mm,
    widthMm: Mm,
    thicknessMm: Mm,
    grain: z.enum(['NONE', 'LENGTH', 'WIDTH']).nullish(),
    edgeband: Text(60).nullish(),
    assemblyRef: Text(40).nullish(),
  }),
  z.object({ op: z.literal('remove_bom'), lineId: Uuid }),
  z.object({ op: z.literal('add_operation'), workCenterId: Uuid, name: Need(120, 'Name the operation'), stdMinutes: z.number().int().min(0).max(100_000) }),
  z.object({ op: z.literal('remove_operation'), operationId: Uuid }),
  z.object({ op: z.literal('update'), quantity: Qty.optional(), promisedOn: Day.nullish(), summary: Need(200, 'Say what the shop is building').optional() }),
]);

export const GET = route({ access: { cap: 'projects.production', action: 'view' }, mask: ['work_order', 'work_center'] }, async ({ db, params }) => {
  const d = await loadProductionDetail(db, params.woId!);
  if (!d) throw new HttpError(404, 'That production order was not found.', 'NOT_FOUND');
  return d;
});

export const POST = route({ access: { cap: 'projects.production', action: 'edit' }, mask: ['work_order', 'work_center'], body: Op }, async ({ db, params, body, tenant }) => {
  const wo = await own<{ id: string; job_id: string; location_id: string; status: string }>(db, 'work_orders', 'id, job_id, location_id, status', { id: params.woId!, kind: 'PRODUCTION' }, 'That production order was not found.');
  assertCompany(tenant, wo.location_id);
  const pm = db.schema('pm');
  switch (body.op) {
    case 'apply_routing': {
      const n = await call<number>(db, 'apply_routing', { p_wo: wo.id, p_routing: body.routingId, p_replace: body.replace });
      return { ok: true, operations: n };
    }
    case 'approve_drawings':
      await call(db, 'approve_drawings', { p_wo: wo.id, p_revoke: false });
      return { ok: true };
    case 'revoke_drawings':
      await call(db, 'approve_drawings', { p_wo: wo.id, p_revoke: true });
      return { ok: true };
    case 'release': {
      const failing = await call<string[] | null>(db, 'release_to_shop', { p_wo: wo.id });
      return { released: !failing || failing.length === 0, failing: failing ?? [] };
    }
    case 'hold':
      await call(db, 'hold_work_order', { p_wo: wo.id, p_reason: body.reason || null });
      return { ok: true };
    case 'resume':
      await call(db, 'start_work_order', { p_wo: wo.id });
      return { ok: true };
    case 'cancel':
      await call(db, 'cancel_work_order', { p_wo: wo.id, p_reason: body.reason || null });
      return { ok: true };
    case 'close':
      await call(db, 'close_work_order', { p_wo: wo.id });
      return { ok: true };
    case 'add_bom': {
      const last = rows<{ seq: number }>(await pm.from('bom_lines').select('seq').eq('work_order_id', wo.id).order('seq', { ascending: false }).limit(1), 'last part');
      await write(
        pm.from('bom_lines').insert({
          job_id: wo.job_id, work_order_id: wo.id, seq: (last[0]?.seq ?? 0) + 1, line_kind: body.lineKind, part_code: body.partCode || null,
          description: body.description, material: body.material || null, qty: body.qty, uom: body.uom || 'EA', length_mm: body.lengthMm ?? null,
          width_mm: body.widthMm ?? null, thickness_mm: body.thicknessMm ?? null, grain: body.grain ?? null, edgeband: body.edgeband || null,
          assembly_ref: body.assemblyRef || null,
        }).select('id'),
        'add part',
      );
      return { ok: true };
    }
    case 'remove_bom':
      await write(pm.from('bom_lines').delete().eq('id', body.lineId).eq('work_order_id', wo.id).select('id'), 'remove part');
      return { ok: true };
    case 'add_operation': {
      const last = rows<{ seq: number }>(await pm.from('wo_operations').select('seq').eq('work_order_id', wo.id).order('seq', { ascending: false }).limit(1), 'last operation');
      await write(
        pm.from('wo_operations').insert({ job_id: wo.job_id, work_order_id: wo.id, work_center_id: body.workCenterId, seq: (last[0]?.seq ?? 0) + 1, name: body.name, std_minutes: body.stdMinutes }).select('id'),
        'add operation',
      );
      return { ok: true };
    }
    case 'remove_operation':
      await write(pm.from('wo_operations').delete().eq('id', body.operationId).eq('work_order_id', wo.id).select('id'), 'remove operation');
      return { ok: true };
    case 'update': {
      const patch: Record<string, unknown> = {};
      if (body.quantity !== undefined) patch.quantity = body.quantity;
      if (body.promisedOn !== undefined) patch.promised_on = body.promisedOn;
      if (body.summary !== undefined) patch.summary = body.summary;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(pm.from('work_orders').update(patch).eq('id', wo.id).select('id'), 'update production order');
      return { ok: true };
    }
  }
});
