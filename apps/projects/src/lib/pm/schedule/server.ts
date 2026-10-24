import 'server-only';
/**
 * Schedule loaders over migration 1112 (WAVE1-SCHEDULE-SPEC §2), on the caller's RLS client.
 * Tasks come from pm.v_tasks_masked (billing amounts null without projects.contract_value).
 * When the engine isn't in the database yet, the job schedule still loads from the 1100
 * columns with engine=false: the Gantt then draws from the client CPM and stays read-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { pm } from '../db';
import { makeCalendar } from './calendar';
import { isMissingEngine, isRec, num, str, toBaselineTask, toDep, toLoadCell, toLookahead, toScheduleJob, toTask, toTemplate, type Rec } from './normalize';
import { DEFAULT_CALENDAR, type BaselineRow, type BaselineTask, type CrewOption, type JobScheduleBundle, type LoadCell, type LookaheadRow, type SchedDep, type SchedTask, type ScheduleHeader, type ScheduleJobRow, type TemplateOption, type WorkCalendar } from './types';

export const TASK_COLS =
  'id, job_id, parent_task_id, title, status, is_milestone, is_summary, sort, wbs_code, duration_days, start_on, due_on, pct_complete, ' +
  'constraint_type, constraint_date, actual_start, actual_finish, early_start, early_finish, late_start, late_finish, total_float, free_float, ' +
  'is_critical, constraint_conflict, assignee_employee_id, assigned_crew_id, assigned_vendor_id, commitment_id, hours_per_day, template_ref, cpm_at, billing_amount_cents';
/** 1100 columns only (members can't read billing_amount_cents on the base table). */
const LEGACY_COLS = 'id, job_id, parent_task_id, title, status, is_milestone, sort, duration_days, start_on, due_on, pct_complete, assignee_employee_id';
const DEP_COLS = 'pred_id, succ_id, dep_type, lag_days';
const HEADER_COLS = 'job_id, calendar_id, anchor_start, status_date, cpm_at, finish_on, critical_count';

type Res = { data: unknown; error: PgErrorLike | null };

function recs(res: Res, what: string): Rec[] {
  if (res.error) throw new PmQueryError(what, res.error);
  return Array.isArray(res.data) ? res.data.filter(isRec) : [];
}

/** Rows, or null when the 1112 object is missing (any other error throws). */
function recsOrMissing(res: Res, what: string): Rec[] | null {
  if (res.error && isMissingEngine(res.error)) return null;
  return recs(res, what);
}

async function loadTasks(db: SupabaseClient, jobId: string): Promise<{ engine: boolean; tasks: SchedTask[] }> {
  const res = await pm(db).from('v_tasks_masked').select(TASK_COLS).eq('job_id', jobId).order('sort').limit(5000);
  const rows = recsOrMissing(res as Res, 'schedule tasks');
  if (rows) return { engine: true, tasks: rows.map(toTask).filter((t): t is SchedTask => !!t) };
  const legacy = recs((await pm(db).from('tasks').select(LEGACY_COLS).eq('job_id', jobId).order('sort').limit(5000)) as Res, 'tasks');
  return { engine: false, tasks: legacy.map(toTask).filter((t): t is SchedTask => !!t) };
}

/** pm.task_deps has no job column: read by successor id in chunks (URL length), in parallel. */
export async function loadDeps(db: SupabaseClient, taskIds: ReadonlyArray<string>): Promise<SchedDep[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < taskIds.length; i += 150) chunks.push(taskIds.slice(i, i + 150));
  const parts = await Promise.all(chunks.map(async (ids) => recs((await pm(db).from('task_deps').select(DEP_COLS).in('succ_id', ids)) as Res, 'task links')));
  return parts.flat().map(toDep).filter((d): d is SchedDep => !!d);
}

async function loadHeader(db: SupabaseClient, jobId: string): Promise<ScheduleHeader | null> {
  const rows = recsOrMissing((await pm(db).from('schedules').select(HEADER_COLS).eq('job_id', jobId).limit(1)) as Res, 'schedule');
  const o = rows?.[0];
  if (!o) return null;
  return {
    job_id: jobId,
    calendar_id: str(o, 'calendar_id'),
    anchor_start: str(o, 'anchor_start'),
    status_date: str(o, 'status_date'),
    cpm_at: str(o, 'cpm_at'),
    finish_on: str(o, 'finish_on'),
    critical_count: num(o, 'critical_count'),
  };
}

/** The job's working calendar: pm.schedules.calendar_id, else pm.schedule_calendar(job) (job → company → org default). */
async function loadCalendar(db: SupabaseClient, jobId: string, calendarId: string | null): Promise<WorkCalendar> {
  let id = calendarId;
  if (!id) {
    const r = (await pm(db).rpc('schedule_calendar', { p_job: jobId })) as Res;
    if (r.error && !isMissingEngine(r.error)) throw new PmQueryError('schedule calendar', r.error);
    id = typeof r.data === 'string' ? r.data : isRec(r.data) ? str(r.data, 'id', 'calendar_id') : null;
  }
  if (!id) return DEFAULT_CALENDAR;
  const [cal, days] = await Promise.all([
    pm(db).from('work_calendars').select('id, name, workdays, hours_per_day').eq('id', id).maybeSingle(),
    pm(db).from('work_calendar_days').select('day, is_workday, name').eq('calendar_id', id).limit(3000),
  ]);
  if (cal.error && !isMissingEngine(cal.error)) throw new PmQueryError('work calendar', cal.error);
  if (!isRec(cal.data)) return DEFAULT_CALENDAR;
  const c = cal.data;
  const wd = Array.isArray(c.workdays) ? c.workdays.map(Number) : DEFAULT_CALENDAR.workdays;
  const dayRows = (recsOrMissing(days as Res, 'calendar days') ?? [])
    .map((d) => ({ day: (str(d, 'day') ?? '').slice(0, 10), is_workday: d.is_workday === true, name: str(d, 'name') }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day));
  return makeCalendar({ id, name: str(c, 'name') ?? 'Work calendar', workdays: wd.length ? wd : DEFAULT_CALENDAR.workdays, hours_per_day: num(c, 'hours_per_day') ?? 8 }, dayRows);
}

async function loadBaseline(db: SupabaseClient, jobId: string): Promise<{ baseline: BaselineRow | null; tasks: BaselineTask[] }> {
  const rows = recsOrMissing((await pm(db).from('schedule_baselines').select('*').eq('job_id', jobId).order('created_at', { ascending: false }).limit(20)) as Res, 'baselines');
  if (!rows?.length) return { baseline: null, tasks: [] };
  const active = rows.find((r) => r.is_active === true) ?? rows[0]!;
  const id = str(active, 'id');
  if (!id) return { baseline: null, tasks: [] };
  const bt = recsOrMissing((await pm(db).from('schedule_baseline_tasks').select('*').eq('baseline_id', id).limit(5000)) as Res, 'baseline tasks') ?? [];
  return {
    baseline: { id, name: str(active, 'name') ?? 'Baseline', created_at: str(active, 'created_at') },
    tasks: bt.map(toBaselineTask).filter((t): t is BaselineTask => !!t),
  };
}

export async function loadTemplates(db: SupabaseClient, companyId: string): Promise<TemplateOption[]> {
  const rows = recsOrMissing((await pm(db).from('schedule_templates').select('*').limit(200)) as Res, 'schedule templates');
  if (!rows) return [];
  return rows
    .filter((r) => r.is_active !== false && (!('location_id' in r) || r.location_id == null || r.location_id === companyId))
    .map(toTemplate)
    .filter((t): t is TemplateOption => !!t)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadCrews(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<CrewOption[]> {
  if (!companyIds.length) return [];
  const rows = recsOrMissing((await pm(db).from('crews').select('id, name, capacity_minutes_per_day, location_id').in('location_id', [...companyIds]).eq('is_active', true).order('name')) as Res, 'crews');
  return (rows ?? []).map((r) => ({ id: str(r, 'id') ?? '', name: str(r, 'name') ?? 'Crew', capacity_hours: (num(r, 'capacity_minutes_per_day') ?? 480) / 60 })).filter((c) => c.id);
}

export async function loadJobSchedule(db: SupabaseClient, job: { jobId: string; companyId: string; plannedStart: string | null }): Promise<JobScheduleBundle> {
  const [{ engine, tasks }, header] = await Promise.all([loadTasks(db, job.jobId), loadHeader(db, job.jobId)]);
  const [deps, calendar, base, crews, templates] = await Promise.all([
    loadDeps(db, tasks.map((t) => t.id)),
    engine ? loadCalendar(db, job.jobId, header?.calendar_id ?? null) : Promise.resolve(DEFAULT_CALENDAR),
    engine ? loadBaseline(db, job.jobId) : Promise.resolve({ baseline: null, tasks: [] as BaselineTask[] }),
    loadCrews(db, [job.companyId]),
    engine && tasks.length === 0 ? loadTemplates(db, job.companyId) : Promise.resolve([] as TemplateOption[]),
  ]);
  return { jobId: job.jobId, engine, tasks, deps, calendar, header, baseline: base.baseline, baselineTasks: base.tasks, crews, templates, plannedStart: job.plannedStart };
}

/** pm.v_schedule_jobs for these jobs; null when the view isn't there yet. */
export async function loadScheduleJobs(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<ScheduleJobRow[] | null> {
  if (!jobIds.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < jobIds.length; i += 150) chunks.push(jobIds.slice(i, i + 150));
  const parts = await Promise.all(chunks.map(async (ids) => recsOrMissing((await pm(db).from('v_schedule_jobs').select('*').in('job_id', ids)) as Res, 'schedule jobs')));
  if (parts.some((p) => p === null)) return null;
  return parts.flatMap((p) => p ?? []).map(toScheduleJob).filter((r): r is ScheduleJobRow => !!r);
}

/** pm.schedule_lookahead(p_from, p_days) with constraint reasons; null when the engine is missing. */
export async function loadLookahead(db: SupabaseClient, from: string, days: number): Promise<LookaheadRow[] | null> {
  const r = (await pm(db).rpc('schedule_lookahead', { p_from: from, p_days: days })) as Res;
  const rows = recsOrMissing(r, 'look-ahead');
  return rows ? rows.map(toLookahead).filter((x): x is LookaheadRow => !!x) : null;
}

/** pm.resource_load(p_from, p_to): crew / vendor × day hours; null when the engine is missing. */
export async function loadResourceLoad(db: SupabaseClient, from: string, to: string): Promise<LoadCell[] | null> {
  const r = (await pm(db).rpc('resource_load', { p_from: from, p_to: to })) as Res;
  const rows = recsOrMissing(r, 'crew load');
  return rows ? rows.map(toLoadCell).filter((x): x is LoadCell => !!x) : null;
}
