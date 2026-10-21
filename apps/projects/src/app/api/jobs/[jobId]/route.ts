export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { must, route } from '@/lib/api';
import { createCustomerId } from '@/lib/pm/parties/create';
import { loadJob } from '@/lib/pm/guarded';
import { getProject, getJobOverview } from '@/lib/pm/projects';

const Date_ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body = z
  .object({
    customerId: z.string().uuid().nullish(),
    customerName: z.string().trim().max(120).nullish(),
    plannedStart: Date_.nullish(),
    plannedFinish: Date_.nullish(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change');

export const GET = route({}, async ({ db, params }) => {
  const job = await getProject(db, params.jobId!);
  if (!job) throw new HttpError(404, 'That job was not found in this workspace.', 'NOT_FOUND');
  return { job, overview: await getJobOverview(db, params.jobId!) };
});

/** Edit the job's customer (identity, Core-owned column) and planned dates (pm.projects). */
export const PATCH = route({ body: Body }, async ({ db, params, body }) => {
  const job = await loadJob(db, params.jobId!);
  if (body.customerId !== undefined || body.customerName !== undefined) {
    // core.jobs identity is written only through the org-guarded definer pm.set_job_customer (mig 1101).
    // A new name becomes a real customer first (pm.create_customer, 1108); the name-only path of
    // set_job_customer is left for legacy rows and is never written from here.
    const customerId = body.customerId ?? (body.customerName ? await createCustomerId(db, body.customerName, job.location_id) : null);
    must(await db.schema('pm').rpc('set_job_customer', { p_job: job.job_id, p_customer_id: customerId, p_customer_name: null }), 'set customer');
  }
  const dates: Record<string, string | null> = {};
  if (body.plannedStart !== undefined) dates.planned_start = body.plannedStart ?? null;
  if (body.plannedFinish !== undefined) dates.planned_finish = body.plannedFinish ?? null;
  if (Object.keys(dates).length) must(await db.schema('pm').from('projects').update(dates).eq('job_id', job.job_id).select('job_id'), 'set dates');
  return { ok: true };
});
