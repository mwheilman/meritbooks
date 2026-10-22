import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { call } from '@/lib/pm/ops/rpc';
import { TEAM_SLOTS } from '@/components/job/team-slots';

export const dynamic = 'force-dynamic';

const Body = z.object({
  membershipId: z.string().uuid('Pick the person to add.'),
  slot: z.enum(TEAM_SLOTS),
});

/**
 * Add someone to a job's team, or change their slot (pm.job_team_upsert, spec §2.4). The job's
 * company must grant projects.team:edit (route guard, then assertCompany at the job's company;
 * the definer function checks it again).
 */
export const POST = route({ access: { cap: 'projects.team', action: 'edit' }, body: Body, mask: false }, async ({ db, params, body, tenant }) => {
  const job = await loadJob(db, params.jobId!);
  assertCompany(tenant, job.location_id);
  await call(db, 'job_team_upsert', { p_job: job.job_id, p_membership: body.membershipId, p_slot: body.slot });
  return { ok: true };
});
