import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rows } from '@/lib/pm/db';
import { APP_TZ, addDays } from '@/lib/time';
import { clockOf, dayBoundsUtc, parseSlot, slotOnDay } from './dispatch-math';
import { personName } from './labels';
import { shopLoad, type ShopLoad } from './shop-math';
import { buildSignals, type Signal } from './signals';
import {
  ASSIGNMENT_COLS,
  type AssignmentRow, type AssignmentStatus, type DrawStatus, type EmployeeRow, type InspectionStatus, type KpiDefRow, type KpiRow,
  type SelectionStatus, type SelectionStatusRow, type WoKind, type WorkCenterLoadRow,
} from './types';

/** The home widgets in components/ops/widgets (one GET each at /api/ops/widgets/<key>). */
export const WIDGET_KEYS = ['signals', 'visits', 'shop', 'selections', 'draws'] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];

const pm = (db: SupabaseClient) => db.schema('pm');

/** "1042 · Smith remodel" for each job id (pm.v_project_list, RLS). */
async function jobLabels(db: SupabaseClient, ids: ReadonlyArray<string>): Promise<Record<string, string>> {
  const uniq = [...new Set(ids)].slice(0, 500);
  if (!uniq.length) return {};
  const r = rows<{ job_id: string; job_number: string | null; name: string }>(
    await pm(db).from('v_project_list').select('job_id, job_number, name').in('job_id', uniq),
    'jobs',
  );
  return Object.fromEntries(r.map((j) => [j.job_id, [j.job_number, j.name].filter(Boolean).join(' · ')]));
}

// ---------------------------------------------------------------------------------------------
// Signals

export interface SignalsData { signals: Signal[]; packMetrics: number }

export async function loadSignals(db: SupabaseClient, companyIds: ReadonlyArray<string>, companyNames: Record<string, string>): Promise<SignalsData> {
  const ids = [...companyIds];
  if (!ids.length) return { signals: [], packMetrics: 0 };
  const [defs, kpis] = await Promise.all([
    rows<KpiDefRow>(await pm(db).from('kpi_defs').select('location_id, key, label, metric, good_direction, sort').in('location_id', ids).eq('is_active', true).order('sort'), 'pack measures'),
    rows<KpiRow>(await pm(db).from('v_kpis').select('location_id, job_id, metric, value, as_of, basis, sample_n').in('location_id', ids).limit(5000), 'measures'),
  ]);
  const labels = await jobLabels(db, kpis.map((k) => k.job_id).filter((x): x is string => !!x));
  const signals = buildSignals({
    defs, kpis: kpis.map((k) => ({ ...k, value: k.value == null ? null : Number(k.value), sample_n: Number(k.sample_n) })),
    companyIds: ids, companyNames, jobLabels: labels,
  });
  return { signals, packMetrics: new Set(defs.map((d) => d.metric)).size };
}

// ---------------------------------------------------------------------------------------------
// Today's visits

export interface VisitItem {
  assignmentId: string;
  workOrderId: string;
  jobId: string;
  number: string | null;
  summary: string;
  kind: WoKind;
  job: string | null;
  tech: string;
  /** Local minutes after midnight, clipped to today. */
  start: number;
  end: number;
  when: string;
  status: AssignmentStatus;
  late: boolean;
}

export interface VisitsData { day: string; items: VisitItem[]; waiting: number; overdueWaiting: number }

export async function loadTodaysVisits(db: SupabaseClient, companyIds: ReadonlyArray<string>, day: string, nowMinutes: number): Promise<VisitsData> {
  const ids = [...companyIds];
  if (!ids.length) return { day, items: [], waiting: 0, overdueWaiting: 0 };
  const { from, to } = dayBoundsUtc(day, APP_TZ);
  const [assignments, queue] = await Promise.all([
    rows<AssignmentRow>(await pm(db).from('dispatch_assignments').select(ASSIGNMENT_COLS).overlaps('slot', `[${from},${to})`).neq('status', 'CANCELLED').limit(500), 'assignments'),
    rows<{ work_order_id: string; is_overdue: boolean | null }>(await pm(db).from('v_dispatch_queue').select('work_order_id, is_overdue').in('location_id', ids).limit(1000), 'dispatch queue'),
  ]);
  const woIds = [...new Set(assignments.map((a) => a.work_order_id))];
  const empIds = [...new Set(assignments.map((a) => a.employee_id).filter((x): x is string => !!x))];
  const crewIds = [...new Set(assignments.map((a) => a.crew_id).filter((x): x is string => !!x))];
  type WoLite = { id: string; location_id: string; job_id: string; number: string | null; summary: string; kind: WoKind };
  const loadOrders = async (): Promise<WoLite[]> =>
    woIds.length ? rows<WoLite>(await pm(db).from('work_orders').select('id, location_id, job_id, number, summary, kind').in('id', woIds).in('location_id', ids), 'work orders') : [];
  const loadEmps = async (): Promise<EmployeeRow[]> => {
    if (!empIds.length) return [];
    try {
      return rows<EmployeeRow>(await db.schema('core').from('employees').select('id, clerk_user_id, first_name, last_name, title, is_active').in('id', empIds), 'employees');
    } catch {
      return [];
    }
  };
  const loadCrews = async (): Promise<Array<{ id: string; name: string }>> =>
    crewIds.length ? rows<{ id: string; name: string }>(await pm(db).from('crews').select('id, name').in('id', crewIds), 'crews') : [];
  const [orders, emps, crews] = await Promise.all([loadOrders(), loadEmps(), loadCrews()]);
  const wo = new Map(orders.map((o) => [o.id, o]));
  const emp = new Map(emps.map((e) => [e.id, e]));
  const crew = new Map(crews.map((c) => [c.id, c.name]));
  const labels = await jobLabels(db, orders.map((o) => o.job_id));
  const items: VisitItem[] = [];
  for (const a of assignments) {
    const o = wo.get(a.work_order_id);
    const s = parseSlot(a.slot);
    if (!o || !s) continue;
    const iv = slotOnDay(s, day, APP_TZ);
    if (!iv) continue;
    const tech = a.employee_id ? personName(emp.get(a.employee_id)) : a.crew_id ? crew.get(a.crew_id) ?? 'Crew' : 'Unassigned';
    const late = a.status !== 'DONE' && ((a.status === 'ASSIGNED' || a.status === 'DISPATCHED') ? iv.start < nowMinutes : iv.end < nowMinutes);
    items.push({
      assignmentId: a.id, workOrderId: o.id, jobId: o.job_id, number: o.number, summary: o.summary, kind: o.kind, job: labels[o.job_id] ?? null,
      tech, start: iv.start, end: iv.end, when: `${clockOf(iv.start)}–${clockOf(iv.end)}`, status: a.status, late,
    });
  }
  items.sort((a, b) => a.start - b.start || a.tech.localeCompare(b.tech));
  return { day, items, waiting: queue.length, overdueWaiting: queue.filter((q) => q.is_overdue).length };
}

// ---------------------------------------------------------------------------------------------
// Shop load

export interface ShopData { centers: WorkCenterLoadRow[]; load: ShopLoad; late: number; released: number }

export async function loadShop(db: SupabaseClient, companyIds: ReadonlyArray<string>, today: string): Promise<ShopData> {
  const ids = [...companyIds];
  if (!ids.length) return { centers: [], load: shopLoad([]), late: 0, released: 0 };
  const [centers, orders] = await Promise.all([
    rows<WorkCenterLoadRow>(await pm(db).from('v_work_center_load').select('location_id, work_center_id, code, name, status, capacity_minutes_per_week, open_std_minutes, backlog_weeks').in('location_id', ids), 'work center load'),
    rows<{ status: string; promised_on: string | null }>(await pm(db).from('v_production_status').select('status, promised_on').in('location_id', ids).in('status', ['RELEASED', 'IN_PROGRESS', 'ON_HOLD']).limit(2000), 'production orders'),
  ]);
  const num = centers.map((c) => ({ ...c, capacity_minutes_per_week: Number(c.capacity_minutes_per_week), open_std_minutes: Number(c.open_std_minutes) }));
  num.sort((a, b) => (b.capacity_minutes_per_week > 0 ? b.open_std_minutes / b.capacity_minutes_per_week : -1) - (a.capacity_minutes_per_week > 0 ? a.open_std_minutes / a.capacity_minutes_per_week : -1));
  return { centers: num, load: shopLoad(num), late: orders.filter((o) => o.promised_on && o.promised_on < today).length, released: orders.length };
}

// ---------------------------------------------------------------------------------------------
// Selections due

export interface SelectionDueItem {
  selectionId: string;
  jobId: string;
  job: string | null;
  title: string;
  category: string;
  status: SelectionStatus;
  dueOn: string;
  overdue: boolean;
  allowanceCents: number | null;
  chosenCents: number | null;
}

export interface SelectionsDueData { items: SelectionDueItem[]; overdue: number; withClient: number; horizon: string }

export async function loadSelectionsDue(db: SupabaseClient, companyIds: ReadonlyArray<string>, today: string, days = 14): Promise<SelectionsDueData> {
  const horizon = addDays(today, days);
  const ids = [...companyIds];
  if (!ids.length) return { items: [], overdue: 0, withClient: 0, horizon };
  const sel = rows<SelectionStatusRow>(
    await pm(db).from('v_selection_status').select('location_id, job_id, selection_id, category, title, status, due_on, allowance_cents, chosen_total_cents, is_overdue')
      .in('location_id', ids).in('status', ['OPEN', 'PROPOSED', 'REJECTED']).not('due_on', 'is', null).lte('due_on', horizon).order('due_on').limit(200),
    'selections',
  );
  const labels = await jobLabels(db, sel.map((s) => s.job_id));
  const items = sel.map((s): SelectionDueItem => ({
    selectionId: s.selection_id, jobId: s.job_id, job: labels[s.job_id] ?? null, title: s.title, category: s.category, status: s.status,
    dueOn: s.due_on!, overdue: s.due_on! < today, allowanceCents: s.allowance_cents == null ? null : Number(s.allowance_cents),
    chosenCents: s.chosen_total_cents == null ? null : Number(s.chosen_total_cents),
  }));
  return { items, overdue: items.filter((i) => i.overdue).length, withClient: items.filter((i) => i.status === 'PROPOSED').length, horizon };
}

// ---------------------------------------------------------------------------------------------
// Draws in flight

export interface DrawFlightItem {
  drawId: string;
  scheduleId: string;
  jobId: string;
  job: string | null;
  number: number;
  status: DrawStatus;
  inspection: InspectionStatus;
  amountCents: number;
  missing: number;
  /** Days since it went to the lender (null while a draft). */
  daysOut: number | null;
}

export interface DrawsFlightData { items: DrawFlightItem[]; outCents: number; withLender: number }

export async function loadDrawsInFlight(db: SupabaseClient, companyIds: ReadonlyArray<string>, now: number): Promise<DrawsFlightData> {
  const ids = [...companyIds];
  if (!ids.length) return { items: [], outCents: 0, withLender: 0 };
  const d = rows<{
    job_id: string; draw_schedule_id: string; draw_id: string; draw_number: number; status: DrawStatus; inspection_status: InspectionStatus;
    lines_requested_cents: number; requested_cents: number | null; approved_cents: number | null; submitted_at: string | null; package_missing: string[] | null;
  }>(
    await pm(db).from('v_draw_summary')
      .select('job_id, draw_schedule_id, draw_id, draw_number, status, inspection_status, lines_requested_cents, requested_cents, approved_cents, submitted_at, package_missing')
      .in('location_id', ids).in('status', ['DRAFT', 'SUBMITTED', 'INSPECTION', 'APPROVED', 'RETURNED']).order('submitted_at', { nullsFirst: false }).limit(200),
    'draws',
  );
  const labels = await jobLabels(db, d.map((x) => x.job_id));
  const rank: Record<DrawStatus, number> = { RETURNED: 0, APPROVED: 1, INSPECTION: 2, SUBMITTED: 3, DRAFT: 4, FUNDED: 9, CANCELLED: 9 };
  const items = d.map((x): DrawFlightItem => ({
    drawId: x.draw_id, scheduleId: x.draw_schedule_id, jobId: x.job_id, job: labels[x.job_id] ?? null, number: x.draw_number, status: x.status,
    inspection: x.inspection_status,
    amountCents: Number(x.status === 'APPROVED' ? x.approved_cents ?? x.requested_cents ?? x.lines_requested_cents : x.requested_cents ?? x.lines_requested_cents),
    missing: (x.package_missing ?? []).length,
    daysOut: x.submitted_at && x.status !== 'DRAFT' ? Math.max(0, Math.floor((now - Date.parse(x.submitted_at)) / 86_400_000)) : null,
  })).sort((a, b) => rank[a.status] - rank[b.status] || (b.daysOut ?? -1) - (a.daysOut ?? -1));
  const out = items.filter((i) => i.status === 'SUBMITTED' || i.status === 'INSPECTION' || i.status === 'APPROVED');
  return { items, outCents: out.reduce((s, i) => s + i.amountCents, 0), withLender: out.length };
}
