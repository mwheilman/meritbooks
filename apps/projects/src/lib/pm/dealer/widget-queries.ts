import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rows } from '@/lib/pm/db';
import { parseRange, utilization } from './math';
import { unitTitle } from './labels';
import type { DealStage } from './types';

/** The dealer home widgets (components/dealer/widgets), one GET each at /api/dealer/widgets/<key>. */
export const DEALER_WIDGET_KEYS = ['aging', 'desk', 'parts', 'rentals'] as const;
export type DealerWidgetKey = (typeof DEALER_WIDGET_KEYS)[number];

const pm = (db: SupabaseClient) => db.schema('pm');

export interface AgingItem { unitId: string; stock: string | null; title: string; days: number; costCents: number; floored: boolean }
export interface AgingData {
  applies: boolean;
  aged: number;
  agedCostCents: number;
  inStock: number;
  /** 91–180 days: the next ones to age out. */
  coming: number;
  items: AgingItem[];
}

/** Units aging over 180 days (the aged_inventory_count_over_180 rule: IN_STOCK, PDI, DEMO, ON_HOLD). */
export async function loadAging(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<AgingData> {
  if (!companyIds.length) return { applies: false, aged: 0, agedCostCents: 0, inStock: 0, coming: 0, items: [] };
  const r = rows<{ unit_id: string; stock_number: string | null; make: string | null; model: string | null; model_year: number | null; days_in_stock: number | null; cost_cents: number; floored: boolean }>(
    await pm(db).from('v_dealer_unit_inventory').select('unit_id, stock_number, make, model, model_year, days_in_stock, cost_cents, floored')
      .in('location_id', [...companyIds]).in('unit_status', ['IN_STOCK', 'PDI', 'DEMO', 'ON_HOLD']).limit(5000),
    'stock',
  );
  const aged = r.filter((u) => (u.days_in_stock ?? 0) > 180).sort((a, b) => (b.days_in_stock ?? 0) - (a.days_in_stock ?? 0));
  return {
    applies: true,
    aged: aged.length,
    agedCostCents: aged.reduce((s, u) => s + Number(u.cost_cents), 0),
    inStock: r.length,
    coming: r.filter((u) => (u.days_in_stock ?? 0) > 90 && (u.days_in_stock ?? 0) <= 180).length,
    items: aged.slice(0, 8).map((u) => ({ unitId: u.unit_id, stock: u.stock_number, title: unitTitle(u), days: Number(u.days_in_stock), costCents: Number(u.cost_cents), floored: u.floored })),
  };
}

export interface DeskItem { dealId: string; number: string; customer: string | null; grossCents: number; pct: number | null; days: number; stage: DealStage }
export interface DeskData {
  applies: boolean;
  toDesk: number;
  toDeskGrossCents: number;
  toFund: number;
  toDeliver: number;
  items: DeskItem[];
}

/** Deals to desk (WRITTEN), with the approved and funded queues behind them as the comparison. */
export async function loadDesk(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<DeskData> {
  if (!companyIds.length) return { applies: false, toDesk: 0, toDeskGrossCents: 0, toFund: 0, toDeliver: 0, items: [] };
  const r = rows<{ deal_id: string; number: string; customer_name: string | null; total_gross_cents: number | null; front_gross_pct: number | null; stage_entered_at: string; stage: DealStage }>(
    await pm(db).from('v_dealer_deals_pipeline').select('deal_id, number, customer_name, total_gross_cents, front_gross_pct, stage_entered_at, stage')
      .in('location_id', [...companyIds]).in('stage', ['WRITTEN', 'APPROVED', 'FUNDED']).limit(1000),
    'deals',
  );
  const now = Date.now();
  const desk = r.filter((d) => d.stage === 'WRITTEN').sort((a, b) => Date.parse(a.stage_entered_at) - Date.parse(b.stage_entered_at));
  return {
    applies: true,
    toDesk: desk.length,
    toDeskGrossCents: desk.reduce((s, d) => s + Number(d.total_gross_cents ?? 0), 0),
    toFund: r.filter((d) => d.stage === 'APPROVED').length,
    toDeliver: r.filter((d) => d.stage === 'FUNDED').length,
    items: desk.slice(0, 6).map((d) => ({
      dealId: d.deal_id, number: d.number, customer: d.customer_name, grossCents: Number(d.total_gross_cents ?? 0),
      pct: d.front_gross_pct == null ? null : Number(d.front_gross_pct), days: Math.max(0, Math.floor((now - Date.parse(d.stage_entered_at)) / 86_400_000)), stage: d.stage,
    })),
  };
}

export interface PartsBelowItem { partId: string; number: string; description: string; onHand: number; min: number; onOrder: number; bin: string | null }
export interface PartsBelowData {
  applies: boolean;
  below: number;
  covered: number;
  stocked: number;
  items: PartsBelowItem[];
}

/** Parts below minimum (pm.v_parts_on_hand.below_min), and how many are already on order to cover it. */
export async function loadPartsBelow(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<PartsBelowData> {
  if (!companyIds.length) return { applies: false, below: 0, covered: 0, stocked: 0, items: [] };
  const r = rows<{ part_id: string; part_number: string; description: string; qty_on_hand: number; min_qty: number | null; qty_on_order: number; below_min: boolean; bin: string | null }>(
    await pm(db).from('v_parts_on_hand').select('part_id, part_number, description, qty_on_hand, min_qty, qty_on_order, below_min, bin').in('location_id', [...companyIds]).not('min_qty', 'is', null).limit(10_000),
    'parts on hand',
  );
  const below = r.filter((x) => x.below_min);
  const gap = (x: (typeof r)[number]) => Number(x.min_qty ?? 0) - Number(x.qty_on_hand);
  below.sort((a, b) => gap(b) - gap(a));
  return {
    applies: true,
    below: below.length,
    covered: below.filter((x) => Number(x.qty_on_hand) + Number(x.qty_on_order) >= Number(x.min_qty ?? 0)).length,
    stocked: r.length,
    items: below.slice(0, 8).map((x) => ({ partId: x.part_id, number: x.part_number, description: x.description, onHand: Number(x.qty_on_hand), min: Number(x.min_qty ?? 0), onOrder: Number(x.qty_on_order), bin: x.bin })),
  };
}

export interface RentalOutItem { contractId: string; number: string; unit: string; customer: string | null; dueBack: string | null; late: boolean }
export interface RentalsOutData {
  applies: boolean;
  out: number;
  late: number;
  dueToday: number;
  fleet: number;
  utilization: number | null;
  items: RentalOutItem[];
}

/** Rentals out now, late ones first, against fleet size and 90-day time utilization. */
export async function loadRentalsOut(db: SupabaseClient, companyIds: ReadonlyArray<string>, today: string): Promise<RentalsOutData> {
  if (!companyIds.length) return { applies: false, out: 0, late: 0, dueToday: 0, fleet: 0, utilization: null, items: [] };
  const [contracts, util] = await Promise.all([
    rows<{ id: string; number: string; asset_id: string; customer_id: string; reserved: string }>(
      await pm(db).from('rental_contracts').select('id, number, asset_id, customer_id, reserved').in('location_id', [...companyIds]).eq('status', 'OUT').limit(500),
      'rentals out',
    ),
    rows<{ unit_id: string; stock_number: string | null; make: string | null; model: string | null; available_days: number; on_rent_days: number }>(
      await pm(db).from('v_rental_utilization').select('unit_id, stock_number, make, model, available_days, on_rent_days').in('location_id', [...companyIds]).limit(1000),
      'rental fleet',
    ),
  ]);
  const unit = new Map(util.map((u) => [u.unit_id, u]));
  const custIds = [...new Set(contracts.map((c) => c.customer_id))];
  const cust = custIds.length ? rows<{ id: string; name: string; display_name: string | null }>(await db.schema('pm').from('v_core_customers_masked').select('id, name, display_name').in('id', custIds), 'customers') : [];
  const cn = new Map(cust.map((c) => [c.id, c.display_name || c.name]));
  const now = Date.now();
  const items = contracts.map((c): RentalOutItem => {
    const r = parseRange(c.reserved);
    const u = unit.get(c.asset_id);
    return {
      contractId: c.id, number: c.number, unit: u ? [u.stock_number, [u.make, u.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') : 'Unit',
      customer: cn.get(c.customer_id) ?? null, dueBack: r ? new Date(r.end).toISOString() : null, late: !!r && r.end < now,
    };
  }).sort((a, b) => Number(b.late) - Number(a.late) || (a.dueBack ?? '').localeCompare(b.dueBack ?? ''));
  const avail = util.reduce((s, u) => s + Number(u.available_days), 0);
  const onRent = util.reduce((s, u) => s + Number(u.on_rent_days), 0);
  return {
    applies: true,
    out: contracts.length,
    late: items.filter((i) => i.late).length,
    dueToday: items.filter((i) => !i.late && i.dueBack?.slice(0, 10) === today).length,
    fleet: util.length,
    utilization: utilization(onRent, avail),
    items: items.slice(0, 6),
  };
}
