import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, type ReadyTenant } from '@/lib/api';
import { loadJob, type JobRef } from '@/lib/pm/guarded';
import { call } from './rpc';
import { createCustomerId } from '@/lib/pm/parties/create';
import type { NewJobZ } from './schemas';

/** The job an ops record hangs on: an existing one the caller can see, or one created now. */
export async function resolveJob(db: SupabaseClient, tenant: ReadyTenant, jobId: string | null | undefined, newJob: z.infer<typeof NewJobZ> | null | undefined): Promise<JobRef> {
  if (jobId) {
    const job = await loadJob(db, jobId);
    assertCompany(tenant, job.location_id);
    return job;
  }
  if (!newJob) throw new HttpError(422, 'Pick the job, or create one for this work.', 'VALIDATION');
  assertCompany(tenant, newJob.companyId);
  // a typed customer name is added to the shared customer master first (no provisional names)
  const customerId = newJob.customerId ?? (newJob.customerName ? await createCustomerId(db, newJob.customerName, newJob.companyId) : null);
  const id = await call<string | null>(db, 'create_project', {
    p_location: newJob.companyId,
    p_job_type_key: newJob.jobTypeKey,
    p_name: newJob.name,
    p_customer_id: customerId,
    p_contract_cents: null,
  });
  if (!id) throw new HttpError(500, 'The job was not created. Try again.', 'CREATE_FAILED');
  return loadJob(db, id);
}

/** 403 unless the row's company is one of the tenant's. */
export function assertRowCompany(tenant: ReadyTenant, locationId: string): void {
  assertCompany(tenant, locationId);
}
