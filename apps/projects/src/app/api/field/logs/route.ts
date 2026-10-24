export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { commandResponse, fieldCtx } from '../_lib/handler';
import { applySingle } from '../_lib/single';

/** POST /api/field/logs — submit a daily log (text from dictation, weather, crew, hours, signature). Idempotent. */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: z.unknown() }, async (rc) => {
  return commandResponse(await applySingle(fieldCtx(rc), rc.body, ['log.submit']));
});
