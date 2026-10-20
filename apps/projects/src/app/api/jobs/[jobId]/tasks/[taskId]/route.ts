import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { must, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body = z.object({
  status: z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED']).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  startOn: Day.nullish(),
  dueOn: Day.nullish(),
});

async function own(db: Parameters<typeof loadJob>[0], jobId: string, taskId: string) {
  const t = must(await db.schema('pm').from('tasks').select('id, job_id').eq('id', taskId).eq('job_id', jobId).maybeSingle(), 'task') as { id: string } | null;
  if (!t) throw new HttpError(404, 'That task was not found on this job.', 'NOT_FOUND');
}

export const PATCH = route({ body: Body }, async ({ db, params, body }) => {
  const job = await loadJob(db, params.jobId!);
  await own(db, job.job_id, params.taskId!);
  const patch: Record<string, unknown> = {};
  if (body.status) {
    patch.status = body.status;
    patch.completed_at = body.status === 'DONE' ? new Date().toISOString() : null;
  }
  if (body.title) patch.title = body.title;
  if (body.startOn !== undefined) patch.start_on = body.startOn ?? null;
  if (body.dueOn !== undefined) patch.due_on = body.dueOn ?? null;
  if (Object.keys(patch).length === 0) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  must(await db.schema('pm').from('tasks').update(patch).eq('id', params.taskId!).select('id'), 'update task');
  return { ok: true };
});

export const DELETE = route({}, async ({ db, params }) => {
  const job = await loadJob(db, params.jobId!);
  await own(db, job.job_id, params.taskId!);
  must(await db.schema('pm').from('tasks').delete().eq('id', params.taskId!).select('id'), 'delete task');
  return { ok: true };
});
