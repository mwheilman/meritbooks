import { HttpError } from '@/lib/api-errors';
import { must, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { approvalSummary, decideObject } from '@/lib/approvals/server';

/**
 * Approve through the approvals engine (1113): the caller's step is recorded when they may act
 * (tier, role, job, limit; preparer ≠ approver); the change order is approved — pm.approve_change_order
 * — when the last step approves. Otherwise it is sent on and `approval` says who it waits on.
 */
export const POST = route({ access: { cap: 'projects.change_orders', action: 'approve' }, mask: 'change_order' }, async ({ db, params }) => {
  const job = await loadJob(db, params.jobId!);
  const co = must(await db.schema('pm').from('change_orders').select('id').eq('id', params.coId!).eq('job_id', job.job_id).maybeSingle(), 'change order') as { id: string } | null;
  if (!co) throw new HttpError(404, 'That change order was not found on this job.', 'NOT_FOUND');
  const r = await decideObject(db, 'change_order', co.id);
  if (r.status === 'not_needed') must(await db.schema('pm').rpc('approve_change_order', { p_co: co.id }), 'approve change order');
  return { ok: true, approved: r.status === 'approved' || r.status === 'not_needed', approval: approvalSummary(r) };
});
