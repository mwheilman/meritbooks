/**
 * Scheduling types shared by the loaders, the API routes, the Gantt and the client CPM.
 * Column names follow WAVE1-SCHEDULE-SPEC §2 (migration 1112_pm_schedule.sql) exactly:
 * pm.tasks additive columns, pm.task_deps, pm.schedules, pm.work_calendars / work_calendar_days,
 * pm.schedule_baselines / schedule_baseline_tasks, pm.schedule_templates.
 * Client-safe (no server imports).
 */
import type { TaskStatus } from '../types';

export type { TaskStatus };

export type DepType = 'FS' | 'SS' | 'FF' | 'SF';
export const DEP_TYPES: readonly DepType[] = ['FS', 'SS', 'FF', 'SF'];

export type ConstraintType = 'ASAP' | 'SNET' | 'FNLT' | 'MSO';
export const CONSTRAINT_TYPES: readonly ConstraintType[] = ['ASAP', 'SNET', 'FNLT', 'MSO'];
export const CONSTRAINT_LABEL: Readonly<Record<ConstraintType, string>> = {
  ASAP: 'As soon as possible',
  SNET: 'Start no earlier than',
  FNLT: 'Finish no later than',
  MSO: 'Must start on',
};

/** Lag bounds the pm.task_deps guard enforces (spec §2). */
export const LAG_MIN = -365;
export const LAG_MAX = 365;

/** pm.tasks as the scheduler reads it (pm.v_tasks_masked). Dates are ISO days ("2026-11-16"). */
export interface SchedTask {
  id: string;
  job_id: string;
  parent_task_id: string | null;
  title: string;
  status: TaskStatus;
  is_milestone: boolean;
  is_summary: boolean;
  sort: number;
  wbs_code: string | null;
  /** Working days. */
  duration_days: number | null;
  start_on: string | null;
  due_on: string | null;
  /** 0..1 */
  pct_complete: number | null;
  constraint_type: ConstraintType;
  constraint_date: string | null;
  actual_start: string | null;
  actual_finish: string | null;
  early_start: string | null;
  early_finish: string | null;
  late_start: string | null;
  late_finish: string | null;
  /** Working days. */
  total_float: number | null;
  free_float: number | null;
  is_critical: boolean;
  constraint_conflict: boolean;
  assignee_employee_id: string | null;
  assigned_crew_id: string | null;
  assigned_vendor_id: string | null;
  commitment_id: string | null;
  hours_per_day: number | null;
  template_ref: string | null;
  cpm_at: string | null;
  /** Masked (null) unless the caller holds projects.contract_value at the job's company. */
  billing_amount_cents: number | null;
}

/** pm.task_deps */
export interface SchedDep {
  pred_id: string;
  succ_id: string;
  dep_type: DepType;
  lag_days: number;
}

/** pm.work_calendars (+ its pm.work_calendar_days exceptions). */
export interface WorkCalendar {
  id: string | null;
  name: string;
  /** ISO weekdays that are working days: 1 = Monday … 7 = Sunday. */
  workdays: number[];
  hours_per_day: number;
  /** Exceptions: a holiday (false) or a working day off the normal week (true). */
  exceptions: Record<string, boolean>;
  /** Names of exception days ("Thanksgiving"), for the shading tooltip. */
  names?: Record<string, string>;
}

export const DEFAULT_CALENDAR: WorkCalendar = { id: null, name: 'Monday to Friday', workdays: [1, 2, 3, 4, 5], hours_per_day: 8, exceptions: {} };

/** pm.schedules (one per job). */
export interface ScheduleHeader {
  job_id: string;
  calendar_id: string | null;
  anchor_start: string | null;
  status_date: string | null;
  cpm_at: string | null;
  finish_on: string | null;
  critical_count: number | null;
}

export interface BaselineRow {
  id: string;
  name: string;
  created_at: string | null;
}

export interface BaselineTask {
  task_id: string;
  start_on: string | null;
  due_on: string | null;
  duration_days: number | null;
}

export interface TemplateOption {
  id: string;
  name: string;
  description: string | null;
  task_count: number | null;
  /** Job types the template is made for (pm.schedule_templates.job_type_keys). */
  job_type_keys: string[];
}

export interface CrewOption {
  id: string;
  name: string;
  /** Hours a day the crew can work (capacity_minutes_per_day / 60). */
  capacity_hours: number;
}

export type ScheduleView = 'gantt' | 'list';
export type Zoom = 'day' | 'week' | 'month';

/** Everything the job Gantt needs (GET /api/jobs/[jobId]/schedule and the job page loader). */
export interface JobScheduleBundle {
  jobId: string;
  /** False until migration 1112 is applied: the Gantt then runs read-only on the client CPM. */
  engine: boolean;
  tasks: SchedTask[];
  deps: SchedDep[];
  calendar: WorkCalendar;
  header: ScheduleHeader | null;
  baseline: BaselineRow | null;
  baselineTasks: BaselineTask[];
  crews: CrewOption[];
  templates: TemplateOption[];
  plannedStart: string | null;
}

/** One changed row from pm.reschedule_task / pm.preview_reschedule. */
export interface RescheduleChange {
  id: string;
  start_on: string | null;
  due_on: string | null;
  early_start?: string | null;
  early_finish?: string | null;
  late_start?: string | null;
  late_finish?: string | null;
  total_float?: number | null;
  free_float?: number | null;
  is_critical?: boolean;
  duration_days?: number | null;
}

/** pm.reschedule_task / pm.preview_reschedule result (spec §2). */
export interface RescheduleResult {
  changed: RescheduleChange[];
  finish_before: string | null;
  finish_after: string | null;
  moved_count: number;
}

/** pm.v_schedule_jobs, one row per job (normalised by the loader). */
export interface ScheduleJobRow {
  job_id: string;
  start_on: string | null;
  finish_on: string | null;
  baseline_finish: string | null;
  task_count: number;
  open_count: number;
  critical_count: number;
  pct_complete: number | null;
  late_count: number;
}

export type ConstraintKind = 'submittal' | 'material' | 'predecessor' | 'other';

export interface LookaheadConstraint {
  kind: ConstraintKind;
  label: string;
}

/** pm.schedule_lookahead(p_from, p_days), normalised. */
export interface LookaheadRow {
  task_id: string;
  job_id: string;
  title: string;
  start_on: string | null;
  due_on: string | null;
  status: TaskStatus;
  pct_complete: number | null;
  crew_id: string | null;
  crew_name: string | null;
  trade: string | null;
  is_critical: boolean;
  constraints: LookaheadConstraint[];
}

/** pm.resource_load(p_from, p_to), normalised: one resource on one day. */
export interface LoadCell {
  resource_kind: 'crew' | 'vendor' | 'employee';
  resource_id: string;
  resource_name: string;
  day: string;
  hours: number;
  capacity_hours: number;
  task_count: number;
}
