import { z } from 'zod';
import { route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import { Day, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({ workOrderId: Uuid, serviceDay: Day, arrivalWindowId: Uuid, overrideReason: Text(300).nullish() });

/** Move a booked visit to another day / window; capacity is rechecked (dispatch may override with a reason). */
export const POST = route({ access: { cap: 'projects.dispatch', action: 'edit' }, mask: false, body: Body }, async ({ db, body }) => {
  const r = await fsCall<{ override: boolean }>(db, 'fs_reschedule_booking', {
    p_wo: body.workOrderId, p_service_day: body.serviceDay, p_arrival_window: body.arrivalWindowId, p_override_reason: body.overrideReason || null,
  });
  return { override: r.override };
});
