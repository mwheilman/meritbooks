export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { commandResponse, fieldCtx } from '../_lib/handler';
import { applySingle } from '../_lib/single';

/**
 * POST /api/field/clock — one clock event (On my way, clock in, break, end break, switch job,
 * clock out), idempotent by its command id. A closing event turns the segment it closes into a
 * DRAFT time entry (source_ref wf:seg:<clock-in id>) with the punch times and GPS in its note;
 * "On my way" and clock in move the dispatch visit. Off-site punches are flagged, never blocked.
 */
export const POST = route({ access: { cap: 'projects.time', action: 'create' }, mask: false, body: z.unknown() }, async (rc) => {
  return commandResponse(await applySingle(fieldCtx(rc), rc.body, ['clock']));
});
