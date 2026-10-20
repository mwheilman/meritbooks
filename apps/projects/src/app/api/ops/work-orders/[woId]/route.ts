export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { loadWorkOrderDetail } from '@/lib/pm/ops/field-queries';
import { customerNames } from '@/lib/pm/ops/scope';
import { Day, Fraction, Instant, LineKindZ, OutcomeZ, Qty, SkillCode, Text, Uuid } from '@/lib/pm/ops/schemas';

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('schedule'),
    start: Instant,
    end: Instant,
    employeeIds: z.array(Uuid).max(8).default([]),
    crewId: Uuid.nullish(),
    replace: z.boolean().default(true),
    ignoreSkills: z.boolean().default(false),
  }),
  z.object({ op: z.literal('start') }),
  z.object({ op: z.literal('hold'), reason: Text(300).nullish() }),
  z.object({
    op: z.literal('complete'),
    outcome: OutcomeZ,
    resolution: Text(4000).nullish(),
    isCallback: z.boolean().nullish(),
    followUp: z.boolean().default(false),
    meterOut: z.number().min(0).max(1e9).nullish(),
  }),
  z.object({ op: z.literal('close') }),
  z.object({ op: z.literal('cancel'), reason: Text(300).nullish() }),
  z.object({ op: z.literal('decide'), approve: z.array(Uuid).max(100).default([]), decline: z.array(Uuid).max(100).default([]), customerName: Text(200).nullish() }),
  z.object({
    op: z.literal('add_line'),
    kind: LineKindZ,
    priceBookItemId: Uuid.nullish(),
    description: Text(300).nullish(),
    qty: Qty.default(1),
    uom: Text(12).nullish(),
    unitPriceCents: z.number().int().min(-1e11).max(1e11).nullish(),
    payType: z.enum(['CUSTOMER', 'WARRANTY', 'INTERNAL']).default('CUSTOMER'),
    optionGroup: Text(60).nullish(),
    proposed: z.boolean().default(false),
    flagHours: z.number().min(0).max(1000).nullish(),
  }),
  z.object({
    op: z.literal('update_line'),
    lineId: Uuid,
    qty: Qty.optional(),
    unitPriceCents: z.number().int().min(-1e11).max(1e11).nullish(),
    discountPct: Fraction.optional(),
    payType: z.enum(['CUSTOMER', 'WARRANTY', 'INTERNAL']).optional(),
    description: Text(300).optional(),
    flagHours: z.number().min(0).max(1000).nullish(),
  }),
  z.object({ op: z.literal('remove_line'), lineId: Uuid }),
  z.object({
    op: z.literal('update'),
    summary: Text(200).optional(),
    description: Text(4000).nullish(),
    complaint: Text(2000).nullish(),
    cause: Text(2000).nullish(),
    resolution: Text(4000).nullish(),
    priority: z.number().int().min(1).max(5).optional(),
    estimatedMinutes: z.number().int().min(0).max(14_400).nullish(),
    requiredSkills: z.array(SkillCode).max(12).optional(),
    promisedOn: Day.nullish(),
    meterIn: z.number().min(0).max(1e9).nullish(),
  }),
]);

interface WoRef { id: string; job_id: string; location_id: string; kind: string; required_skills: string[] }

export const GET = route({}, async ({ db, params }) => {
  const d = await loadWorkOrderDetail(db, params.woId!);
  if (!d) throw new HttpError(404, 'That work order was not found.', 'NOT_FOUND');
  const empIds = [...new Set(d.assignments.map((a) => a.employee_id).filter((x): x is string => !!x))];
  const emps = empIds.length
    ? rows<{ id: string; first_name: string; last_name: string }>(await db.schema('core').from('employees').select('id, first_name, last_name').in('id', empIds), 'technicians')
    : [];
  const payers = await customerNames(db, [d.order.payer_customer_id, ...d.claims.map((c) => c.payer_customer_id)]);
  return { ...d, employees: Object.fromEntries(emps.map((e) => [e.id, `${e.first_name} ${e.last_name}`.trim()])), customers: payers };
});

export const POST = route({ body: Op }, async ({ db, params, body, tenant }) => {
  const wo = await own<WoRef>(db, 'work_orders', 'id, job_id, location_id, kind, required_skills', { id: params.woId! }, 'That work order was not found.');
  assertCompany(tenant, wo.location_id);
  const pm = db.schema('pm');
  switch (body.op) {
    case 'schedule': {
      if (Date.parse(body.end) <= Date.parse(body.start)) throw new HttpError(422, 'The visit must end after it starts.', 'VALIDATION');
      if (!body.employeeIds.length && !body.crewId) throw new HttpError(422, 'Pick a technician or a crew.', 'VALIDATION');
      const skills = rows<{ code: string; name: string }>(await pm.from('skills').select('code, name'), 'skills');
      const res = await call<{ assignment_ids: string[]; work_order_status: string }>(db, 'schedule_work_order', {
        p_wo: wo.id, p_start: body.start, p_end: body.end, p_employees: body.employeeIds.length ? body.employeeIds : null,
        p_crew: body.crewId ?? null, p_replace: body.replace, p_ignore_skills: body.ignoreSkills,
      }, Object.fromEntries(skills.map((s) => [s.code, s.name])));
      return { ok: true, ...res };
    }
    case 'start':
      await call(db, 'start_work_order', { p_wo: wo.id });
      return { ok: true };
    case 'hold':
      await call(db, 'hold_work_order', { p_wo: wo.id, p_reason: body.reason || null });
      return { ok: true };
    case 'complete':
      await call(db, 'complete_work_order', {
        p_wo: wo.id, p_outcome: body.outcome, p_resolution: body.resolution || null, p_is_callback: body.isCallback ?? null,
        p_callback_of: null, p_follow_up_required: body.followUp, p_meter_out: body.meterOut ?? null,
      });
      return { ok: true };
    case 'close':
      await call(db, 'close_work_order', { p_wo: wo.id });
      return { ok: true };
    case 'cancel':
      await call(db, 'cancel_work_order', { p_wo: wo.id, p_reason: body.reason || null });
      return { ok: true };
    case 'decide': {
      if (!body.approve.length && !body.decline.length) throw new HttpError(422, 'Pick at least one option to approve or decline.', 'VALIDATION');
      const n = await call<number>(db, 'decide_work_order_options', { p_wo: wo.id, p_approve: body.approve, p_decline: body.decline, p_customer_name: body.customerName || null });
      return { ok: true, decided: n };
    }
    case 'add_line': {
      if (!body.priceBookItemId && !body.description) throw new HttpError(422, 'Pick a price book item or describe the line.', 'VALIDATION');
      if (body.kind !== 'DISCOUNT' && body.unitPriceCents != null && body.unitPriceCents < 0) throw new HttpError(422, 'Only a discount line can be negative.', 'VALIDATION');
      const last = rows<{ sort: number }>(await pm.from('work_order_lines').select('sort').eq('work_order_id', wo.id).order('sort', { ascending: false }).limit(1), 'last line');
      await write(
        pm.from('work_order_lines').insert({
          job_id: wo.job_id, work_order_id: wo.id, sort: (last[0]?.sort ?? -1) + 1, kind: body.kind, price_book_item_id: body.priceBookItemId ?? null,
          description: body.description || null, qty: body.qty, uom: body.uom || 'EA', unit_price_cents: body.unitPriceCents ?? null,
          pay_type: body.payType, option_group: body.optionGroup || null, status: body.proposed ? 'PROPOSED' : 'APPROVED', flag_hours: body.flagHours ?? null,
        }).select('id'),
        'add line',
      );
      return { ok: true };
    }
    case 'update_line': {
      const patch: Record<string, unknown> = {};
      if (body.qty !== undefined) patch.qty = body.qty;
      if (body.unitPriceCents !== undefined) patch.unit_price_cents = body.unitPriceCents;
      if (body.discountPct !== undefined) patch.discount_pct = body.discountPct;
      if (body.payType !== undefined) patch.pay_type = body.payType;
      if (body.description !== undefined && body.description) patch.description = body.description;
      if (body.flagHours !== undefined) patch.flag_hours = body.flagHours;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await write<unknown[]>(pm.from('work_order_lines').update(patch).eq('id', body.lineId).eq('work_order_id', wo.id).select('id'), 'update line');
      if (!r.length) throw new HttpError(404, 'That line was not found on this work order.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'remove_line': {
      const r = await write<unknown[]>(pm.from('work_order_lines').delete().eq('id', body.lineId).eq('work_order_id', wo.id).select('id'), 'remove line');
      if (!r.length) throw new HttpError(404, 'That line was not found on this work order.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'update': {
      const map: Array<[keyof typeof body, string]> = [
        ['summary', 'summary'], ['description', 'description'], ['complaint', 'complaint'], ['cause', 'cause'], ['resolution', 'resolution'],
        ['priority', 'priority'], ['estimatedMinutes', 'estimated_minutes'], ['requiredSkills', 'required_skills'], ['promisedOn', 'promised_on'], ['meterIn', 'meter_in'],
      ];
      const patch: Record<string, unknown> = {};
      for (const [k, col] of map) if (body[k] !== undefined) patch[col] = body[k] === '' ? null : body[k];
      if (patch.summary === null) throw new HttpError(422, 'A work order needs a summary.', 'VALIDATION');
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(pm.from('work_orders').update(patch).eq('id', wo.id).select('id'), 'update work order');
      return { ok: true };
    }
  }
});
