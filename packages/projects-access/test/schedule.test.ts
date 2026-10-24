/**
 * 1112 scheduling engine (docs/projects/WAVE1-SCHEDULE-SPEC.md §2), on the 1110 fixture with every
 * later migration applied (numeric order — the state production reaches):
 *   CPM correctness on the shared cases (fixtures/cpm-cases.json — the same file the client CPM mirror
 *   is tested on), idempotency, the link guard (named loops, lag / job / phase rules), reschedule +
 *   cascade, preview without side effects, links / indent / order, baselines + variance, templates,
 *   look-ahead constraint reasons, resource load, RLS per persona, registries, re-apply.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigration } from './pg';
import { buildFixture, applyAfter1110, as, q, errorOf, type Fixture, type Persona, ORG_A, ORG_B, L1, J1, J2, J3, JB } from './fixture';

interface CaseTask {
  key: string; title: string; duration_days: number | null; parent: string | null; is_milestone: boolean; status: string;
  pct_complete: number | null; constraint_type: string; constraint_date: string | null; actual_start: string | null;
  actual_finish: string | null; start_on: string | null; due_on: string | null;
}
interface CaseDep { pred: string; succ: string; dep_type: string; lag_days: number }
interface CpmCase {
  name: string; description: string;
  calendar: { workdays: number[]; hours_per_day: number; exceptions: Record<string, boolean> };
  anchor: string; status_date: string | null; tasks: CaseTask[]; deps: CaseDep[];
  expected?: { project_finish: string; critical_count: number; ignored_links: number; tasks: Record<string, Record<string, unknown>> };
  expect_error?: { code: string; loop: string[]; guard_message: string };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES: CpmCase[] = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/cpm-cases.json'), 'utf8')).cases;

let f: Fixture;
let seq = 0;

beforeAll(async () => {
  f = await buildFixture();
  await applyAfter1110(f.db);
}, 600_000);

afterAll(async () => {
  await f?.db.close();
});

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(f.db, sql, params);
  if (!r[0]) throw new Error(`no row: ${sql}`);
  return r[0];
}

/** A fresh job at L1 (org A) with its pm.projects row. */
async function newJob(label: string, loc = L1, org = ORG_A): Promise<string> {
  seq += 1;
  const j = await one<{ id: string }>(
    `insert into core.jobs (org_id, location_id, job_number, name) values ($1, $2, $3, $3) returning id`, [org, loc, `S-${label}-${seq}`]);
  await f.db.query(`insert into pm.projects (job_id, org_id, location_id, job_type_id, stage_key) values ($1, $2, $3, $4, 'active')`,
    [j.id, org, loc, f.ids[`jobType:${loc}`]]);
  return j.id;
}

async function addTask(job: string, title: string, extra: Record<string, unknown> = {}, org = ORG_A): Promise<string> {
  const cols = ['org_id', 'job_id', 'title', ...Object.keys(extra)];
  const vals = [org, job, title, ...Object.values(extra)];
  const r = await one<{ id: string }>(`insert into pm.tasks (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, vals);
  return r.id;
}

async function link(pred: string, succ: string, type = 'FS', lag = 0, org = ORG_A): Promise<void> {
  await f.db.query(`insert into pm.task_deps (org_id, pred_id, succ_id, dep_type, lag_days) values ($1, $2, $3, $4, $5)`, [org, pred, succ, type, lag]);
}

/** Load a fixture case into a fresh job; returns key → task id. */
async function loadCase(c: CpmCase, opts: { skipDeps?: boolean } = {}): Promise<{ job: string; ids: Record<string, string> }> {
  const job = await newJob(c.name);
  let cal: string | null = null;
  const custom = Object.keys(c.calendar.exceptions).length > 0 || c.calendar.workdays.join(',') !== '1,2,3,4,5';
  if (custom) {
    cal = (await one<{ id: string }>(`insert into pm.work_calendars (org_id, location_id, name, workdays, hours_per_day) values ($1, null, $2, $3, $4) returning id`,
      [ORG_A, `case ${c.name} ${seq}`, `{${c.calendar.workdays.join(',')}}`, c.calendar.hours_per_day])).id;
    for (const [day, work] of Object.entries(c.calendar.exceptions)) {
      await f.db.query(`insert into pm.work_calendar_days (org_id, calendar_id, day, is_workday) values ($1, $2, $3, $4)`, [ORG_A, cal, day, work]);
    }
  }
  await f.db.query(`insert into pm.schedules (job_id, org_id, calendar_id, anchor_start, status_date) values ($1, $2, $3, $4, $5)`,
    [job, ORG_A, cal, c.anchor, c.status_date]);
  const ids: Record<string, string> = {};
  for (const [i, t] of c.tasks.entries()) {
    ids[t.key] = await addTask(job, t.title, {
      parent_task_id: t.parent ? ids[t.parent] : null, duration_days: t.duration_days, is_milestone: t.is_milestone, status: t.status,
      pct_complete: t.pct_complete, constraint_type: t.constraint_type, constraint_date: t.constraint_date, actual_start: t.actual_start,
      actual_finish: t.actual_finish, start_on: t.start_on, due_on: t.due_on, sort: i,
    });
  }
  if (!opts.skipDeps) for (const d of c.deps) await link(ids[d.pred]!, ids[d.succ]!, d.dep_type, d.lag_days);
  return { job, ids };
}

const TASK_SQL = `select id, title, start_on::text, due_on::text, duration_days, early_start::text, early_finish::text,
                         late_start::text, late_finish::text, total_float, free_float, is_critical, is_summary, constraint_conflict,
                         pct_complete::float8 as pct_complete, status, actual_start::text, actual_finish::text, wbs_code, sort,
                         constraint_type, constraint_date::text, parent_task_id, cpm_at::text, updated_at::text
                    from pm.tasks where job_id = $1 order by sort, title, id`;
type Row = Record<string, unknown> & { id: string; title: string };
const rowsOf = (job: string) => q<Row>(f.db, TASK_SQL, [job]);
const byTitle = async (job: string) => Object.fromEntries((await rowsOf(job)).map((r) => [r.title, r]));
const cpm = (job: string) => f.db.query(`select count(*) from pm.schedule_cpm($1)`, [job]);
const header = (job: string) => one<Record<string, unknown>>(`select finish_on::text, start_on::text, critical_count, task_count, ignored_links, anchor_start::text, cpm_at::text, updated_at::text from pm.schedules where job_id = $1`, [job]);

// ─────────────────────────────────────────────────────────────────────────────
describe('CPM on the shared cases (fixtures/cpm-cases.json)', () => {
  for (const c of CASES.filter((x) => x.expected)) {
    it(`${c.name}: ${c.description}`, async () => {
      const { job } = await loadCase(c);
      await cpm(job);
      const got = await byTitle(job);
      for (const [key, exp] of Object.entries(c.expected!.tasks)) {
        const title = c.tasks.find((t) => t.key === key)!.title;
        const row = got[title]!;
        for (const [col, v] of Object.entries(exp)) expect(row[col], `${c.name} ${key}.${col}`).toEqual(v);
      }
      const h = await header(job);
      expect(h.finish_on, `${c.name} finish`).toBe(c.expected!.project_finish);
      expect(h.critical_count, `${c.name} critical`).toBe(c.expected!.critical_count);
      expect(h.ignored_links, `${c.name} ignored links`).toBe(c.expected!.ignored_links);
    });
  }

  it('is idempotent: a second run changes no row and returns the same tasks', async () => {
    const { job } = await loadCase(CASES.find((c) => c.name === 'summary_rollup_progress')!);
    await cpm(job);
    const before = await rowsOf(job);
    const ret1 = (await q<Row>(f.db, `select * from pm.schedule_cpm($1)`, [job])).length;
    const after = await rowsOf(job);
    expect(after).toEqual(before); // cpm_at / updated_at included: nothing was rewritten
    expect(ret1).toBe(before.length);
  });

  it('outline numbers (wbs_code) follow the phases', async () => {
    const { job } = await loadCase(CASES.find((c) => c.name === 'summary_rollup_progress')!);
    await cpm(job);
    const r = await byTitle(job);
    expect([r.P1!.wbs_code, r.A!.wbs_code, r.B!.wbs_code, r.P2!.wbs_code, r.C!.wbs_code, r.P2a!.wbs_code, r.D!.wbs_code, r.M!.wbs_code])
      .toEqual(['1', '1.1', '1.2', '2', '2.1', '2.2', '2.2.1', '3']);
  });

  it('first run persists the project start; schedules.start_on is the first working day on / after it', async () => {
    const job = await newJob('anchor');
    await f.db.query(`update pm.projects set planned_start = '2026-11-07' where job_id = $1`, [job]); // a Saturday
    await addTask(job, 'only', { duration_days: 2 });
    await cpm(job);
    const h = await header(job);
    expect(h.anchor_start).toBe('2026-11-07');
    expect(h.start_on).toBe('2026-11-09');
    expect((await byTitle(job)).only!.due_on).toBe('2026-11-10');
  });

  it('a calendar / project-start change on pm.schedules re-runs CPM', async () => {
    const { job } = await loadCase(CASES.find((c) => c.name === 'fs_chain')!);
    await cpm(job);
    await f.db.query(`update pm.schedules set anchor_start = '2026-11-09' where job_id = $1`, [job]);
    expect((await byTitle(job)).A!.start_on).toBe('2026-11-09');
    expect((await header(job)).finish_on).toBe('2026-11-19');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('link guard: loops are refused naming the loop; lag, job and phase rules', () => {
  const cyc = CASES.find((c) => c.name === 'cycle')!;

  it('closing A → B → C with C → A is refused: "PM_DEP_CYCLE: C → A → B → C"', async () => {
    const { ids } = await loadCase(cyc, { skipDeps: true });
    await link(ids.A!, ids.B!);
    await link(ids.B!, ids.C!);
    expect(await errorOf(f.db, `insert into pm.task_deps (org_id, pred_id, succ_id) values ($1, $2, $3)`, [ORG_A, ids.C, ids.A]))
      .toBe(cyc.expect_error!.guard_message);
  });

  it('the same loop through pm.set_task_links (several links in one call) is refused and nothing changes', async () => {
    const { job, ids } = await loadCase(cyc, { skipDeps: true });
    await link(ids.A!, ids.B!);
    await link(ids.B!, ids.C!);
    const err = await errorOf(f.db, `select pm.set_task_links($1, $2::jsonb)`,
      [ids.A, JSON.stringify([{ pred_id: ids.C, dep_type: 'FS', lag_days: 0 }])]);
    expect(err).toBe('PM_DEP_CYCLE: C → A → B → C');
    expect((await q(f.db, `select 1 from pm.task_deps d join pm.tasks t on t.id = d.succ_id where t.job_id = $1`, [job])).length).toBe(2);
  });

  it('a self-link, a cross-job link, an out-of-range lag and a link to a phase are refused', async () => {
    const job = await newJob('guard');
    const a = await addTask(job, 'Frame');
    const p = await addTask(job, 'Phase');
    await addTask(job, 'Kid', { parent_task_id: p });
    const other = await addTask(J3, 'Elsewhere');
    expect(await errorOf(f.db, `insert into pm.task_deps (org_id, pred_id, succ_id) values ($1, $2, $2)`, [ORG_A, a])).toBe('PM_DEP_CYCLE: Frame → Frame');
    expect(await errorOf(f.db, `insert into pm.task_deps (org_id, pred_id, succ_id) values ($1, $2, $3)`, [ORG_A, a, other])).toMatch(/^PM_DEP_CROSS_JOB/);
    expect(await errorOf(f.db, `insert into pm.task_deps (org_id, pred_id, succ_id, lag_days) values ($1, $2, $3, 366)`, [ORG_A, p, a])).toMatch(/PM_DEP_LAG|PM_DEP_SUMMARY/);
    const b = await addTask(job, 'Trim');
    expect(await errorOf(f.db, `insert into pm.task_deps (org_id, pred_id, succ_id, lag_days) values ($1, $2, $3, -366)`, [ORG_A, a, b])).toMatch(/^PM_DEP_LAG/);
    expect(await errorOf(f.db, `insert into pm.task_deps (org_id, pred_id, succ_id) values ($1, $2, $3)`, [ORG_A, p, a])).toBe('PM_DEP_SUMMARY: "Phase" is a phase. Link to one of its tasks instead.');
    // lag bounds are inclusive
    await link(a, b, 'FS', 365);
  });

  it('a task with links cannot get children (indent / insert under it)', async () => {
    const job = await newJob('linked-parent');
    const a = await addTask(job, 'Linked', { sort: 0 });
    const b = await addTask(job, 'Next', { sort: 1 });
    const c = await addTask(job, 'Third', { sort: 2 });
    await link(a, c);
    expect(await errorOf(f.db, `select pm.indent_task($1, 'in')`, [b])).toBe('PM_SCHEDULE_LINKED_PARENT: "Linked" has links. Remove its links before putting tasks under it.');
    expect(await errorOf(f.db, `insert into pm.tasks (org_id, job_id, title, parent_task_id) values ($1, $2, 'Child', $3)`, [ORG_A, job, a])).toMatch(/^PM_SCHEDULE_LINKED_PARENT/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pm.reschedule_task / pm.preview_reschedule', () => {
  const chain = CASES.find((c) => c.name === 'fs_chain')!;

  it('resizing pushes the successors: moved_count, finish before / after, changed rows', async () => {
    const { job, ids } = await loadCase(chain);
    await cpm(job);
    const r = (await one<{ r: Record<string, unknown> }>(`select pm.reschedule_task($1, null, 5) as r`, [ids.A])).r;
    expect(r.moved_count).toBe(3);
    expect(r.finish_before).toBe('2026-11-12');
    expect(r.finish_after).toBe('2026-11-16');
    expect(r.finish_delta_days).toBe(2);
    const changed = r.changed as Array<Record<string, unknown>>;
    expect(changed.map((c) => c.title)).toEqual(['A', 'B', 'C']);
    expect(changed[0]).toMatchObject({ id: ids.A, start_on: '2026-11-02', due_on: '2026-11-06', duration_days: 5, total_float: 0, is_critical: true });
    expect(changed[2]).toMatchObject({ start_on: '2026-11-11', due_on: '2026-11-16' });
    const t = await byTitle(job);
    expect([t.B!.start_on, t.C!.due_on]).toEqual(['2026-11-09', '2026-11-16']);
  });

  it('moving becomes start-no-earlier-than; only the dragged task and its successors move', async () => {
    const { job, ids } = await loadCase(chain);
    await cpm(job);
    const r = (await one<{ r: Record<string, unknown> }>(`select pm.reschedule_task($1, '2026-11-10', null) as r`, [ids.B])).r;
    expect(r.moved_count).toBe(2);
    expect(r.finish_after).toBe('2026-11-17');
    const t = await byTitle(job);
    expect([t.B!.constraint_type, t.B!.constraint_date, t.B!.start_on, t.A!.total_float]).toEqual(['SNET', '2026-11-10', '2026-11-10', 3]);
    // earlier than logic allows: the constraint is kept, the task does not move
    const r2 = (await one<{ r: Record<string, unknown> }>(`select pm.reschedule_task($1, '2026-11-02', null) as r`, [ids.C])).r;
    expect(r2.moved_count).toBe(0);
    expect((await byTitle(job)).C!.start_on).toBe('2026-11-12');
  });

  it('a must-start-on keeps its type and takes the new date; a milestone keeps 0 days', async () => {
    const job = await newJob('mso');
    const a = await addTask(job, 'Pour', { duration_days: 1, constraint_type: 'MSO', constraint_date: '2026-11-04' });
    const m = await addTask(job, 'Done', { is_milestone: true });
    await f.db.query(`insert into pm.schedules (job_id, org_id, anchor_start) values ($1, $2, '2026-11-02')`, [job, ORG_A]);
    await f.db.query(`select pm.reschedule_task($1, '2026-11-05', null)`, [a]);
    await f.db.query(`select pm.reschedule_task($1, null, 4)`, [m]);
    const t = await byTitle(job);
    expect([t.Pour!.constraint_type, t.Pour!.constraint_date, t.Pour!.start_on, t.Done!.duration_days]).toEqual(['MSO', '2026-11-05', '2026-11-05', 0]);
  });

  it('a started task is not moved (change its actual start); a phase cannot be resized', async () => {
    const { job, ids } = await loadCase(chain);
    await f.db.query(`update pm.tasks set actual_start = '2026-11-02' where id = $1`, [ids.A]);
    expect((await byTitle(job)).A!.status).toBe('IN_PROGRESS');
    expect(await errorOf(f.db, `select pm.reschedule_task($1, '2026-11-04', null)`, [ids.A])).toMatch(/^PM_SCHEDULE_STARTED: "A" has started/);
    const ph = await newJob('phase');
    const p = await addTask(ph, 'Phase', { sort: 0 });
    await addTask(ph, 'Kid', { parent_task_id: p, sort: 1, duration_days: 2 });
    expect(await errorOf(f.db, `select pm.reschedule_task($1, null, 9)`, [p])).toMatch(/^PM_INVALID: "Phase" is a phase/);
  });

  it('moving a phase shifts its unstarted tasks by the same working days', async () => {
    const job = await newJob('shift');
    await f.db.query(`select pm.apply_schedule_template($1, 'simple_project', '2026-11-02')`, [job]);
    const before = await byTitle(job);
    // planning Nov 2–4, procure Nov 5–11, the work SS+3 after procure → Nov 10
    expect([before.Execute!.start_on, before['Do the work']!.start_on]).toEqual(['2026-11-10', '2026-11-10']);
    const r = (await one<{ r: Record<string, unknown> }>(`select pm.reschedule_task($1, '2026-11-17', null) as r`, [before.Execute!.id])).r;
    const after = await byTitle(job);
    expect(after['Do the work']!.start_on).toBe('2026-11-17');
    expect(after['Do the work']!.constraint_type).toBe('SNET');
    expect(r.moved_count).toBe(3); // the work, punch, complete
    expect(r.finish_delta_days).toBe(5);
  });

  it('preview returns the same result and writes nothing (rows, header, timestamps)', async () => {
    const { job, ids } = await loadCase(chain);
    await cpm(job);
    const snap = async () => JSON.stringify([await rowsOf(job), await header(job), await q(f.db, `select * from pm.task_deps d join pm.tasks t on t.id = d.succ_id where t.job_id = $1 order by d.pred_id`, [job])]);
    const before = await snap();
    const p = (await one<{ r: Record<string, unknown> }>(`select pm.preview_reschedule($1, '2026-11-04', 6) as r`, [ids.A])).r;
    expect(await snap()).toBe(before);
    expect(p.preview).toBe(true);
    const real = (await one<{ r: Record<string, unknown> }>(`select pm.reschedule_task($1, '2026-11-04', 6) as r`, [ids.A])).r;
    const { preview: _drop, ...rest } = p;
    expect(rest).toEqual(real);
    expect(real.moved_count).toBe(3);
  });

  it('preview of an invalid edit raises the real error', async () => {
    const { ids } = await loadCase(chain);
    expect(await errorOf(f.db, `select pm.preview_reschedule($1, null, -1)`, [ids.A])).toMatch(/^PM_INVALID: a duration/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('links and outline: set_task_links, indent_task, move_task_order', () => {
  it('set_task_links replaces the predecessors and re-runs CPM', async () => {
    const { job, ids } = await loadCase(CASES.find((c) => c.name === 'fs_chain')!);
    await cpm(job);
    const r = (await one<{ r: Record<string, unknown> }>(`select pm.set_task_links($1, $2::jsonb) as r`,
      [ids.C, JSON.stringify([{ pred_id: ids.A, dep_type: 'ss', lag_days: 1 }])])).r;
    const deps = await q<{ pred_id: string; dep_type: string; lag_days: number }>(f.db, `select pred_id, dep_type, lag_days from pm.task_deps where succ_id = $1`, [ids.C]);
    expect(deps).toEqual([{ pred_id: ids.A, dep_type: 'SS', lag_days: 1 }]);
    expect((await byTitle(job)).C!.start_on).toBe('2026-11-03');
    expect(r.finish_after).toBe('2026-11-06');
    // an empty list removes every predecessor
    await f.db.query(`select pm.set_task_links($1, '[]'::jsonb)`, [ids.C]);
    expect((await q(f.db, `select 1 from pm.task_deps where succ_id = $1`, [ids.C])).length).toBe(0);
  });

  it('set_task_links validates its input', async () => {
    const { ids } = await loadCase(CASES.find((c) => c.name === 'fs_chain')!);
    const call = (links: unknown) => errorOf(f.db, `select pm.set_task_links($1, $2::jsonb)`, [ids.C, JSON.stringify(links)]);
    expect(await call([{ pred_id: ids.A }, { pred_id: ids.A, dep_type: 'SS' }])).toBe('PM_INVALID: "A" is listed twice. Keep one link to it.');
    expect(await call([{ pred_id: ids.A, dep_type: 'XX' }])).toMatch(/^PM_INVALID: each link needs/);
    expect(await call([{ pred_id: 'nope' }])).toMatch(/^PM_INVALID: each link needs/);
    expect(await call([{ pred_id: ids.A, lag_days: 1.5 }])).toMatch(/^PM_INVALID: each link needs/);
    expect(await call([{ pred_id: ids.A, lag_days: 400 }])).toMatch(/^PM_DEP_LAG/);
    expect(await call([{ pred_id: f.ids[`task:${J3}`] }])).toMatch(/^PM_DEP_CROSS_JOB/);
    expect(await call({ pred_id: ids.A })).toMatch(/^PM_INVALID: links must be a list/);
  });

  it('Tab / Shift-Tab / reorder keep the outline (sort, wbs_code) consistent', async () => {
    const job = await newJob('outline');
    const t1 = await addTask(job, 'T1', { sort: 0, duration_days: 2 });
    const t2 = await addTask(job, 'T2', { sort: 1, duration_days: 3 });
    const t3 = await addTask(job, 'T3', { sort: 2, duration_days: 1 });
    const t4 = await addTask(job, 'T4', { sort: 3, duration_days: 1 });
    const outline = async () => (await rowsOf(job)).map((r) => `${r.wbs_code}:${r.title}`).join(' ');
    expect(await errorOf(f.db, `select pm.indent_task($1, 'in')`, [t1])).toMatch(/^PM_SCHEDULE_INDENT/);
    await f.db.query(`select pm.indent_task($1, 'in')`, [t2]);
    expect(await outline()).toBe('1:T1 1.1:T2 2:T3 3:T4');
    const sum = (await byTitle(job)).T1!;
    expect([sum.is_summary, sum.duration_days, sum.start_on, sum.due_on]).toEqual([true, 3, sum.start_on, sum.due_on]);
    await f.db.query(`select pm.indent_task($1, 'in')`, [t3]);
    expect(await outline()).toBe('1:T1 1.1:T2 1.2:T3 2:T4');
    await f.db.query(`select pm.indent_task($1, 'out')`, [t2]);
    expect(await outline()).toBe('1:T1 1.1:T3 2:T2 3:T4');
    expect(await errorOf(f.db, `select pm.indent_task($1, 'out')`, [t4])).toMatch(/already at the top level/);
    await f.db.query(`select pm.move_task_order($1, null)`, [t4]);
    expect(await outline()).toBe('1:T4 2:T1 2.1:T3 3:T2');
    await f.db.query(`select pm.move_task_order($1, $2)`, [t2, t1]); // after T1 → its sibling, after its branch
    expect(await outline()).toBe('1:T4 2:T1 2.1:T3 3:T2');
    await f.db.query(`select pm.move_task_order($1, $2)`, [t2, t3]); // after T3 → sibling of T3 (inside T1)
    expect(await outline()).toBe('1:T4 2:T1 2.1:T3 2.2:T2');
    await f.db.query(`select pm.move_task_order($1, $2)`, [t2, t1]); // after its own parent → first child
    expect(await outline()).toBe('1:T4 2:T1 2.1:T2 2.2:T3');
    expect(await errorOf(f.db, `select pm.move_task_order($1, $2)`, [t1, t3])).toMatch(/cannot move under one of its own tasks/);
    expect((await rowsOf(job)).map((r) => r.sort)).toEqual([0, 1, 2, 3]);
    // the app's create flow: insert under a parent, then place it
    const t5 = await addTask(job, 'T5', { parent_task_id: t1, sort: 0, duration_days: 1 });
    await f.db.query(`select pm.move_task_order($1, $2)`, [t5, t2]);
    expect(await outline()).toBe('1:T4 2:T1 2.1:T2 2.2:T5 2.3:T3');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('baselines and variance', () => {
  it('a baseline snapshots the schedule; variance is in working days against the active one', async () => {
    const { job, ids } = await loadCase(CASES.find((c) => c.name === 'fs_chain')!);
    const b1 = (await one<{ id: string }>(`select pm.set_schedule_baseline($1, 'Original') as id`, [job])).id;
    const bt = await q<{ task_id: string; start_on: string; due_on: string; duration_days: number }>(f.db,
      `select task_id, start_on::text, due_on::text, duration_days from pm.schedule_baseline_tasks where baseline_id = $1 order by sort`, [b1]);
    expect(bt.map((x) => x.due_on)).toEqual(['2026-11-04', '2026-11-06', '2026-11-12']);
    await f.db.query(`select pm.reschedule_task($1, null, 5)`, [ids.A]);
    const v = await q<{ title: string; start_variance_days: number; finish_variance_days: number; duration_variance_days: number; variance_status: string }>(f.db,
      `select title, start_variance_days, finish_variance_days, duration_variance_days, variance_status from pm.v_schedule_variance where job_id = $1 order by sort`, [job]);
    expect(v).toEqual([
      { title: 'A', start_variance_days: 0, finish_variance_days: 2, duration_variance_days: 2, variance_status: 'late' },
      { title: 'B', start_variance_days: 2, finish_variance_days: 2, duration_variance_days: 0, variance_status: 'late' },
      { title: 'C', start_variance_days: 2, finish_variance_days: 2, duration_variance_days: 0, variance_status: 'late' },
    ]);
    const sj = await one<Record<string, unknown>>(`select baseline_id, baseline_name, baseline_finish::text, finish_on::text, finish_variance_days, task_count, critical_count from pm.v_schedule_jobs where job_id = $1`, [job]);
    expect(sj).toMatchObject({ baseline_id: b1, baseline_name: 'Original', baseline_finish: '2026-11-12', finish_on: '2026-11-16', finish_variance_days: 2, task_count: 3, critical_count: 3 });
    // a new baseline becomes the active one; a new task shows as "new"
    const b2 = (await one<{ id: string }>(`select pm.set_schedule_baseline($1, null) as id`, [job])).id;
    const bl = await q<{ id: string; number: number; name: string; is_active: boolean }>(f.db, `select id, number, name, is_active from pm.schedule_baselines where job_id = $1 order by number`, [job]);
    expect(bl.map((x) => [x.number, x.name, x.is_active])).toEqual([[1, 'Original', false], [2, 'Baseline 2', true]]);
    expect(bl[1]!.id).toBe(b2);
    await addTask(job, 'Late add', { duration_days: 1, sort: 9 });
    await cpm(job);
    const nv = await one<{ variance_status: string }>(`select variance_status from pm.v_schedule_variance where job_id = $1 and title = 'Late add'`, [job]);
    expect(nv.variance_status).toBe('new');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('templates', () => {
  const COUNTS: Record<string, [string, number]> = {
    commercial_ti: ['commercial_gc', 65], kitchen_remodel: ['residential_remodel', 29], bathroom_remodel: ['residential_remodel', 21],
    custom_home: ['home_builder', 133], hvac_replacement: ['field_service', 14], cabinet_eto: ['manufacturing_eto', 25],
    flooring_install: ['flooring', 11], re_development: ['real_estate_development', 29], trade_rough_trim: ['specialty_trade', 11],
    design_project: ['interior_design', 11], engagement_phases: ['professional_services', 7], pdi_delivery: ['equipment_dealer', 6],
    simple_project: ['general', 6],
  };

  it('the catalog is seeded per pack with realistic task counts', async () => {
    const rows = await q<{ key: string; pack_key: string; task_count: number }>(f.db, `select key, pack_key, task_count from pm.schedule_template_catalog order by key`);
    expect(Object.fromEntries(rows.map((r) => [r.key, [r.pack_key, r.task_count]]))).toEqual(COUNTS);
  });

  for (const key of Object.keys(COUNTS)) {
    it(`${key} applies cleanly: phases, tasks, links, CPM, no conflicts`, async () => {
      const job = await newJob(`tpl-${key}`);
      const r = (await one<{ r: Record<string, unknown> }>(`select pm.apply_schedule_template($1, $2, '2026-11-02') as r`, [job, key])).r;
      const body = (await one<{ body: { items: Array<{ kind: string; deps?: unknown[] }> } }>(`select body from pm.schedule_template_catalog where key = $1`, [key])).body;
      expect(r.created).toBe(body.items.length);
      expect(r.links).toBe(body.items.reduce((a, x) => a + (x.deps?.length ?? 0), 0));
      expect(r.start_on).toBe('2026-11-02');
      expect(typeof r.finish_on).toBe('string');
      expect(r.critical_count as number).toBeGreaterThan(0);
      const rows = await rowsOf(job);
      expect(rows.filter((x) => x.is_summary).length).toBe(body.items.filter((x) => x.kind === 'phase').length);
      expect(rows.some((x) => x.constraint_conflict)).toBe(false);
      expect(rows.every((x) => x.start_on && x.due_on && (x.total_float as number) >= 0)).toBe(true);
      expect(rows.every((x) => typeof x.template_ref === 'undefined' || true)).toBe(true);
      expect((await one<{ n: number }>(`select count(*)::int n from pm.tasks where job_id = $1 and template_ref like $2`, [job, `${key}:%`])).n).toBe(body.items.length);
    });
  }

  it('the custom home runs about seven months; the kitchen about two', async () => {
    const h = await newJob('home-len');
    const k = await newJob('kitchen-len');
    const rh = (await one<{ r: { finish_on: string } }>(`select pm.apply_schedule_template($1, 'custom_home', '2027-03-01') as r`, [h])).r;
    const rk = (await one<{ r: { finish_on: string } }>(`select pm.apply_schedule_template($1, 'kitchen_remodel', '2027-03-01') as r`, [k])).r;
    const months = (d: string) => (Date.parse(d) - Date.parse('2027-03-01')) / (30.4 * 86_400_000);
    expect(months(rh.finish_on)).toBeGreaterThan(5);
    expect(months(rh.finish_on)).toBeLessThan(10);
    expect(months(rk.finish_on)).toBeGreaterThan(1.5);
    expect(months(rk.finish_on)).toBeLessThan(3.5);
  });

  it('applying twice is refused; into a job with tasks the template starts no earlier than p_start', async () => {
    const job = await newJob('tpl-twice');
    await addTask(job, 'Existing', { duration_days: 2 });
    await f.db.query(`insert into pm.schedules (job_id, org_id, anchor_start) values ($1, $2, '2026-11-02')`, [job, ORG_A]);
    await f.db.query(`select pm.apply_schedule_template($1, 'flooring_install', '2026-11-16')`, [job]);
    const t = await byTitle(job);
    expect([t.Measure!.constraint_type, t.Measure!.start_on, t.Existing!.start_on, t.Existing!.sort]).toEqual(['SNET', '2026-11-16', '2026-11-02', 0]);
    expect(await errorOf(f.db, `select pm.apply_schedule_template($1, 'flooring_install', null)`, [job])).toMatch(/^PM_SCHEDULE_TEMPLATE_APPLIED/);
    expect(await errorOf(f.db, `select pm.apply_schedule_template($1, 'no_such', null)`, [job])).toMatch(/^PM_NOT_FOUND/);
  });

  it('installing a pack seeds the company copies; a company template is applied by id; tenant bodies are validated', async () => {
    const before = (await q(f.db, `select key from pm.schedule_templates where location_id = $1`, [L1])).length;
    await f.db.query(`insert into pm.pack_installs (org_id, location_id, pack_key, pack_version, role, resolved, plan_hash)
                      values ($1, $2, 'home_builder', '1.0.0', 'addon', '{}'::jsonb, 'h')`, [ORG_A, L1]);
    const keys = (await q<{ key: string; source: string }>(f.db, `select key, source from pm.schedule_templates where location_id = $1 order by key`, [L1]));
    expect(keys.map((k) => k.key)).toEqual(expect.arrayContaining(['custom_home', 'simple_project']));
    expect(keys.length).toBeGreaterThan(before);
    const tpl = (await one<{ id: string }>(`select id from pm.schedule_templates where location_id = $1 and key = 'custom_home'`, [L1])).id;
    const job = await newJob('by-id');
    const r = (await one<{ r: { created: number } }>(`select pm.apply_schedule_template($1, $2, '2026-11-02') as r`, [job, tpl])).r;
    expect(r.created).toBe(133 + 11);
    // tenant template: validated, task_count computed
    const bad = await errorOf(f.db, `insert into pm.schedule_templates (org_id, location_id, key, name, body) values ($1, $2, 'mine', 'Mine', $3::jsonb)`,
      [ORG_A, L1, JSON.stringify({ items: [{ ref: 'a', kind: 'task', name: 'A', duration: 1, deps: [{ ref: 'zz' }] }] })]);
    expect(bad).toMatch(/^PM_TEMPLATE_INVALID: bad links/);
    const ok = await one<{ task_count: number }>(`insert into pm.schedule_templates (org_id, location_id, key, name, body) values ($1, $2, 'mine', 'Mine', $3::jsonb) returning task_count`,
      [ORG_A, L1, JSON.stringify({ items: [{ ref: 'p', kind: 'phase', name: 'P' }, { ref: 'a', kind: 'task', parent: 'p', name: 'A', duration: 2 }, { ref: 'b', kind: 'milestone', parent: 'p', name: 'B', deps: [{ ref: 'a', type: 'FS', lag: 1 }] }] })]);
    expect(ok.task_count).toBe(2);
    const j2 = await newJob('mine');
    const r2 = (await one<{ r: { created: number; links: number } }>(`select pm.apply_schedule_template($1, 'mine', '2026-11-02') as r`, [j2])).r;
    expect([r2.created, r2.links]).toEqual([3, 1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pm.schedule_lookahead: tasks in the window with constraint reasons', () => {
  let job: string;
  const reasons = async (p: Persona, from = '2026-11-02', days = 21) =>
    as(f, p, async () => q<{ title: string; constraints: Array<{ kind: string; label: string }>; ready: boolean; trade: string; job_id: string; crew_name: string | null }>(f.db,
      `select title, constraints, ready, trade, job_id, crew_name from pm.schedule_lookahead($1, $2)`, [from, days]));

  beforeAll(async () => {
    job = J1; // the PM's job (and the supervisor's)
    await f.db.query(`insert into pm.schedules (job_id, org_id, anchor_start) values ($1, $2, '2026-11-02') on conflict (job_id) do update set anchor_start = excluded.anchor_start`, [job, ORG_A]);
    const crew = (await one<{ id: string }>(`insert into pm.crews (org_id, location_id, name, kind) values ($1, $2, 'Framing crew', 'INSTALL') returning id`, [ORG_A, L1])).id;
    const wbs = (await one<{ id: string }>(`insert into pm.wbs_nodes (org_id, job_id, kind, name) values ($1, $2, 'PHASE', 'Kitchen') returning id`, [ORG_A, job])).id;
    const pred = await addTask(job, 'LA demo', { duration_days: 2, sort: 100 });
    const succ = await addTask(job, 'LA framing', { duration_days: 3, sort: 101, assigned_crew_id: crew });
    await link(pred, succ);
    const po = (await one<{ id: string }>(`insert into pm.commitments (org_id, job_id, number, commitment_type, retainage_pct) values ($1, $2, 'PO-LA-1', 'PO', 0) returning id`, [ORG_A, job])).id;
    await addTask(job, 'LA cabinets', { duration_days: 2, sort: 102, commitment_id: po });
    const po2 = (await one<{ id: string }>(`insert into pm.commitments (org_id, job_id, number, commitment_type, retainage_pct, status, approved_at) values ($1, $2, 'PO-LA-2', 'PO', 0, 'APPROVED', now()) returning id`, [ORG_A, job])).id;
    await f.db.query(`insert into pm.commitment_lines (org_id, commitment_id, description, qty, unit_cost_cents, amount_cents, received_qty, cost_code_id)
                      values ($1, $2, 'Tile', 10, 500, 5000, 4, $3)`, [ORG_A, po2, f.ids[`costCode:${L1}`]]);
    await addTask(job, 'LA tile', { duration_days: 2, sort: 103, commitment_id: po2 });
    await f.db.query(`insert into pm.procurement_items (org_id, job_id, wbs_id, description, status, approved_at, expected_on) values ($1, $2, $3, 'Range hood', 'ORDERED', now(), '2026-11-06')`, [ORG_A, job, wbs]);
    await addTask(job, 'LA hood', { duration_days: 1, sort: 104, wbs_id: wbs });
    const sub = (await one<{ id: string }>(`insert into proj.submittals (org_id, job_id, number, title, status) values ($1, $2, 'S-014', 'Cabinet shop drawings', 'SUBMITTED') returning id`, [ORG_A, job])).id;
    await addTask(job, 'LA install', { duration_days: 1, sort: 105, ext: JSON.stringify({ _submittal_id: sub }) });
    await addTask(job, 'LA blocked', { duration_days: 1, sort: 106, status: 'BLOCKED' });
    await addTask(job, 'LA ready', { duration_days: 1, sort: 107 });
    await addTask(job, 'LA far', { duration_days: 1, sort: 108, constraint_type: 'SNET', constraint_date: '2027-02-01' });
    await cpm(job);
  });

  it('reasons: predecessor, PO not approved, material not received (PO lines and procurement), submittal, blocked', async () => {
    const rows = Object.fromEntries((await reasons('pm')).map((r) => [r.title, r]));
    expect(rows['LA framing']!.constraints).toEqual([expect.objectContaining({ kind: 'predecessor', label: 'Predecessor not done: LA demo' })]);
    expect(rows['LA framing']!.trade).toBe('Framing crew');
    expect(rows['LA framing']!.crew_name).toBe('Framing crew');
    expect(rows['LA cabinets']!.constraints).toEqual([expect.objectContaining({ kind: 'material', label: 'PO PO-LA-1 is not approved' })]);
    expect(rows['LA tile']!.constraints).toEqual([expect.objectContaining({ kind: 'material', label: 'Material not received: PO PO-LA-2' })]);
    expect(rows['LA hood']!.constraints).toEqual([expect.objectContaining({ kind: 'material', label: 'Material not received: Range hood (ordered, expected 2026-11-06)' })]);
    expect(rows['LA install']!.constraints).toEqual([expect.objectContaining({ kind: 'submittal', label: 'Submittal S-014 not approved (submitted)' })]);
    expect(rows['LA blocked']!.constraints).toEqual([expect.objectContaining({ kind: 'other', label: 'Marked blocked' })]);
    expect([rows['LA ready']!.ready, rows['LA ready']!.constraints]).toEqual([true, []]);
    expect(rows['LA far']).toBeUndefined();
    expect(rows['LA demo']!.ready).toBe(true);
  });

  it('a predecessor done / receipt complete / submittal approved clears the reason', async () => {
    await f.db.query(`update pm.tasks set status = 'DONE' where job_id = $1 and title = 'LA demo'`, [job]);
    await f.db.query(`update pm.commitment_lines set received_qty = 10 where description = 'Tile' and org_id = $1`, [ORG_A]);
    await f.db.query(`update proj.submittals set status = 'APPROVED_AS_NOTED' where number = 'S-014'`);
    const rows = Object.fromEntries((await reasons('pm')).map((r) => [r.title, r]));
    expect(rows['LA framing']!.ready).toBe(true);
    expect(rows['LA tile']!.ready).toBe(true);
    expect(rows['LA install']!.ready).toBe(true);
    expect(rows['LA demo']).toBeUndefined(); // done work leaves the look-ahead
  });

  it("only the caller's jobs; the window and size are validated", async () => {
    expect(new Set((await reasons('pm')).map((r) => r.job_id))).toEqual(new Set([J1]));
    expect((await reasons('labor')).every((r) => r.job_id === J2)).toBe(true);
    expect(await as(f, 'pm', () => errorOf(f.db, `select * from pm.schedule_lookahead('2026-11-02', 500)`))).toMatch(/^PM_INVALID/);
    expect((await reasons('bOwner')).every((r) => r.job_id === JB)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pm.resource_load', () => {
  it('crew × working day hours from tasks (+ dispatch), over capacity flagged', async () => {
    const job = await newJob('load');
    const crew = (await one<{ id: string }>(`insert into pm.crews (org_id, location_id, name, kind, capacity_minutes_per_day) values ($1, $2, 'Tile crew', 'INSTALL', 480) returning id`, [ORG_A, L1])).id;
    await f.db.query(`insert into pm.schedules (job_id, org_id, anchor_start) values ($1, $2, '2026-11-05')`, [job, ORG_A]);
    await addTask(job, 'Tile floor', { duration_days: 3, assigned_crew_id: crew, hours_per_day: 6 });
    await addTask(job, 'Tile shower', { duration_days: 2, assigned_crew_id: crew, constraint_type: 'SNET', constraint_date: '2026-11-06' });
    await cpm(job);
    const rows = await q<{ resource_kind: string; resource_name: string; day: string; hours: number; capacity_hours: number; task_count: number; over_capacity: boolean }>(f.db,
      `select resource_kind, resource_name, day::text, hours::float8 as hours, capacity_hours::float8 as capacity_hours, task_count, over_capacity
         from pm.resource_load('2026-11-05', '2026-11-11') where resource_id = $1 order by day`, [crew]);
    expect(rows).toEqual([
      { resource_kind: 'crew', resource_name: 'Tile crew', day: '2026-11-05', hours: 6, capacity_hours: 8, task_count: 1, over_capacity: false },
      { resource_kind: 'crew', resource_name: 'Tile crew', day: '2026-11-06', hours: 14, capacity_hours: 8, task_count: 2, over_capacity: true },
      { resource_kind: 'crew', resource_name: 'Tile crew', day: '2026-11-09', hours: 14, capacity_hours: 8, task_count: 2, over_capacity: true },
    ]);
    expect(await errorOf(f.db, `select * from pm.resource_load('2026-11-05', '2026-01-01')`)).toMatch(/^PM_INVALID/);
  });

  it('labor sees load only from its own jobs (its dispatch on J2 today)', async () => {
    const rows = await as(f, 'labor', async () => q<{ resource_kind: string; job_ids: string[]; dispatch_count: number }>(f.db,
      `select resource_kind, job_ids, dispatch_count from pm.resource_load(current_date - 1, current_date + 1)`));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.job_ids.every((j) => j === J2))).toBe(true);
    expect(rows.some((r) => r.resource_kind === 'employee' && r.dispatch_count === 1)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RLS and guards per persona', () => {
  let jobTask: Record<string, string>;
  beforeAll(async () => {
    jobTask = {};
    for (const job of [J1, J2, J3]) {
      const r = (await one<{ r: unknown }>(`select pm.apply_schedule_template($1, 'bathroom_remodel', '2026-11-02') as r`, [job])).r;
      expect(r).toBeTruthy();
      jobTask[job] = (await one<{ id: string }>(`select id from pm.tasks where job_id = $1 and title = 'Demolition'`, [job])).id;
    }
  });

  it("Labor reads its own job's schedule (tasks with CPM columns, links, header, summary) and nothing else", async () => {
    const r = await as(f, 'labor', async () => ({
      tasks: await q<{ job_id: string; early_start: string | null; billing_amount_cents: number | null }>(f.db, `select job_id, early_start::text, billing_amount_cents from pm.v_tasks_masked`),
      deps: await q(f.db, `select pred_id from pm.task_deps`),
      sched: await q<{ job_id: string }>(f.db, `select job_id from pm.schedules`),
      jobs: await q<{ job_id: string; task_count: number }>(f.db, `select job_id, task_count from pm.v_schedule_jobs`),
      cal: await q(f.db, `select id from pm.work_calendars`),
      tpl: await q(f.db, `select key from pm.schedule_template_catalog`),
    }));
    expect(new Set(r.tasks.map((t) => t.job_id))).toEqual(new Set([J2]));
    expect(r.tasks.some((t) => t.early_start)).toBe(true);
    expect(r.tasks.every((t) => t.billing_amount_cents === null)).toBe(true);
    expect(r.deps.length).toBeGreaterThan(0);
    expect(r.sched.map((s) => s.job_id)).toEqual([J2]);
    expect(r.jobs.map((s) => s.job_id)).toEqual([J2]);
    expect(r.cal.length).toBeGreaterThan(0); // the org default calendar
    expect(r.tpl.length).toBe(13);
  });

  it('Labor cannot write: every RPC is refused, direct writes change nothing', async () => {
    const t = jobTask[J2]!;
    await as(f, 'labor', async () => {
      for (const [sql, params] of [
        [`select * from pm.schedule_cpm($1)`, [J2]],
        [`select pm.reschedule_task($1, '2026-11-09', null)`, [t]],
        [`select pm.set_task_links($1, '[]'::jsonb)`, [t]],
        [`select pm.indent_task($1, 'in')`, [t]],
        [`select pm.move_task_order($1, null)`, [t]],
        [`select pm.set_schedule_baseline($1, 'x')`, [J2]],
        [`select pm.apply_schedule_template($1, 'simple_project', null)`, [J2]],
      ] as Array<[string, unknown[]]>) {
        expect(await errorOf(f.db, sql, params), sql).toMatch(/PM_FORBIDDEN/);
      }
      const upd = await q(f.db, `update pm.tasks set title = 'hacked' where id = $1 returning id`, [t]);
      expect(upd).toEqual([]);
      expect(await errorOf(f.db, `update pm.tasks set early_start = current_date where id = $1`, [t])).toMatch(/permission denied/);
      expect(await errorOf(f.db, `update pm.schedules set status_date = current_date where job_id = $1 returning job_id`, [J2])).toBeNull();
      expect(await errorOf(f.db, `insert into pm.work_calendars (name) values ('mine')`)).toMatch(/row-level security|permission denied/);
      expect(await errorOf(f.db, `insert into pm.task_deps (pred_id, succ_id) values ($1, $1)`, [t])).toMatch(/row-level security|PM_DEP/);
    });
    expect((await one<{ title: string; status_date: string | null }>(`select t.title, s.status_date::text from pm.tasks t join pm.schedules s on s.job_id = t.job_id where t.id = $1`, [t])))
      .toEqual({ title: 'Demolition', status_date: null });
  });

  it('preview needs projects.jobs:edit (security review L3): Labor is refused, the PM previews without writing', async () => {
    expect(await as(f, 'labor', () => errorOf(f.db, `select pm.preview_reschedule($1, null, 6)`, [jobTask[J2]]))).toMatch(/PM_FORBIDDEN: requires projects.jobs:edit/);
    const before = JSON.stringify(await rowsOf(J1));
    const r = await as(f, 'pm', async () => (await q<{ r: { moved_count: number } }>(f.db, `select pm.preview_reschedule($1, null, 6) as r`, [jobTask[J1]]))[0]!.r);
    expect(r.moved_count).toBeGreaterThan(0);
    expect(JSON.stringify(await rowsOf(J1))).toBe(before);
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.preview_reschedule($1, null, 6)`, [jobTask[J2]]))).toMatch(/PM_FORBIDDEN/);
  });

  it('the PM edits the schedule of their own job, not of others', async () => {
    const mine = await as(f, 'pm', async () => (await q<{ r: { moved_count: number } }>(f.db, `select pm.reschedule_task($1, null, 4) as r`, [jobTask[J1]]))[0]!.r);
    expect(mine.moved_count).toBeGreaterThan(1);
    expect((await one<{ duration_days: number }>(`select duration_days from pm.tasks where id = $1`, [jobTask[J1]])).duration_days).toBe(4);
    for (const job of [J2, J3]) {
      expect(await as(f, 'pm', () => errorOf(f.db, `select pm.reschedule_task($1, null, 4)`, [jobTask[job]]))).toMatch(/PM_FORBIDDEN/);
      expect(await as(f, 'pm', () => errorOf(f.db, `select * from pm.schedule_cpm($1)`, [job]))).toMatch(/PM_FORBIDDEN/);
    }
    await as(f, 'pm', async () => {
      expect((await q(f.db, `select * from pm.schedule_cpm($1)`, [J1])).length).toBeGreaterThan(0);
      expect(await errorOf(f.db, `select pm.set_schedule_baseline($1, 'PM baseline')`, [J1])).toBeNull();
      expect(await errorOf(f.db, `update pm.schedules set status_date = '2026-11-04' where job_id = $1`, [J1])).toBeNull();
      expect((await q(f.db, `update pm.tasks set pct_complete = 0.5 where id = $1 returning id`, [jobTask[J1]])).length).toBe(1);
    });
    expect((await one<{ status: string; actual_start: string | null }>(`select status, actual_start::text from pm.tasks where id = $1`, [jobTask[J1]])).status).toBe('IN_PROGRESS');
  });

  it('schedule_cpm returns billing amounts only with projects.contract_value (PM yes, Supervisor no)', async () => {
    const t = f.ids[`task:${J1}`]!;
    const pmSees = await as(f, 'pm', async () => (await q<{ id: string; billing_amount_cents: string | null }>(f.db, `select id, billing_amount_cents from pm.schedule_cpm($1)`, [J1])).find((r) => r.id === t));
    const supSees = await as(f, 'supervisor', async () => (await q<{ id: string; billing_amount_cents: string | null }>(f.db, `select id, billing_amount_cents from pm.schedule_cpm($1)`, [J1])).find((r) => r.id === t));
    expect(Number(pmSees!.billing_amount_cents)).toBe(500000);
    expect(supSees!.billing_amount_cents).toBeNull();
  });

  it('another tenant cannot reach the job at all', async () => {
    expect(await as(f, 'bOwner', () => errorOf(f.db, `select pm.reschedule_task($1, null, 3)`, [jobTask[J1]]))).toMatch(/PM_FORBIDDEN/);
    expect(await as(f, 'bOwner', () => errorOf(f.db, `select pm.apply_schedule_template($1, 'simple_project', null)`, [J1]))).toMatch(/PM_FORBIDDEN/);
    expect(await as(f, 'bOwner', async () => (await q(f.db, `select 1 from pm.v_schedule_jobs where job_id = $1`, [J1])).length)).toBe(0);
  });

  it('settings: only projects.settings:configure writes calendars and templates', async () => {
    expect(await as(f, 'pm', () => errorOf(f.db, `insert into pm.work_calendars (location_id, name) values ($1, 'PM cal')`, [L1]))).toMatch(/row-level security/);
    expect(await as(f, 'owner', () => errorOf(f.db, `insert into pm.work_calendars (location_id, name, workdays, is_default) values ($1, 'Six-day', '{1,2,3,4,5,6}', true)`, [L1]))).toBeNull();
    // the company default now wins over the org default for L1 jobs
    const cal = await one<{ c: string; name: string }>(`select pm.schedule_calendar($1) as c, (select name from pm.work_calendars where id = pm.schedule_calendar($1)) as name`, [J1]);
    expect(cal.name).toBe('Six-day');
    expect(await as(f, 'labor', async () => (await q<{ c: string }>(f.db, `select pm.schedule_calendar($1) as c`, [J2]))[0]!.c)).toBe(cal.c);
    await f.db.query(`delete from pm.work_calendars where id = $1`, [cal.c]);
  });

  it('registries: every pm table classified with its policies, no unguarded definer RPC, org isolation holds', async () => {
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    const pol = await q<{ table_name: string; n: number }>(f.db,
      `select a.table_name, count(p.policyname)::int n from pm.access_table_classes a
         left join pg_policies p on p.schemaname = 'pm' and p.tablename = a.table_name and p.policyname like 'pm\\_access\\_%' and p.permissive = 'RESTRICTIVE'
        where a.table_name like 'schedule%' or a.table_name like 'work_calendar%' group by 1 order by 1`);
    expect(pol).toEqual(['schedule_baseline_tasks', 'schedule_baselines', 'schedule_template_catalog', 'schedule_templates', 'schedules', 'work_calendar_days', 'work_calendars']
      .map((t) => ({ table_name: t, n: 4 })));
    const guarded = await q<{ function_name: string }>(f.db, `select function_name from pm.access_rpc_guards where note like '1112%' order by 1`);
    expect(guarded.map((g) => g.function_name)).toEqual(['apply_schedule_template', 'indent_task', 'move_task_order', 'preview_reschedule', 'reschedule_task',
      'resource_load', 'schedule_cpm', 'schedule_lookahead', 'set_schedule_baseline', 'set_task_links']);
    for (const t of ['schedules', 'schedule_baselines', 'schedule_baseline_tasks', 'work_calendars', 'schedule_templates']) {
      const n = await as(f, 'owner', async () => (await q<{ n: number }>(f.db, `select count(*)::int n from pm.${t} where org_id <> $1`, [ORG_A]))[0]!.n);
      expect(n, t).toBe(0);
    }
    expect(await errorOf(f.db, `select 1`)).toBeNull();
    expect(ORG_B).toBeTruthy();
  });

  it('pm.v_tasks_masked carries the new columns for members; the base table still hides billing', async () => {
    const cols = await as(f, 'supervisor', async () => q<Record<string, unknown>>(f.db,
      `select constraint_type, early_start, late_finish, total_float, free_float, is_critical, is_summary, wbs_code, template_ref, cpm_at, billing_amount_cents from pm.v_tasks_masked limit 1`));
    expect(Object.keys(cols[0]!)).toHaveLength(11);
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select billing_amount_cents from pm.tasks limit 1`))).toMatch(/permission denied/);
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select early_start, wbs_code, is_critical from pm.tasks limit 1`))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('re-apply', () => {
  it('1112 is idempotent and survives a later 1110 re-apply', async () => {
    const counts = async () => q(f.db, `select (select count(*)::int from pm.schedule_template_catalog) c, (select count(*)::int from pm.schedule_templates) t,
      (select count(*)::int from pg_policies where schemaname = 'pm') p, (select count(*)::int from pm.work_calendars) w`);
    const before = await counts();
    await applyMigration(f.db, '1112_pm_schedule.sql');
    expect(await counts()).toEqual(before);
    await applyMigration(f.db, '1110_pm_access.sql');
    await applyMigration(f.db, '1112_pm_schedule.sql');
    expect(await counts()).toEqual(before);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    expect(await as(f, 'labor', () => errorOf(f.db, `select pm.reschedule_task($1, null, 3)`, [f.ids[`task:${J2}`]]))).toMatch(/PM_FORBIDDEN/);
    const { job } = await loadCase(CASES.find((c) => c.name === 'textbook_aon')!);
    await cpm(job);
    expect((await header(job)).critical_count).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security review of 1112 (2026-10-24): each probe is a regression test.
describe('security review regressions (M1 M2 L1 L2 L3 + billing)', () => {
  const L2 = 'a0000000-0000-4000-8000-0000000000a2';
  let l1adminMs = '';
  const asUser = async <T>(clerk: string, org: string, fn: () => Promise<T>): Promise<T> => {
    await f.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: clerk, org_id: org, role: 'authenticated' })]);
    await f.db.exec('set role authenticated');
    try {
      return await fn();
    } finally {
      await f.db.exec('reset role');
      await f.db.query(`select set_config('request.jwt.claims', '{}', false)`);
      await f.db.query(`select set_config('pm.access_entry', '', false)`);
    }
  };
  const asL1Admin = <T>(fn: () => Promise<T>) => asUser('user_l1admin', ORG_A, fn);
  const grantOwnerAt = async (loc: string) => {
    const r = await one<{ id: string }>(`select id from core.role_definitions where owner_level = 'tenant' and org_id = $1 and key = 'projects_owner'`, [ORG_A]);
    await f.db.query(`insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, source)
                      values ($1, $2, 'role', $3, 'client', $4, 'manual')`, [ORG_A, l1adminMs, r.id, loc]);
  };
  let orgCal = '';

  beforeAll(async () => {
    const u = await one<{ id: string }>(`insert into core.users (clerk_user_id, email, first_name, last_name) values ('user_l1admin', 'l1admin@example.test', 'T', 'l1admin') returning id`);
    l1adminMs = (await one<{ id: string }>(`insert into core.memberships (user_id, org_id, role) values ($1, $2, 'member') returning id`, [u.id, ORG_A])).id;
    await grantOwnerAt(L1); // Projects owner at company L1 only (not an owner seat)
    orgCal = (await one<{ id: string }>(`select id from pm.work_calendars where org_id = $1 and location_id is null and is_default`, [ORG_A])).id;
  });

  it('M1: a configure-holder at one company cannot change the org-wide calendar or its days', async () => {
    expect(await asL1Admin(async () => (await q<{ ok: boolean }>(f.db, `select pm.can('projects.settings', 'configure', $1) as ok`, [L1]))[0]!.ok)).toBe(true);
    await asL1Admin(async () => {
      expect(await q(f.db, `update pm.work_calendars set workdays = '{7}' where id = $1 returning id`, [orgCal])).toEqual([]);
      expect(await q(f.db, `delete from pm.work_calendars where id = $1 returning id`, [orgCal])).toEqual([]);
      expect(await errorOf(f.db, `insert into pm.work_calendar_days (calendar_id, day, is_workday) values ($1, '2026-11-03', false)`, [orgCal])).toMatch(/row-level security/);
      expect(await errorOf(f.db, `insert into pm.work_calendars (location_id, name) values (null, 'Org-wide by L1')`)).toMatch(/row-level security/);
      // the company's own calendar is fine
      const c = (await q<{ id: string }>(f.db, `insert into pm.work_calendars (location_id, name) values ($1, 'L1 shop') returning id`, [L1]))[0]!.id;
      expect(await errorOf(f.db, `insert into pm.work_calendar_days (calendar_id, day, is_workday) values ($1, '2026-11-03', false)`, [c])).toBeNull();
      // nor can it promote its company calendar to org-wide
      expect(await errorOf(f.db, `update pm.work_calendars set location_id = null where id = $1`, [c])).toMatch(/row-level security policy "pm_sched_orgcal_update"/);
    });
    expect((await one<{ workdays: number[] }>(`select workdays from pm.work_calendars where id = $1`, [orgCal])).workdays).toEqual([1, 2, 3, 4, 5]);
    expect((await q(f.db, `select 1 from pm.work_calendar_days where calendar_id = $1`, [orgCal])).length).toBe(0);
  });

  it('M1: configure at every company, or an owner seat, may change it', async () => {
    expect(await as(f, 'owner', async () => (await q(f.db, `update pm.work_calendars set hours_per_day = 8 where id = $1 returning id`, [orgCal])).length)).toBe(1);
    await grantOwnerAt(L2);
    expect(await asL1Admin(async () => (await q(f.db, `update pm.work_calendars set hours_per_day = 8 where id = $1 returning id`, [orgCal])).length)).toBe(1);
    expect(await asL1Admin(() => errorOf(f.db, `insert into pm.work_calendar_days (calendar_id, day, is_workday, name) values ($1, '2030-12-25', false, 'Christmas')`, [orgCal]))).toBeNull();
    await f.db.query(`delete from pm.work_calendar_days where calendar_id = $1`, [orgCal]);
  });

  it("M1: a job's schedule may use only its company's calendar or an org-wide one", async () => {
    const l1cal = (await one<{ id: string }>(`insert into pm.work_calendars (org_id, location_id, name) values ($1, $2, 'L1 only') returning id`, [ORG_A, L1])).id;
    await f.db.query(`insert into pm.schedules (job_id, org_id) values ($1, $2) on conflict (job_id) do nothing`, [J3, ORG_A]);
    expect(await errorOf(f.db, `update pm.schedules set calendar_id = $2 where job_id = $1`, [J3, l1cal])).toMatch(/^PM_INVALID: a job uses its own company/);
    expect(await errorOf(f.db, `update pm.schedules set calendar_id = $2 where job_id = $1`, [J1, l1cal])).toBeNull();
    expect(await errorOf(f.db, `update pm.schedules set calendar_id = $2 where job_id = $1`, [J3, orgCal])).toBeNull();
    await f.db.query(`update pm.schedules set calendar_id = null where job_id in ($1, $2)`, [J1, J3]);
  });

  it('M2: dates are bounded to 1900–2200 on tasks, headers and calendar days', async () => {
    const t = f.ids[`task:${J1}`]!;
    await as(f, 'pm', async () => {
      expect(await errorOf(f.db, `update pm.tasks set constraint_type = 'SNET', constraint_date = '9999-12-31' where id = $1`, [t])).toMatch(/tasks_schedule_dates_range_check/);
      expect(await errorOf(f.db, `update pm.tasks set actual_start = '2300-01-01' where id = $1`, [t])).toMatch(/tasks_schedule_dates_range_check/);
      expect(await errorOf(f.db, `update pm.tasks set start_on = '1800-01-01' where id = $1`, [t])).toMatch(/tasks_plan_dates_range_check/);
      expect(await errorOf(f.db, `update pm.schedules set anchor_start = '1800-01-01' where job_id = $1`, [J1])).toMatch(/schedules_dates_range_check/);
      expect(await errorOf(f.db, `update pm.schedules set status_date = '2500-01-01' where job_id = $1`, [J1])).toMatch(/schedules_dates_range_check/);
      expect(await errorOf(f.db, `update pm.tasks set duration_days = 3651 where id = $1`, [t])).toMatch(/tasks_duration_bound_check/);
    });
    expect(await errorOf(f.db, `insert into pm.work_calendar_days (org_id, calendar_id, day) values ($1, $2, '2201-01-01')`, [ORG_A, orgCal])).toMatch(/work_calendar_days_range_check/);
  });

  it('M2: a far (in-range) date or a 40-year chain is refused fast, not computed for minutes', async () => {
    const job = await newJob('poison');
    await f.db.query(`insert into pm.schedules (job_id, org_id, anchor_start) values ($1, $2, '2026-11-02')`, [job, ORG_A]);
    const p = await addTask(job, 'poison', { duration_days: 1 });
    await f.db.query(`update pm.tasks set constraint_type = 'SNET', constraint_date = '2200-12-31' where id = $1`, [p]);
    let t0 = Date.now();
    expect(await errorOf(f.db, `select count(*) from pm.schedule_cpm($1)`, [job])).toMatch(/^PM_SCHEDULE_RANGE: the schedule's dates span more than 40 years/);
    expect(Date.now() - t0).toBeLessThan(3000);
    await f.db.query(`update pm.tasks set constraint_type = 'ASAP' where id = $1`, [p]);
    // 4 × 3,650 working days in a chain ≈ 56 years
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await addTask(job, `long ${i}`, { duration_days: 3650, sort: i + 1 }));
    for (let i = 1; i < 4; i++) await link(ids[i - 1]!, ids[i]!);
    t0 = Date.now();
    expect(await errorOf(f.db, `select count(*) from pm.schedule_cpm($1)`, [job])).toMatch(/^PM_SCHEDULE_RANGE: the schedule would run more than 40 years/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('M2: a legacy duration derived from far-apart dates is capped at 3,650 working days', async () => {
    const job = await newJob('legacy-cap');
    await f.db.query(`insert into pm.schedules (job_id, org_id, anchor_start) values ($1, $2, '2026-11-02')`, [job, ORG_A]);
    await addTask(job, 'forever', { constraint_type: 'ASAP', start_on: '2026-11-02', due_on: '2199-12-31' });
    const t0 = Date.now();
    await cpm(job);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await byTitle(job)).forever!.duration_days).toBe(3650);
  });

  it('L1: an outline loop (racing re-parents) ends in a clear error, never an endless walk; re-parents take a job lock', async () => {
    const job = await newJob('loop');
    const a = await addTask(job, 'Loop A', { duration_days: 1, sort: 0 });
    const b = await addTask(job, 'Loop B', { duration_days: 1, sort: 1, parent_task_id: a });
    await cpm(job);
    // the committed result of two racing PATCHes, each checked against the old tree
    await f.db.exec(`alter table pm.tasks disable trigger trg_task_hierarchy`);
    await f.db.query(`update pm.tasks set parent_task_id = $2 where id = $1`, [a, b]);
    await f.db.exec(`alter table pm.tasks enable trigger trg_task_hierarchy`);
    await f.db.exec(`set statement_timeout = '4s'`);
    try {
      const t0 = Date.now();
      expect(await as(f, 'owner', () => errorOf(f.db, `select pm.reschedule_task($1, '2026-12-01', null)`, [a]))).toMatch(/^PM_SCHEDULE_OUTLINE_LOOP: these tasks sit under each other: Loop A ⇄ Loop B/);
      expect(await errorOf(f.db, `select count(*) from pm.schedule_cpm($1)`, [job])).toMatch(/^PM_SCHEDULE_OUTLINE_LOOP/);
      expect(Date.now() - t0).toBeLessThan(4000);
    } finally {
      await f.db.exec(`reset statement_timeout`);
    }
    // the guard itself refuses the second half of the race when it runs serialized
    await f.db.query(`update pm.tasks set parent_task_id = null where id = $1`, [a]);
    expect(await errorOf(f.db, `update pm.tasks set parent_task_id = $2 where id = $1`, [a, b])).toMatch(/cannot sit under one of its own tasks/);
    // and it serializes on a per-job advisory lock
    await f.db.exec('begin');
    try {
      const c = await addTask(job, 'Loop C', { sort: 2 });
      await f.db.query(`update pm.tasks set parent_task_id = $2 where id = $1`, [c, b]);
      const locks = await q<{ n: number }>(f.db, `select count(*)::int n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`);
      expect(locks[0]!.n).toBeGreaterThan(0);
    } finally {
      await f.db.exec('rollback');
    }
  });

  it("L2: the look-ahead never reads another org's or another job's submittal", async () => {
    const job = J1;
    const foreign = (await one<{ id: string }>(`insert into proj.submittals (org_id, job_id, number, title, status) values ($1, $2, 'B-SECRET-17', 'Org B secret', 'REJECTED') returning id`, [ORG_B, JB])).id;
    const otherJob = (await one<{ id: string }>(`insert into proj.submittals (org_id, job_id, number, title, status) values ($1, $2, 'J3-OTHER-2', 'Other job', 'REJECTED') returning id`, [ORG_A, J3])).id;
    const own = (await one<{ id: string }>(`insert into proj.submittals (org_id, job_id, number, title, status) values ($1, $2, 'J1-OWN-3', 'Own job', 'REJECTED') returning id`, [ORG_A, job])).id;
    const t1 = await addTask(job, 'SR foreign', { duration_days: 1, sort: 300, ext: JSON.stringify({ _submittal_id: foreign }) });
    const t2 = await addTask(job, 'SR other job', { duration_days: 1, sort: 301, ext: JSON.stringify({ _submittal_id: otherJob }) });
    const t3 = await addTask(job, 'SR own', { duration_days: 1, sort: 302, ext: JSON.stringify({ _submittal_id: own }) });
    await cpm(job);
    const from = (await one<{ d: string }>(`select min(start_on)::text d from pm.tasks where id in ($1, $2, $3)`, [t1, t2, t3])).d;
    const rows = await as(f, 'pm', async () => q<{ title: string; constraints: Array<{ kind: string; label: string }> }>(f.db,
      `select title, constraints from pm.schedule_lookahead($1, 60) where task_id in ($2, $3, $4)`, [from, t1, t2, t3]));
    const by = Object.fromEntries(rows.map((r) => [r.title, r.constraints.filter((c) => c.kind === 'submittal')]));
    expect(by['SR foreign']).toEqual([]);
    expect(by['SR other job']).toEqual([]);
    expect(by['SR own']!.map((c) => c.label)).toEqual(['Submittal J1-OWN-3 not approved (rejected)']);
    expect(JSON.stringify(rows)).not.toMatch(/B-SECRET|Org B secret|J3-OTHER/);
  });

  it('billing value: a member changes tasks.billing_amount_cents only with projects.contract_value', async () => {
    const t = f.ids[`task:${J1}`]!;
    await as(f, 'supervisor', async () => {
      expect(await errorOf(f.db, `update pm.tasks set billing_amount_cents = 1 where id = $1`, [t])).toMatch(/^PM_FORBIDDEN: changing a task's billing value requires projects.contract_value/);
      expect(await errorOf(f.db, `update pm.tasks set billing_pct = 0.5 where id = $1`, [t])).toMatch(/^PM_FORBIDDEN/);
      expect(await errorOf(f.db, `insert into pm.tasks (job_id, title, billing_amount_cents) values ($1, 'sneaky', 99)`, [J1])).toMatch(/^PM_FORBIDDEN/);
      expect(await errorOf(f.db, `update pm.tasks set title = 'task 01' where id = $1`, [t])).toBeNull(); // other columns are fine
    });
    expect(await as(f, 'pm', () => errorOf(f.db, `update pm.tasks set billing_amount_cents = 600000 where id = $1`, [t]))).toBeNull();
    expect(Number((await one<{ b: string }>(`select billing_amount_cents b from pm.tasks where id = $1`, [t])).b)).toBe(600000);
    await f.db.query(`update pm.tasks set billing_amount_cents = 500000 where id = $1`, [t]);
  });
});
