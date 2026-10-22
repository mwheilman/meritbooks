import { HttpError } from '@/lib/api-errors';
import { must, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';

/** Approve (preparer ≠ approver, enforced by pm.approve_change_order → 403 with a plain sentence). */
export const POST = route({ access: { cap: 'projects.change_orders', action: 'approve' }, mask: 'change_order' }, async ({ db, params }) => {
  const job = await loadJob(db, params.jobId!);
  const co = must(await db.schema('pm').from('change_orders').select('id').eq('id', params.coId!).eq('job_id', job.job_id).maybeSingle(), 'change order') as { id: string } | null;
  if (!co) throw new HttpError(404, 'That change order was not found on this job.', 'NOT_FOUND');
  must(await db.schema('pm').rpc('approve_change_order', { p_co: co.id }), 'approve change order');
  return { ok: true };
});
