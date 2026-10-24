/**
 * Normalisers for rows and RPC results from the 1112 engine. Views and set-returning functions
 * are read defensively (a renamed column degrades one field, never the page). Pure.
 */
import { isDepType } from './links';
import { CONSTRAINT_TYPES, type BaselineTask, type ConstraintKind, type ConstraintType, type LoadCell, type LookaheadConstraint, type LookaheadRow, type RescheduleChange, type RescheduleResult, type SchedDep, type SchedTask, type ScheduleJobRow, type TaskStatus, type TemplateOption } from './types';

export type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(o: Rec, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

export function num(o: Rec, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

export function bool(o: Rec, ...keys: string[]): boolean {
  for (const k of keys) if (typeof o[k] === 'boolean') return o[k] as boolean;
  return false;
}

/** "2026-11-16T00:00:00" → "2026-11-16" */
export function day(o: Rec, ...keys: string[]): string | null {
  const s = str(o, ...keys);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

const STATUSES: readonly TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'];

export function toTask(o: Rec): SchedTask | null {
  const id = str(o, 'id');
  const job = str(o, 'job_id');
  if (!id || !job) return null;
  const st = str(o, 'status');
  const ct = str(o, 'constraint_type');
  return {
    id,
    job_id: job,
    parent_task_id: str(o, 'parent_task_id'),
    title: str(o, 'title') ?? 'Untitled task',
    status: st && (STATUSES as readonly string[]).includes(st) ? (st as TaskStatus) : 'TODO',
    is_milestone: bool(o, 'is_milestone'),
    is_summary: bool(o, 'is_summary'),
    sort: num(o, 'sort') ?? 0,
    wbs_code: str(o, 'wbs_code'),
    duration_days: num(o, 'duration_days'),
    start_on: day(o, 'start_on'),
    due_on: day(o, 'due_on'),
    pct_complete: num(o, 'pct_complete'),
    constraint_type: ct && (CONSTRAINT_TYPES as readonly string[]).includes(ct) ? (ct as ConstraintType) : 'ASAP',
    constraint_date: day(o, 'constraint_date'),
    actual_start: day(o, 'actual_start'),
    actual_finish: day(o, 'actual_finish'),
    early_start: day(o, 'early_start'),
    early_finish: day(o, 'early_finish'),
    late_start: day(o, 'late_start'),
    late_finish: day(o, 'late_finish'),
    total_float: num(o, 'total_float'),
    free_float: num(o, 'free_float'),
    is_critical: bool(o, 'is_critical'),
    constraint_conflict: bool(o, 'constraint_conflict'),
    assignee_employee_id: str(o, 'assignee_employee_id'),
    assigned_crew_id: str(o, 'assigned_crew_id'),
    assigned_vendor_id: str(o, 'assigned_vendor_id'),
    commitment_id: str(o, 'commitment_id'),
    hours_per_day: num(o, 'hours_per_day'),
    template_ref: str(o, 'template_ref'),
    cpm_at: str(o, 'cpm_at'),
    billing_amount_cents: num(o, 'billing_amount_cents'),
  };
}

export function toDep(o: Rec): SchedDep | null {
  const p = str(o, 'pred_id');
  const s = str(o, 'succ_id');
  const t = o.dep_type;
  if (!p || !s) return null;
  return { pred_id: p, succ_id: s, dep_type: isDepType(t) ? t : 'FS', lag_days: num(o, 'lag_days') ?? 0 };
}

export function toChange(o: Rec): RescheduleChange | null {
  const id = str(o, 'id', 'task_id');
  if (!id) return null;
  const c: RescheduleChange = { id, start_on: day(o, 'start_on'), due_on: day(o, 'due_on') };
  for (const k of ['early_start', 'early_finish', 'late_start', 'late_finish'] as const) if (k in o) c[k] = day(o, k);
  if ('total_float' in o) c.total_float = num(o, 'total_float');
  if ('free_float' in o) c.free_float = num(o, 'free_float');
  if ('is_critical' in o) c.is_critical = bool(o, 'is_critical');
  if ('duration_days' in o) c.duration_days = num(o, 'duration_days');
  return c;
}

/** pm.reschedule_task / pm.preview_reschedule jsonb. */
export function toReschedule(v: unknown): RescheduleResult {
  const o = isRec(v) ? v : {};
  const changed = Array.isArray(o.changed) ? o.changed.filter(isRec).map(toChange).filter((c): c is RescheduleChange => !!c) : [];
  return {
    changed,
    finish_before: day(o, 'finish_before'),
    finish_after: day(o, 'finish_after'),
    moved_count: num(o, 'moved_count') ?? changed.length,
  };
}

export function toBaselineTask(o: Rec): BaselineTask | null {
  const id = str(o, 'task_id');
  if (!id) return null;
  return { task_id: id, start_on: day(o, 'start_on', 'baseline_start'), due_on: day(o, 'due_on', 'finish_on', 'baseline_finish'), duration_days: num(o, 'duration_days') };
}

export function toTemplate(o: Rec): TemplateOption | null {
  const id = str(o, 'id');
  const name = str(o, 'name', 'label', 'title');
  if (!id || !name) return null;
  const keys = Array.isArray(o.job_type_keys) ? o.job_type_keys.filter((k): k is string => typeof k === 'string') : [];
  const tasks = Array.isArray(o.tasks) ? o.tasks.length : null;
  const one = str(o, 'job_type_key');
  return { id, name, description: str(o, 'description'), task_count: num(o, 'task_count') ?? tasks, job_type_keys: one && !keys.includes(one) ? [one, ...keys] : keys };
}

export function toScheduleJob(o: Rec): ScheduleJobRow | null {
  const id = str(o, 'job_id');
  if (!id) return null;
  return {
    job_id: id,
    start_on: day(o, 'start_on', 'project_start', 'early_start'),
    finish_on: day(o, 'finish_on', 'project_finish', 'early_finish'),
    baseline_finish: day(o, 'baseline_finish', 'baseline_finish_on'),
    task_count: num(o, 'task_count', 'tasks_total') ?? 0,
    open_count: num(o, 'open_count', 'tasks_open') ?? 0,
    critical_count: num(o, 'critical_count') ?? 0,
    pct_complete: num(o, 'pct_complete'),
    late_count: num(o, 'late_count', 'overdue_count', 'tasks_overdue') ?? 0,
  };
}

const KIND_WORDS: ReadonlyArray<[RegExp, ConstraintKind, string]> = [
  [/submittal/i, 'submittal', 'Submittal not approved'],
  [/material|procure|deliver|receiv/i, 'material', 'Material not received'],
  [/pred|depend/i, 'predecessor', 'Predecessor not done'],
];

/** A constraint reason as text ("submittal_not_approved") or {kind,label}. */
export function toConstraint(v: unknown): LookaheadConstraint | null {
  if (typeof v === 'string' && v.trim()) {
    for (const [re, kind, label] of KIND_WORDS) if (re.test(v)) return { kind, label: /[a-z]_[a-z]/.test(v) || v === v.toUpperCase() ? label : v };
    return { kind: 'other', label: v.replace(/_/g, ' ') };
  }
  if (isRec(v)) {
    const raw = str(v, 'kind', 'type', 'code', 'reason') ?? '';
    const label = str(v, 'label', 'detail', 'message', 'text');
    const base = toConstraint(raw);
    if (!base && !label) return null;
    return { kind: base?.kind ?? 'other', label: label ?? base?.label ?? raw };
  }
  return null;
}

export function toLookahead(o: Rec): LookaheadRow | null {
  const id = str(o, 'task_id', 'id');
  const job = str(o, 'job_id');
  if (!id || !job) return null;
  const st = str(o, 'status');
  const raw = o.constraints ?? o.constraint_reasons ?? o.reasons;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[;,]/) : [];
  return {
    task_id: id,
    job_id: job,
    title: str(o, 'title', 'task_title') ?? 'Untitled task',
    start_on: day(o, 'start_on'),
    due_on: day(o, 'due_on', 'finish_on'),
    status: st && (STATUSES as readonly string[]).includes(st) ? (st as TaskStatus) : 'TODO',
    pct_complete: num(o, 'pct_complete'),
    crew_id: str(o, 'crew_id', 'assigned_crew_id'),
    crew_name: str(o, 'crew_name', 'crew'),
    trade: str(o, 'trade', 'cost_code_name', 'trade_name', 'vendor_name'),
    is_critical: bool(o, 'is_critical'),
    constraints: list.map(toConstraint).filter((c): c is LookaheadConstraint => !!c),
  };
}

export function toLoadCell(o: Rec): LoadCell | null {
  const id = str(o, 'resource_id', 'crew_id', 'vendor_id', 'employee_id');
  const d = day(o, 'day', 'on_day', 'date', 'work_date');
  if (!id || !d) return null;
  const kindRaw = (str(o, 'resource_kind', 'kind', 'resource_type') ?? (o.crew_id ? 'crew' : o.vendor_id ? 'vendor' : 'employee')).toLowerCase();
  const kind: LoadCell['resource_kind'] = kindRaw.startsWith('crew') ? 'crew' : kindRaw.startsWith('vendor') ? 'vendor' : 'employee';
  const cap = num(o, 'capacity_hours', 'capacity');
  const capMin = num(o, 'capacity_minutes');
  return {
    resource_kind: kind,
    resource_id: id,
    resource_name: str(o, 'resource_name', 'name', 'crew_name', 'vendor_name') ?? 'Unnamed',
    day: d,
    hours: num(o, 'hours', 'load_hours', 'planned_hours') ?? 0,
    capacity_hours: cap ?? (capMin != null ? capMin / 60 : 8),
    task_count: num(o, 'task_count', 'tasks') ?? 0,
  };
}

/** PostgREST / Postgres codes meaning "the 1112 engine isn't in this database yet". */
const MISSING = new Set(['42703', '42P01', '42883', 'PGRST200', 'PGRST202', 'PGRST204', 'PGRST205']);

export function isMissingEngine(err: { code?: string | null } | null | undefined): boolean {
  return !!err && !!err.code && MISSING.has(err.code);
}
