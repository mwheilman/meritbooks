/**
 * Row shapes the dealer services read (bigint columns coerced to number at the edge).
 * Column names verified against migration 169.
 */

import type {
  CollateralType,
  CostType,
  DeptRole,
  FloorTxnType,
  IncentiveStatus,
  IncentiveTreatment,
  InventoryRole,
  LineStatus,
  NoteStatus,
  PayoffTerms,
  RowStatus,
  UnitCondition,
  UnitStatus,
  WarrantyStatus,
} from '../types';
import type { DealerCtx } from './context';
import { DealerError, dbFail } from './errors';

export interface UnitRow {
  id: string;
  org_id: string;
  location_id: string;
  serial_number: string;
  vin_hin: string | null;
  stock_number: string | null;
  make_vendor_id: string | null;
  model: string | null;
  model_year: number | null;
  item_id: string | null;
  condition: UnitCondition;
  is_consignment: boolean;
  status: UnitStatus;
  inventory_role: InventoryRole;
  department_role: DeptRole;
  received_date: string | null;
  sold_date: string | null;
  warranty_registered_date: string | null;
  cost_cents: number;
  source: string;
}

export interface LineRow {
  id: string;
  location_id: string;
  lender_vendor_id: string;
  name: string;
  credit_limit_cents: number;
  liability_account_id: string | null;
  sau_codes: string[];
  status: LineStatus;
}

export interface ProgramRow {
  id: string;
  line_id: string;
  oem_vendor_id: string | null;
  name: string;
  free_floor_days: number;
  rate_type: string;
  rate_bps: number;
  index_rate_bps: number | null;
  spread_bps: number | null;
  sau_penalty_rate_bps: number | null;
  day_count: 'ACT_365' | 'ACT_360';
  payoff_terms: PayoffTerms;
  payoff_days: number;
  max_term_days: number | null;
  curtail_demos: boolean;
  curtailment_schedule: unknown;
  status: string;
}

export interface NoteRow {
  id: string;
  location_id: string;
  line_id: string;
  program_id: string | null;
  unit_id: string | null;
  collateral_type: CollateralType;
  lender_invoice_number: string;
  floored_date: string;
  original_principal_cents: number;
  principal_balance_cents: number;
  free_floor_end_date: string | null;
  maturity_date: string | null;
  interest_accrued_through: string | null;
  status: NoteStatus;
  sold_date: string | null;
  payoff_due_date: string | null;
  paid_off_date: string | null;
  is_opening: boolean;
}

export interface FloorTxnRow {
  id: string;
  line_id: string;
  note_id: string | null;
  txn_type: FloorTxnType;
  txn_date: string;
  period_end: string | null;
  principal_cents: number;
  interest_cents: number;
  accrual_cleared_cents: number;
  fee_cents: number;
  status: RowStatus;
  gl_entry_id: string | null;
  proposed_by: string | null;
  released_by: string | null;
  idempotency_key: string;
}

export interface CostRow {
  id: string;
  unit_id: string;
  cost_type: CostType;
  amount_cents: number;
  labor_cents: number;
  parts_cents: number;
  source_type: string;
  source_id: string | null;
  offset_role: string | null;
  status: RowStatus;
  gl_entry_id: string | null;
  idempotency_key: string;
  memo: string | null;
}

export interface WarrantyRow {
  id: string;
  location_id: string;
  oem_vendor_id: string;
  oem_claim_number: string | null;
  unit_id: string | null;
  serial_number: string | null;
  labor_cents: number;
  parts_cost_cents: number;
  parts_cents: number;
  sublet_cents: number;
  freight_cents: number;
  other_cents: number;
  claimed_cents: number;
  settled_cents: number;
  written_off_cents: number;
  debited_cents: number;
  status: WarrantyStatus;
  recognized_gl_entry_id: string | null;
  submitted_date: string | null;
  ro_closed_date: string | null;
}

export interface IncentiveRow {
  id: string;
  program_id: string;
  unit_id: string | null;
  sale_id: string | null;
  claim_reference: string | null;
  treatment: IncentiveTreatment;
  accrual_target_role: string | null;
  accrued_cents: number;
  claimed_cents: number;
  settled_cents: number;
  written_off_cents: number;
  status: IncentiveStatus;
  gl_entry_id: string | null;
  earned_date: string;
}

const MONEY = /_cents$/;

/** Coerce bigint-as-string money columns to numbers (safe: cents ≪ 2^53). */
export function coerceMoney<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (MONEY.test(k) && v != null && typeof v !== 'number') out[k] = Number(v);
  }
  return out as T;
}

/** Fetch one row of a dealer table, pinned to the org + client. 404 if absent. */
export async function getRow<T>(d: DealerCtx, table: string, id: string, what: string): Promise<T> {
  const { data, error } = await d.admin
    .from(table)
    .select('*')
    .eq('org_id', d.orgId)
    .eq('location_id', d.locationId)
    .eq('id', id)
    .maybeSingle();
  if (error) dbFail(`${what} lookup failed`, error);
  if (!data) throw new DealerError('NOT_FOUND', `${what} not found for this client`);
  return coerceMoney<T>(data as Record<string, unknown>);
}

/** Insert one row (admin, org+client pinned) and return it. */
export async function insertRow<T>(d: DealerCtx, table: string, values: Record<string, unknown>, what: string): Promise<T> {
  const { data, error } = await d.admin
    .from(table)
    .insert({ ...values, org_id: d.orgId, location_id: d.locationId })
    .select('*')
    .single();
  if (error || !data) {
    if (error && /duplicate key/i.test(error.message)) throw new DealerError('CONFLICT', `${what} already exists`, { db: error.message });
    if (error && /check constraint|not in this|does not belong/i.test(error.message)) throw new DealerError('VALIDATION', `${what}: ${error.message}`);
    dbFail(`Creating ${what} failed`, error);
  }
  return coerceMoney<T>(data as Record<string, unknown>);
}

/** Update rows (admin, org+client pinned). `guard` adds equality filters (optimistic). */
export async function updateRow<T>(
  d: DealerCtx,
  table: string,
  id: string,
  values: Record<string, unknown>,
  what: string,
  guard: Record<string, string | number | boolean | null> = {},
): Promise<T | null> {
  let q = d.admin.from(table).update(values).eq('org_id', d.orgId).eq('location_id', d.locationId).eq('id', id);
  for (const [k, v] of Object.entries(guard)) q = v === null ? q.is(k, null) : q.eq(k, v);
  const { data, error } = await q.select('*').maybeSingle();
  if (error) {
    if (/check constraint|immutable|not in this|does not belong/i.test(error.message)) throw new DealerError('VALIDATION', `${what}: ${error.message}`);
    dbFail(`Updating ${what} failed`, error);
  }
  return data ? coerceMoney<T>(data as Record<string, unknown>) : null;
}

/** Look up a row by idempotency key (org-scoped). */
export async function byKey<T>(d: DealerCtx, table: string, key: string): Promise<T | null> {
  const { data, error } = await d.admin.from(table).select('*').eq('org_id', d.orgId).eq('idempotency_key', key).maybeSingle();
  if (error) dbFail(`${table} lookup failed`, error);
  return data ? coerceMoney<T>(data as Record<string, unknown>) : null;
}
