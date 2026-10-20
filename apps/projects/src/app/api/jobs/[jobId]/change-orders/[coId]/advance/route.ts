import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { must, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';

/** PCO ⇄ COR, → REJECTED, → VOID (pm.advance_change_order checks the move). */
export const POST = route({ body: z.object({ to: z.enum(['PCO', 'COR', 'REJECTED', 'VOID']) }) }, async ({ db, params, body }) => {
  const job = await loadJob(db, params.jobId!);
  const co = must(await db.schema('pm').from('change_orders').select('id').eq('id', params.coId!).eq('job_id', job.job_id).maybeSingle(), 'change order') as { id: string } | null;
  if (!co) throw new HttpError(404, 'That change order was not found on this job.', 'NOT_FOUND');
  must(await db.schema('pm').rpc('advance_change_order', { p_co: co.id, p_to: body.to }), 'advance change order');
  return { ok: true };
});
