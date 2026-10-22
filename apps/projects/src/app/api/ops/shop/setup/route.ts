import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { write } from '@/lib/pm/ops/rpc';
import { Cents, Need, SkillCode, Text, Uuid } from '@/lib/pm/ops/schemas';

/** Work centers and routings (company library, member-writable in 1105). */
const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_center'),
    companyId: Uuid,
    code: SkillCode,
    name: Need(80, 'Name the work center'),
    kind: Text(40).nullish(),
    capacityMinutesPerWeek: z.number().int().min(0).max(100_000).default(2400),
    rateCents: Cents.nullish(),
  }),
  z.object({ op: z.literal('update_center'), centerId: Uuid, capacityMinutesPerWeek: z.number().int().min(0).max(100_000).optional(), status: z.enum(['ACTIVE', 'DOWN', 'INACTIVE']).optional(), name: Need(80, 'Name the work center').optional() }),
  z.object({ op: z.literal('add_routing'), companyId: Uuid, code: Need(24, 'Give the routing a code'), name: Need(120, 'Name the routing') }),
  z.object({ op: z.literal('deactivate_routing'), routingId: Uuid }),
  z.object({
    op: z.literal('add_step'),
    routingId: Uuid,
    workCenterId: Uuid,
    name: Need(120, 'Name the step'),
    setupMinutes: z.number().int().min(0).max(100_000).default(0),
    runMinutesPerUnit: z.number().min(0).max(100_000).default(0),
  }),
  z.object({ op: z.literal('remove_step'), stepId: Uuid }),
]);

export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: 'work_center', body: Op }, async ({ db, body, tenant }) => {
  const pm = db.schema('pm');
  switch (body.op) {
    case 'add_center':
      assertCompany(tenant, body.companyId);
      await write(pm.from('work_centers').insert({ location_id: body.companyId, code: body.code, name: body.name, kind: body.kind || null, capacity_minutes_per_week: body.capacityMinutesPerWeek, rate_cents: body.rateCents ?? null }).select('id'), 'add work center');
      return { ok: true };
    case 'update_center': {
      const patch: Record<string, unknown> = {};
      if (body.capacityMinutesPerWeek !== undefined) patch.capacity_minutes_per_week = body.capacityMinutesPerWeek;
      if (body.status !== undefined) patch.status = body.status;
      if (body.name !== undefined) patch.name = body.name;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(pm.from('work_centers').update(patch).eq('id', body.centerId).select('id'), 'update work center');
      return { ok: true };
    }
    case 'add_routing':
      assertCompany(tenant, body.companyId);
      await write(pm.from('routings').insert({ location_id: body.companyId, code: body.code, name: body.name }).select('id'), 'add routing');
      return { ok: true };
    case 'deactivate_routing':
      await write(pm.from('routings').update({ is_active: false }).eq('id', body.routingId).select('id'), 'retire routing');
      return { ok: true };
    case 'add_step': {
      const last = rows<{ seq: number }>(await pm.from('routing_steps').select('seq').eq('routing_id', body.routingId).order('seq', { ascending: false }).limit(1), 'last step');
      await write(
        pm.from('routing_steps').insert({ routing_id: body.routingId, seq: (last[0]?.seq ?? 0) + 1, work_center_id: body.workCenterId, name: body.name, setup_minutes: body.setupMinutes, run_minutes_per_unit: body.runMinutesPerUnit }).select('id'),
        'add routing step',
      );
      return { ok: true };
    }
    case 'remove_step':
      await write(pm.from('routing_steps').delete().eq('id', body.stepId).select('id'), 'remove routing step');
      return { ok: true };
  }
});
