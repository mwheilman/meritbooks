export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { QuantityCreate } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

/** POST /api/commercial/productivity/quantities — units installed today on a cost code, or its percent complete where units don't fit (CGC-89). */
export const POST = route({ access: { cap: 'projects.time', action: 'create' }, mask: false, body: QuantityCreate }, async ({ db, body }) => {
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_installed_quantities').insert({
    job_id: body.jobId, cost_code_id: body.costCodeId, work_date: body.workDate, qty: body.qty, pct_complete: body.pctComplete, uom: body.uom, area: body.area, note: body.note,
  }).select('id').single());
});
