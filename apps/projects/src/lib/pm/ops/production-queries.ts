import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { one, rows } from '@/lib/pm/db';
import { checkGuards } from '@/lib/pm/projects';
import {
  BOM_COLS, OP_COLS, PRODUCTION_COLS,
  type BomLineRow, type JobProductionRow, type OperationRow, type ProductionOrderRow, type ProductionStatusRow, type RoutingRow,
  type RoutingStepRow, type WorkCenterLoadRow, type WorkCenterRow,
} from './types';
import type { Where } from './field-queries';

const pm = (db: SupabaseClient) => db.schema('pm');

const STATUS_COLS =
  'location_id, job_id, work_order_id, number, summary, status, quantity, promised_on, released_at, completed_at, is_remake, drawings_approved_at, ' +
  'ops_total, ops_done, std_minutes, std_minutes_done, actual_minutes, remaining_std_minutes, pct_complete, current_work_center_id, current_operation, is_late';

export interface ShopLibrary {
  centers: WorkCenterRow[];
  routings: RoutingRow[];
  steps: RoutingStepRow[];
}

export async function loadShopLibrary(db: SupabaseClient, w: Where): Promise<ShopLibrary> {
  if (!w.companyIds.length) return { centers: [], routings: [], steps: [] };
  const ids = [...w.companyIds];
  const [centers, routings] = await Promise.all([
    rows<WorkCenterRow>(await pm(db).from('work_centers').select('id, location_id, code, name, kind, capacity_minutes_per_week, rate_cents, status, sort').in('location_id', ids).order('sort').order('name'), 'work centers'),
    rows<RoutingRow>(await pm(db).from('routings').select('id, location_id, code, name, version, is_active').in('location_id', ids).order('code').order('version', { ascending: false }), 'routings'),
  ]);
  const steps = routings.length
    ? rows<RoutingStepRow>(await pm(db).from('routing_steps').select('id, routing_id, seq, work_center_id, name, setup_minutes, run_minutes_per_unit').in('routing_id', routings.map((r) => r.id)).order('seq'), 'routing steps')
    : [];
  return { centers, routings, steps };
}

export interface ProductionBoard extends ShopLibrary {
  orders: ProductionStatusRow[];
  load: WorkCenterLoadRow[];
  /** Operations ready or running on released orders (the shop floor list). */
  floor: OperationRow[];
}

/** Production orders in scope: open ones, plus those completed in the last 30 days. */
export async function loadProduction(db: SupabaseClient, w: Where): Promise<ProductionBoard> {
  if (!w.companyIds.length) return { orders: [], load: [], floor: [], centers: [], routings: [], steps: [] };
  const ids = [...w.companyIds];
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  let oq = pm(db).from('v_production_status').select(STATUS_COLS).in('location_id', ids);
  if (w.jobId) oq = oq.eq('job_id', w.jobId);
  oq = oq.or(`status.in.(NEW,RELEASED,IN_PROGRESS,ON_HOLD),completed_at.gte."${since}"`);
  const [orders, load, lib] = await Promise.all([
    rows<ProductionStatusRow>(await oq.order('promised_on', { nullsFirst: false }).limit(500), 'production orders'),
    rows<WorkCenterLoadRow>(await pm(db).from('v_work_center_load').select('location_id, work_center_id, code, name, status, capacity_minutes_per_week, open_std_minutes, backlog_weeks').in('location_id', ids).order('backlog_weeks', { ascending: false, nullsFirst: false }), 'work center load'),
    loadShopLibrary(db, w),
  ]);
  const live = orders.filter((o) => o.status === 'RELEASED' || o.status === 'IN_PROGRESS' || o.status === 'ON_HOLD').map((o) => o.work_order_id);
  const floor = live.length
    ? rows<OperationRow>(await pm(db).from('wo_operations').select(OP_COLS).in('work_order_id', live.slice(0, 300)).in('status', ['READY', 'IN_PROGRESS', 'PENDING']).order('seq'), 'shop operations')
    : [];
  return { orders, load, floor, ...lib };
}

export async function loadJobProduction(db: SupabaseClient, jobId: string): Promise<JobProductionRow | null> {
  return one<JobProductionRow>(
    await pm(db).from('v_job_production').select('location_id, job_id, orders, in_engineering, in_shop, complete, std_minutes, actual_minutes, remaining_std_minutes, pct_complete, any_late').eq('job_id', jobId).maybeSingle(),
    'job production',
  );
}

export interface ProductionDetail {
  order: ProductionOrderRow;
  operations: OperationRow[];
  bom: BomLineRow[];
  /** Job guards release_to_shop also checks, evaluated now (nothing changes). */
  jobGatesFailing: string[];
}

export async function loadProductionDetail(db: SupabaseClient, woId: string): Promise<ProductionDetail | null> {
  const order = one<ProductionOrderRow>(await pm(db).from('work_orders').select(PRODUCTION_COLS).eq('id', woId).eq('kind', 'PRODUCTION').maybeSingle(), 'production order');
  if (!order) return null;
  const [operations, bom, jobGatesFailing] = await Promise.all([
    rows<OperationRow>(await pm(db).from('wo_operations').select(OP_COLS).eq('work_order_id', woId).order('seq'), 'operations'),
    rows<BomLineRow>(await pm(db).from('bom_lines').select(BOM_COLS).eq('work_order_id', woId).order('seq').order('created_at'), 'cut list'),
    order.status === 'NEW' ? checkGuards(db, order.job_id, ['selections_approved', 'has_budget']) : Promise.resolve([] as string[]),
  ]);
  return { order, operations, bom, jobGatesFailing };
}
