/**
 * The client CPM (lib/pm/schedule/cpm.ts) against fixture cases: this app's own, and the shared
 * cases the SQL engine (pm.schedule_cpm, migration 1112) is tested on when that file exists at
 * packages/projects-access/test/fixtures/cpm-cases.json. Plus loop detection and the drag preview.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeCalendar } from '@/lib/pm/schedule/calendar';
import { applyMove, computeCpm, cycleMessage, diffCpm, findLinkCycle, ScheduleCycleError, tryCpm, type CpmInputTask } from '@/lib/pm/schedule/cpm';
import { DEFAULT_CALENDAR, type ConstraintType, type DepType, type SchedDep, type TaskStatus, type WorkCalendar } from '@/lib/pm/schedule/types';

type Json = Record<string, unknown>;

interface Case {
  name: string;
  anchor: string;
  statusDate: string | null;
  calendar: WorkCalendar;
  tasks: CpmInputTask[];
  deps: SchedDep[];
  expect: Record<string, Json>;
  projectFinish: string | null;
  criticalCount: number | null;
  ignoredLinks: number | null;
  error: string | null;
  /** SQL fixture: the loop's members, and the guard's message for adding the last link. */
  loop: string[] | null;
  guardMessage: string | null;
}

const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Accepts this app's shape and the SQL fixture's likely spellings (ids or titles, pred/pred_id …). */
function toCase(c: Json): Case {
  const cal = (c.calendar ?? {}) as Json;
  const holidays = Array.isArray(cal.holidays) ? (cal.holidays as unknown[]).map(String) : [];
  const extra = Array.isArray(cal.workdays_extra) ? (cal.workdays_extra as unknown[]).map(String) : [];
  // the SQL fixture: exceptions { day: is_workday }
  const exMap = typeof cal.exceptions === 'object' && cal.exceptions !== null ? Object.entries(cal.exceptions as Record<string, unknown>).map(([day, w]) => ({ day, is_workday: w === true })) : [];
  const calendar = c.calendar
    ? makeCalendar(
        { id: null, name: 'fixture', workdays: Array.isArray(cal.workdays) ? (cal.workdays as unknown[]).map(Number) : [1, 2, 3, 4, 5], hours_per_day: Number(cal.hours_per_day ?? 8) },
        [...holidays.map((d) => ({ day: d, is_workday: false })), ...extra.map((d) => ({ day: d, is_workday: true })), ...exMap],
      )
    : DEFAULT_CALENDAR;
  const tasks = ((c.tasks ?? []) as Json[]).map((t): CpmInputTask => {
    const id = s(t.id) ?? s(t.key) ?? s(t.title) ?? '';
    return {
      id,
      title: s(t.title) ?? id,
      parent_task_id: s(t.parent) ?? s(t.parent_task_id) ?? s(t.parent_id),
      status: (s(t.status) ?? 'TODO') as TaskStatus,
      is_milestone: t.is_milestone === true,
      duration_days: typeof t.duration_days === 'number' ? t.duration_days : typeof t.duration === 'number' ? t.duration : null,
      start_on: s(t.start_on),
      due_on: s(t.due_on),
      pct_complete: typeof t.pct_complete === 'number' ? t.pct_complete : null,
      constraint_type: (s(t.constraint_type) ?? 'ASAP') as ConstraintType,
      constraint_date: s(t.constraint_date),
      actual_start: s(t.actual_start),
      actual_finish: s(t.actual_finish),
    };
  });
  const deps = ((c.deps ?? c.links ?? []) as Json[]).map((d): SchedDep => ({
    pred_id: s(d.pred) ?? s(d.pred_id) ?? '',
    succ_id: s(d.succ) ?? s(d.succ_id) ?? '',
    dep_type: (s(d.type) ?? s(d.dep_type) ?? 'FS') as DepType,
    lag_days: Number(d.lag ?? d.lag_days ?? 0),
  }));
  const expected = (c.expected ?? {}) as Json;
  const expTasks = (expected.tasks ?? c.expect ?? (c.expected && !expected.tasks ? c.expected : {})) as Record<string, Json>;
  const n = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    name: String(c.name ?? 'case'),
    anchor: s(c.anchor) ?? s(c.anchor_start) ?? '2026-11-02',
    statusDate: s(c.status_date),
    calendar,
    tasks,
    deps,
    expect: expTasks,
    projectFinish: s(c.project_finish) ?? s(c.finish_on) ?? s(expected.project_finish),
    criticalCount: n(expected.critical_count),
    ignoredLinks: n(expected.ignored_links),
    error: s(c.expect_error) ?? s(c.error) ?? (typeof c.expect_error === 'object' && c.expect_error !== null ? s((c.expect_error as Json).code) : null),
    loop: typeof c.expect_error === 'object' && c.expect_error !== null && Array.isArray((c.expect_error as Json).loop) ? ((c.expect_error as Json).loop as unknown[]).map(String) : null,
    guardMessage: typeof c.expect_error === 'object' && c.expect_error !== null ? s((c.expect_error as Json).guard_message) : null,
  };
}

function load(path: string): Case[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Json | Json[];
  const list = Array.isArray(raw) ? raw : ((raw.cases ?? []) as Json[]);
  return list.map(toCase);
}

const OWN = resolve(__dirname, 'fixtures/cpm-cases.json');
const SHARED = resolve(__dirname, '../../../../packages/projects-access/test/fixtures/cpm-cases.json');

function runCase(c: Case) {
  if (c.error) {
    expect(() => computeCpm(c.tasks, c.deps, c.calendar, c.anchor, c.statusDate)).toThrow(c.error);
    const r = tryCpm(c.tasks, c.deps, c.calendar, c.anchor, c.statusDate);
    const title = (id: string) => c.tasks.find((t) => t.id === id)?.title ?? id;
    if (c.loop && !r.ok) expect(new Set(r.cycle)).toEqual(new Set(c.loop.map(title)));
    if (c.guardMessage) {
      // the link guard refuses the LAST link and names the loop from its predecessor, like findLinkCycle
      const last = c.deps[c.deps.length - 1]!;
      const loop = findLinkCycle(c.deps.slice(0, -1), last.pred_id, last.succ_id);
      expect(loop && `PM_DEP_CYCLE: ${loop.map(title).join(' → ')}`).toBe(c.guardMessage);
    }
    return;
  }
  const out = computeCpm(c.tasks, c.deps, c.calendar, c.anchor, c.statusDate);
  for (const [id, want] of Object.entries(c.expect)) {
    const got = out.results.get(id) ?? [...out.results.values()].find((r) => c.tasks.find((t) => t.id === r.id)?.title === id);
    expect(got, `${c.name}: task ${id}`).toBeDefined();
    const picked: Json = {};
    for (const k of Object.keys(want)) picked[k] = (got as unknown as Json)[k === 'total_float_days' ? 'total_float' : k === 'free_float_days' ? 'free_float' : k];
    expect(picked, `${c.name}: task ${id}`).toEqual(Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v])));
  }
  if (c.projectFinish) expect(out.projectFinish, `${c.name}: project finish`).toBe(c.projectFinish);
  if (c.criticalCount != null) expect(out.criticalCount, `${c.name}: critical count`).toBe(c.criticalCount);
  if (c.ignoredLinks != null) expect(out.ignoredLinks, `${c.name}: ignored links`).toBe(c.ignoredLinks);
}

describe('client CPM — this app’s cases', () => {
  const cases = load(OWN);
  it('has cases', () => expect(cases.length).toBeGreaterThan(10));
  for (const c of cases) it(c.name, () => runCase(c));
});

describe('client CPM — shared cases with the SQL engine (1112)', () => {
  if (!existsSync(SHARED)) {
    it.skip('packages/projects-access/test/fixtures/cpm-cases.json is not written yet', () => {});
    return;
  }
  const cases = load(SHARED);
  for (const c of cases) it(c.name, () => runCase(c));
});

describe('loops', () => {
  const t = (id: string, title = id): CpmInputTask => ({
    id, title, parent_task_id: null, status: 'TODO', is_milestone: false, duration_days: 1, start_on: null, due_on: null, pct_complete: null,
    constraint_type: 'ASAP', constraint_date: null, actual_start: null, actual_finish: null,
  });
  const dep = (a: string, b: string): SchedDep => ({ pred_id: a, succ_id: b, dep_type: 'FS', lag_days: 0 });

  it('names the loop the way the DB guard does', () => {
    const r = tryCpm([t('A', 'Frame'), t('B', 'Rough-in'), t('C', 'Insulate')], [dep('A', 'B'), dep('B', 'C'), dep('C', 'A')], DEFAULT_CALENDAR, '2026-11-02');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.cycle[0]).toBe(r.cycle[r.cycle.length - 1]);
    expect(new Set(r.cycle)).toEqual(new Set(['Frame', 'Rough-in', 'Insulate']));
    expect(new ScheduleCycleError(r.cycle).message).toMatch(/^PM_DEP_CYCLE: .+ → .+ → .+ → .+$/);
  });

  it('a loop downstream of a clean task still names only the loop', () => {
    const r = tryCpm([t('S'), t('A'), t('B')], [dep('S', 'A'), dep('A', 'B'), dep('B', 'A')], DEFAULT_CALENDAR, '2026-11-02');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(new Set(r.cycle)).toEqual(new Set(['A', 'B']));
  });

  it('findLinkCycle refuses the closing link before it is sent', () => {
    const deps = [dep('A', 'B'), dep('B', 'C')];
    expect(findLinkCycle(deps, 'C', 'A')).toEqual(['C', 'A', 'B', 'C']);
    expect(findLinkCycle(deps, 'A', 'C')).toBeNull();
    expect(findLinkCycle(deps, 'A', 'A')).toEqual(['A', 'A']);
    expect(cycleMessage(['Frame', 'Rough-in', 'Frame'])).toBe('These links make a loop: Frame → Rough-in → Frame. Remove one of them.');
  });
});

describe('drag preview (ghost bars)', () => {
  const base: CpmInputTask[] = ['A', 'B', 'C', 'D'].map((id) => ({
    id, title: id, parent_task_id: null, status: 'TODO', is_milestone: false, duration_days: 2, start_on: null, due_on: null, pct_complete: null,
    constraint_type: 'ASAP', constraint_date: null, actual_start: null, actual_finish: null,
  }));
  const deps: SchedDep[] = [
    { pred_id: 'A', succ_id: 'B', dep_type: 'FS', lag_days: 0 },
    { pred_id: 'B', succ_id: 'C', dep_type: 'FS', lag_days: 0 },
  ];

  it('moving A three working days moves its successors, not the unlinked task', () => {
    const before = computeCpm(base, deps, DEFAULT_CALENDAR, '2026-11-02');
    const after = computeCpm(applyMove(base, { taskId: 'A', start: '2026-11-05', duration: null }), deps, DEFAULT_CALENDAR, '2026-11-02');
    const d = diffCpm(before, after);
    expect(new Set(d.changed)).toEqual(new Set(['A', 'B', 'C']));
    expect(d.movedLeaves).toBe(3);
    expect(d.finishBefore).toBe('2026-11-09');
    expect(d.finishAfter).toBe('2026-11-12');
  });

  it('a resize changes the duration and pushes successors', () => {
    const before = computeCpm(base, deps, DEFAULT_CALENDAR, '2026-11-02');
    const after = computeCpm(applyMove(base, { taskId: 'B', start: null, duration: 4 }), deps, DEFAULT_CALENDAR, '2026-11-02');
    expect(after.results.get('B')?.due_on).toBe('2026-11-09');
    expect(diffCpm(before, after).changed.sort()).toEqual(['B', 'C']);
  });

  it('a must-start-on keeps its type when dragged', () => {
    const t = applyMove([{ ...base[0]!, constraint_type: 'MSO', constraint_date: '2026-11-02' }], { taskId: 'A', start: '2026-11-04', duration: null });
    expect(t[0]).toMatchObject({ constraint_type: 'MSO', constraint_date: '2026-11-04' });
  });

  it('2,000 tasks: one drag frame of CPM stays inside a frame budget', () => {
    const n = 2000;
    const tasks: CpmInputTask[] = Array.from({ length: n }, (_, i) => ({
      id: `t${i}`, title: `Task ${i}`, parent_task_id: i % 20 === 0 ? null : `t${i - (i % 20)}`, status: 'TODO', is_milestone: i % 97 === 0,
      duration_days: 1 + (i % 5), start_on: null, due_on: null, pct_complete: null, constraint_type: 'ASAP', constraint_date: null, actual_start: null, actual_finish: null,
    }));
    const links: SchedDep[] = [];
    for (let i = 2; i < n; i++) if (i % 20 !== 0 && (i - 1) % 20 !== 0) links.push({ pred_id: `t${i - 1}`, succ_id: `t${i}`, dep_type: 'FS', lag_days: 0 });
    for (let i = 21; i < n; i += 20) links.push({ pred_id: `t${i - 2}`, succ_id: `t${i}`, dep_type: i % 3 === 0 ? 'SS' : 'FS', lag_days: i % 2 });
    computeCpm(tasks, links, DEFAULT_CALENDAR, '2026-11-02'); // warm up
    const runs = 10;
    const t0 = performance.now();
    for (let k = 0; k < runs; k++) computeCpm(applyMove(tasks, { taskId: 't3', start: `2026-11-${String(3 + k).padStart(2, '0')}`, duration: null }), links, DEFAULT_CALENDAR, '2026-11-02');
    const per = (performance.now() - t0) / runs;
    // eslint-disable-next-line no-console
    console.info(`[perf] CPM, 2,000 tasks / ${links.length} links: ${per.toFixed(2)} ms per drag frame`);
    // ~6 ms alone (and it runs only when the snapped day changes, not on every pointer move);
    // the ceiling allows for the parallel test runner sharing the CPU.
    expect(per).toBeLessThan(33);
  });
});
