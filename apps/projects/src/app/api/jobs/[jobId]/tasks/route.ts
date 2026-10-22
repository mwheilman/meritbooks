export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { must, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { listTasks } from '@/lib/pm/work';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body = z
  .object({
    title: z.string().trim().min(1, 'Name the task').max(200),
    startOn: Day.nullish(),
    dueOn: Day.nullish(),
    isMilestone: z.boolean().optional(),
  })
  .refine((b) => !b.startOn || !b.dueOn || b.dueOn >= b.startOn, { message: 'Due date is before the start date', path: ['dueOn'] });

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' } }, async ({ db, params }) => {
  const job = await loadJob(db, params.jobId!);
  return { tasks: await listTasks(db, job.job_id) };
});

export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, body: Body }, async ({ db, params, body }) => {
  const job = await loadJob(db, params.jobId!);
  const pm = db.schema('pm');
  const last = must(await pm.from('tasks').select('sort').eq('job_id', job.job_id).order('sort', { ascending: false }).limit(1), 'last task') as Array<{ sort: number }>;
  const task = must(
    await pm.from('tasks').insert({
      job_id: job.job_id, title: body.title, start_on: body.startOn ?? null, due_on: body.dueOn ?? null,
      is_milestone: body.isMilestone ?? false, sort: (last[0]?.sort ?? -1) + 1,
    }).select('id').single(),
    'add task',
  ) as { id: string };
  return { taskId: task.id };
});
