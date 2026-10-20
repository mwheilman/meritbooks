import { z } from 'zod';
import { must, route } from '@/lib/api';
import { guardCopy, guardFixHref } from '@/lib/pm/guards';
import { loadJob } from '@/lib/pm/guarded';

/** Move a job to the next stage. Failing guards come back as plain sentences; nothing changes. */
export const POST = route({ body: z.object({ to: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/) }) }, async ({ db, params, body }) => {
  const job = await loadJob(db, params.jobId!);
  const failing = (must(await db.schema('pm').rpc('transition_stage', { p_job: job.job_id, p_to: body.to }), 'move stage') ?? []) as string[];
  if (failing.length > 0) {
    return {
      moved: false,
      failing: failing.map((g) => ({ guard: g, sentence: guardCopy(g).failing, fix: { label: guardCopy(g).fix.label, href: guardFixHref(g, job.job_id) } })),
    };
  }
  return { moved: true, failing: [] };
});
