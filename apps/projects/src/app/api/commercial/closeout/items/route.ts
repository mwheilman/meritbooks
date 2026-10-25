export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { CloseoutItemCreate } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

/** POST /api/commercial/closeout/items — add an item the spec's Division 01 closeout section asks for. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: CloseoutItemCreate }, async ({ db, body }) => {
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_closeout_items').insert({
    job_id: body.jobId, category: body.category, title: body.title, vendor_id: body.vendorId, spec_section: body.specSection, due_on: body.dueOn,
  }).select('id').single());
});
