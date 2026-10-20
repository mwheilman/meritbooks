import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, must, route } from '@/lib/api';

const Body = z.object({
  companyId: z.string().uuid(),
  jobTypeKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, 'Pick a job type'),
  name: z.string().trim().min(1, 'Give the job a name').max(120),
  customerId: z.string().uuid().nullish(),
  customerName: z.string().trim().max(120).nullish(),
  contractCents: z.number().int().min(0).max(1e13).nullish(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

/** Create a job: core.jobs + pm.projects atomically (pm.create_project mints the number). */
export const POST = route({ body: Body }, async ({ body, db, tenant }) => {
  assertCompany(tenant, body.companyId);
  const jobId = must(
    await db.schema('pm').rpc('create_project', {
      p_location: body.companyId,
      p_job_type_key: body.jobTypeKey,
      p_name: body.name,
      p_customer_id: body.customerId ?? null,
      p_contract_cents: body.contractCents && body.contractCents > 0 ? body.contractCents : null,
    }),
    'create job',
  ) as string | null;
  if (!jobId) throw new HttpError(500, 'The job was not created. Try again.', 'CREATE_FAILED');

  // A typed customer that is not in Books yet: keep it as the job's provisional customer name
  // (identity on create; no core.customers row is invented).
  if (!body.customerId && body.customerName) {
    must(await db.schema('pm').rpc('set_job_customer', { p_job: jobId, p_customer_id: null, p_customer_name: body.customerName }), 'set customer name');
  }
  if (body.startDate) {
    must(await db.schema('pm').from('projects').update({ planned_start: body.startDate }).eq('job_id', jobId).select('job_id'), 'set start');
  }
  return { jobId };
});
