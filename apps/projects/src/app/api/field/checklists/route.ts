export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { CHECKLISTS } from '../_lib/checklists';
import { commandResponse, fieldCtx } from '../_lib/handler';
import { applySingle } from '../_lib/single';

/** GET /api/field/checklists — the checklist templates (English and Spanish). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false }, async () => ({ checklists: CHECKLISTS }));

/**
 * POST /api/field/checklists — submit a completed checklist: every item answered, required photos
 * taken, a note on each failure. Stored as a log on the job; failed items come as punch commands.
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: z.unknown() }, async (rc) => {
  return commandResponse(await applySingle(fieldCtx(rc), rc.body, ['checklist.submit']));
});
