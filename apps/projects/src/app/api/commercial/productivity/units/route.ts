export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { UnitsUpsert } from '@/lib/commercial/screen-schemas';
import { cmError, cmWrote } from '@/lib/commercial/server';

/** POST /api/commercial/productivity/units — budget quantity, unit and hours for a cost code (what earned hours are measured against, CGC-90). Hours only. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: UnitsUpsert }, async ({ db, body }) => {
  const pm = db.schema('pm');
  const row = { budget_qty: body.budgetQty, uom: body.uom, budget_hours: body.budgetHours, pct_complete_entry: body.pctCompleteEntry };
  const cur = await pm.from('cm_cost_code_units').select('id').eq('job_id', body.jobId).eq('cost_code_id', body.costCodeId).maybeSingle();
  if (cur.error) throw cmError(cur.error);
  const id = (cur.data as { id: string } | null)?.id;
  if (id) return cmWrote<{ id: string }>(await pm.from('cm_cost_code_units').update(row).eq('id', id).select('id').single());
  return cmWrote<{ id: string }>(await pm.from('cm_cost_code_units').insert({ job_id: body.jobId, cost_code_id: body.costCodeId, ...row }).select('id').single());
});
