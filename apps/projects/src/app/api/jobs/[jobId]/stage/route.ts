import { z } from 'zod';
import { must, route } from '@/lib/api';
import { guardCopy, guardFixHref } from '@/lib/pm/guards';
import { loadJob } from '@/lib/pm/guarded';
import { approvalNeeded, approvalSummary, decideObject } from '@/lib/approvals/server';

/** Move a job to the next stage. Failing guards come back as plain sentences; nothing changes. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: 'job', body: z.object({ to: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/) }) }, async ({ db, params, body }) => {
  const job = await loadJob(db, params.jobId!);
  // a transition that names an approval policy (stage_transitions.approval_policy_key) goes through
  // the approvals engine; the engine moves the job when its chain approves (1113)
  if (await approvalNeeded(db, 'stage_transition', job.job_id, body.to)) {
    const a = await decideObject(db, 'stage_transition', job.job_id, { decision: 'submit', ref: body.to });
    return { moved: false, failing: [], approval: approvalSummary(a) };
  }
  const failing = (must(await db.schema('pm').rpc('transition_stage', { p_job: job.job_id, p_to: body.to }), 'move stage') ?? []) as string[];
  if (failing.length > 0) {
    return {
      moved: false,
      failing: failing.map((g) => ({ guard: g, sentence: guardCopy(g).failing, fix: { label: guardCopy(g).fix.label, href: guardFixHref(g, job.job_id) } })),
    };
  }
  return { moved: true, failing: [] };
});
