import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { one, rows } from '@/lib/pm/db';
import { APP_TZ } from '@/lib/time';
import { dayBoundsUtc } from './dispatch-math';
import {
  AGREEMENT_COLS, ASSET_COLS, ASSIGNMENT_COLS, CLAIM_COLS, WO_COLS, WO_LINE_COLS,
  type AgreementRow, type AssetHistoryRow, type AssetRow, type AssignmentRow, type CrewMemberRow, type CrewRow, type DispatchBoardRow,
  type DispatchQueueRow, type EmployeeRow, type EmployeeSkillRow, type SkillRow, type WarrantyClaimRow, type WoLineRow, type WorkOrderRow,
} from './types';

export interface Where {
  companyIds: ReadonlyArray<string>;
  jobId?: string | null;
}

const pm = (db: SupabaseClient) => db.schema('pm');

export async function listEmployees(db: SupabaseClient): Promise<EmployeeRow[]> {
  try {
    return rows<EmployeeRow>(
      await db.schema('core').from('employees').select('id, clerk_user_id, first_name, last_name, title, is_active').eq('is_active', true).order('first_name').limit(1000),
      'employees',
    );
  } catch {
    return [];
  }
}

export interface TechSetup {
  crews: CrewRow[];
  members: CrewMemberRow[];
  skills: SkillRow[];
  employeeSkills: EmployeeSkillRow[];
  employees: EmployeeRow[];
}

export async function loadTechSetup(db: SupabaseClient, w: Where): Promise<TechSetup> {
  const [crews, skills, employeeSkills, employees] = await Promise.all([
    w.companyIds.length
      ? rows<CrewRow>(await pm(db).from('crews').select('id, location_id, name, kind, lead_employee_id, vendor_id, capacity_minutes_per_day, is_active').in('location_id', [...w.companyIds]).order('name'), 'crews')
      : Promise.resolve([] as CrewRow[]),
    rows<SkillRow>(await pm(db).from('skills').select('id, code, name, kind, is_active').order('name'), 'skills'),
    rows<EmployeeSkillRow>(await pm(db).from('employee_skills').select('employee_id, skill_id, level, expires_on').limit(5000), 'employee skills'),
    listEmployees(db),
  ]);
  const members = crews.length
    ? rows<CrewMemberRow>(await pm(db).from('crew_members').select('crew_id, employee_id, role, is_primary').in('crew_id', crews.map((c) => c.id)), 'crew members')
    : [];
  return { crews, members, skills, employeeSkills, employees };
}

export interface DispatchDay extends TechSetup {
  day: string;
  queue: DispatchQueueRow[];
  assignments: AssignmentRow[];
  /** Work orders behind the day's assignments. */
  orders: WorkOrderRow[];
  board: DispatchBoardRow[];
}

/** Everything the board needs for one local day. */
export async function loadDispatchDay(db: SupabaseClient, w: Where, day: string): Promise<DispatchDay> {
  const ids = [...w.companyIds];
  const { from, to } = dayBoundsUtc(day, APP_TZ);
  const [setup, queue, assignments, board] = await Promise.all([
    loadTechSetup(db, w),
    ids.length
      ? rows<DispatchQueueRow>(
          await pm(db).from('v_dispatch_queue')
            .select('location_id, work_order_id, job_id, number, kind, priority, summary, requested_start, requested_end, due_on, due_by, estimated_minutes, required_skills, is_overdue, created_at')
            .in('location_id', ids).order('priority').order('due_on', { nullsFirst: false }).order('created_at').limit(300),
          'dispatch queue',
        )
      : Promise.resolve([] as DispatchQueueRow[]),
    rows<AssignmentRow>(await pm(db).from('dispatch_assignments').select(ASSIGNMENT_COLS).overlaps('slot', `[${from},${to})`).neq('status', 'CANCELLED').limit(1000), 'assignments'),
    ids.length
      ? rows<DispatchBoardRow>(await pm(db).from('v_dispatch_board').select('location_id, day, employee_id, crew_id, assignments, booked_minutes, capacity_minutes, available_minutes').in('location_id', ids).eq('day', day), 'dispatch board')
      : Promise.resolve([] as DispatchBoardRow[]),
  ]);
  const woIds = [...new Set(assignments.map((a) => a.work_order_id))];
  const orders = woIds.length ? rows<WorkOrderRow>(await pm(db).from('work_orders').select(WO_COLS).in('id', woIds), 'work orders') : [];
  const inScope = new Set(orders.filter((o) => ids.includes(o.location_id)).map((o) => o.id));
  return {
    ...setup,
    day,
    queue,
    assignments: assignments.filter((a) => inScope.has(a.work_order_id)),
    orders: orders.filter((o) => inScope.has(o.id)),
    board,
  };
}

export interface WorkOrderList {
  orders: WorkOrderRow[];
  assignments: AssignmentRow[];
  claims: WarrantyClaimRow[];
  assets: AssetRow[];
  capped: boolean;
}

/** Work orders in scope (production orders live on /production). Closed ones from the last 180 days. */
export async function loadWorkOrders(db: SupabaseClient, w: Where, cap = 500): Promise<WorkOrderList> {
  if (!w.companyIds.length) return { orders: [], assignments: [], claims: [], assets: [], capped: false };
  let q = pm(db).from('work_orders').select(WO_COLS, { count: 'exact' }).in('location_id', [...w.companyIds]).neq('kind', 'PRODUCTION');
  if (w.jobId) q = q.eq('job_id', w.jobId);
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
  q = q.or(`status.not.in.(CLOSED,CANCELLED),updated_at.gte."${since}"`);
  const res = await q.order('created_at', { ascending: false }).limit(cap);
  const orders = rows<WorkOrderRow>(res, 'work orders');
  const ids = orders.map((o) => o.id);
  const assetIds = [...new Set(orders.map((o) => o.asset_id).filter((x): x is string => !!x))];
  const [assignments, claims, assets] = await Promise.all([
    ids.length ? rows<AssignmentRow>(await pm(db).from('dispatch_assignments').select(ASSIGNMENT_COLS).in('work_order_id', ids.slice(0, 500)).neq('status', 'CANCELLED'), 'assignments') : Promise.resolve([] as AssignmentRow[]),
    ids.length ? rows<WarrantyClaimRow>(await pm(db).from('warranty_claims').select(CLAIM_COLS).in('work_order_id', ids.slice(0, 500)), 'warranty claims') : Promise.resolve([] as WarrantyClaimRow[]),
    assetIds.length ? rows<AssetRow>(await pm(db).from('assets').select(ASSET_COLS).in('id', assetIds.slice(0, 500)), 'assets') : Promise.resolve([] as AssetRow[]),
  ]);
  return { orders, assignments, claims, assets, capped: (res.count ?? 0) > orders.length };
}

export interface WorkOrderDetail {
  order: WorkOrderRow;
  lines: WoLineRow[];
  assignments: AssignmentRow[];
  claims: WarrantyClaimRow[];
  asset: AssetRow | null;
  history: AssetHistoryRow[];
}

export async function loadWorkOrderDetail(db: SupabaseClient, woId: string): Promise<WorkOrderDetail | null> {
  const order = one<WorkOrderRow>(await pm(db).from('work_orders').select(WO_COLS).eq('id', woId).maybeSingle(), 'work order');
  if (!order) return null;
  const [lines, assignments, claims, asset, history] = await Promise.all([
    rows<WoLineRow>(await pm(db).from('v_work_order_lines_masked').select(WO_LINE_COLS).eq('work_order_id', woId).order('sort').order('created_at'), 'lines'),
    rows<AssignmentRow>(await pm(db).from('dispatch_assignments').select(ASSIGNMENT_COLS).eq('work_order_id', woId).order('created_at'), 'assignments'),
    rows<WarrantyClaimRow>(await pm(db).from('warranty_claims').select(CLAIM_COLS).eq('work_order_id', woId).order('created_at'), 'claims'),
    order.asset_id ? pm(db).from('assets').select(ASSET_COLS).eq('id', order.asset_id).maybeSingle().then((r) => (r.data ?? null) as AssetRow | null) : Promise.resolve(null),
    order.asset_id ? rows<AssetHistoryRow>(await pm(db).from('v_asset_history').select('location_id, asset_id, serial_number, make, model, customer_id, history_id, kind, performed_on, summary, meter_reading, employee_id, work_order_id, work_order_number, job_id').eq('asset_id', order.asset_id).order('performed_on', { ascending: false }).limit(6), 'asset history') : Promise.resolve([] as AssetHistoryRow[]),
  ]);
  return { order, lines, assignments, claims, asset, history };
}

export interface AgreementList {
  agreements: AgreementRow[];
  visits: Array<Pick<WorkOrderRow, 'id' | 'agreement_id' | 'number' | 'visit_seq' | 'status' | 'due_on' | 'due_by' | 'scheduled_start' | 'completed_at' | 'job_id' | 'summary'>>;
  coveredAssets: Array<{ agreement_id: string; asset_id: string }>;
}

export async function loadAgreements(db: SupabaseClient, w: Where): Promise<AgreementList> {
  if (!w.companyIds.length) return { agreements: [], visits: [], coveredAssets: [] };
  let q = pm(db).from('service_agreements').select(AGREEMENT_COLS).in('location_id', [...w.companyIds]);
  if (w.jobId) q = q.eq('job_id', w.jobId);
  const agreements = rows<AgreementRow>(await q.order('ends_on').limit(1000), 'agreements');
  const ids = agreements.map((a) => a.id);
  if (!ids.length) return { agreements, visits: [], coveredAssets: [] };
  const [visits, coveredAssets] = await Promise.all([
    rows<AgreementList['visits'][number]>(
      await pm(db).from('work_orders').select('id, agreement_id, number, visit_seq, status, due_on, due_by, scheduled_start, completed_at, job_id, summary').in('agreement_id', ids.slice(0, 500)).order('due_on').limit(3000),
      'agreement visits',
    ),
    rows<{ agreement_id: string; asset_id: string }>(await pm(db).from('agreement_assets').select('agreement_id, asset_id').in('agreement_id', ids.slice(0, 500)), 'covered assets'),
  ]);
  return { agreements, visits, coveredAssets };
}

export async function loadAssets(db: SupabaseClient, w: Where & { customerId?: string | null }): Promise<AssetRow[]> {
  if (!w.companyIds.length) return [];
  let q = pm(db).from('assets').select(ASSET_COLS).in('location_id', [...w.companyIds]);
  if (w.customerId) q = q.eq('customer_id', w.customerId);
  return rows<AssetRow>(await q.order('last_service_on', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(1000), 'assets');
}

export async function loadAssetHistory(db: SupabaseClient, assetId: string): Promise<{ history: AssetHistoryRow[]; open: WorkOrderRow[] }> {
  const [history, open] = await Promise.all([
    rows<AssetHistoryRow>(
      await pm(db).from('v_asset_history').select('location_id, asset_id, serial_number, make, model, customer_id, history_id, kind, performed_on, summary, meter_reading, employee_id, work_order_id, work_order_number, job_id').eq('asset_id', assetId).order('performed_on', { ascending: false }).limit(200),
      'asset history',
    ),
    rows<WorkOrderRow>(await pm(db).from('work_orders').select(WO_COLS).eq('asset_id', assetId).not('status', 'in', '(CLOSED,CANCELLED)').order('created_at', { ascending: false }).limit(20), 'open work on asset'),
  ]);
  return { history, open };
}
