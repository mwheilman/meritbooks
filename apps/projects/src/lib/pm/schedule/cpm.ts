/**
 * Client-side mirror of pm.schedule_cpm (migration 1112) for instant ghost bars while dragging.
 * The server stays authoritative: every edit is sent, the server re-runs CPM and the Gantt
 * reconciles to its rows. `schedule-cpm.test.ts` runs this against the shared fixture cases
 * (packages/projects-access/test/fixtures/cpm-cases.json) the SQL engine is tested on.
 *
 * Model (P6-style integer boundaries on the job's working-day calendar):
 *   a task occupies working days es … ef-1 (ef = es + duration); a milestone is a point (es = ef).
 *   FS: es(s) ≥ ef(p) + lag     SS: es(s) ≥ es(p) + lag
 *   FF: ef(s) ≥ ef(p) + lag     SF: ef(s) ≥ es(p) + lag            (lag in working days)
 *   Constraints: SNET (start ≥ date), MSO (start = date, mandatory: also pins the late dates),
 *   FNLT (late finish ≤ date; a breach shows as negative float). Actual dates pin a task.
 *   A milestone with predecessors is a finish milestone (shown on the day its work ends); one
 *   without is a start milestone (shown on the day work begins).
 */
import { addWorkdays, countWorkdays, dayNum, isoOf, plusDays, workdayNumsIn } from './calendar';
import type { SchedDep, SchedTask, TaskStatus, WorkCalendar } from './types';

export type CpmInputTask = Pick<
  SchedTask,
  'id' | 'title' | 'parent_task_id' | 'status' | 'is_milestone' | 'duration_days' | 'start_on' | 'due_on' | 'pct_complete' | 'constraint_type' | 'constraint_date' | 'actual_start' | 'actual_finish'
>;

export interface CpmTaskResult {
  id: string;
  is_summary: boolean;
  duration_days: number | null;
  start_on: string | null;
  due_on: string | null;
  early_start: string | null;
  early_finish: string | null;
  late_start: string | null;
  late_finish: string | null;
  total_float: number | null;
  free_float: number | null;
  is_critical: boolean;
  constraint_conflict: boolean;
  /** Rolled up on summaries; leaves keep their own. */
  pct_complete: number | null;
  status: TaskStatus;
  actual_start: string | null;
  actual_finish: string | null;
}

export interface CpmOutput {
  results: Map<string, CpmTaskResult>;
  projectStart: string;
  projectFinish: string | null;
  criticalCount: number;
  taskCount: number;
  ignoredLinks: number;
}

/** Same token and shape as the pm.task_deps guard: `PM_DEP_CYCLE: A → B → A`. */
export class ScheduleCycleError extends Error {
  constructor(public readonly path: string[]) {
    super(`PM_DEP_CYCLE: ${path.join(' → ')}`);
    this.name = 'ScheduleCycleError';
  }
}

/** Ascending working days that can grow at both ends (mirrors the SQL array W and its extension). */
class WorkdayIndex {
  private w: number[];
  private shift = 0; // logical index i lives at w[i + shift]
  constructor(private readonly cal: WorkCalendar, from: string, to: string) {
    this.w = workdayNumsIn(cal, dayNum(from), dayNum(to));
    if (!this.w.length) this.w = [dayNum(addWorkdays(cal, from, 0))];
  }
  /** Logical count of working days < day n (the start-type ordinal). */
  ltNum(n: number): number {
    while (n <= (this.w[0] as number)) this.prepend();
    while (n > (this.w[this.w.length - 1] as number)) this.append();
    let lo = 0;
    let hi = this.w.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.w[mid] as number) < n) lo = mid + 1;
      else hi = mid;
    }
    return lo - this.shift;
  }
  lt(iso: string): number {
    return this.ltNum(dayNum(iso));
  }
  /** Logical count of working days ≤ iso (the finish-type ordinal). */
  le(iso: string): number {
    return this.ltNum(dayNum(iso) + 1);
  }
  at(i: number): string {
    while (i + this.shift < 0) this.prepend();
    while (i + this.shift >= this.w.length) this.append();
    return isoOf(this.w[i + this.shift] as number);
  }
  private prepend() {
    const first = this.w[0] as number;
    const more = workdayNumsIn(this.cal, first - Math.max(120, this.w.length), first - 1);
    this.w = more.concat(this.w);
    this.shift += more.length;
  }
  private append() {
    const last = this.w[this.w.length - 1] as number;
    this.w = this.w.concat(workdayNumsIn(this.cal, last + 1, last + Math.max(120, this.w.length)));
  }
}

const NEG = Number.NEGATIVE_INFINITY;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** The anchor CPM uses when the schedule has none yet (pm.schedule_cpm's fallback chain). */
export function resolveAnchor(tasks: ReadonlyArray<Pick<SchedTask, 'start_on' | 'actual_start' | 'constraint_date'>>, anchorStart: string | null, plannedStart: string | null, today: string): string {
  if (anchorStart) return anchorStart;
  if (plannedStart) return plannedStart;
  let min: string | null = null;
  for (const t of tasks) for (const d of [t.start_on, t.actual_start, t.constraint_date]) if (d && (!min || d < min)) min = d;
  return min ?? today;
}

/** Ids of tasks that have at least one non-cancelled child (summary rows). */
export function summaryIds(tasks: ReadonlyArray<Pick<SchedTask, 'id' | 'parent_task_id' | 'status'>>): Set<string> {
  const s = new Set<string>();
  for (const t of tasks) if (t.parent_task_id && t.status !== 'CANCELLED') s.add(t.parent_task_id);
  return s;
}

export function computeCpm(tasksIn: ReadonlyArray<CpmInputTask>, depsIn: ReadonlyArray<SchedDep>, cal: WorkCalendar, anchor: string, statusDate: string | null = null): CpmOutput {
  const summaries = summaryIds(tasksIn);
  const nodes = tasksIn.filter((t) => !summaries.has(t.id) && t.status !== 'CANCELLED');
  const n = nodes.length;
  const pos = new Map(nodes.map((t, i) => [t.id, i]));
  const jobIds = new Set(tasksIn.map((t) => t.id));
  const deps = depsIn.filter((d) => pos.has(d.pred_id) && pos.has(d.succ_id));
  const ignoredLinks = depsIn.filter((d) => (jobIds.has(d.pred_id) || jobIds.has(d.succ_id)) && !(pos.has(d.pred_id) && pos.has(d.succ_id))).length;

  // durations (legacy rows without one: working days between their dates, else 1)
  const dur = nodes.map((t) => {
    if (t.is_milestone) return 0;
    if (t.duration_days != null) return Math.max(0, t.duration_days);
    if (t.start_on && t.due_on) return Math.max(1, countWorkdays(cal, t.start_on, t.due_on));
    return 1;
  });

  // index range
  let from = anchor;
  let to = anchor;
  let total = 0;
  const widen = (d: string | null) => {
    if (!d) return;
    if (d < from) from = d;
    if (d > to) to = d;
  };
  for (let i = 0; i < n; i++) {
    const t = nodes[i]!;
    widen(t.actual_start);
    widen(t.actual_finish);
    widen(t.constraint_date);
    total += dur[i]!;
  }
  if (statusDate && statusDate > to) to = statusDate;
  // size the index for the whole job up front (calendar days ≈ 1.4 × working days)
  const W = new WorkdayIndex(cal, plusDays(from, -1), plusDays(to, 60 + Math.ceil(Math.min(total, 2600) * 1.4)));
  const P0 = W.lt(anchor);
  const dd = statusDate ? W.lt(statusDate) : null;

  const out: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Array<number>(n).fill(0);
  deps.forEach((d, e) => {
    out[pos.get(d.pred_id) as number]!.push(e);
    indeg[pos.get(d.succ_id) as number]! += 1;
  });
  const hasPred = indeg.map((x) => x > 0);
  const eSucc = deps.map((d) => pos.get(d.succ_id) as number);

  // Kahn topological order; leftovers mean a loop
  const topo: number[] = [];
  const deg = [...indeg];
  for (let i = 0; i < n; i++) if (deg[i] === 0) topo.push(i);
  for (let h = 0; h < topo.length; h++) {
    for (const e of out[topo[h] as number]!) {
      const s = eSucc[e]!;
      deg[s]! -= 1;
      if (deg[s] === 0) topo.push(s);
    }
  }
  if (topo.length < n) throw new ScheduleCycleError(findCycle(nodes, deps, pos, deg));

  const fms = (i: number) => dur[i] === 0 && hasPred[i] === true;
  const cs = (i: number, x: string) => (fms(i) ? W.le(x) : W.lt(x));
  const cf = (i: number, x: string) => (dur[i] === 0 && !hasPred[i] ? W.le(x) - 1 : W.le(x));

  const es = new Array<number>(n).fill(0);
  const ef = new Array<number>(n).fill(0);
  const cand = new Array<number>(n).fill(NEG);
  const conflict = new Array<boolean>(n).fill(false);
  const pinned = new Array<boolean>(n).fill(false); // finished (actual finish) → late = early

  for (const i of topo) {
    const t = nodes[i]!;
    const d = dur[i]!;
    if (d === 0 && (t.actual_finish || t.actual_start)) {
      const b = cs(i, (t.actual_finish ?? t.actual_start) as string);
      es[i] = b;
      ef[i] = b;
      pinned[i] = true;
    } else if (t.actual_start || t.actual_finish) {
      if (t.actual_start) {
        es[i] = W.lt(t.actual_start);
        if (t.actual_finish) ef[i] = Math.max(W.le(t.actual_finish), es[i]! + 1);
        else {
          ef[i] = es[i]! + d;
          if (dd != null) ef[i] = Math.max(ef[i]!, dd + Math.max(1, Math.ceil(Math.round(d * (1 - (t.pct_complete ?? 0)) * 1e9) / 1e9)));
        }
      } else {
        ef[i] = W.le(t.actual_finish as string);
        es[i] = ef[i]! - d;
      }
      pinned[i] = !!t.actual_finish;
    } else {
      let s = Math.max(P0, cand[i]!);
      if (dd != null) s = Math.max(s, dd);
      if (t.constraint_type === 'SNET' && t.constraint_date) s = Math.max(s, cs(i, t.constraint_date));
      if (t.constraint_type === 'MSO' && t.constraint_date) {
        const x = cs(i, t.constraint_date);
        if (cand[i]! > x) conflict[i] = true;
        s = x;
      }
      es[i] = s;
      ef[i] = s + d;
    }
    for (const e of out[i]!) {
      const dep = deps[e]!;
      const s = eSucc[e]!;
      const lag = dep.lag_days;
      const v = dep.dep_type === 'FS' ? ef[i]! + lag : dep.dep_type === 'SS' ? es[i]! + lag : dep.dep_type === 'FF' ? ef[i]! + lag - dur[s]! : es[i]! + lag - dur[s]!;
      if (v > cand[s]!) cand[s] = v;
    }
  }

  const PF = n ? Math.max(...ef) : P0;
  const ls = new Array<number>(n).fill(0);
  const lf = new Array<number>(n).fill(0);
  const tf = new Array<number>(n).fill(0);
  const ff = new Array<number>(n).fill(0);
  for (let k = topo.length - 1; k >= 0; k--) {
    const i = topo[k]!;
    const t = nodes[i]!;
    const d = dur[i]!;
    let l = PF;
    let f = Number.POSITIVE_INFINITY;
    for (const e of out[i]!) {
      const dep = deps[e]!;
      const s = eSucc[e]!;
      const lag = dep.lag_days;
      const v = dep.dep_type === 'FS' ? ls[s]! - lag : dep.dep_type === 'SS' ? ls[s]! - lag + d : dep.dep_type === 'FF' ? lf[s]! - lag : lf[s]! - lag + d;
      if (v < l) l = v;
      const slack = dep.dep_type === 'FS' ? es[s]! - lag - ef[i]! : dep.dep_type === 'SS' ? es[s]! - lag - es[i]! : dep.dep_type === 'FF' ? ef[s]! - lag - ef[i]! : ef[s]! - lag - es[i]!;
      if (slack < f) f = slack;
    }
    if (!out[i]!.length) f = PF - ef[i]!;
    if (t.constraint_type === 'FNLT' && t.constraint_date) {
      const x = cf(i, t.constraint_date);
      if (x < l) l = x;
      if (ef[i]! > x) conflict[i] = true;
    }
    if (t.constraint_type === 'MSO' && t.constraint_date && !t.actual_start && !t.actual_finish && ef[i]! < l) l = ef[i]!;
    if (pinned[i]) l = ef[i]!;
    lf[i] = l;
    ls[i] = l - d;
    tf[i] = l - ef[i]!;
    ff[i] = Math.min(f, tf[i]!);
  }

  const results = new Map<string, CpmTaskResult>();
  const disp = (i: number, b: number) => (fms(i) ? W.at(Math.max(b - 1, P0)) : W.at(b));
  let critical = 0;
  nodes.forEach((t, i) => {
    const d = dur[i]!;
    const done = pinned[i] || t.status === 'DONE';
    const isCrit = tf[i]! <= 0 && !done;
    if (isCrit) critical++;
    let s: string, f: string, lsD: string, lfD: string;
    if (d === 0) {
      s = f = disp(i, es[i]!);
      lsD = lfD = disp(i, ls[i]!);
    } else {
      s = W.at(es[i]!);
      f = W.at(ef[i]! - 1);
      lsD = W.at(ls[i]!);
      lfD = W.at(lf[i]! - 1);
    }
    const milestoneActual = d === 0 ? t.actual_finish ?? t.actual_start : null;
    results.set(t.id, {
      id: t.id,
      is_summary: false,
      duration_days: d,
      start_on: milestoneActual ?? t.actual_start ?? s,
      due_on: milestoneActual ?? t.actual_finish ?? f,
      early_start: s,
      early_finish: f,
      late_start: lsD,
      late_finish: lfD,
      total_float: tf[i]!,
      free_float: ff[i]!,
      is_critical: isCrit,
      constraint_conflict: conflict[i]!,
      pct_complete: t.pct_complete,
      status: t.status,
      actual_start: t.actual_start,
      actual_finish: t.actual_finish,
    });
  });

  // cancelled leaves are outside the network: kept with their own dates, no CPM values (as the SQL engine writes them)
  for (const t of tasksIn) {
    if (t.status !== 'CANCELLED' || summaries.has(t.id)) continue;
    results.set(t.id, {
      id: t.id, is_summary: false, duration_days: t.is_milestone ? 0 : t.duration_days, start_on: t.actual_start ?? t.start_on, due_on: t.actual_finish ?? t.due_on,
      early_start: null, early_finish: null, late_start: null, late_finish: null, total_float: null, free_float: null,
      is_critical: false, constraint_conflict: false, pct_complete: t.pct_complete, status: t.status, actual_start: t.actual_start, actual_finish: t.actual_finish,
    });
  }

  // summary rollup, deepest first
  const byId = new Map(tasksIn.map((t) => [t.id, t]));
  const kidsOf = new Map<string, string[]>();
  for (const t of tasksIn) {
    if (!t.parent_task_id || t.status === 'CANCELLED') continue;
    const list = kidsOf.get(t.parent_task_id);
    if (list) list.push(t.id);
    else kidsOf.set(t.parent_task_id, [t.id]);
  }
  const depthOf = (id: string): number => {
    let k = 0;
    let p = byId.get(id)?.parent_task_id ?? null;
    while (p && k < 64) {
      k++;
      p = byId.get(p)?.parent_task_id ?? null;
    }
    return k;
  };
  const order = [...summaries].filter((id) => byId.has(id)).sort((a, b) => depthOf(b) - depthOf(a));
  for (const sid of order) {
    const kids = (kidsOf.get(sid) ?? []).map((c) => results.get(c)).filter((r): r is CpmTaskResult => !!r);
    const own = byId.get(sid)!;
    if (!kids.length) continue;
    const mn = (xs: Array<string | null>) => xs.reduce<string | null>((a, x) => (x && (!a || x < a) ? x : a), null);
    const mx = (xs: Array<string | null>) => xs.reduce<string | null>((a, x) => (x && (!a || x > a) ? x : a), null);
    const s = mn(kids.map((k) => k.start_on));
    const f = mx(kids.map((k) => k.due_on));
    const w = kids.map((k) => Math.max(k.duration_days ?? 0, 0));
    const sw = w.reduce((a, x) => a + x, 0);
    const pct = sw > 0 ? kids.reduce((a, k, j) => a + (k.pct_complete ?? 0) * w[j]!, 0) / sw : kids.reduce((a, k) => a + (k.pct_complete ?? 0), 0) / kids.length;
    const allDone = kids.every((k) => k.status === 'DONE');
    const started = kids.some((k) => k.status === 'IN_PROGRESS' || k.status === 'DONE' || !!k.actual_start);
    const tfs = kids.map((k) => k.total_float).filter((x): x is number => x != null);
    const ffs = kids.map((k) => k.free_float).filter((x): x is number => x != null);
    results.set(sid, {
      id: sid,
      is_summary: true,
      duration_days: s && f ? Math.max(0, W.le(f) - W.lt(s)) : null,
      start_on: s,
      due_on: f,
      early_start: mn(kids.map((k) => k.early_start)),
      early_finish: mx(kids.map((k) => k.early_finish)),
      late_start: mn(kids.map((k) => k.late_start)),
      late_finish: mx(kids.map((k) => k.late_finish)),
      total_float: tfs.length ? Math.min(...tfs) : null,
      free_float: ffs.length ? Math.min(...ffs) : null,
      is_critical: kids.some((k) => k.is_critical),
      constraint_conflict: kids.some((k) => k.constraint_conflict),
      pct_complete: round4(pct),
      status: own.status === 'CANCELLED' ? 'CANCELLED' : allDone ? 'DONE' : started ? 'IN_PROGRESS' : 'TODO',
      actual_start: mn(kids.map((k) => k.actual_start)),
      actual_finish: kids.every((k) => k.actual_finish) ? mx(kids.map((k) => k.actual_finish)) : null,
    });
  }

  let projectFinish: string | null = null;
  for (const r of results.values()) if (!r.is_summary && r.status !== 'CANCELLED' && r.due_on && (!projectFinish || r.due_on > projectFinish)) projectFinish = r.due_on;
  return { results, projectStart: W.at(P0), projectFinish: n ? projectFinish : null, criticalCount: critical, taskCount: n, ignoredLinks };
}

function findCycle(nodes: ReadonlyArray<CpmInputTask>, deps: ReadonlyArray<SchedDep>, pos: Map<string, number>, deg: number[]): string[] {
  // every node left with deg > 0 has a predecessor that is also left: walk backwards until a repeat
  let x = deg.findIndex((v) => v > 0);
  const seen = new Map<number, number>();
  const walk: number[] = [];
  while (x >= 0 && !seen.has(x)) {
    seen.set(x, walk.length);
    walk.push(x);
    const e = deps.find((d) => pos.get(d.succ_id) === x && (deg[pos.get(d.pred_id) as number] ?? 0) > 0);
    x = e ? (pos.get(e.pred_id) as number) : -1;
  }
  const loop = x >= 0 ? walk.slice(seen.get(x)) : walk;
  const names = loop.reverse().map((i) => nodes[i]!.title);
  return [...names, names[0] ?? ''];
}

/** computeCpm, or the loop it found (a schedule loaded with a loop still renders). */
export function tryCpm(tasks: ReadonlyArray<CpmInputTask>, deps: ReadonlyArray<SchedDep>, cal: WorkCalendar, anchor: string, statusDate: string | null = null): { ok: true; out: CpmOutput } | { ok: false; cycle: string[] } {
  try {
    return { ok: true, out: computeCpm(tasks, deps, cal, anchor, statusDate) };
  } catch (e) {
    if (e instanceof ScheduleCycleError) return { ok: false, cycle: e.path };
    throw e;
  }
}

export interface MoveEdit {
  taskId: string;
  /** New start (a drag of the middle); null keeps the start. */
  start: string | null;
  /** New duration in working days (a drag of the right edge); null keeps it. */
  duration: number | null;
}

/**
 * The schedule as it would be after a move/resize, the way pm.reschedule_task models it: a new
 * start becomes a start-no-earlier-than constraint (a must-start-on keeps its type and takes the
 * date); a new duration replaces the duration. Predecessors still win over the dragged start.
 */
export function applyMove<T extends CpmInputTask>(tasks: ReadonlyArray<T>, edit: MoveEdit): T[] {
  return tasks.map((t) => {
    if (t.id !== edit.taskId) return t;
    const next: T = { ...t };
    if (edit.duration != null && !t.is_milestone) next.duration_days = Math.max(1, Math.round(edit.duration));
    if (edit.start) {
      next.constraint_type = t.constraint_type === 'MSO' ? 'MSO' : 'SNET';
      next.constraint_date = edit.start;
    }
    return next;
  });
}

export interface CpmDiff {
  /** Ids whose start or finish changed (leaves and summaries). */
  changed: string[];
  /** Leaf tasks that moved, the count the toast reports. */
  movedLeaves: number;
  finishBefore: string | null;
  finishAfter: string | null;
}

export function diffCpm(before: CpmOutput, after: CpmOutput): CpmDiff {
  const changed: string[] = [];
  let movedLeaves = 0;
  for (const [id, a] of after.results) {
    const b = before.results.get(id);
    if (!b || b.start_on !== a.start_on || b.due_on !== a.due_on) {
      changed.push(id);
      if (!a.is_summary) movedLeaves++;
    }
  }
  return { changed, movedLeaves, finishBefore: before.projectFinish, finishAfter: after.projectFinish };
}

/**
 * Would linking pred → succ close a loop? Returns the loop as ids (pred → succ → … → pred), or
 * null. Checked before the link is sent so the refusal is instant and names the loop.
 */
export function findLinkCycle(deps: ReadonlyArray<Pick<SchedDep, 'pred_id' | 'succ_id'>>, pred: string, succ: string): string[] | null {
  if (pred === succ) return [pred, pred];
  const out = new Map<string, string[]>();
  for (const d of deps) {
    const list = out.get(d.pred_id);
    if (list) list.push(d.succ_id);
    else out.set(d.pred_id, [d.succ_id]);
  }
  // BFS from succ along existing links; reaching pred means pred → succ ⇝ pred
  const from = new Map<string, string>();
  const queue = [succ];
  const seen = new Set([succ]);
  for (let h = 0; h < queue.length; h++) {
    const x = queue[h] as string;
    if (x === pred) {
      const path = [pred];
      let k = pred;
      while (k !== succ) {
        k = from.get(k) as string;
        path.push(k);
      }
      return [pred, ...path.reverse()];
    }
    for (const y of out.get(x) ?? []) {
      if (seen.has(y)) continue;
      seen.add(y);
      from.set(y, x);
      queue.push(y);
    }
  }
  return null;
}

/** "These links make a loop: Frame → Rough-in → Frame. Remove one of them." */
export function cycleMessage(names: ReadonlyArray<string>): string {
  return `These links make a loop: ${names.join(' → ')}. Remove one of them.`;
}
