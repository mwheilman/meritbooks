import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { call } from '@/lib/pm/ops/rpc';
import { Day, Need, Qty, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  jobId: Uuid,
  summary: Need(200, 'Say what the shop is building'),
  quantity: Qty.default(1),
  routingId: Uuid.nullish(),
  promisedOn: Day.nullish(),
  remakeOfId: Uuid.nullish(),
});

/** New production order (a pm.work_orders row of kind PRODUCTION), in engineering until released. */
export const POST = route({ access: { cap: 'projects.production', action: 'create' }, mask: 'work_order', body: Body }, async ({ db, body, tenant }) => {
  const job = await loadJob(db, body.jobId);
  assertCompany(tenant, job.location_id);
  const id = await call<string | null>(db, 'create_production_order', {
    p_job: job.job_id, p_summary: body.summary, p_quantity: body.quantity, p_routing: body.routingId ?? null,
    p_promised_on: body.promisedOn ?? null, p_wbs: null, p_remake_of: body.remakeOfId ?? null,
  });
  if (!id) throw new HttpError(500, 'The production order was not created. Try again.', 'CREATE_FAILED');
  return { workOrderId: id };
});
