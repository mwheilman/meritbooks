/**
 * 1112 CPM at the spec's scale (WAVE1-SCHEDULE-SPEC acceptance 7: 2,000 tasks): 100 phases × 19 tasks
 * with ~2,800 links (chains, phase-to-phase FS, SS / FF / SF overlaps with lags), on the PGlite replay
 * (WASM Postgres — slower than the hosted database). Logs the timings; the bounds are generous ceilings.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildFixture, applyAfter1110, q, type Fixture, ORG_A, L1 } from './fixture';

let f: Fixture;
let job: string;
const timings: Record<string, number> = {};

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  timings[label] = Math.round(performance.now() - t0);
  return r;
}

beforeAll(async () => {
  f = await buildFixture();
  await applyAfter1110(f.db);
  const j = await q<{ id: string }>(f.db, `insert into core.jobs (org_id, location_id, job_number, name) values ($1, $2, 'PERF-1', 'Perf') returning id`, [ORG_A, L1]);
  job = j[0]!.id;
  await f.db.query(`insert into pm.projects (job_id, org_id, location_id, job_type_id, stage_key) values ($1, $2, $3, $4, 'active')`, [job, ORG_A, L1, f.ids[`jobType:${L1}`]]);
  await f.db.query(`insert into pm.schedules (job_id, org_id, anchor_start) values ($1, $2, '2026-11-02')`, [job, ORG_A]);
  await timed('insert 2,000 tasks', async () => {
    await f.db.query(`insert into pm.tasks (org_id, job_id, title, sort, template_ref)
                      select $1, $2, 'Phase ' || p, (p - 1) * 20, 'perf:p' || p from generate_series(1, 100) p`, [ORG_A, job]);
    await f.db.query(`insert into pm.tasks (org_id, job_id, title, sort, template_ref, duration_days, parent_task_id)
                      select $1, $2, 'Task ' || p || '.' || k, (p - 1) * 20 + k, 'perf:p' || p || '_' || k, 1 + (p * 7 + k * 3) % 6,
                             (select x.id from pm.tasks x where x.org_id = $1 and x.job_id = $2 and x.template_ref = 'perf:p' || p)
                        from generate_series(1, 100) p, generate_series(1, 19) k`, [ORG_A, job]);
  });
  await timed('insert links (one statement, loop check once)', async () => {
    await f.db.query(`
      with l as (
        select 'perf:p' || p || '_' || k as a, 'perf:p' || p || '_' || (k + 1) as b, 'FS' as typ, 0 as lag
          from generate_series(1, 100) p, generate_series(1, 18) k
        union all
        select 'perf:p' || p || '_19', 'perf:p' || (p + 1) || '_1', 'FS', 1 from generate_series(1, 99) p
        union all
        select 'perf:p' || p || '_' || k, 'perf:p' || p || '_' || (k + 3), case k % 3 when 0 then 'SS' when 1 then 'FF' else 'SF' end, k % 4
          from generate_series(1, 100) p, generate_series(1, 16, 2) k
        union all
        select 'perf:p' || p || '_5', 'perf:p' || (p + 2) || '_10', 'FS', -2 from generate_series(1, 98, 3) p
      )
      insert into pm.task_deps (org_id, pred_id, succ_id, dep_type, lag_days)
      select $1, ta.id, tb.id, l.typ, l.lag
        from l join pm.tasks ta on ta.org_id = $1 and ta.job_id = $2 and ta.template_ref = l.a
               join pm.tasks tb on tb.org_id = $1 and tb.job_id = $2 and tb.template_ref = l.b
      on conflict (pred_id, succ_id) do nothing`, [ORG_A, job]);
  });
}, 600_000);

afterAll(async () => {
  console.log('[schedule-perf] timings (ms):', JSON.stringify(timings));
  await f?.db.close();
});

describe('job size cap (security review M2)', () => {
  it('more than 10,000 tasks on a job are refused in one statement, nothing is kept', async () => {
    const j = await q<{ id: string }>(f.db, `insert into core.jobs (org_id, location_id, job_number, name) values ($1, $2, 'PERF-CAP', 'Cap') returning id`, [ORG_A, L1]);
    const err = await timed('insert 10,001 tasks (refused)', async () => {
      try {
        await f.db.query(`insert into pm.tasks (org_id, job_id, title, duration_days) select $1, $2, 'T' || k, 1 from generate_series(1, 10001) k`, [ORG_A, j[0]!.id]);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(err).toBe('PM_SCHEDULE_TOO_LARGE: a schedule holds at most 10,000 tasks');
    expect((await q<{ n: number }>(f.db, `select count(*)::int n from pm.tasks where job_id = $1`, [j[0]!.id]))[0]!.n).toBe(0);
  });
});

describe('CPM on 2,000 tasks', () => {
  it('the network is the spec size', async () => {
    const n = await q<{ tasks: number; links: number }>(f.db,
      `select (select count(*)::int from pm.tasks where job_id = $1) tasks,
              (select count(*)::int from pm.task_deps d join pm.tasks t on t.id = d.succ_id where t.job_id = $1) links`, [job]);
    expect(n[0]!.tasks).toBe(2000);
    expect(n[0]!.links).toBeGreaterThan(2700);
  });

  it('pm.schedule_cpm computes and writes 2,000 tasks', async () => {
    const rows = await timed('schedule_cpm first run (2,000 tasks written)', () => q(f.db, `select * from pm.schedule_cpm($1)`, [job]));
    expect(rows.length).toBe(2000);
    const h = await q<{ finish_on: string; critical_count: number; task_count: number }>(f.db,
      `select finish_on::text, critical_count, task_count from pm.schedules where job_id = $1`, [job]);
    expect(h[0]!.task_count).toBe(1900);
    expect(h[0]!.critical_count).toBeGreaterThan(19);
    const bad = await q(f.db, `select 1 from pm.tasks where job_id = $1 and (start_on is null or due_on is null or total_float < 0 or early_start is null)`, [job]);
    expect(bad).toEqual([]);
    expect(timings['schedule_cpm first run (2,000 tasks written)']!).toBeLessThan(30_000);
  });

  it('a second run is idempotent (no row rewritten)', async () => {
    const before = await q(f.db, `select max(updated_at)::text m from pm.tasks where job_id = $1`, [job]);
    await timed('schedule_cpm second run (no change)', () => q(f.db, `select count(*) from pm.schedule_cpm($1)`, [job]));
    expect(await q(f.db, `select max(updated_at)::text m from pm.tasks where job_id = $1`, [job])).toEqual(before);
    expect(timings['schedule_cpm second run (no change)']!).toBeLessThan(30_000);
  });

  it('preview and reschedule of an early task cascade through the network', async () => {
    const t = (await q<{ id: string }>(f.db, `select id from pm.tasks where job_id = $1 and template_ref = 'perf:p1_2'`, [job]))[0]!.id;
    const p = await timed('preview_reschedule', () => q<{ r: { moved_count: number; finish_delta_days: number } }>(f.db, `select pm.preview_reschedule($1, null, 12) as r`, [t]));
    const r = await timed('reschedule_task', () => q<{ r: { moved_count: number; finish_delta_days: number } }>(f.db, `select pm.reschedule_task($1, null, 12) as r`, [t]));
    expect(r[0]!.r.moved_count).toBeGreaterThan(1000);
    expect(r[0]!.r.finish_delta_days).toBeGreaterThan(0);
    expect(p[0]!.r.moved_count).toBe(r[0]!.r.moved_count);
    expect(timings.reschedule_task!).toBeLessThan(30_000);
  });
});
