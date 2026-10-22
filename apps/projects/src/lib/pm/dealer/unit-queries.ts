import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rows, one } from '@/lib/pm/db';
import { vendorNames } from '@/lib/pm/ops/scope';
import type { AssetHistoryRow } from '@/lib/pm/ops/types';
import type { ActivityRow } from '@/lib/pm/types';
import {
  DEALER_UNIT_COLS, FLOOR_STATUS_COLS, OUTBOX_MARK_COLS, UNIT_COST_COLS, UNIT_INVENTORY_COLS,
  type DealerUnitRow, type FloorStatusRow, type OutboxMarkRow, type PhotoItem, type SotAlertRow, type UnitCostRow, type UnitInventoryRow,
} from './types';

const pm = (db: SupabaseClient) => db.schema('pm');

export interface StockList {
  units: UnitInventoryRow[];
  vendors: Record<string, string>;
  photoCounts: Record<string, number>;
  capped: boolean;
}

/** Whole goods on hand, on order and held (pm.v_dealer_unit_inventory), oldest first. */
export async function loadStock(db: SupabaseClient, companyIds: ReadonlyArray<string>, cap = 1000): Promise<StockList> {
  if (!companyIds.length) return { units: [], vendors: {}, photoCounts: {}, capped: false };
  const res = await pm(db).from('v_dealer_unit_inventory').select(UNIT_INVENTORY_COLS, { count: 'exact' })
    .in('location_id', [...companyIds]).order('received_on', { ascending: true, nullsFirst: false }).limit(cap);
  const units = rows<UnitInventoryRow>(res, 'unit inventory').map(numUnit);
  const ids = units.map((u) => u.unit_id);
  const [vendors, photoCounts] = await Promise.all([
    vendorNames(db, units.flatMap((u) => [u.mfr_vendor_id, u.floor_lender_vendor_id])),
    countPhotos(db, 'assets', ids),
  ]);
  return { units, vendors, photoCounts, capped: (res.count ?? 0) > units.length };
}

/** Photo counts per subject (display-only: a failure shows no counts rather than failing the page). */
export async function countPhotos(db: SupabaseClient, subjectTable: string, ids: ReadonlyArray<string>): Promise<Record<string, number>> {
  if (!ids.length) return {};
  const r = await pm(db).from('document_links').select('subject_id').eq('subject_table', subjectTable).in('subject_id', ids.slice(0, 1000));
  const out: Record<string, number> = {};
  if (r.error) return out;
  for (const p of (r.data ?? []) as Array<{ subject_id: string }>) out[p.subject_id] = (out[p.subject_id] ?? 0) + 1;
  return out;
}

function numUnit(u: UnitInventoryRow): UnitInventoryRow {
  return {
    ...u,
    cost_cents: Number(u.cost_cents),
    cost_acked_by_books_cents: Number(u.cost_acked_by_books_cents),
    books_cost_cents: u.books_cost_cents == null ? null : Number(u.books_cost_cents),
    payoff_cents: u.payoff_cents == null ? null : Number(u.payoff_cents),
    meter_reading: u.meter_reading == null ? null : Number(u.meter_reading),
    days_in_stock: u.days_in_stock == null ? null : Number(u.days_in_stock),
  };
}

export interface UnitDetail {
  unit: DealerUnitRow;
  inventory: UnitInventoryRow | null;
  costs: UnitCostRow[];
  costMarks: Record<string, OutboxMarkRow>;
  floor: FloorStatusRow | null;
  alerts: SotAlertRow[];
  history: AssetHistoryRow[];
  activity: ActivityRow[];
  openWork: Array<{ id: string; number: string | null; kind: string; status: string; summary: string }>;
  deal: { id: string; number: string; stage: string } | null;
  photos: PhotoItem[];
  vendors: Record<string, string>;
  customer: string | null;
}

/** Everything the unit panel shows: cost build-up, Books' floor word, history, photos. */
export async function loadUnitDetail(db: SupabaseClient, unitId: string): Promise<UnitDetail | null> {
  const unit = one<DealerUnitRow>(await pm(db).from('v_assets_masked').select(DEALER_UNIT_COLS).eq('id', unitId).maybeSingle(), 'unit');
  if (!unit) return null;
  const [inventory, costs, floor, alerts, history, activity, openWork, deal, photos, customer] = await Promise.all([
    pm(db).from('v_dealer_unit_inventory').select(UNIT_INVENTORY_COLS).eq('unit_id', unitId).maybeSingle().then((r) => (r.data ? numUnit(r.data as unknown as UnitInventoryRow) : null)),
    rows<UnitCostRow>(await pm(db).from('dealer_unit_costs').select(UNIT_COST_COLS).eq('asset_id', unitId).order('created_at'), 'unit costs'),
    pm(db).from('dealer_floor_status').select(FLOOR_STATUS_COLS).eq('asset_id', unitId).maybeSingle().then((r) => (r.data ?? null) as FloorStatusRow | null),
    rows<SotAlertRow>(await pm(db).from('dealer_sot_alerts').select('id, asset_id, deal_id, sold_on, payoff_due_on, days_out_of_trust, amount_cents, message, raised_at, cleared_at').eq('asset_id', unitId).order('raised_at', { ascending: false }).limit(10), 'sold-out-of-trust alerts'),
    rows<AssetHistoryRow>(await pm(db).from('v_asset_history').select('location_id, asset_id, serial_number, make, model, customer_id, history_id, kind, performed_on, summary, meter_reading, employee_id, work_order_id, work_order_number, job_id').eq('asset_id', unitId).order('performed_on', { ascending: false }).limit(100), 'unit history'),
    rows<ActivityRow>(await pm(db).from('activity').select('id, location_id, job_id, actor_type, actor_id, verb, subject_table, subject_id, summary, meta, created_at').eq('subject_table', 'assets').eq('subject_id', unitId).order('created_at', { ascending: false }).limit(50), 'unit timeline'),
    rows<{ id: string; number: string | null; kind: string; status: string; summary: string }>(await pm(db).from('work_orders').select('id, number, kind, status, summary').eq('asset_id', unitId).not('status', 'in', '(CLOSED,CANCELLED)').order('created_at', { ascending: false }).limit(10), 'open work on the unit'),
    unit.deal_id ? pm(db).from('dealer_deals').select('id, number, stage').eq('id', unit.deal_id).maybeSingle().then((r) => (r.data ?? null) as UnitDetail['deal']) : Promise.resolve(null),
    loadPhotos(db, 'assets', unitId),
    unit.customer_id ? db.schema('pm').from('v_core_customers_masked').select('name, display_name').eq('id', unit.customer_id).maybeSingle().then((r) => { const c = r.data as { name: string; display_name: string | null } | null; return c ? c.display_name || c.name : null; }) : Promise.resolve(null),
  ]);
  const outboxIds = costs.map((c) => c.outbox_id).filter((x): x is string => !!x);
  const marks = outboxIds.length ? rows<OutboxMarkRow>(await pm(db).from('dealer_outbox').select(OUTBOX_MARK_COLS).in('id', outboxIds), 'cost acks') : [];
  const vendors = await vendorNames(db, [unit.mfr_vendor_id, unit.floor_lender_vendor_id, floor?.lender_vendor_id, ...costs.map((c) => c.vendor_id)]);
  return {
    unit: { ...unit, dealer_cost_cents: Number(unit.dealer_cost_cents), books_cost_cents: unit.books_cost_cents == null ? null : Number(unit.books_cost_cents), payoff_cents: unit.payoff_cents == null ? null : Number(unit.payoff_cents) },
    inventory,
    costs: costs.map((c) => ({ ...c, amount_cents: Number(c.amount_cents), labor_cents: Number(c.labor_cents), parts_cents: Number(c.parts_cents) })),
    costMarks: Object.fromEntries(marks.map((m) => [m.id, m])),
    floor,
    alerts,
    history,
    activity,
    openWork,
    deal,
    photos,
    vendors,
    customer,
  };
}

/** Photos on a non-job subject (pm.document_links → public.documents → signed storage URLs). */
export async function loadPhotos(db: SupabaseClient, subjectTable: string, subjectId: string): Promise<PhotoItem[]> {
  const links = await pm(db).from('document_links').select('document_id').eq('subject_table', subjectTable).eq('subject_id', subjectId).limit(40);
  if (links.error || !links.data?.length) return [];
  const docIds = (links.data as Array<{ document_id: string }>).map((l) => l.document_id);
  const docs = await db.from('documents').select('id, storage_path, file_name, mime_type').in('id', docIds);
  if (docs.error || !docs.data?.length) return [];
  const list = docs.data as Array<{ id: string; storage_path: string; file_name: string; mime_type: string | null }>;
  const signed = await db.storage.from('documents').createSignedUrls(list.map((d) => d.storage_path), 3600);
  const urls = new Map((signed.data ?? []).map((s) => [s.path ?? '', s.signedUrl ?? null]));
  return list.map((d) => ({ id: d.id, name: d.file_name, url: urls.get(d.storage_path) ?? null }));
}
