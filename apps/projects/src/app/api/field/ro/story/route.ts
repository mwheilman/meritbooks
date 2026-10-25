export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { xcall } from '@/lib/dealer/rpc';
import { Text, Uuid } from '@/lib/dealer/schemas';

const Part = Text(2000).nullish();
const Body = z.object({
  commandId: Uuid,
  lineId: Uuid,
  complaint: Part,
  cause: Part,
  correction: Part,
}).refine((b) => b.complaint != null || b.cause != null || b.correction != null, { message: 'Say the complaint, the cause or the correction.', path: ['complaint'] });

interface StoryRow {
  story_id: string;
  line_id: string;
  work_order_id: string;
  work_order: string;
  complaint: string | null;
  cause: string | null;
  correction: string | null;
  updated_at: string;
  replayed: boolean;
}

/**
 * POST /api/field/ro/story — the technician's 3C story (complaint / cause / correction) on one RO
 * line, idempotent by commandId (pm.dlr_set_line_story, migration 1125). A part left out or null
 * stays as it is; "" clears it. The database decides who may write: a tech on the RO (dispatched,
 * assigned operation, performed-by or punched on the line) or projects.store:edit /
 * projects.dispatch:edit on it. Text only, no prices.
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: Body }, async ({ db, body }) => {
  const r = await xcall<StoryRow>(db, 'dlr_set_line_story', {
    p_line: body.lineId,
    p_complaint: body.complaint ?? null,
    p_cause: body.cause ?? null,
    p_correction: body.correction ?? null,
    p_command: body.commandId,
  });
  return {
    storyId: r.story_id, lineId: r.line_id, workOrderId: r.work_order_id, workOrder: r.work_order,
    complaint: r.complaint, cause: r.cause, correction: r.correction, updatedAt: r.updated_at, replayed: r.replayed,
  };
});
