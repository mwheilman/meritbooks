import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { own, write } from '@/lib/pm/ops/rpc';
import { Day, Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'CLOSED', 'VOID']).optional(),
  title: Need(200, 'Say what needs fixing').optional(),
  description: Text(4000).nullish(),
  area: Text(120).nullish(),
  dueOn: Day.nullish(),
  responsibleVendorId: Uuid.nullish(),
  billable: z.boolean().optional(),
});

/** pm.punch_items is member-writable (1100 grants); closed_at follows the status. */
export const PATCH = route({ access: { cap: 'projects.jobs', action: 'edit' }, body: Body }, async ({ db, params, body }) => {
  await own(db, 'punch_items', 'id', { id: params.itemId! }, 'That item was not found.');
  const patch: Record<string, unknown> = {};
  if (body.status) {
    patch.status = body.status;
    patch.closed_at = body.status === 'CLOSED' ? new Date().toISOString() : null;
  }
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description || null;
  if (body.area !== undefined) patch.area = body.area || null;
  if (body.dueOn !== undefined) patch.due_on = body.dueOn;
  if (body.responsibleVendorId !== undefined) patch.responsible_vendor_id = body.responsibleVendorId;
  if (body.billable !== undefined) patch.billable = body.billable;
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  await write(db.schema('pm').from('punch_items').update(patch).eq('id', params.itemId!).select('id'), 'update punch item');
  return { ok: true };
});

export const DELETE = route({ access: { cap: 'projects.jobs', action: 'edit' } }, async ({ db, params }) => {
  await own(db, 'punch_items', 'id', { id: params.itemId! }, 'That item was not found.');
  await write(db.schema('pm').from('punch_items').delete().eq('id', params.itemId!).select('id'), 'delete punch item');
  return { ok: true };
});
