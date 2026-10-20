import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Scope } from '@/lib/scope';
import { addDays, todayIso } from '@/lib/time';
import { listActivity } from './activity';
import { checkGuards, listAllProjects, listJobTypes, listStages, listTransitions } from './projects';
import { listAllChangeOrders, listOpenTasksDue } from './work';
import { guardCopy, guardFixHref } from './guards';
import { isOverBudget, marginCents } from './money';
import type { ActivityRow, ChangeOrderRow, ProjectListRow, TaskRow } from './types';

export type NeedsGroup = 'blocked' | 'co' | 'overdue' | 'nobudget';

export interface NeedsItem {
  id: string;
  group: NeedsGroup;
  jobId: string;
  title: string;
  sub: string;
  company: string | null;
  amountCents: number | null;
  /** Days late (overdue tasks). */
  days: number | null;
  href: string;
  fix: string;
}

export interface RiskJob {
  job: ProjectListRow;
  company: string | null;
  marginCents: number;
  overdueTasks: number;
  reason: string;
}

export interface WeekTask {
  task: TaskRow;
  job: Pick<ProjectListRow, 'job_id' | 'job_number' | 'name'>;
}

export interface HomeData {
  today: string;
  companyNames: Record<string, string>;
  multiCompany: boolean;
  projects: ProjectListRow[];
  capped: boolean;
  needs: NeedsItem[];
  checkedJobs: number;
  openJobCount: number;
  risk: RiskJob[];
  week: WeekTask[];
  nextDue: WeekTask | null;
  overdueCount: number;
  openCos: ChangeOrderRow[];
  activity: ActivityRow[];
}

const GUARD_CHECK_CAP = 30;

export async function loadHome(db: SupabaseClient, scope: Scope): Promise<HomeData> {
  const today = todayIso();
  const weekEnd = addDays(today, 6);
  const ids = scope.companyIds;
  const [{ rows: projects, capped }, jobTypes, stages, transitions, tasks, cos, activity] = await Promise.all([
    listAllProjects(db, ids),
    listJobTypes(db, ids),
    listStages(db, ids),
    listTransitions(db, ids),
    listOpenTasksDue(db, addDays(today, 60)),
    listAllChangeOrders(db, { openOnly: true }),
    listActivity(db, { companyIds: ids }, 12),
  ]);
  const names = Object.fromEntries(scope.tenant.companies.map((c) => [c.id, c.name]));
  const multi = ids.length > 1;
  const byJob = new Map(projects.map((p) => [p.job_id, p]));
  const open = projects.filter((p) => !p.stage_is_terminal);
  const companyOf = (p: ProjectListRow) => (multi ? names[p.location_id] ?? null : null);
  const label = (p: ProjectListRow) => [p.job_number, p.name].filter(Boolean).join(' · ');

  // ---- blocked stage moves: each open job's next forward move, checked by pm.check_guards
  const machineOf = new Map(jobTypes.map((jt) => [`${jt.location_id}:${jt.key}`, jt.stage_machine_key]));
  const sortOf = new Map(stages.map((s) => [`${s.location_id}:${s.machine_key}:${s.stage_key}`, s]));
  const candidates = open
    .map((p) => {
      const machine = machineOf.get(`${p.location_id}:${p.job_type_key}`);
      if (!machine) return null;
      const cur = sortOf.get(`${p.location_id}:${machine}:${p.stage_key}`)?.sort ?? p.stage_sort ?? 0;
      const forward = transitions
        .filter((t) => t.location_id === p.location_id && t.machine_key === machine && t.from_stage === p.stage_key)
        .map((t) => ({ t, to: sortOf.get(`${p.location_id}:${machine}:${t.to_stage}`) }))
        .filter((x) => x.to && x.to.sort > cur && x.to.core_status !== 'CANCELLED')
        .sort((a, b) => (a.to!.sort - b.to!.sort) || (a.t.sort - b.t.sort))[0];
      return forward && forward.t.guards.length ? { p, t: forward.t, toLabel: forward.to!.label } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, GUARD_CHECK_CAP);
  const checked = await Promise.all(candidates.map(async (c) => ({ ...c, failing: await checkGuards(db, c.p.job_id, c.t.guards) })));

  const needs: NeedsItem[] = [];
  for (const c of checked) {
    if (c.failing.length === 0) continue;
    const first = c.failing[0]!;
    needs.push({
      id: `b:${c.p.job_id}`, group: 'blocked', jobId: c.p.job_id, title: label(c.p),
      sub: `Move to ${c.toLabel}: ${c.failing.map((g) => guardCopy(g).failing).join(' ')}`,
      company: companyOf(c.p), amountCents: null, days: null, href: guardFixHref(first, c.p.job_id), fix: guardCopy(first).fix.label,
    });
  }

  const scopedCos = cos.filter((co) => byJob.has(co.job_id));
  for (const co of scopedCos) {
    const p = byJob.get(co.job_id)!;
    needs.push({
      id: `c:${co.id}`, group: 'co', jobId: p.job_id, title: `${co.number ?? 'Change order'} · ${co.title}`,
      sub: `${label(p)} · ${co.stage === 'COR' ? 'Requested' : 'Potential'}`, company: companyOf(p),
      amountCents: co.amount_cents, days: null, href: `/jobs/${p.job_id}?tab=change-orders`, fix: 'Review',
    });
  }

  const scopedTasks = tasks.filter((t) => byJob.has(t.job_id));
  const overdue = scopedTasks.filter((t) => t.due_on && t.due_on < today);
  const overdueByJob = new Map<string, number>();
  for (const t of overdue) {
    overdueByJob.set(t.job_id, (overdueByJob.get(t.job_id) ?? 0) + 1);
    const p = byJob.get(t.job_id)!;
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${t.due_on}T00:00:00Z`)) / 86_400_000);
    needs.push({
      id: `t:${t.id}`, group: 'overdue', jobId: p.job_id, title: t.title, sub: label(p), company: companyOf(p),
      amountCents: null, days, href: `/jobs/${p.job_id}?tab=schedule`, fix: 'Open schedule',
    });
  }

  for (const p of open) {
    if (p.budget_total_cents != null || p.core_status === 'CANCELLED') continue;
    needs.push({
      id: `n:${p.job_id}`, group: 'nobudget', jobId: p.job_id, title: label(p), sub: `${p.stage_label ?? p.stage_key} · ${p.customer_name ?? 'no customer yet'}`,
      company: companyOf(p), amountCents: p.contract_revised_cents || null, days: null, href: `/jobs/${p.job_id}?tab=budget`, fix: 'Build budget',
    });
  }

  const risk: RiskJob[] = open
    .filter((p) => isOverBudget(p) || (overdueByJob.get(p.job_id) ?? 0) > 0)
    .map((p) => {
      const od = overdueByJob.get(p.job_id) ?? 0;
      const over = isOverBudget(p);
      return {
        job: p, company: companyOf(p), marginCents: marginCents(p), overdueTasks: od,
        reason: over && od ? `Over contract and ${od} overdue` : over ? 'Cost estimate over contract' : `${od} overdue ${od === 1 ? 'task' : 'tasks'}`,
      };
    })
    .sort((a, b) => a.marginCents - b.marginCents || b.overdueTasks - a.overdueTasks);

  const weekTasks = scopedTasks
    .filter((t) => t.due_on && t.due_on >= today && t.due_on <= weekEnd)
    .map((t) => ({ task: t, job: pick(byJob.get(t.job_id)!) }));
  const later = scopedTasks.find((t) => t.due_on && t.due_on > weekEnd);

  return {
    today,
    companyNames: names,
    multiCompany: multi,
    projects,
    capped,
    needs,
    checkedJobs: checked.length,
    openJobCount: open.length,
    risk,
    week: weekTasks,
    nextDue: later ? { task: later, job: pick(byJob.get(later.job_id)!) } : null,
    overdueCount: overdue.length,
    openCos: scopedCos,
    activity,
  };
}

function pick(p: ProjectListRow): Pick<ProjectListRow, 'job_id' | 'job_number' | 'name'> {
  return { job_id: p.job_id, job_number: p.job_number, name: p.name };
}
