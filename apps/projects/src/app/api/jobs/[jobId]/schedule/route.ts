export const dynamic = 'force-dynamic';

/**
 * A job's schedule (WAVE1-SCHEDULE-SPEC): GET the Gantt bundle (projects.jobs:view); POST one
 * schedule operation (projects.jobs:edit at the job's company), each calling a 1112 RPC that
 * re-runs CPM on the server. The server result is authoritative: reschedule returns the changed
 * rows, structural edits return the job's fresh tasks and links for the Gantt to reconcile to.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { HttpError, PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { assertCompany, must, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { pm } from '@/lib/pm/db';
import { isMissingEngine, isRec, toReschedule, toTask } from '@/lib/pm/schedule/normalize';
import { loadDeps, loadJobSchedule, TASK_COLS } from '@/lib/pm/schedule/server';
import { CONSTRAINT_TYPES, DEP_TYPES, LAG_MAX, LAG_MIN, type SchedTask } from '@/lib/pm/schedule/types';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-16');
const Id = z.string().uuid();
const EDIT = { cap: 'projects.jobs', action: 'edit' } as const;

const Link = z.object({ pred_id: Id, dep_type: z.enum(DEP_TYPES as unknown as [string, ...string[]]), lag_days: z.number().int().min(LAG_MIN).max(LAG_MAX) });

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('cpm') }),
  z.object({ op: z.literal('reschedule'), taskId: Id, start: Day.nullable(), duration: z.number().int().min(0).max(3650).nullable() }),
  z.object({ op: z.literal('preview'), taskId: Id, start: Day.nullable(), duration: z.number().int().min(0).max(3650).nullable() }),
  z.object({ op: z.literal('links'), taskId: Id, links: z.array(Link).max(100) }),
  z.object({ op: z.literal('indent'), taskId: Id, direction: z.enum(['in', 'out']) }),
  z.object({ op: z.literal('order'), taskId: Id, afterTaskId: Id.nullable() }),
  z.object({ op: z.literal('baseline'), name: z.string().trim().min(1, 'Name the baseline').max(80) }),
  z.object({ op: z.literal('template'), templateId: Id, start: Day }),
  z.object({
    op: z.literal('create'),
    title: z.string().trim().min(1, 'Name the task').max(200),
    afterTaskId: Id.nullable(),
    parentId: Id.nullable(),
    duration: z.number().int().min(0).max(3650).default(1),
    isMilestone: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('update'),
    taskId: Id,
    patch: z
      .object({
        title: z.string().trim().min(1, 'Name the task').max(200),
        status: z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED']),
        pct_complete: z.number().min(0).max(1),
        actual_start: Day.nullable(),
        actual_finish: Day.nullable(),
        assigned_crew_id: Id.nullable(),
        constraint_type: z.enum(CONSTRAINT_TYPES as unknown as [string, ...string[]]),
        constraint_date: Day.nullable(),
        is_milestone: z.boolean(),
      })
      .partial()
      .refine((p) => Object.keys(p).length > 0, 'Nothing to change')
      .refine((p) => !p.actual_start || !p.actual_finish || p.actual_finish >= p.actual_start, { message: 'The actual finish is before the actual start', path: ['actual_finish'] }),
  }),
  z.object({ op: z.literal('delete'), taskId: Id }),
]);

type Res = { data: unknown; error: PgErrorLike | null };

/** Call a 1112 RPC; a missing engine is a plain 409, any other error maps as usual. */
async function rpc(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const r = (await pm(db).rpc(fn, args)) as Res;
  if (r.error) {
    if (isMissingEngine(r.error)) throw new HttpError(409, 'Scheduling is not switched on in this workspace yet. Ask your administrator to apply the schedule update.', 'ENGINE_MISSING');
    throw new PmQueryError(fn, r.error);
  }
  return r.data;
}

async function ownTask(db: SupabaseClient, jobId: string, taskId: string): Promise<void> {
  const t = must(await pm(db).from('tasks').select('id').eq('id', taskId).eq('job_id', jobId).maybeSingle(), 'task') as { id: string } | null;
  if (!t) throw new HttpError(404, 'That task was not found on this job.', 'NOT_FOUND');
}

async function fresh(db: SupabaseClient, jobId: string): Promise<{ tasks: SchedTask[]; deps: Awaited<ReturnType<typeof loadDeps>> }> {
  const r = (await pm(db).from('v_tasks_masked').select(TASK_COLS).eq('job_id', jobId).order('sort').limit(5000)) as Res;
  if (r.error) throw new PmQueryError('schedule tasks', r.error);
  const tasks = (Array.isArray(r.data) ? r.data : []).filter(isRec).map(toTask).filter((t): t is SchedTask => !!t);
  return { tasks, deps: await loadDeps(db, tasks.map((t) => t.id)) };
}

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: 'billing' }, async ({ db, params, tenant }) => {
  const job = await loadJob(db, params.jobId!);
  assertCompany(tenant, job.location_id);
  const p = must(await pm(db).from('projects').select('planned_start').eq('job_id', job.job_id).maybeSingle(), 'job dates') as { planned_start: string | null } | null;
  return loadJobSchedule(db, { jobId: job.job_id, companyId: job.location_id, plannedStart: p?.planned_start ?? null });
});

export const POST = route({ access: EDIT, body: Body, mask: 'billing' }, async ({ db, params, body, tenant }) => {
  const job = await loadJob(db, params.jobId!);
  assertCompany(tenant, job.location_id);
  const jobId = job.job_id;
  if ('taskId' in body) await ownTask(db, jobId, body.taskId);

  switch (body.op) {
    case 'cpm':
      await rpc(db, 'schedule_cpm', { p_job: jobId });
      return fresh(db, jobId);
    case 'reschedule':
      return { result: toReschedule(await rpc(db, 'reschedule_task', { p_task: body.taskId, p_new_start: body.start, p_new_duration: body.duration })) };
    case 'preview':
      return { result: toReschedule(await rpc(db, 'preview_reschedule', { p_task: body.taskId, p_new_start: body.start, p_new_duration: body.duration })) };
    case 'links':
      await rpc(db, 'set_task_links', { p_task: body.taskId, p_links: body.links });
      return fresh(db, jobId);
    case 'indent':
      await rpc(db, 'indent_task', { p_task: body.taskId, p_direction: body.direction });
      return fresh(db, jobId);
    case 'order':
      await rpc(db, 'move_task_order', { p_task: body.taskId, p_after_task: body.afterTaskId });
      return fresh(db, jobId);
    case 'baseline':
      return { baseline: await rpc(db, 'set_schedule_baseline', { p_job: jobId, p_name: body.name }) };
    case 'template':
      await rpc(db, 'apply_schedule_template', { p_job: jobId, p_template: body.templateId, p_start: body.start });
      return fresh(db, jobId);
    case 'create': {
      if (body.parentId) await ownTask(db, jobId, body.parentId);
      if (body.afterTaskId) await ownTask(db, jobId, body.afterTaskId);
      const created = must(
        await pm(db).from('tasks').insert({
          job_id: jobId, title: body.title, parent_task_id: body.parentId, duration_days: body.isMilestone ? 0 : Math.max(1, body.duration),
          is_milestone: body.isMilestone, sort: 0,
        }).select('id').single(),
        'add task',
      ) as { id: string };
      await rpc(db, 'move_task_order', { p_task: created.id, p_after_task: body.afterTaskId });
      await rpc(db, 'schedule_cpm', { p_job: jobId });
      return { taskId: created.id, ...(await fresh(db, jobId)) };
    }
    case 'update': {
      const patch: Record<string, unknown> = { ...body.patch };
      if (body.patch.status) patch.completed_at = body.patch.status === 'DONE' ? new Date().toISOString() : null;
      if (body.patch.constraint_type === 'ASAP') patch.constraint_date = null;
      if (body.patch.is_milestone === true) patch.duration_days = 0;
      must(await pm(db).from('tasks').update(patch).eq('id', body.taskId).eq('job_id', jobId).select('id'), 'update task');
      await rpc(db, 'schedule_cpm', { p_job: jobId });
      return fresh(db, jobId);
    }
    case 'delete':
      must(await pm(db).from('tasks').delete().eq('id', body.taskId).eq('job_id', jobId).select('id'), 'delete task');
      await rpc(db, 'schedule_cpm', { p_job: jobId });
      return fresh(db, jobId);
  }
});
