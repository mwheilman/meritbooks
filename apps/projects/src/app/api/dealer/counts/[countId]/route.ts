export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dcall, downs, dwrite } from '@/lib/pm/dealer/rpc';
import { Text, Uuid } from '@/lib/pm/dealer/schemas';

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), lines: z.array(z.object({ lineId: Uuid, counted: z.number().min(0).max(1e8).nullable(), notes: Text(200).nullish() })).min(1).max(500) }),
  z.object({ op: z.literal('post') }),
]);

/** Key counted quantities, then post the variance as stock adjustments (pm.post_parts_count). */
export const POST = route({ body: Op }, async ({ db, params, body, tenant }) => {
  const c = await downs<{ id: string; location_id: string; status: string }>(db, 'parts_counts', 'id, location_id, status', params.countId!, 'That count was not found.');
  assertCompany(tenant, c.location_id);
  if (body.op === 'set') {
    if (c.status !== 'OPEN') throw new HttpError(422, 'The count is posted; its lines are locked.', 'PM_COUNT_LOCKED');
    for (const l of body.lines) {
      const patch: Record<string, unknown> = { counted_qty: l.counted };
      if (l.notes !== undefined) patch.notes = l.notes || null;
      await dwrite(db.schema('pm').from('parts_count_lines').update(patch).eq('id', l.lineId).eq('count_id', c.id).select('id'), 'save the count');
    }
    return { ok: true, saved: body.lines.length };
  }
  const summary = await dcall<Record<string, number>>(db, 'post_parts_count', { p_count: c.id });
  return { ok: true, summary };
});
