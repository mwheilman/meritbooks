export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { commandResponse, fieldCtx } from '../_lib/handler';
import { applySingle } from '../_lib/single';

/**
 * POST /api/field/punch — add a punch item (from the Punch screen or a failed checklist item).
 * Needs projects.jobs:create, the grant pm.punch_items' RLS checks. Idempotent.
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'create' }, mask: false, body: z.unknown() }, async (rc) => {
  return commandResponse(await applySingle(fieldCtx(rc), rc.body, ['punch.create']));
});
