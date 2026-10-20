/**
 * Dealer Pack (D2 slice A) — client-side row shapes for units, costs, notes, sales
 * and trade-ins as the D1 routes return them (snake_case columns, cents as numbers).
 * Column names verified against migration 169 (dealer_units, dealer_unit_costs,
 * floor_plan_notes, dealer_unit_sales, trade_ins). Type-only, client-safe.
 */

import type {
  CostSourceType,
  CostType,
  DeptRole,
  InventoryRole,
  LienStatus,
  NoteStatus,
  RowStatus,
  SalePostingMode,
  SaleSource,
  TradeStatus,
  TradeValuationPolicy,
  UnitCondition,
  UnitSource,
  UnitStatus,
} from '../types';

export interface UnitView {
  id: string;
  serial_number: string;
  vin_hin: string | null;
  stock_number: string | null;
  make_vendor_id: string | null;
  model: string | null;
  model_year: number | null;
  item_id: string | null;
  description: string | null;
  condition: UnitCondition;
  is_consignment: boolean;
  consignor_vendor_id: string | null;
  status: UnitStatus;
  inventory_role: InventoryRole;
  department_role: DeptRole;
  received_date: string | null;
  sold_date: string | null;
  warranty_registered_date: string | null;
  cost_cents: number;
  list_price_cents: number | null;
  source: UnitSource;
  external_ref: string | null;
  import_batch_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CostView {
  id: string;
  unit_id: string;
  cost_type: CostType;
  amount_cents: number;
  labor_cents: number;
  parts_cents: number;
  source_type: CostSourceType;
  source_id: string | null;
  source_ref: string | null;
  offset_role: string | null;
  memo: string | null;
  status: RowStatus;
  gl_entry_id: string | null;
  proposed_by: string | null;
  posted_by: string | null;
  posted_at: string | null;
  created_at: string;
}

export interface NoteView {
  id: string;
  line_id: string;
  program_id: string | null;
  unit_id: string | null;
  lender_invoice_number: string;
  floored_date: string;
  original_principal_cents: number;
  principal_balance_cents: number;
  free_floor_end_date: string | null;
  maturity_date: string | null;
  status: NoteStatus;
  sold_date: string | null;
  payoff_due_date: string | null;
  paid_off_date: string | null;
  is_opening: boolean;
}

export interface SaleView {
  id: string;
  unit_id: string;
  invoice_id: string | null;
  posting_mode: SalePostingMode;
  customer_id: string | null;
  sale_date: string;
  sale_price_cents: number;
  tax_cents: number;
  deposit_id: string | null;
  deposit_applied_cents: number;
  retail_rebate_cents: number;
  retail_rebate_program_id: string | null;
  trade_in_id: string | null;
  cogs_cents: number | null;
  salesperson: string | null;
  retail_finance_vendor_id: string | null;
  source: SaleSource;
  external_deal_ref: string | null;
  status: RowStatus;
  gl_entry_id: string | null;
  proposed_by: string | null;
  posted_by: string | null;
  posted_at: string | null;
  created_at: string;
}

export interface TradeView {
  id: string;
  sale_id: string | null;
  customer_id: string | null;
  used_unit_id: string | null;
  serial_number: string | null;
  make_vendor_id: string | null;
  model: string | null;
  model_year: number | null;
  allowance_cents: number;
  acv_cents: number;
  valuation_policy: TradeValuationPolicy;
  recorded_value_cents: number;
  over_allowance_cents: number;
  under_allowance_cents: number;
  lien_payoff_cents: number;
  lienholder_vendor_id: string | null;
  lien_status: LienStatus;
  lien_proposed_by: string | null;
  lien_released_by: string | null;
  lien_paid_date: string | null;
  lien_gl_entry_id: string | null;
  appraised_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  status: TradeStatus;
  created_at: string;
}

/** GET /api/dealer/units/detail */
export interface UnitDetailView {
  unit: UnitView;
  costs: CostView[];
  notes: NoteView[];
  sale: SaleView | null;
}

/** The deal's Books invoice (DEAL mode creates it on post). */
export interface DealInvoiceView {
  id: string;
  invoice_number: string;
  status: string;
  total_cents: number;
  balance_cents: number;
}

/** The payoff proposed for the unit's note when the sale posted. */
export interface DealPayoffView {
  id: string;
  note_id: string | null;
  status: RowStatus;
  principal_cents: number;
  txn_date: string;
}

/** GET /api/dealer/deal-detail (slice A read helper). */
export interface DealDetailView {
  sale: SaleView;
  trade: TradeView | null;
  unit: UnitView;
  notes: NoteView[];
  invoice: DealInvoiceView | null;
  payoffs: DealPayoffView[];
  /** PROPOSED cost rows on the unit — a sale can't post while any remain. */
  proposedCostCount: number;
}

/** POST /api/dealer/sales/post */
export interface PostSaleResultView {
  sale: SaleView;
  glEntryId: string;
  invoiceId: string | null;
  usedUnitId: string | null;
  payoffProposalId: string | null;
  warnings: string[];
}
