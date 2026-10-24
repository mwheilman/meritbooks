import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { scopedJobs } from '@/lib/pm/scoped';
import { listOpenTasks } from '@/lib/pm/work';
import { employeeNames } from '@/lib/pm/people';
import { loadCrews, loadLookahead, loadResourceLoad, loadScheduleJobs } from '@/lib/pm/schedule/server';
import { dayNum, isoOf } from '@/lib/pm/schedule/calendar';
import type { LookaheadRow, ScheduleJobRow } from '@/lib/pm/schedule/types';
import type { TaskRow } from '@/lib/pm/types';
import { addDays, todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { GlobalSchedule, type GlobalJob, type GlobalView } from '@/components/schedule/GlobalSchedule';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Schedule' };

const VIEWS: readonly GlobalView[] = ['jobs', 'lookahead', 'crews'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function monday(iso: string): string {
  const n = dayNum(iso);
  return isoOf(n - ((new Date(n * 86_400_000).getUTCDay() + 6) % 7));
}

/** Per-job summary from open tasks when pm.v_schedule_jobs isn't there yet. */
function summaryFromTasks(jobIds: ReadonlyArray<string>, tasks: ReadonlyArray<TaskRow>, today: string): ScheduleJobRow[] {
  const by = new Map<string, ScheduleJobRow>(jobIds.map((id) => [id, { job_id: id, start_on: null, finish_on: null, baseline_finish: null, task_count: 0, open_count: 0, critical_count: 0, pct_complete: null, late_count: 0 }]));
  for (const t of tasks) {
    const r = by.get(t.job_id);
    if (!r) continue;
    r.task_count += 1;
    r.open_count += 1;
    const s = t.start_on ?? t.due_on;
    if (s && (!r.start_on || s < r.start_on)) r.start_on = s;
    if (t.due_on && (!r.finish_on || t.due_on > r.finish_on)) r.finish_on = t.due_on;
    if (t.due_on && t.due_on < today) r.late_count += 1;
  }
  return [...by.values()];
}

/** Look-ahead rows from open tasks (no constraint reasons) when pm.schedule_lookahead isn't there yet. */
function lookaheadFromTasks(tasks: ReadonlyArray<TaskRow>, from: string, days: number): LookaheadRow[] {
  const to = addDays(from, days - 1);
  return tasks
    .filter((t) => {
      const s = t.start_on ?? t.due_on;
      const f = t.due_on ?? t.start_on;
      return !!s && !!f && s <= to && f >= from;
    })
    .map((t) => ({
      task_id: t.id, job_id: t.job_id, title: t.title, start_on: t.start_on ?? t.due_on, due_on: t.due_on ?? t.start_on, status: t.status,
      pct_complete: null, crew_id: null, crew_name: null, trade: null, is_critical: false, constraints: [],
    }));
}

export default async function SchedulePage({ searchParams }: { searchParams: { view?: string; from?: string; crew?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  await guardPage('/schedule');
  const db = await requireDb();
  const today = todayIso();
  const view: GlobalView = (VIEWS as readonly string[]).includes(searchParams.view ?? '') ? (searchParams.view as GlobalView) : 'jobs';
  const from = monday(searchParams.from && DAY.test(searchParams.from) ? searchParams.from : today);

  const jobs = await scopedJobs(db, scope);
  const list = [...jobs.byId.values()].filter((j) => j.core_status !== 'CANCELLED' && j.core_status !== 'CLOSED');
  const ids = list.map((j) => j.job_id);
  const names = await employeeNames(db, list.map((j) => j.pm_user_id));
  const companyName = new Map(scope.tenant.companies.map((c) => [c.id, c.name]));
  // Only what the page draws crosses to the browser: no contract or cost figures.
  const globalJobs: GlobalJob[] = list.map((j) => ({
    id: j.job_id,
    label: [j.job_number, j.name].filter(Boolean).join(' · '),
    companyId: j.location_id,
    company: companyName.get(j.location_id) ?? null,
    pmId: j.pm_user_id,
    pm: j.pm_user_id ? names[j.pm_user_id] ?? 'Team member' : null,
    stage: j.stage_label ?? j.stage_key,
    plannedStart: j.planned_start,
    plannedFinish: j.planned_finish,
  }));

  let summaries: ScheduleJobRow[] = [];
  let engine = true;
  let lookahead: LookaheadRow[] = [];
  let crews: Awaited<ReturnType<typeof loadCrews>> = [];
  let load: Awaited<ReturnType<typeof loadResourceLoad>> = [];

  if (view === 'jobs') {
    const s = await loadScheduleJobs(db, ids);
    if (s) summaries = s;
    else {
      engine = false;
      summaries = summaryFromTasks(ids, await listOpenTasks(db, 5000), today);
    }
  } else if (view === 'lookahead') {
    const rows = await loadLookahead(db, from, 21);
    if (rows) lookahead = rows.filter((r) => jobs.byId.has(r.job_id));
    else {
      engine = false;
      lookahead = lookaheadFromTasks((await listOpenTasks(db, 5000)).filter((t) => jobs.byId.has(t.job_id)), from, 21);
    }
    crews = await loadCrews(db, scope.companyIds);
  } else {
    crews = await loadCrews(db, scope.companyIds);
    load = await loadResourceLoad(db, from, addDays(from, 13));
    if (load === null) engine = false;
  }

  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  const late = summaries.reduce((a, s) => a + s.late_count, 0);
  const facts =
    view === 'jobs'
      ? [where, { label: `${count(globalJobs.length)} open jobs`, strong: true }, ...(late ? [`${count(late)} late tasks`] : [])]
      : view === 'lookahead'
        ? [where, { label: `${count(lookahead.length)} tasks in the next 3 weeks`, strong: true }, `${count(lookahead.filter((r) => r.constraints.length).length)} with constraints`]
        : [where, { label: `${count(crews.length)} crews`, strong: true }];

  return (
    <>
      <PageLine facts={facts} />
      <Page>
        <PageHead eyebrow={where} title="Schedule" />
        <GlobalSchedule
          view={view}
          jobs={globalJobs}
          summaries={summaries}
          lookahead={lookahead}
          crews={crews}
          load={load ?? []}
          engine={engine}
          from={from}
          today={today}
          multi={scope.companyIds.length > 1}
          initialCrew={searchParams.crew && UUID.test(searchParams.crew) ? searchParams.crew : null}
        />
      </Page>
    </>
  );
}
