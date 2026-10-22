import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { opsScope, type OpsScope } from '@/lib/pm/ops/scope';
import { rows } from '@/lib/pm/db';
import { isDealerPack } from './labels';
import { SETTINGS_COLS, type DealerSettingsRow, type StockLocationRow } from './types';

/**
 * Dealer companies in a set: the equipment_dealer pack is their primary pack, or one of their
 * active job types has archetype dealer_service (an add-on install, or a pack built on it).
 */
export async function dealerCompanyIds(db: SupabaseClient, companyIds: ReadonlyArray<string>, packByCompany: Readonly<Record<string, string>>): Promise<string[]> {
  if (!companyIds.length) return [];
  const byPack = companyIds.filter((id) => isDealerPack(packByCompany[id]));
  const res = await db.schema('pm').from('job_types').select('location_id').in('location_id', [...companyIds]).eq('archetype', 'dealer_service').eq('is_active', true);
  const byType = res.error ? [] : ((res.data ?? []) as Array<{ location_id: string }>).map((r) => r.location_id);
  const set = new Set([...byPack, ...byType]);
  return companyIds.filter((id) => set.has(id));
}

export interface DealerScope extends OpsScope {
  /** Dealer companies in this view. */
  dealerIds: string[];
  /** The company new records go to: the active company, or the only dealer company in view. */
  writeCompanyId: string | null;
  dealerCompanies: Array<{ id: string; name: string }>;
}

/** The scope every store page starts from (null while the layout shows a gate). */
export async function dealerScope(): Promise<DealerScope | null> {
  const o = await opsScope();
  if (!o) return null;
  const dealerIds = await dealerCompanyIds(o.db, o.companyIds, o.packByCompany);
  const active = o.scope.company?.id ?? null;
  const writeCompanyId = o.scope.readOnly ? null : active && dealerIds.includes(active) ? active : !active && dealerIds.length === 1 ? dealerIds[0]! : null;
  return {
    ...o,
    dealerIds,
    writeCompanyId,
    dealerCompanies: o.companies.filter((c) => dealerIds.includes(c.id)),
  };
}

/** The defaults pm.dealer_settings carries until a manager saves (the table's column defaults). */
export function defaultSettings(locationId: string): DealerSettingsRow {
  return {
    location_id: locationId,
    margin_floor_pct: 0.08,
    min_front_gross_cents: 0,
    desk_roles: ['pm'],
    floor_override_roles: ['ops_manager'],
    payoff_guard: 'WARN',
    payoff_ack_roles: ['pm'],
    unwind_roles: ['ops_manager'],
    trade_reduces_taxable: true,
    default_tax_rate: null,
    unit_stock_location_id: null,
    parts_stock_location_id: null,
    allow_negative_parts: false,
    delivery_checklist: [
      { key: 'pdi_complete', label: 'PDI and setup complete', required: true },
      { key: 'walkaround', label: 'Operator walk-around and safety review', required: true },
      { key: 'operator_manual', label: 'Operator’s manual, keys and accessories handed over', required: true },
      { key: 'buyers_order_signed', label: 'Buyer’s order signed', required: true },
      { key: 'warranty_registration', label: 'Warranty registration submitted', required: false },
    ],
    updated_by: null,
    updated_at: null,
  };
}

/** Settings per company (saved row, else the defaults). Numeric columns arrive as strings from PostgREST. */
export async function loadSettings(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<Record<string, DealerSettingsRow>> {
  if (!companyIds.length) return {};
  const saved = rows<DealerSettingsRow>(await db.schema('pm').from('dealer_settings').select(SETTINGS_COLS).in('location_id', [...companyIds]), 'store settings');
  const out: Record<string, DealerSettingsRow> = {};
  for (const id of companyIds) {
    const s = saved.find((r) => r.location_id === id);
    out[id] = s
      ? { ...s, margin_floor_pct: Number(s.margin_floor_pct), min_front_gross_cents: Number(s.min_front_gross_cents), default_tax_rate: s.default_tax_rate == null ? null : Number(s.default_tax_rate) }
      : defaultSettings(id);
  }
  return out;
}

export async function loadStockLocations(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<StockLocationRow[]> {
  if (!companyIds.length) return [];
  return rows<StockLocationRow>(
    await db.schema('pm').from('stock_locations').select('id, location_id, code, name, kind, is_active').in('location_id', [...companyIds]).order('code'),
    'stock locations',
  );
}
