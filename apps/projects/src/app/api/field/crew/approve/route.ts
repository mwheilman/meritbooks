export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { commandResponse, fieldCtx } from '../../_lib/handler';
import { applySingle } from '../../_lib/single';

/**
 * POST /api/field/crew/approve — a supervisor approves submitted crew time (pm.approve_time_entries:
 * someone other than the worker approves; rates are pinned there, never shown here). Idempotent.
 */
export const POST = route({ access: { cap: 'projects.time', action: 'approve' }, mask: false, body: z.unknown() }, async (rc) => {
  return commandResponse(await applySingle(fieldCtx(rc), rc.body, ['crew.approve']));
});
