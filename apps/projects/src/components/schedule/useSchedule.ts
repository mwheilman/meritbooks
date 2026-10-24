'use client';

/**
 * The job Gantt's data: tasks and links as the server last returned them, the outline, the
 * local CPM (ghost bars, and the drawing when the engine isn't on yet), and one mutation path
 * to /api/jobs/[jobId]/schedule that reconciles to the server's rows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiResponse } from '@meritbooks/merit-ui';
import { resolveAnchor, tryCpm, type CpmInputTask, type CpmOutput } from '@/lib/pm/schedule/cpm';
import { buildOutline, visibleOutline, type OutlineRow } from '@/lib/pm/schedule/tree';
import type { JobScheduleBundle, RescheduleResult, SchedDep, SchedTask } from '@/lib/pm/schedule/types';

export type ScheduleOp =
  | { op: 'cpm' }
  | { op: 'reschedule' | 'preview'; taskId: string; start: string | null; duration: number | null }
  | { op: 'links'; taskId: string; links: Array<{ pred_id: string; dep_type: string; lag_days: number }> }
  | { op: 'indent'; taskId: string; direction: 'in' | 'out' }
  | { op: 'order'; taskId: string; afterTaskId: string | null }
  | { op: 'baseline'; name: string }
  | { op: 'template'; templateId: string; start: string }
  | { op: 'create'; title: string; afterTaskId: string | null; parentId: string | null; duration?: number; isMilestone?: boolean }
  | { op: 'update'; taskId: string; patch: Partial<Pick<SchedTask, 'title' | 'status' | 'pct_complete' | 'actual_start' | 'actual_finish' | 'assigned_crew_id' | 'constraint_type' | 'constraint_date' | 'is_milestone'>> }
  | { op: 'delete'; taskId: string };

export interface OpResponse {
  tasks?: SchedTask[];
  deps?: SchedDep[];
  result?: RescheduleResult;
  taskId?: string;
  baseline?: unknown;
}

/**
 * CPM inputs from the tasks as drawn. A task with no predecessors keeps its drawn start
 * (start-no-earlier-than its start) so the local pass reproduces the server's dates and only
 * the dragged task's successors move in a ghost preview.
 */
export function cpmInputs(tasks: ReadonlyArray<SchedTask>, deps: ReadonlyArray<SchedDep>): CpmInputTask[] {
  const hasPred = new Set(deps.map((d) => d.succ_id));
  return tasks.map((t) =>
    t.constraint_type === 'ASAP' && t.start_on && !hasPred.has(t.id) && !t.actual_start ? { ...t, constraint_type: 'SNET', constraint_date: t.start_on } : t,
  );
}

/** Tasks as drawn: the server's dates; the local CPM fills rows the server hasn't scheduled. */
export function drawnTasks(tasks: ReadonlyArray<SchedTask>, local: CpmOutput | null, engine: boolean, summaries: ReadonlySet<string>): SchedTask[] {
  return tasks.map((t) => {
    const r = local?.results.get(t.id);
    const isSum = t.is_summary || summaries.has(t.id);
    if (!r) return isSum === t.is_summary ? t : { ...t, is_summary: isSum };
    if (engine && t.start_on && t.due_on && t.cpm_at && !isSum) return t;
    return {
      ...t,
      is_summary: isSum,
      start_on: r.start_on,
      due_on: r.due_on,
      duration_days: isSum ? r.duration_days : t.duration_days ?? r.duration_days,
      early_start: r.early_start,
      early_finish: r.early_finish,
      late_start: r.late_start,
      late_finish: r.late_finish,
      total_float: r.total_float,
      free_float: r.free_float,
      is_critical: r.is_critical,
      constraint_conflict: r.constraint_conflict,
      pct_complete: isSum ? r.pct_complete : t.pct_complete,
    };
  });
}

export function useSchedule(bundle: JobScheduleBundle, today: string, canEdit: boolean) {
  const [tasks, setTasks] = useState<SchedTask[]>(bundle.tasks);
  const [deps, setDeps] = useState<SchedDep[]>(bundle.deps);
  const [busy, setBusy] = useState<string | null>(null);
  const url = `/api/jobs/${bundle.jobId}/schedule`;
  const cal = bundle.calendar;
  const statusDate = bundle.header?.status_date ?? null;

  useEffect(() => {
    setTasks(bundle.tasks);
    setDeps(bundle.deps);
  }, [bundle]);

  const anchor = useMemo(() => resolveAnchor(tasks, bundle.header?.anchor_start ?? null, bundle.plannedStart, today), [tasks, bundle.header, bundle.plannedStart, today]);
  const outlineAll = useMemo(() => buildOutline(tasks), [tasks]);
  const summaries = useMemo(() => new Set(outlineAll.filter((r) => r.hasChildren).map((r) => r.task.id)), [outlineAll]);
  const local = useMemo(() => tryCpm(cpmInputs(tasks, deps), deps, cal, anchor, statusDate), [tasks, deps, cal, anchor, statusDate]);
  const localOut = local.ok ? local.out : null;
  const shown = useMemo(() => drawnTasks(tasks, localOut, bundle.engine, summaries), [tasks, localOut, bundle.engine, summaries]);
  const outline: OutlineRow[] = useMemo(() => {
    const byId = new Map(shown.map((t) => [t.id, t]));
    return outlineAll.map((r) => ({ ...r, task: byId.get(r.task.id) ?? r.task }));
  }, [outlineAll, shown]);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => visibleOutline(outline, collapsed), [outline, collapsed]);
  const toggle = useCallback((id: string) => {
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const inflight = useRef(0);
  const send = useCallback(
    async (body: ScheduleOp, key = body.op): Promise<ApiResponse<OpResponse>> => {
      inflight.current += 1;
      setBusy(key);
      const res = await api.post<OpResponse>(url, body);
      inflight.current -= 1;
      if (inflight.current === 0) setBusy(null);
      const d = res.data;
      if (d?.tasks) setTasks(d.tasks);
      if (d?.deps) setDeps(d.deps);
      if (d?.result?.changed.length) {
        const ch = new Map(d.result.changed.map((c) => [c.id, c]));
        setTasks((ts) =>
          ts.map((t) => {
            const c = ch.get(t.id);
            if (!c) return t;
            const next: SchedTask = { ...t, start_on: c.start_on, due_on: c.due_on, cpm_at: t.cpm_at ?? new Date().toISOString() };
            if (c.early_start !== undefined) next.early_start = c.early_start;
            if (c.early_finish !== undefined) next.early_finish = c.early_finish;
            if (c.late_start !== undefined) next.late_start = c.late_start;
            if (c.late_finish !== undefined) next.late_finish = c.late_finish;
            if (c.total_float !== undefined) next.total_float = c.total_float;
            if (c.free_float !== undefined) next.free_float = c.free_float;
            if (c.is_critical !== undefined) next.is_critical = c.is_critical;
            if (c.duration_days !== undefined) next.duration_days = c.duration_days;
            return next;
          }),
        );
      }
      return res;
    },
    [url],
  );

  /** Re-read the job's rows from the server (after an error, so the drawing matches the truth). */
  const reload = useCallback(async () => {
    const res = await api.get<JobScheduleBundle>(url);
    if (res.data) {
      setTasks(res.data.tasks);
      setDeps(res.data.deps);
    }
    return res;
  }, [url]);

  // A schedule the engine has never scheduled (tasks from before 1112): run CPM once.
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current || !bundle.engine || !canEdit || !bundle.tasks.length) return;
    if (bundle.tasks.every((t) => t.cpm_at)) return;
    ran.current = true;
    void send({ op: 'cpm' }, 'cpm');
  }, [bundle, canEdit, send]);

  return { tasks, deps, shown, outline, rows, collapsed, toggle, local, localOut, anchor, statusDate, cal, send, reload, busy, setTasks, setDeps };
}

export type ScheduleState = ReturnType<typeof useSchedule>;
