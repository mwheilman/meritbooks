import 'server-only';
/**
 * Data for the office, supervisor and labor homes (Wave 0a spec §5). Real rows only, read on the
 * caller's RLS client — the database already limits a supervisor or a technician to their own
 * jobs, so nothing here filters by person except "my" time and "my" assignments.
 *
 * Each source is settled on its own: one failing read shows as an error on its block, never as an
 * empty list (an empty list would say "nothing needs you" when we simply don't know).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Access } from '@/lib/access/types';
import type { Scope } from '@/lib/scope';
import { holds } from '@/lib/nav';
import { listAllProjects } from '@/lib/pm/projects';
import { listOpenTasks } from '@/lib/pm/work';
import { listBillingQueue } from '@/lib/pm/money/queries';
import { COMPLIANCE_DOC_LABELS, billingKindLabel } from '@/lib/pm/money/status';
import { listEmployees } from '@/lib/pm/ops/field-queries';
import { loadPunch, loadTime } from '@/lib/pm/ops/records-queries';
import { clockOf, dayBoundsUtc, localParts, parseSlot } from '@/lib/pm/ops/dispatch-math';
import { mondayOf } from '@/lib/pm/ops/week';
import { personName } from '@/lib/pm/ops/labels';
import { ASSIGNMENT_COLS, type AssignmentRow, type AssignmentStatus, type EmployeeRow, type TimeEntryRow } from '@/lib/pm/ops/types';
import type { ComplianceDocRow } from '@/lib/pm/money/types';
import type { ModuleKey } from '@/lib/packs';
import type { ProjectListRow, TaskRow } from '@/lib/pm/types';
import { APP_TZ, addDays, todayIso } from '@/lib/time';

export type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

async function settle<T>(p: Promise<T>, what: string): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch {
    return { ok: false, error: `We couldn’t load ${what}.` };
  }
}

const pm = (db: SupabaseClient) => db.schema('pm');
const jobLabel = (p: Pick<ProjectListRow, 'job_number' | 'name'>) => [p.job_number, p.name].filter(Boolean).join(' · ');
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

interface Base {
  db: SupabaseClient;
  scope: Scope;
  access: Access;
  modules: ReadonlyArray<ModuleKey>;
}

function companyNamer(scope: Scope) {
  const names = new Map(scope.tenant.companies.map((c) => [c.id, c.name]));
  const multi = scope.companyIds.length > 1;
  return (id: string | null | undefined) => (multi && id ? names.get(id) ?? null : null);
}

// =====================================================================================  office
export type AdminGroup = 'unscheduled' | 'billing' | 'compliance';

export interface AdminItem {
  id: string;
  group: AdminGroup;
  title: string;
  sub: string;
  company: string | null;
  /** Contract-side money (an invoice amount): shown only with contract_value. */
  amountCents: number | null;
  /** Days waiting, or days until a document expires (negative = expired). */
  days: number | null;
  dayWord: 'waiting' | 'expires' | null;
  href: string;
  fix: string;
}

export interface AdminSource {
  group: AdminGroup;
  /** Not offered to this caller or this company (no grant, no module): the block is absent. */
  off: boolean;
  error: string | null;
}

export interface AdminHomeData {
  today: string;
  items: AdminItem[];
  sources: AdminSource[];
  openJobs: number;
}

const SOON_DAYS = 30;

export async function loadAdminHome({ db, scope, access, modules }: Base): Promise<AdminHomeData> {
  const today = todayIso();
  const ids = scope.companyIds;
  const company = companyNamer(scope);
  const cid = scope.company?.id ?? null;
  const can = (g: Parameters<typeof holds>[1]) => holds(access, g, cid);
  const useDispatch = modules.includes('dispatch') && can('projects.dispatch:view');
  const useBilling = (modules.includes('billing') || modules.includes('retainage') || modules.includes('lender_draws')) && can('projects.billing:view');
  const useCompliance = modules.includes('commitments') && can('projects.commitments:view');

  const [jobsR, queueR, billingR, complianceR] = await Promise.all([
    settle(listAllProjects(db, ids, 2000), 'jobs'),
    useDispatch
      ? settle(
          (async () => {
            const r = await pm(db).from('v_dispatch_queue').select('location_id, work_order_id, job_id, number, summary, due_on, created_at').in('location_id', [...ids]).order('priority').order('created_at').limit(200);
            if (r.error) throw r.error;
            return (r.data ?? []) as Array<{ location_id: string; work_order_id: string; job_id: string; number: string | null; summary: string; due_on: string | null; created_at: string }>;
          })(),
          'the dispatch queue',
        )
      : Promise.resolve(null),
    useBilling ? settle(listBillingQueue(db, ids), 'billing') : Promise.resolve(null),
    useCompliance
      ? settle(
          (async () => {
            const r = await pm(db).from('compliance_docs')
              .select('id, job_id, commitment_id, vendor_id, doc_type, status, required, expires_on, covers_through, amount_cents, notes, verified_by, verified_at, created_at')
              .not('expires_on', 'is', null).lte('expires_on', addDays(today, SOON_DAYS)).in('status', ['RECEIVED', 'VERIFIED', 'EXPIRED']).order('expires_on').limit(300);
            if (r.error) throw r.error;
            return (r.data ?? []) as ComplianceDocRow[];
          })(),
          'vendor compliance',
        )
      : Promise.resolve(null),
  ]);

  const jobs = jobsR.ok ? jobsR.value.rows : [];
  const byId = new Map(jobs.map((j) => [j.job_id, j]));
  const open = jobs.filter((j) => !j.stage_is_terminal && j.core_status !== 'CANCELLED');
  const items: AdminItem[] = [];

  // ---- unscheduled: open jobs with no start date, and work orders no one is booked on
  for (const j of open) {
    if (j.planned_start) continue;
    items.push({
      id: `j:${j.job_id}`, group: 'unscheduled', title: jobLabel(j), sub: `${j.stage_label ?? j.stage_key} · no start date${j.customer_name ? ` · ${j.customer_name}` : ''}`,
      company: company(j.location_id), amountCents: null, days: daysBetween(j.created_at.slice(0, 10), today), dayWord: 'waiting',
      href: `/jobs/${j.job_id}`, fix: 'Set dates',
    });
  }
  if (queueR?.ok) {
    for (const w of queueR.value) {
      const j = byId.get(w.job_id);
      items.push({
        id: `w:${w.work_order_id}`, group: 'unscheduled', title: [w.number, w.summary].filter(Boolean).join(' · '),
        sub: `${j ? jobLabel(j) : 'Work order'} · not booked${w.due_on ? ` · due ${w.due_on}` : ''}`,
        company: company(w.location_id), amountCents: null, days: daysBetween(w.created_at.slice(0, 10), today), dayWord: 'waiting',
        href: `/dispatch?wo=${w.work_order_id}`, fix: 'Book it',
      });
    }
  }

  // ---- unsent billing: drafts to approve, and anything Merit Books sent back
  if (billingR?.ok) {
    for (const b of billingR.value) {
      if (b.next_action === 'AWAITING_BOOKS') continue;
      items.push({
        id: `b:${b.id}`, group: 'billing', title: `${billingKindLabel(b)} · ${[b.job_number, b.job_name].filter(Boolean).join(' · ')}`,
        sub: b.next_action === 'FIX_AND_RESEND' ? `Sent back${b.error_text ? `: ${b.error_text}` : ''}` : `Draft${b.customer_name ? ` · ${b.customer_name}` : ''}`,
        company: company(b.location_id), amountCents: b.net_cents, days: b.age_days, dayWord: 'waiting',
        href: b.kind === 'DEPOSIT' ? `/billing` : `/jobs/${b.job_id}?tab=billing&request=${b.id}`, fix: b.next_action === 'FIX_AND_RESEND' ? 'Fix' : 'Review',
      });
    }
  }

  // ---- compliance: insurance and lien waivers expiring in the next 30 days, or already expired
  if (complianceR?.ok) {
    for (const d of complianceR.value) {
      const j = byId.get(d.job_id);
      if (!j || !d.expires_on) continue;
      const left = daysBetween(today, d.expires_on);
      items.push({
        id: `c:${d.id}`, group: 'compliance', title: COMPLIANCE_DOC_LABELS[d.doc_type] ?? d.doc_type,
        sub: `${jobLabel(j)} · ${left < 0 ? `expired ${d.expires_on}` : `expires ${d.expires_on}`}`,
        company: company(j.location_id), amountCents: null, days: left, dayWord: 'expires',
        href: `/jobs/${d.job_id}?tab=commitments`, fix: 'Get a new one',
      });
    }
  }

  const sources: AdminSource[] = [
    { group: 'unscheduled', off: false, error: !jobsR.ok ? jobsR.error : queueR && !queueR.ok ? queueR.error : null },
    { group: 'billing', off: !useBilling, error: billingR && !billingR.ok ? billingR.error : null },
    { group: 'compliance', off: !useCompliance, error: complianceR && !complianceR.ok ? complianceR.error : null },
  ];
  return { today, items, sources, openJobs: open.length };
}

// ================================================================================  supervisor
export interface SiteJob {
  job: Pick<ProjectListRow, 'job_id' | 'job_number' | 'name' | 'customer_name' | 'stage_label' | 'stage_key'>;
  company: string | null;
  tasks: TaskRow[];
  punchOpen: number;
}

export interface CrewTimeItem {
  id: string;
  person: string;
  jobId: string;
  job: string;
  workDate: string;
  hours: number;
}

export interface PunchItem {
  id: string;
  jobId: string;
  job: string;
  title: string;
  status: string;
  dueOn: string | null;
  late: boolean;
}

export interface SupervisorHomeData {
  today: string;
  weekStart: string;
  site: Settled<SiteJob[]>;
  /** null: the caller does not approve time (or the company doesn't track it). */
  crewTime: Settled<CrewTimeItem[]> | null;
  punch: Settled<PunchItem[]> | null;
}

const OPEN_PUNCH = new Set(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW']);

export async function loadSupervisorHome({ db, scope, access, modules }: Base): Promise<SupervisorHomeData> {
  const today = todayIso();
  const weekStart = mondayOf(today);
  const cid = scope.company?.id ?? null;
  const company = companyNamer(scope);
  const jobsR = await settle(listAllProjects(db, scope.companyIds, 2000), 'your jobs');
  const jobs = jobsR.ok ? jobsR.value.rows : [];
  const byId = new Map(jobs.map((j) => [j.job_id, j]));
  const inScope = (id: string) => byId.has(id);
  const approves = modules.includes('time') && holds(access, 'projects.time:approve', cid);
  const usesPunch = modules.includes('punch_warranty');

  const [tasksR, timeR, employeesR, punchR] = await Promise.all([
    settle(listOpenTasks(db, 1000), 'today’s tasks'),
    approves ? settle(loadTime(db, { companyIds: scope.companyIds }, addDays(today, -21), today, inScope), 'crew time') : Promise.resolve(null),
    approves ? settle(listEmployees(db), 'the crew') : Promise.resolve(null),
    usesPunch ? settle(loadPunch(db, { companyIds: scope.companyIds }, inScope), 'the punch list') : Promise.resolve(null),
  ]);

  const openPunch = punchR?.ok ? punchR.value.filter((p) => OPEN_PUNCH.has(p.status)) : [];
  const punchByJob = new Map<string, number>();
  for (const p of openPunch) punchByJob.set(p.job_id, (punchByJob.get(p.job_id) ?? 0) + 1);

  let site: Settled<SiteJob[]>;
  if (!jobsR.ok) site = jobsR;
  else if (!tasksR.ok) site = tasksR;
  else {
    const onToday = tasksR.value.filter(
      (t) => inScope(t.job_id) && (t.status === 'IN_PROGRESS' || t.due_on === today || (!!t.start_on && t.start_on <= today && (!t.due_on || t.due_on >= today))),
    );
    const grouped = new Map<string, TaskRow[]>();
    for (const t of onToday) grouped.set(t.job_id, [...(grouped.get(t.job_id) ?? []), t]);
    site = {
      ok: true,
      value: [...grouped.entries()].map(([jobId, tasks]) => {
        const j = byId.get(jobId)!;
        return {
          job: { job_id: j.job_id, job_number: j.job_number, name: j.name, customer_name: j.customer_name, stage_label: j.stage_label, stage_key: j.stage_key },
          company: company(j.location_id),
          tasks: tasks.sort((a, b) => (a.due_on ?? '').localeCompare(b.due_on ?? '')),
          punchOpen: punchByJob.get(jobId) ?? 0,
        };
      }),
    };
  }

  let crewTime: Settled<CrewTimeItem[]> | null = null;
  if (timeR) {
    if (!timeR.ok) crewTime = timeR;
    else {
      const emps = new Map((employeesR?.ok ? employeesR.value : []).map((e) => [e.id, e]));
      crewTime = {
        ok: true,
        value: timeR.value
          .filter((t) => t.approval_state === 'SUBMITTED')
          .map((t) => {
            const e = t.employee_id ? emps.get(t.employee_id) : undefined;
            const j = byId.get(t.job_id)!;
            return { id: t.id, person: e ? personName(e) : 'Team member', jobId: t.job_id, job: jobLabel(j), workDate: t.work_date, hours: Number(t.hours) };
          }),
      };
    }
  }

  const punch: Settled<PunchItem[]> | null = punchR
    ? punchR.ok
      ? {
          ok: true,
          value: openPunch.map((p) => ({
            id: p.id, jobId: p.job_id, job: jobLabel(byId.get(p.job_id)!), title: p.title, status: p.status, dueOn: p.due_on, late: !!p.due_on && p.due_on < today,
          })).sort((a, b) => Number(b.late) - Number(a.late) || (a.dueOn ?? '9').localeCompare(b.dueOn ?? '9')),
        }
      : punchR
    : null;

  return { today, weekStart, site, crewTime, punch };
}

// =====================================================================================  labor
export interface Assignment {
  id: string;
  status: AssignmentStatus;
  workOrderId: string;
  jobId: string;
  title: string;
  job: string;
  customer: string | null;
  address: string | null;
  start: string | null;
  end: string | null;
  /** "9:00 AM – 10:30 AM" in the company's time zone. */
  window: string | null;
}

export interface TodayTask {
  id: string;
  jobId: string;
  title: string;
  job: string;
  status: string;
}

export interface LaborHomeData {
  today: string;
  weekStart: string;
  me: Pick<EmployeeRow, 'id' | 'first_name' | 'last_name'> | null;
  /** The one thing to do now: the first open assignment of the day. */
  current: Assignment | null;
  /** The rest of today, in order. */
  later: Assignment[];
  done: number;
  tasks: Settled<TodayTask[]>;
  assignments: Settled<Assignment[]> | null;
  hours: Settled<{ total: number; byDay: Array<{ day: string; hours: number }>; drafts: number }>;
  /** A job to log hours against (the current assignment's, else the only open job). */
  logJobId: string | null;
}

const CLOSED_ASSIGNMENT = new Set<AssignmentStatus>(['DONE', 'CANCELLED']);

export async function loadLaborHome({ db, scope, modules }: Base): Promise<LaborHomeData> {
  const today = todayIso();
  const weekStart = mondayOf(today);
  const jobsR = await settle(listAllProjects(db, scope.companyIds, 500), 'your jobs');
  const jobs = jobsR.ok ? jobsR.value.rows : [];
  const byId = new Map(jobs.map((j) => [j.job_id, j]));
  const inScope = (id: string) => byId.has(id);

  const employees = await listEmployees(db);
  const meRow = employees.find((e) => e.clerk_user_id === scope.userId) ?? null;
  const usesDispatch = modules.includes('dispatch');

  const [tasksR, assignR, timeR] = await Promise.all([
    settle(listOpenTasks(db, 1000), 'today’s tasks'),
    usesDispatch && meRow ? settle(myAssignments(db, meRow.id, today), 'your visits') : Promise.resolve(null),
    settle(loadTime(db, { companyIds: scope.companyIds }, weekStart, addDays(weekStart, 6), inScope), 'your hours'),
  ]);

  const tasks: Settled<TodayTask[]> = tasksR.ok
    ? {
        ok: true,
        value: tasksR.value
          .filter((t) => inScope(t.job_id) && (t.status === 'IN_PROGRESS' || t.due_on === today || (!!t.start_on && t.start_on <= today && (!t.due_on || t.due_on >= today))))
          .map((t) => ({ id: t.id, jobId: t.job_id, title: t.title, job: jobLabel(byId.get(t.job_id)!), status: t.status })),
      }
    : tasksR;

  let assignments: Settled<Assignment[]> | null = null;
  if (assignR) {
    if (!assignR.ok) assignments = assignR;
    else {
      const ws = assignR.value;
      assignments = {
        ok: true,
        value: ws.map(({ a, wo }) => {
          const j = byId.get(a.job_id);
          const s = parseSlot(a.slot);
          const win = s ? `${clockOf(localParts(s.start, APP_TZ).minutes)} – ${clockOf(localParts(s.end, APP_TZ).minutes)}` : null;
          return {
            id: a.id, status: a.status, workOrderId: a.work_order_id, jobId: a.job_id,
            title: wo ? [wo.number, wo.summary].filter(Boolean).join(' · ') : 'Visit',
            job: j ? jobLabel(j) : 'Job', customer: j?.customer_name ?? null, address: null,
            start: s?.start ?? null, end: s?.end ?? null, window: win,
          };
        }).sort((x, y) => (x.start ?? '').localeCompare(y.start ?? '')),
      };
    }
  }

  const mine = (t: TimeEntryRow) => (meRow && t.employee_id === meRow.id) || t.user_id === scope.userId;
  const hours: LaborHomeData['hours'] = timeR.ok
    ? (() => {
        const list = timeR.value.filter(mine);
        const byDay = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).map((day) => ({
          day, hours: list.filter((t) => t.work_date === day).reduce((s, t) => s + Number(t.hours), 0),
        }));
        return { ok: true as const, value: { total: byDay.reduce((s, d) => s + d.hours, 0), byDay, drafts: list.filter((t) => t.approval_state === 'DRAFT').length } };
      })()
    : timeR;

  const openA = assignments?.ok ? assignments.value.filter((x) => !CLOSED_ASSIGNMENT.has(x.status)) : [];
  const current = openA[0] ?? null;
  const openJobs = jobs.filter((j) => !j.stage_is_terminal);
  return {
    today,
    weekStart,
    me: meRow ? { id: meRow.id, first_name: meRow.first_name, last_name: meRow.last_name } : null,
    current,
    later: openA.slice(1),
    done: assignments?.ok ? assignments.value.filter((x) => x.status === 'DONE').length : 0,
    tasks,
    assignments,
    hours,
    logJobId: current?.jobId ?? (openJobs.length === 1 ? openJobs[0]!.job_id : null),
  };
}

/** Today's dispatch assignments for me, directly or through a crew I'm on. */
async function myAssignments(db: SupabaseClient, employeeId: string, day: string): Promise<Array<{ a: AssignmentRow; wo: { number: string | null; summary: string } | null }>> {
  const { from, to } = dayBoundsUtc(day, APP_TZ);
  const crews = await pm(db).from('crew_members').select('crew_id').eq('employee_id', employeeId);
  if (crews.error) throw crews.error;
  const crewIds = ((crews.data ?? []) as Array<{ crew_id: string }>).map((c) => c.crew_id);
  const who = crewIds.length ? `employee_id.eq.${employeeId},crew_id.in.(${crewIds.join(',')})` : `employee_id.eq.${employeeId}`;
  const r = await pm(db).from('dispatch_assignments').select(ASSIGNMENT_COLS).overlaps('slot', `[${from},${to})`).neq('status', 'CANCELLED').or(who).limit(50);
  if (r.error) throw r.error;
  const list = (r.data ?? []) as AssignmentRow[];
  const woIds = [...new Set(list.map((x) => x.work_order_id))];
  const wos = woIds.length ? await pm(db).from('work_orders').select('id, number, summary').in('id', woIds) : { data: [], error: null };
  if (wos.error) throw wos.error;
  const woById = new Map(((wos.data ?? []) as Array<{ id: string; number: string | null; summary: string }>).map((w) => [w.id, w]));
  return list.map((a) => ({ a, wo: woById.get(a.work_order_id) ?? null }));
}
