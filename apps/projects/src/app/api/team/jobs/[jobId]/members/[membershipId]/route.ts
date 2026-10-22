import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { call } from '@/lib/pm/ops/rpc';

export const dynamic = 'force-dynamic';

/** Take someone off a job's team (pm.job_team_remove, spec §2.4; projects.team:edit at the job's company). */
export const DELETE = route({ access: { cap: 'projects.team', action: 'edit' }, mask: false }, async ({ db, params, tenant }) => {
  const job = await loadJob(db, params.jobId!);
  assertCompany(tenant, job.location_id);
  await call(db, 'job_team_remove', { p_job: job.job_id, p_membership: params.membershipId! });
  return { ok: true };
});
