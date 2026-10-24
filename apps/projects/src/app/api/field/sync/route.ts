export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { applyBatch } from '../_lib/apply';
import { SyncBodyZ, type SyncResponse } from '../_lib/contract';
import { fieldCtx } from '../_lib/handler';

/**
 * POST /api/field/sync — the phone's queued commands, oldest first, up to 50 per call. Each is
 * validated and applied on its own, at most once (deduped by its client command id), with its
 * own grant checked at the job's company; one result per command, in order. A batch never fails
 * as a whole for one bad command. Photos go to /api/field/photos (multipart).
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, body: SyncBodyZ }, async (rc) => {
  const results = await applyBatch(fieldCtx(rc), rc.body.commands);
  const out: SyncResponse = { results, serverTime: new Date().toISOString() };
  return out;
});
