import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { one, rows } from '@/lib/pm/db';
import {
  APPROVAL_COLS, AREA_COLS, OPTION_COLS, SELECTION_COLS,
  type ClientApprovalRow, type MeasureAreaRow, type MeasureRow, type MeasureTotalRow, type ProcurementRow, type SelectionOptionRow,
  type SelectionRow, type SelectionStatusRow,
} from './types';
import type { Where } from './field-queries';

const pm = (db: SupabaseClient) => db.schema('pm');

const SEL_STATUS_COLS =
  'location_id, job_id, selection_id, category, title, wbs_id, status, due_on, allowance_cents, chosen_total_cents, variance_cents, approved_at, ' +
  'approved_by_name, proposed_at, option_count, low_cents, high_cents, is_overdue, approved_late';

const PROC_COLS =
  'location_id, job_id, item_id, description, vendor_id, sidemark, status, qty, uom, unit_cost_cents, markup_pct, unit_sell_cents, freight_cents, ' +
  'cost_total_cents, sell_total_cents, margin_cents, margin_pct, po_number, commitment_id, expected_on, received_on, storage_location_id, install_on, ' +
  'delivered_on, installed_on, is_overdue, days_in_storage';

export async function loadSelections(db: SupabaseClient, w: Where): Promise<SelectionStatusRow[]> {
  if (!w.companyIds.length) return [];
  let q = pm(db).from('v_selection_status').select(SEL_STATUS_COLS).in('location_id', [...w.companyIds]);
  if (w.jobId) q = q.eq('job_id', w.jobId);
  return rows<SelectionStatusRow>(await q.order('due_on', { nullsFirst: false }).order('category').limit(1500), 'selections');
}

export async function loadProcurement(db: SupabaseClient, w: Where): Promise<ProcurementRow[]> {
  if (!w.companyIds.length) return [];
  let q = pm(db).from('v_procurement_status').select(PROC_COLS).in('location_id', [...w.companyIds]);
  if (w.jobId) q = q.eq('job_id', w.jobId);
  return rows<ProcurementRow>(await q.order('expected_on', { nullsFirst: false }).limit(1500), 'procurement items');
}

export interface MeasureBundle {
  measures: MeasureRow[];
  areas: MeasureAreaRow[];
  totals: MeasureTotalRow[];
}

/** Takeoffs. pm.measures carries no company column, so the caller filters to its jobs. */
export async function loadMeasures(db: SupabaseClient, w: Where, inScope: (jobId: string) => boolean): Promise<MeasureBundle> {
  let q = pm(db).from('measures').select('id, job_id, work_order_id, version, measured_on, source, status, finalized_at, notes');
  if (w.jobId) q = q.eq('job_id', w.jobId);
  const measures = rows<MeasureRow>(await q.order('job_id').order('version', { ascending: false }).limit(600), 'measures').filter((m) => inScope(m.job_id));
  const ids = measures.map((m) => m.id);
  const [areas, totals] = await Promise.all([
    ids.length ? rows<MeasureAreaRow>(await pm(db).from('measure_areas').select(AREA_COLS).in('measure_id', ids.slice(0, 300)).order('sort').order('created_at'), 'measure areas') : Promise.resolve([] as MeasureAreaRow[]),
    w.companyIds.length
      ? rows<MeasureTotalRow>(await pm(db).from('v_measure_totals').select('job_id, measure_id, version, product_category, material_uom, areas, sqft, linear_ft, material_qty').in('location_id', [...w.companyIds]), 'measure totals')
      : Promise.resolve([] as MeasureTotalRow[]),
  ]);
  return { measures, areas, totals: totals.filter((t) => inScope(t.job_id)) };
}

export interface SelectionDetail {
  selection: SelectionRow;
  options: SelectionOptionRow[];
  approvals: ClientApprovalRow[];
  procurementIds: string[];
}

export async function loadSelectionDetail(db: SupabaseClient, selectionId: string): Promise<SelectionDetail | null> {
  const selection = one<SelectionRow>(await pm(db).from('v_selections_masked').select(SELECTION_COLS).eq('id', selectionId).maybeSingle(), 'selection');
  if (!selection) return null;
  const [options, approvals, items] = await Promise.all([
    rows<SelectionOptionRow>(await pm(db).from('v_selection_options_masked').select(OPTION_COLS).eq('selection_id', selectionId).order('sort').order('created_at'), 'options'),
    rows<ClientApprovalRow>(await pm(db).from('client_approvals').select(APPROVAL_COLS).eq('subject_table', 'selections').eq('subject_id', selectionId).order('decided_at', { ascending: false }), 'client approvals'),
    rows<{ id: string }>(await pm(db).from('procurement_items').select('id').eq('selection_id', selectionId).neq('status', 'CANCELLED'), 'linked items'),
  ]);
  return { selection, options, approvals, procurementIds: items.map((i) => i.id) };
}

export async function loadItemApprovals(db: SupabaseClient, itemId: string): Promise<ClientApprovalRow[]> {
  return rows<ClientApprovalRow>(await pm(db).from('client_approvals').select(APPROVAL_COLS).eq('subject_table', 'procurement_items').eq('subject_id', itemId).order('decided_at', { ascending: false }), 'item approvals');
}

export async function loadStockLocations(db: SupabaseClient, w: Where): Promise<Array<{ id: string; location_id: string; code: string; name: string; kind: string }>> {
  if (!w.companyIds.length) return [];
  return rows(await pm(db).from('stock_locations').select('id, location_id, code, name, kind').in('location_id', [...w.companyIds]).eq('is_active', true).order('code'), 'stock locations');
}
