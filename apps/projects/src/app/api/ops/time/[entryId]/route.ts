import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { own, write } from '@/lib/pm/ops/rpc';
import { Day, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  workDate: Day.optional(),
  hours: z.number().gt(0).max(24).optional(),
  payType: z.enum(['REG', 'OT', 'DT', 'PIECE', 'FLAG']).optional(),
  costCodeId: Uuid.nullish(),
  workOrderId: Uuid.nullish(),
  operationId: Uuid.nullish(),
  billable: z.boolean().optional(),
  notes: Text(1000).nullish(),
  /** submit: DRAFT → SUBMITTED; recall: SUBMITTED/REJECTED → DRAFT. Approval is a later release. */
  state: z.enum(['submit', 'recall']).optional(),
});

const MAP: Array<[keyof z.infer<typeof Body>, string]> = [
  ['workDate', 'work_date'], ['hours', 'hours'], ['payType', 'pay_type'], ['costCodeId', 'cost_code_id'], ['workOrderId', 'work_order_id'],
  ['operationId', 'operation_id'], ['billable', 'billable'], ['notes', 'notes'],
];

export const PATCH = route({ body: Body }, async ({ db, params, body }) => {
  const t = await own<{ id: string; approval_state: string }>(db, 'time_entries', 'id, approval_state', { id: params.entryId! }, 'That time entry was not found.');
  if (t.approval_state === 'APPROVED' || t.approval_state === 'VOID') throw new HttpError(422, 'Approved time is locked.', 'LOCKED');
  const patch: Record<string, unknown> = {};
  for (const [k, col] of MAP) if (body[k] !== undefined) patch[col] = body[k] === '' ? null : body[k];
  if (body.state === 'submit') patch.approval_state = 'SUBMITTED';
  if (body.state === 'recall') patch.approval_state = 'DRAFT';
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  await write(db.schema('pm').from('time_entries').update(patch).eq('id', t.id).select('id'), 'update time');
  return { ok: true };
});

export const DELETE = route({}, async ({ db, params }) => {
  const t = await own<{ id: string; approval_state: string }>(db, 'time_entries', 'id, approval_state', { id: params.entryId! }, 'That time entry was not found.');
  if (t.approval_state === 'APPROVED') throw new HttpError(422, 'Approved time cannot be deleted.', 'LOCKED');
  await write(db.schema('pm').from('time_entries').delete().eq('id', t.id).select('id'), 'delete time');
  return { ok: true };
});
