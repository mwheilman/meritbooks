import 'server-only';
/**
 * GET /api/field/today: what the phone caches for offline work — today and the next two days of
 * the caller's assigned work, the jobs behind it (with the site location for "job by location"),
 * cost codes, checklists, my week of time and, for supervisors, the crew and the crew time
 * waiting for approval. Hours and quantities only: no column with money is selected.
 *
 * Every read runs on the caller's RLS client, so a technician gets only the jobs they are
 * assigned to (pm.my_job_ids) and only their own time (class P).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { can } from '@/lib/access/can';
import type { Access } from '@/lib/access/types';
import { PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { APP_TZ, addDays, todayIso } from '@/lib/time';
import { dayBoundsUtc, parseSlot } from '@/lib/pm/ops/dispatch-math';
import { mondayOf } from '@/lib/pm/ops/week';
import type { ReadyTenant } from '@/lib/api';
import { CHECKLISTS, templatesFor } from './checklists';

export const FIELD_DAYS = 3;
const TIME_FIELD_COLS = 'id, job_id, employee_id, user_id, work_date, hours, cost_code_id, notes, approval_state, source_ref, updated_at';

function rowsOf<T>(r: { data: unknown; error: PgErrorLike | null }, what: string): T[] {
  if (r.error) throw new PmQueryError(what, r.error);
  return (r.data ?? []) as T[];
}

export interface FieldJobCard {
  id: string;
  number: string | null;
  name: string;
  companyId: string;
  company: string | null;
  customer: string | null;
  stage: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  checklists: string[];
}

export interface FieldAssignment {
  id: string;
  jobId: string;
  workOrderId: string;
  title: string;
  status: string;
  start: string | null;
  end: string | null;
  day: string | null;
  crew: boolean;
}

export interface FieldTask {
  id: string;
  jobId: string;
  title: string;
  status: string;
  startOn: string | null;
  dueOn: string | null;
  costCodeId: string | null;
  mine: boolean;
}

export interface FieldTimeEntry {
  id: string;
  jobId: string;
  employeeId: string | null;
  workDate: string;
  hours: number;
  costCodeId: string | null;
  notes: string | null;
  state: string;
  commandRef: string | null;
  updatedAt: string | null;
}

export interface FieldToday {
  serverTime: string;
  timeZone: string;
  today: string;
  days: string[];
  weekStart: string;
  me: { employeeId: string | null; name: string; persona: string; title: string; group: string };
  can: { approveTime: boolean; crewClock: boolean; punch: boolean; logs: boolean; photos: boolean; time: boolean };
  /** Books owns pay, commissions and receipts; the Me tab shows those cards only when the tenant has Merit Books. */
  booksPresent: boolean;
  jobs: FieldJobCard[];
  assignments: FieldAssignment[];
  tasks: FieldTask[];
  costCodes: Array<{ id: string; companyId: string; jobId: string | null; code: string; name: string }>;
  checklists: typeof CHECKLISTS;
  week: FieldTimeEntry[];
  crew: Array<{ employeeId: string; name: string; crewId: string; crewName: string }>;
  crewTime: Array<FieldTimeEntry & { person: string }>;
  /** Open punch items on my jobs (titles and status only). */
  punch: Array<{ id: string; jobId: string; title: string; status: string; area: string | null; dueOn: string | null }>;
}

interface ListRow { job_id: string; job_number: string | null; name: string; location_id: string; customer_name: string | null; stage_label: string | null; stage_is_terminal: boolean | null; job_type_key: string | null }
interface SiteRow { job_id: string; job_type_id: string; site_address_line1: string | null; site_city: string | null; site_state: string | null; site_zip: string | null; site_lat: number | string | null; site_lng: number | string | null }
interface TimeRowDb { id: string; job_id: string; employee_id: string | null; user_id: string | null; work_date: string; hours: number | string; cost_code_id: string | null; notes: string | null; approval_state: string; source_ref: string | null; updated_at: string | null }

function toEntry(t: TimeRowDb): FieldTimeEntry {
  return {
    id: t.id, jobId: t.job_id, employeeId: t.employee_id, workDate: t.work_date, hours: Number(t.hours), costCodeId: t.cost_code_id,
    notes: t.notes, state: t.approval_state, commandRef: t.source_ref?.startsWith('wf:') ? t.source_ref : null, updatedAt: t.updated_at,
  };
}

const pmOf = (db: SupabaseClient) => db.schema('pm');

export async function loadFieldToday(db: SupabaseClient, tenant: ReadyTenant, access: Access, userId: string, now = new Date()): Promise<FieldToday> {
  const today = todayIso(now);
  const days = Array.from({ length: FIELD_DAYS }, (_, i) => addDays(today, i));
  const weekStart = mondayOf(today);
  const names = new Map(tenant.companies.map((c) => [c.id, c.name]));
  const multi = tenant.companies.length > 1;
  const companyIds = tenant.companies.map((c) => c.id);

  const meRes = await db.schema('core').from('employees').select('id, first_name, last_name').eq('clerk_user_id', userId).eq('is_active', true).limit(1).maybeSingle();
  const meRow = (meRes.data ?? null) as { id: string; first_name: string | null; last_name: string | null } | null;
  const meName = meRow ? [meRow.first_name, meRow.last_name].filter(Boolean).join(' ') || 'Team member' : 'Team member';

  // ---- jobs I can reach (RLS), open ones, non-money columns only
  const list = companyIds.length
    ? rowsOf<ListRow>(
        await pmOf(db).from('v_project_list').select('job_id, job_number, name, location_id, customer_name, stage_label, stage_is_terminal, job_type_key')
          .in('location_id', companyIds).order('updated_at', { ascending: false }).limit(400),
        'jobs',
      ).filter((j) => !j.stage_is_terminal)
    : [];
  const jobIds = list.map((j) => j.job_id);
  const sites = jobIds.length
    ? rowsOf<SiteRow>(await pmOf(db).from('projects').select('job_id, job_type_id, site_address_line1, site_city, site_state, site_zip, site_lat, site_lng').in('job_id', jobIds), 'job sites')
    : [];
  const siteBy = new Map(sites.map((s) => [s.job_id, s]));
  const typeIds = [...new Set(sites.map((s) => s.job_type_id))];
  const types = typeIds.length
    ? rowsOf<{ id: string; modules: Record<string, boolean> | null }>(await pmOf(db).from('job_types').select('id, modules').in('id', typeIds), 'job types')
    : [];
  const modulesBy = new Map(types.map((t) => [t.id, Object.entries(t.modules ?? {}).filter(([, on]) => on === true).map(([k]) => k)]));

  // ---- my visits over the window (directly, or through a crew I am on)
  const { from } = dayBoundsUtc(days[0]!, APP_TZ);
  const { to } = dayBoundsUtc(days[days.length - 1]!, APP_TZ);
  let assignments: FieldAssignment[] = [];
  let myCrewIds: string[] = [];
  if (meRow) {
    const crews = rowsOf<{ crew_id: string }>(await pmOf(db).from('crew_members').select('crew_id').eq('employee_id', meRow.id), 'crews');
    myCrewIds = crews.map((c) => c.crew_id);
    const who = myCrewIds.length ? `employee_id.eq.${meRow.id},crew_id.in.(${myCrewIds.join(',')})` : `employee_id.eq.${meRow.id}`;
    const a = rowsOf<{ id: string; job_id: string; work_order_id: string; slot: string; status: string; crew_id: string | null }>(
      await pmOf(db).from('dispatch_assignments').select('id, job_id, work_order_id, slot, status, crew_id').overlaps('slot', `[${from},${to})`).neq('status', 'CANCELLED').or(who).limit(100),
      'visits',
    );
    const woIds = [...new Set(a.map((x) => x.work_order_id))];
    const wos = woIds.length ? rowsOf<{ id: string; number: string | null; summary: string }>(await pmOf(db).from('work_orders').select('id, number, summary').in('id', woIds), 'work orders') : [];
    const woBy = new Map(wos.map((w) => [w.id, w]));
    assignments = a.map((x) => {
      const s = parseSlot(x.slot);
      const wo = woBy.get(x.work_order_id);
      return {
        id: x.id, jobId: x.job_id, workOrderId: x.work_order_id, title: wo ? [wo.number, wo.summary].filter(Boolean).join(' · ') : 'Visit',
        status: x.status, start: s?.start ?? null, end: s?.end ?? null, day: s ? todayIso(new Date(s.start)) : null, crew: !!x.crew_id,
      };
    }).sort((p, q) => (p.start ?? '').localeCompare(q.start ?? ''));
  }

  // ---- tasks on my jobs in the window (the schedule's cost code is the clock-in default)
  const last = days[days.length - 1]!;
  const tasks = jobIds.length
    ? rowsOf<{ id: string; job_id: string; title: string; status: string; start_on: string | null; due_on: string | null; cost_code_id: string | null; assignee_user_id: string | null; assignee_employee_id: string | null }>(
        await pmOf(db).from('tasks').select('id, job_id, title, status, start_on, due_on, cost_code_id, assignee_user_id, assignee_employee_id')
          .in('job_id', jobIds.slice(0, 300)).not('status', 'in', '(DONE,CANCELLED)').order('due_on', { nullsFirst: false }).limit(600),
        'tasks',
      )
        .filter((t) => t.status === 'IN_PROGRESS' || ((!t.start_on || t.start_on <= last) && (!t.due_on || t.due_on >= today) && (!!t.start_on || !!t.due_on)))
        .map((t) => ({
          id: t.id, jobId: t.job_id, title: t.title, status: t.status, startOn: t.start_on, dueOn: t.due_on, costCodeId: t.cost_code_id,
          mine: t.assignee_user_id === userId || (!!meRow && t.assignee_employee_id === meRow.id),
        }))
    : [];

  // ---- cost codes of the companies my jobs are in (settings class: readable by every member)
  const jobCompanies = [...new Set(list.map((j) => j.location_id))];
  const costCodes = jobCompanies.length
    ? rowsOf<{ id: string; location_id: string; job_id: string | null; code: string; name: string }>(
        await pmOf(db).from('cost_codes').select('id, location_id, job_id, code, name').in('location_id', jobCompanies).eq('is_active', true).order('sort').order('code').limit(2000),
        'cost codes',
      )
        .filter((c) => !c.job_id || jobIds.includes(c.job_id))
        .map((c) => ({ id: c.id, companyId: c.location_id, jobId: c.job_id, code: c.code, name: c.name }))
    : [];

  // ---- my week of time (own rows; masked view, no rate columns selected)
  const mine = meRow ? `employee_id.eq.${meRow.id},user_id.eq.${userId}` : `user_id.eq.${userId}`;
  const week = rowsOf<TimeRowDb>(
    await pmOf(db).from('v_time_entries_masked').select(TIME_FIELD_COLS).gte('work_date', weekStart).lte('work_date', addDays(weekStart, 6)).neq('approval_state', 'VOID').or(mine).order('work_date').limit(500),
    'my time',
  ).map(toEntry);

  // ---- supervisors: my crews and the crew time waiting on me (hours only)
  const approves = can(access, 'projects.time', 'approve');
  let crew: FieldToday['crew'] = [];
  let crewTime: FieldToday['crewTime'] = [];
  if (approves) {
    const led = meRow
      ? rowsOf<{ id: string; name: string }>(await pmOf(db).from('crews').select('id, name').eq('is_active', true).or(`lead_employee_id.eq.${meRow.id}${myCrewIds.length ? `,id.in.(${myCrewIds.join(',')})` : ''}`).limit(50), 'my crews')
      : [];
    const members = led.length
      ? rowsOf<{ crew_id: string; employee_id: string }>(await pmOf(db).from('crew_members').select('crew_id, employee_id').in('crew_id', led.map((c) => c.id)), 'crew members')
      : [];
    const pending = rowsOf<TimeRowDb>(
      await pmOf(db).from('v_time_entries_masked').select(TIME_FIELD_COLS).eq('approval_state', 'SUBMITTED').gte('work_date', addDays(today, -21)).order('work_date').limit(500),
      'crew time',
    ).filter((t) => !(meRow && t.employee_id === meRow.id) && t.user_id !== userId);
    const empIds = [...new Set([...members.map((m) => m.employee_id), ...pending.map((t) => t.employee_id).filter((x): x is string => !!x)])];
    const emps = empIds.length
      ? rowsOf<{ id: string; first_name: string | null; last_name: string | null }>(await db.schema('core').from('employees').select('id, first_name, last_name').in('id', empIds), 'crew names')
      : [];
    const nameBy = new Map(emps.map((e) => [e.id, [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Team member']));
    const crewName = new Map(led.map((c) => [c.id, c.name]));
    crew = members.filter((m) => !meRow || m.employee_id !== meRow.id).map((m) => ({ employeeId: m.employee_id, name: nameBy.get(m.employee_id) ?? 'Team member', crewId: m.crew_id, crewName: crewName.get(m.crew_id) ?? 'Crew' }));
    crewTime = pending.map((t) => ({ ...toEntry(t), person: t.employee_id ? nameBy.get(t.employee_id) ?? 'Team member' : 'Team member' }));
  }

  // ---- open punch on my jobs (class J: job reach)
  const punch = jobIds.length
    ? rowsOf<{ id: string; job_id: string; title: string; status: string; area: string | null; due_on: string | null }>(
        await pmOf(db).from('punch_items').select('id, job_id, title, status, area, due_on').in('job_id', jobIds.slice(0, 300)).in('status', ['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW']).order('created_at', { ascending: false }).limit(500),
        'punch list',
      ).map((p) => ({ id: p.id, jobId: p.job_id, title: p.title, status: p.status, area: p.area, dueOn: p.due_on }))
    : [];

  const jobs: FieldJobCard[] = list.map((j) => {
    const s = siteBy.get(j.job_id);
    const addr = s ? [s.site_address_line1, [s.site_city, s.site_state].filter(Boolean).join(', '), s.site_zip].filter(Boolean).join(' · ') : '';
    return {
      id: j.job_id, number: j.job_number, name: j.name, companyId: j.location_id, company: multi ? names.get(j.location_id) ?? null : null,
      customer: j.customer_name, stage: j.stage_label, address: addr || null,
      lat: s?.site_lat == null ? null : Number(s.site_lat), lng: s?.site_lng == null ? null : Number(s.site_lng),
      checklists: templatesFor(s ? modulesBy.get(s.job_type_id) ?? [] : []),
    };
  });

  return {
    serverTime: now.toISOString(),
    timeZone: APP_TZ,
    today,
    days,
    weekStart,
    me: { employeeId: meRow?.id ?? null, name: meName, persona: access.persona, title: access.title, group: access.group },
    can: {
      approveTime: approves,
      crewClock: approves,
      punch: can(access, 'projects.jobs', 'create'),
      logs: can(access, 'projects.documents', 'create'),
      photos: can(access, 'projects.documents', 'create'),
      time: can(access, 'projects.time', 'create'),
    },
    booksPresent: tenant.booksPresent,
    jobs,
    assignments,
    tasks,
    costCodes,
    checklists: CHECKLISTS,
    week,
    crew,
    crewTime,
    punch,
  };
}
