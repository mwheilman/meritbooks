/**
 * Row shapes for the dealership read models and tables in migration 1109 (pm.v_dealer_*,
 * pm.dealer_*, pm.parts*, pm.rental_*), plus the dealer columns 1109 adds to pm.assets and
 * pm.work_order_lines. Column names are the migration's, verbatim. Money is integer cents;
 * every figure is OPERATIONAL (Merit Books owns the ledger basis, AR, tax and floor plan).
 */

// ---------------------------------------------------------------- vocabularies (CHECK constraints)
export const UNIT_STATUSES = ['ON_ORDER', 'IN_TRANSIT', 'IN_STOCK', 'PDI', 'DEMO', 'RENTAL', 'ON_HOLD', 'SOLD', 'DELIVERED', 'RETURNED_TO_MFR', 'TRANSFERRED'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];
/** Units the inventory view lists (pm.v_dealer_unit_inventory). */
export const INVENTORY_STATUSES: ReadonlyArray<UnitStatus> = ['ON_ORDER', 'IN_TRANSIT', 'IN_STOCK', 'PDI', 'DEMO', 'RENTAL', 'ON_HOLD', 'SOLD'];

export const CONDITIONS = ['NEW', 'USED', 'DEMO', 'RENTAL'] as const;
export type UnitCondition = (typeof CONDITIONS)[number];

export const FLOOR_STATUSES = ['FLOORED', 'SOLD_UNPAID', 'PAID_OFF', 'NOT_FLOORED', 'IN_DEFAULT', 'RETURNED'] as const;
export type FloorStatus = (typeof FLOOR_STATUSES)[number];

export const COST_TYPES = ['BASE_INVOICE', 'FREIGHT', 'SETUP_PDI', 'ACCESSORY', 'RECON', 'OTHER'] as const;
export type UnitCostType = (typeof COST_TYPES)[number];
/** pm.add_unit_cost accepts these (BASE_INVOICE comes with the receipt). */
export const ADDABLE_COST_TYPES: ReadonlyArray<UnitCostType> = ['FREIGHT', 'SETUP_PDI', 'ACCESSORY', 'RECON', 'OTHER'];
export type UnitCostSource = 'RECEIPT' | 'MANUAL' | 'INTERNAL_RO' | 'TRADE_IN';

export const DEAL_STAGES = ['QUOTE', 'WRITTEN', 'APPROVED', 'FUNDED', 'DELIVERED', 'UNWOUND', 'LOST'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const FINANCE_TYPES = ['CASH', 'RETAIL_FINANCE', 'LEASE', 'OPEN_ACCOUNT'] as const;
export type FinanceType = (typeof FINANCE_TYPES)[number];
export const DEAL_LINE_TYPES = ['UNIT', 'ATTACHMENT', 'FEE', 'DISCOUNT', 'REBATE', 'INCENTIVE'] as const;
export type DealLineType = (typeof DEAL_LINE_TYPES)[number];
export type RebateTreatment = 'TRANSACTION_PRICE' | 'COST_REDUCTION' | 'PASS_THROUGH';
export type QuoteStatus = 'ISSUED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'SUPERSEDED';
export type TradeStatus = 'APPRAISED' | 'RECEIVED' | 'UNWOUND' | 'VOID';
export const FI_PRODUCT_TYPES = ['EXTENDED_WARRANTY', 'SERVICE_CONTRACT', 'MAINTENANCE_PLAN', 'GAP', 'CREDIT_LIFE', 'TIRE_WHEEL', 'THEFT', 'OTHER'] as const;
export type FiProductType = (typeof FI_PRODUCT_TYPES)[number];
export type DepositStatus = 'REQUESTED' | 'ISSUED' | 'REJECTED' | 'SUPPRESSED' | 'VOID';
export const PAYOFF_GUARDS = ['OFF', 'WARN', 'BLOCK'] as const;
export type PayoffGuard = (typeof PAYOFF_GUARDS)[number];

export type TicketStatus = 'OPEN' | 'CLOSED' | 'VOID';
export const PAYMENT_METHODS = ['CASH', 'CARD', 'CHARGE', 'CHECK', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type PartStatus = 'ACTIVE' | 'SUPERSEDED' | 'OBSOLETE';
export const SPECIAL_ORDER_STATUSES = ['REQUESTED', 'ORDERED', 'RECEIVED', 'NOTIFIED', 'PICKED_UP', 'CANCELLED'] as const;
export type SpecialOrderStatus = (typeof SPECIAL_ORDER_STATUSES)[number];
export type PartsOrderKind = 'STOCK' | 'EMERGENCY' | 'SPECIAL';
export type PartsOrderStatus = 'DRAFT' | 'SUBMITTED' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED';
export type CountStatus = 'OPEN' | 'POSTED' | 'CANCELLED';

export type RentalStatus = 'RESERVED' | 'OUT' | 'RETURNED' | 'CLOSED' | 'CANCELLED';

export type OutboxStatus = 'HELD' | 'RELEASED' | 'PROCESSED' | 'REJECTED' | 'SUPPRESSED';
export type DealerEventType =
  | 'DEALER_UNIT_RECEIVED' | 'DEALER_UNIT_COST' | 'DEALER_UNIT_STATUS' | 'DEALER_DEAL_FINALIZED' | 'DEALER_DEAL_UNWOUND'
  | 'DEALER_TRADE_RECEIVED' | 'DEALER_PARTS_SALE' | 'DEALER_RO_CLOSED' | 'DEALER_WARRANTY_CLAIM' | 'DEALER_WARRANTY_REGISTRATION'
  | 'DEALER_RENTAL_BILLED' | 'DEALER_DEPOSIT_REQUEST';

/** RO line pay types after 1109 (POLICY added) and kinds (MISC added). */
export const RO_PAY_TYPES = ['CUSTOMER', 'WARRANTY', 'INTERNAL', 'POLICY'] as const;
export type RoPayType = (typeof RO_PAY_TYPES)[number];
export type RoLineKind = 'SERVICE' | 'PART' | 'LABOR' | 'EQUIPMENT' | 'FEE' | 'DISCOUNT' | 'SUBLET' | 'FREIGHT' | 'MISC';
export type WarrantyClaimStatus = 'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'APPROVED' | 'PAID' | 'REJECTED' | 'WRITTEN_OFF';
export type BooksOutcome = 'CREDITED' | 'SHORT_PAID' | 'REJECTED';

// ---------------------------------------------------------------- units
/** pm.v_dealer_unit_inventory */
export interface UnitInventoryRow {
  location_id: string;
  unit_id: string;
  stock_number: string | null;
  serial_number: string | null;
  vin: string | null;
  make: string | null;
  mfr_vendor_id: string | null;
  model: string | null;
  model_year: number | null;
  category: string | null;
  condition: UnitCondition | null;
  unit_status: UnitStatus;
  kind: string;
  stock_location_id: string | null;
  stock_location_code: string | null;
  received_on: string | null;
  days_in_stock: number | null;
  aging_bucket: AgingBucket | null;
  cost_cents: number;
  cost_acked_by_books_cents: number;
  books_cost_cents: number | null;
  books_cost_as_of: string | null;
  retail_price_cents: number | null;
  advertised_price_cents: number | null;
  meter_reading: number | null;
  attachments: unknown;
  floored: boolean;
  floor_status: FloorStatus | null;
  floor_lender_vendor_id: string | null;
  floor_note_ref: string | null;
  payoff_cents: number | null;
  payoff_due_on: string | null;
  payoff_scheduled: boolean;
  floor_status_at: string | null;
  sold_out_of_trust: boolean;
  sot_alert_at: string | null;
  deal_id: string | null;
  deal_number: string | null;
  deal_stage: DealStage | null;
  unit_life: number;
  is_sample: boolean;
}
export const UNIT_INVENTORY_COLS =
  'location_id, unit_id, stock_number, serial_number, vin, make, mfr_vendor_id, model, model_year, category, condition, unit_status, kind, ' +
  'stock_location_id, stock_location_code, received_on, days_in_stock, aging_bucket, cost_cents, cost_acked_by_books_cents, books_cost_cents, ' +
  'books_cost_as_of, retail_price_cents, advertised_price_cents, meter_reading, attachments, floored, floor_status, floor_lender_vendor_id, ' +
  'floor_note_ref, payoff_cents, payoff_due_on, payoff_scheduled, floor_status_at, sold_out_of_trust, sot_alert_at, deal_id, deal_number, ' +
  'deal_stage, unit_life, is_sample';

export type AgingBucket = '0-90' | '91-180' | '181-365' | '365+';

/** pm.assets with the 1109 dealer columns (one unit, any life stage). */
export interface DealerUnitRow {
  id: string;
  location_id: string;
  kind: string;
  status: string;
  customer_id: string | null;
  stock_number: string | null;
  serial_number: string | null;
  vin: string | null;
  make: string | null;
  model: string | null;
  model_year: number | null;
  category: string | null;
  description: string | null;
  condition: UnitCondition | null;
  unit_status: UnitStatus | null;
  unit_life: number;
  stock_location_id: string | null;
  received_on: string | null;
  mfr_invoice_ref: string | null;
  mfr_vendor_id: string | null;
  dealer_cost_cents: number;
  books_cost_cents: number | null;
  books_cost_as_of: string | null;
  retail_price_cents: number | null;
  advertised_price_cents: number | null;
  attachments: unknown;
  unit_sold_on: string | null;
  unit_delivered_on: string | null;
  registration_count: number;
  registered_on: string | null;
  warranty_expires_on: string | null;
  deal_id: string | null;
  is_sample: boolean;
  floored: boolean;
  floor_status: FloorStatus | null;
  floor_lender_vendor_id: string | null;
  floor_note_ref: string | null;
  payoff_due_on: string | null;
  payoff_cents: number | null;
  payoff_scheduled: boolean;
  floor_status_at: string | null;
  sot_alert_at: string | null;
  sot_alert: Record<string, unknown> | null;
  meter_reading: number | null;
  meter_read_on: string | null;
}
export const DEALER_UNIT_COLS =
  'id, location_id, kind, status, customer_id, stock_number, serial_number, vin, make, model, model_year, category, description, condition, ' +
  'unit_status, unit_life, stock_location_id, received_on, mfr_invoice_ref, mfr_vendor_id, dealer_cost_cents, books_cost_cents, books_cost_as_of, ' +
  'retail_price_cents, advertised_price_cents, attachments, unit_sold_on, unit_delivered_on, registration_count, registered_on, warranty_expires_on, ' +
  'deal_id, is_sample, floored, floor_status, floor_lender_vendor_id, floor_note_ref, payoff_due_on, payoff_cents, payoff_scheduled, ' +
  'floor_status_at, sot_alert_at, sot_alert, meter_reading, meter_read_on';

/** pm.dealer_unit_costs */
export interface UnitCostRow {
  id: string;
  asset_id: string;
  unit_life: number;
  cost_type: UnitCostType;
  amount_cents: number;
  labor_cents: number;
  parts_cents: number;
  labor_hours: number | null;
  source: UnitCostSource;
  work_order_id: string | null;
  vendor_id: string | null;
  vendor_invoice_ref: string | null;
  memo: string | null;
  status: 'ACTIVE' | 'VOID';
  outbox_id: string | null;
  created_at: string;
}
export const UNIT_COST_COLS =
  'id, asset_id, unit_life, cost_type, amount_cents, labor_cents, parts_cents, labor_hours, source, work_order_id, vendor_id, vendor_invoice_ref, memo, status, outbox_id, created_at';

/** pm.dealer_floor_status (Books' latest word on the unit). */
export interface FloorStatusRow {
  asset_id: string;
  floored: boolean;
  floor_status: FloorStatus;
  lender_vendor_id: string | null;
  note_ref: string | null;
  principal_cents: number | null;
  payoff_cents: number | null;
  payoff_due_on: string | null;
  payoff_scheduled: boolean;
  curtailment_due_on: string | null;
  curtailment_cents: number | null;
  books_cost_cents: number | null;
  as_of: string;
}
export const FLOOR_STATUS_COLS =
  'asset_id, floored, floor_status, lender_vendor_id, note_ref, principal_cents, payoff_cents, payoff_due_on, payoff_scheduled, curtailment_due_on, curtailment_cents, books_cost_cents, as_of';

/** pm.dealer_sot_alerts */
export interface SotAlertRow {
  id: string;
  asset_id: string;
  deal_id: string | null;
  sold_on: string | null;
  payoff_due_on: string | null;
  days_out_of_trust: number | null;
  amount_cents: number | null;
  message: string | null;
  raised_at: string;
  cleared_at: string | null;
}

/** pm.stock_locations (1104) */
export interface StockLocationRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  kind: string;
  is_active: boolean;
}

/** A photo linked to a unit, deal, trade or rental (pm.document_links + public.documents). */
export interface PhotoItem {
  id: string;
  name: string;
  url: string | null;
}

// ---------------------------------------------------------------- deals
/** pm.v_dealer_deals_pipeline */
export interface DealPipelineRow {
  location_id: string;
  deal_id: string;
  number: string;
  stage: DealStage;
  stage_entered_at: string;
  age_days: number;
  customer_id: string | null;
  customer_name: string | null;
  salesperson_user_id: string | null;
  finance_type: FinanceType;
  unit_count: number | null;
  sale_price_cents: number | null;
  unit_cost_cents: number | null;
  over_allowance_cents: number | null;
  front_gross_cents: number | null;
  back_gross_cents: number | null;
  total_gross_cents: number | null;
  front_gross_pct: number | null;
  balance_due_estimate_cents: number | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_rule: string | null;
  delivered_on: string | null;
  sold_out_of_trust: boolean;
  is_sample: boolean;
  next_action: string | null;
}
export const PIPELINE_COLS =
  'location_id, deal_id, number, stage, stage_entered_at, age_days, customer_id, customer_name, salesperson_user_id, finance_type, unit_count, ' +
  'sale_price_cents, unit_cost_cents, over_allowance_cents, front_gross_cents, back_gross_cents, total_gross_cents, front_gross_pct, ' +
  'balance_due_estimate_cents, approved_by, approved_at, approval_rule, delivered_on, sold_out_of_trust, is_sample, next_action';

export interface ChecklistItem {
  key: string;
  label: string;
  required: boolean;
  done?: boolean;
  done_by?: string | null;
  done_at?: string | null;
}

/** pm.dealer_deals */
export interface DealRow {
  id: string;
  location_id: string;
  number: string;
  customer_id: string | null;
  salesperson_user_id: string | null;
  stage: DealStage;
  stage_entered_at: string;
  tax_rate_estimate: number | null;
  tax_exempt: boolean;
  tax_exempt_ref: string | null;
  finance_type: FinanceType;
  finance_vendor_id: string | null;
  amount_financed_cents: number | null;
  finance_reserve_cents: number;
  subvention_cents: number;
  finance_ref: string | null;
  delivery_checklist: ChecklistItem[];
  approved_by: string | null;
  approved_at: string | null;
  approval: Record<string, unknown> | null;
  funded_at: string | null;
  delivered_on: string | null;
  delivered_at: string | null;
  final_totals: DealTotals | null;
  payoff_ack: Record<string, unknown> | null;
  finalized_outbox_id: string | null;
  unwound_at: string | null;
  unwind_reason: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  sot_alert_at: string | null;
  sot_alert: Record<string, unknown> | null;
  is_sample: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}
export const DEAL_COLS =
  'id, location_id, number, customer_id, salesperson_user_id, stage, stage_entered_at, tax_rate_estimate, tax_exempt, tax_exempt_ref, finance_type, ' +
  'finance_vendor_id, amount_financed_cents, finance_reserve_cents, subvention_cents, finance_ref, delivery_checklist, approved_by, approved_at, ' +
  'approval, funded_at, delivered_on, delivered_at, final_totals, payoff_ack, finalized_outbox_id, unwound_at, unwind_reason, lost_at, lost_reason, ' +
  'sot_alert_at, sot_alert, is_sample, notes, created_by, created_at';

/** pm.dealer_deal_lines */
export interface DealLineRow {
  id: string;
  deal_id: string;
  line_no: number;
  line_type: DealLineType;
  asset_id: string | null;
  part_id: string | null;
  description: string;
  qty: number;
  unit_price_cents: number;
  amount_cents: number;
  cost_cents: number;
  taxable: boolean;
  program_ref: string | null;
  oem_vendor_id: string | null;
  rebate_treatment: RebateTreatment | null;
  sort: number;
}
export const DEAL_LINE_COLS =
  'id, deal_id, line_no, line_type, asset_id, part_id, description, qty, unit_price_cents, amount_cents, cost_cents, taxable, program_ref, oem_vendor_id, rebate_treatment, sort';

/** pm.dealer_trades */
export interface TradeRow {
  id: string;
  deal_id: string;
  asset_id: string | null;
  serial_number: string | null;
  make: string | null;
  model: string | null;
  model_year: number | null;
  meter_reading: number | null;
  description: string | null;
  condition_notes: string | null;
  acv_cents: number | null;
  allowance_cents: number;
  over_allowance_cents: number;
  payoff_cents: number;
  lienholder_vendor_id: string | null;
  lien_account_ref: string | null;
  status: TradeStatus;
  appraised_by: string | null;
  appraised_at: string | null;
  received_asset_id: string | null;
}
export const TRADE_COLS =
  'id, deal_id, asset_id, serial_number, make, model, model_year, meter_reading, description, condition_notes, acv_cents, allowance_cents, ' +
  'over_allowance_cents, payoff_cents, lienholder_vendor_id, lien_account_ref, status, appraised_by, appraised_at, received_asset_id';

/** pm.dealer_fi_products */
export interface FiProductRow {
  id: string;
  deal_id: string;
  product_type: FiProductType;
  provider_vendor_id: string | null;
  description: string | null;
  price_cents: number;
  cost_cents: number;
  term_months: number | null;
  contract_number: string | null;
  sort: number;
}
export const FI_COLS = 'id, deal_id, product_type, provider_vendor_id, description, price_cents, cost_cents, term_months, contract_number, sort';

/** pm.dealer_deposits */
export interface DepositRow {
  id: string;
  deal_id: string;
  amount_cents: number;
  memo: string | null;
  status: DepositStatus;
  outbox_id: string | null;
  invoice_number: string | null;
  error_text: string | null;
  created_at: string;
}
export const DEPOSIT_COLS = 'id, deal_id, amount_cents, memo, status, outbox_id, invoice_number, error_text, created_at';

/** pm.dealer_quotes */
export interface QuoteRow {
  id: string;
  deal_id: string;
  number: string;
  version: number;
  status: QuoteStatus;
  customer_id: string | null;
  valid_until: string | null;
  snapshot: QuoteSnapshot;
  totals: DealTotals;
  issued_by: string | null;
  issued_at: string;
  decided_at: string | null;
  decline_reason: string | null;
}
export const QUOTE_COLS = 'id, deal_id, number, version, status, customer_id, valid_until, snapshot, totals, issued_by, issued_at, decided_at, decline_reason';

export interface QuoteSnapshot {
  lines?: Array<{ line_id: string; line_type: DealLineType; description: string; qty: number; unit_price_cents: number; amount_cents: number; taxable: boolean; unit_id: string | null }>;
  trades?: Array<{ trade_id: string; serial_number: string | null; make: string | null; model: string | null; model_year: number | null; allowance_cents: number; payoff_cents: number }>;
  fi_products?: Array<{ fi_id: string; product_type: FiProductType; description: string | null; price_cents: number; term_months: number | null }>;
  deposits?: Array<{ deposit_id: string; amount_cents: number; status: DepositStatus }>;
  totals?: DealTotals;
}

/** pm.dealer_deal_totals(deal) — the jsonb, key for key. */
export interface DealTotals {
  unit_count: number;
  merchandise_cents: number;
  discount_cents: number;
  sale_price_cents: number;
  unit_cost_cents: number;
  fees_cents: number;
  fee_cost_cents: number;
  rebates_cents: number;
  incentives_cents: number;
  trade_count: number;
  trade_allowance_cents: number;
  trade_acv_cents: number;
  over_allowance_cents: number;
  trade_payoff_cents: number;
  fi_count: number;
  fi_price_cents: number;
  fi_cost_cents: number;
  finance_reserve_cents: number;
  subvention_cents: number;
  front_gross_cents: number;
  back_gross_cents: number;
  total_gross_cents: number;
  front_gross_pct: number | null;
  taxable_estimate_cents: number;
  tax_rate_estimate: number | null;
  tax_estimate_cents: number;
  tax_exempt: boolean;
  deposits_cents: number;
  cash_price_cents: number;
  balance_due_estimate_cents: number;
}

/** pm.dealer_settings (one row per company; defaults until a manager saves). */
export interface DealerSettingsRow {
  location_id: string;
  margin_floor_pct: number;
  min_front_gross_cents: number;
  desk_roles: string[];
  floor_override_roles: string[];
  payoff_guard: PayoffGuard;
  payoff_ack_roles: string[];
  unwind_roles: string[];
  trade_reduces_taxable: boolean;
  default_tax_rate: number | null;
  unit_stock_location_id: string | null;
  parts_stock_location_id: string | null;
  allow_negative_parts: boolean;
  delivery_checklist: ChecklistItem[];
  updated_by: string | null;
  updated_at: string | null;
}
export const SETTINGS_COLS =
  'location_id, margin_floor_pct, min_front_gross_cents, desk_roles, floor_override_roles, payoff_guard, payoff_ack_roles, unwind_roles, ' +
  'trade_reduces_taxable, default_tax_rate, unit_stock_location_id, parts_stock_location_id, allow_negative_parts, delivery_checklist, updated_by, updated_at';

// ---------------------------------------------------------------- parts
/** pm.parts */
export interface PartRow {
  id: string;
  location_id: string;
  item_id: string;
  part_number: string;
  manufacturer: string | null;
  mfr_vendor_id: string | null;
  description: string;
  uom: string;
  category: string | null;
  cost_cents: number | null;
  list_price_cents: number | null;
  price_cents: number | null;
  core_charge_cents: number;
  superseded_by_part_id: string | null;
  status: PartStatus;
  is_active: boolean;
}
export const PART_COLS =
  'id, location_id, item_id, part_number, manufacturer, mfr_vendor_id, description, uom, category, cost_cents, list_price_cents, price_cents, ' +
  'core_charge_cents, superseded_by_part_id, status, is_active';

/** pm.v_parts_on_hand */
export interface PartOnHandRow {
  location_id: string;
  part_id: string;
  part_number: string;
  manufacturer: string | null;
  description: string;
  part_status: PartStatus;
  superseded_by_part_id: string | null;
  stock_location_id: string;
  stock_location_code: string;
  bin: string | null;
  qty_on_hand: number;
  min_qty: number | null;
  max_qty: number | null;
  below_min: boolean;
  qty_on_order: number;
  qty_special_order_open: number;
  cost_cents: number | null;
  price_cents: number | null;
  core_charge_cents: number;
  extended_cost_cents: number;
}
export const ON_HAND_COLS =
  'location_id, part_id, part_number, manufacturer, description, part_status, superseded_by_part_id, stock_location_id, stock_location_code, bin, ' +
  'qty_on_hand, min_qty, max_qty, below_min, qty_on_order, qty_special_order_open, cost_cents, price_cents, core_charge_cents, extended_cost_cents';

/** pm.parts_tickets */
export interface TicketRow {
  id: string;
  location_id: string;
  number: string;
  customer_id: string | null;
  stock_location_id: string;
  status: TicketStatus;
  tax_rate_estimate: number | null;
  tax_exempt: boolean;
  tax_exempt_ref: string | null;
  po_number: string | null;
  payment_method: PaymentMethod | null;
  totals: Record<string, number> | null;
  notes: string | null;
  closed_at: string | null;
  voided_at: string | null;
  outbox_id: string | null;
  created_at: string;
}
export const TICKET_COLS =
  'id, location_id, number, customer_id, stock_location_id, status, tax_rate_estimate, tax_exempt, tax_exempt_ref, po_number, payment_method, totals, notes, closed_at, voided_at, outbox_id, created_at';

/** pm.parts_ticket_lines */
export interface TicketLineRow {
  id: string;
  ticket_id: string;
  line_no: number;
  part_id: string;
  requested_part_id: string | null;
  description: string | null;
  qty_requested: number;
  qty_filled: number;
  qty_special_order: number;
  unit_price_cents: number;
  unit_cost_cents: number | null;
  core_charge_cents: number;
  taxable: boolean;
  amount_cents: number;
  special_order_id: string | null;
  sort: number;
}
export const TICKET_LINE_COLS =
  'id, ticket_id, line_no, part_id, requested_part_id, description, qty_requested, qty_filled, qty_special_order, unit_price_cents, unit_cost_cents, core_charge_cents, taxable, amount_cents, special_order_id, sort';

/** pm.parts_special_orders */
export interface SpecialOrderRow {
  id: string;
  location_id: string;
  number: string;
  part_id: string;
  qty: number;
  customer_id: string | null;
  job_id: string | null;
  work_order_id: string | null;
  deal_id: string | null;
  parts_ticket_line_id: string | null;
  vendor_id: string | null;
  status: SpecialOrderStatus;
  needed_by: string | null;
  ordered_at: string | null;
  received_at: string | null;
  notified_at: string | null;
  picked_up_at: string | null;
  notes: string | null;
  created_at: string;
}
export const SPECIAL_ORDER_COLS =
  'id, location_id, number, part_id, qty, customer_id, job_id, work_order_id, deal_id, parts_ticket_line_id, vendor_id, status, needed_by, ordered_at, received_at, notified_at, picked_up_at, notes, created_at';

/** pm.parts_orders */
export interface PartsOrderRow {
  id: string;
  location_id: string;
  number: string;
  vendor_id: string;
  stock_location_id: string;
  kind: PartsOrderKind;
  status: PartsOrderStatus;
  vendor_ref: string | null;
  submitted_at: string | null;
  received_at: string | null;
  notes: string | null;
  created_at: string;
}
export const PARTS_ORDER_COLS = 'id, location_id, number, vendor_id, stock_location_id, kind, status, vendor_ref, submitted_at, received_at, notes, created_at';

/** pm.parts_order_lines */
export interface PartsOrderLineRow {
  id: string;
  order_id: string;
  line_no: number;
  part_id: string;
  qty_ordered: number;
  qty_received: number;
  unit_cost_cents: number | null;
  special_order_id: string | null;
}
export const PARTS_ORDER_LINE_COLS = 'id, order_id, line_no, part_id, qty_ordered, qty_received, unit_cost_cents, special_order_id';

/** One row of pm.suggest_parts_order(stock_location). */
export interface SuggestedLine {
  part_id: string;
  part_number: string;
  on_hand: number;
  on_order: number;
  min_qty: number;
  max_qty: number | null;
  suggested_qty: number;
}

/** pm.parts_counts */
export interface CountRow {
  id: string;
  location_id: string;
  number: string;
  stock_location_id: string;
  status: CountStatus;
  started_at: string;
  posted_at: string | null;
  variance_summary: { lines?: number; variance_lines?: number; net_variance_qty?: number; variance_cost_cents?: number } | null;
  notes: string | null;
}
export const COUNT_COLS = 'id, location_id, number, stock_location_id, status, started_at, posted_at, variance_summary, notes';

/** pm.parts_count_lines */
export interface CountLineRow {
  id: string;
  count_id: string;
  part_id: string;
  expected_qty: number;
  counted_qty: number | null;
  variance_qty: number | null;
  notes: string | null;
}
export const COUNT_LINE_COLS = 'id, count_id, part_id, expected_qty, counted_qty, variance_qty, notes';

// ---------------------------------------------------------------- service
/** pm.work_order_lines with the 1109 dealer columns. */
export interface RoLineRow {
  id: string;
  work_order_id: string;
  sort: number;
  kind: RoLineKind;
  description: string;
  qty: number;
  uom: string;
  unit_price_cents: number | null;
  unit_cost_cents: number | null;
  discount_pct: number;
  flag_hours: number | null;
  pay_type: RoPayType;
  status: 'PROPOSED' | 'APPROVED' | 'DECLINED';
  option_group: string | null;
  amount_cents: number;
  labor_op: string | null;
  part_id: string | null;
  stock_location_id: string | null;
  issued_move_id: string | null;
}
export const RO_LINE_COLS =
  'id, work_order_id, sort, kind, description, qty, uom, unit_price_cents, unit_cost_cents, discount_pct, flag_hours, pay_type, status, option_group, amount_cents, labor_op, part_id, stock_location_id, issued_move_id';

/** pm.v_warranty_outstanding */
export interface WarrantyOutstandingRow {
  location_id: string;
  claim_id: string;
  claim_number: string | null;
  status: WarrantyClaimStatus;
  job_id: string;
  work_order_id: string;
  ro_number: string | null;
  asset_id: string | null;
  serial_number: string | null;
  payer_customer_id: string;
  oem_vendor_id: string | null;
  claimed_cents: number;
  approved_cents: number | null;
  paid_cents: number;
  short_paid_cents: number;
  outstanding_cents: number;
  submitted_at: string | null;
  days_outstanding: number | null;
  filing_deadline: string | null;
  deadline_at_risk: boolean;
  books_outcome: BooksOutcome | null;
  books_paid_on: string | null;
  last_event_status: OutboxStatus | null;
}
export const WARRANTY_OUTSTANDING_COLS =
  'location_id, claim_id, claim_number, status, job_id, work_order_id, ro_number, asset_id, serial_number, payer_customer_id, oem_vendor_id, ' +
  'claimed_cents, approved_cents, paid_cents, short_paid_cents, outstanding_cents, submitted_at, days_outstanding, filing_deadline, ' +
  'deadline_at_risk, books_outcome, books_paid_on, last_event_status';

/** A claim Merit Books settled (pm.warranty_claims + pm.dealer_warranty_payments). */
export interface SettledClaim {
  claim_id: string;
  claim_number: string | null;
  status: WarrantyClaimStatus;
  work_order_id: string;
  ro_number: string | null;
  payer_customer_id: string;
  claimed_cents: number;
  paid_cents: number;
  short_paid_cents: number;
  books_outcome: BooksOutcome;
  books_paid_on: string | null;
  books_credit_ref: string | null;
  reason: string | null;
}

// ---------------------------------------------------------------- rentals
/** pm.rental_rates */
export interface RentalRateRow {
  id: string;
  location_id: string;
  asset_id: string | null;
  model: string | null;
  category: string | null;
  label: string | null;
  day_cents: number | null;
  week_cents: number | null;
  month_cents: number | null;
  damage_waiver_pct: number | null;
  is_active: boolean;
  created_at: string;
}
export const RENTAL_RATE_COLS = 'id, location_id, asset_id, model, category, label, day_cents, week_cents, month_cents, damage_waiver_pct, is_active, created_at';

/** pm.rental_contracts */
export interface RentalContractRow {
  id: string;
  location_id: string;
  number: string;
  asset_id: string;
  customer_id: string;
  status: RentalStatus;
  reserved: string;
  rate_day_cents: number | null;
  rate_week_cents: number | null;
  rate_month_cents: number | null;
  damage_waiver: boolean;
  damage_waiver_pct: number | null;
  checked_out_at: string | null;
  meter_out: number | null;
  condition_out: string | null;
  checked_in_at: string | null;
  meter_in: number | null;
  condition_in: string | null;
  damage_notes: string | null;
  damage_cents: number;
  fuel_cents: number;
  cleaning_cents: number;
  delivery_cents: number;
  billed_through: string | null;
  closed_at: string | null;
  notes: string | null;
  created_at: string;
}
export const RENTAL_CONTRACT_COLS =
  'id, location_id, number, asset_id, customer_id, status, reserved, rate_day_cents, rate_week_cents, rate_month_cents, damage_waiver, damage_waiver_pct, ' +
  'checked_out_at, meter_out, condition_out, checked_in_at, meter_in, condition_in, damage_notes, damage_cents, fuel_cents, cleaning_cents, delivery_cents, ' +
  'billed_through, closed_at, notes, created_at';

/** pm.rental_billings */
export interface RentalBillingRow {
  id: string;
  contract_id: string;
  period_start: string;
  period_end: string;
  breakdown: RentalCharge & Record<string, number>;
  rental_cents: number;
  damage_waiver_cents: number;
  fees_cents: number;
  total_cents: number;
  is_final: boolean;
  outbox_id: string | null;
  created_at: string;
}
export const RENTAL_BILLING_COLS = 'id, contract_id, period_start, period_end, breakdown, rental_cents, damage_waiver_cents, fees_cents, total_cents, is_final, outbox_id, created_at';

/** pm.v_rental_utilization */
export interface RentalUtilRow {
  location_id: string;
  unit_id: string;
  stock_number: string | null;
  serial_number: string | null;
  make: string | null;
  model: string | null;
  unit_status: UnitStatus;
  available_days: number;
  on_rent_days: number;
  contracts_out: number;
  billed_90d_cents: number;
}
export const RENTAL_UTIL_COLS = 'location_id, unit_id, stock_number, serial_number, make, model, unit_status, available_days, on_rent_days, contracts_out, billed_90d_cents';

/** pm.rental_charge(...) */
export interface RentalCharge {
  days: number;
  months: number;
  weeks: number;
  extra_days: number;
  rate_day_cents?: number;
  rate_week_cents?: number;
  rate_month_cents?: number;
  rental_cents: number;
}

// ---------------------------------------------------------------- seam
/** pm.v_dealer_outbox_queue */
export interface OutboxQueueRow {
  location_id: string;
  outbox_id: string;
  seq: number;
  event_type: DealerEventType;
  source_ref: string;
  status: 'HELD' | 'RELEASED' | 'REJECTED';
  occurred_on: string;
  subject_table: string | null;
  subject_id: string | null;
  created_at: string;
  released_at: string | null;
  acked_at: string | null;
  error_text: string | null;
  resent_count: number;
  age_days: number;
  next_action: string | null;
}
export const OUTBOX_QUEUE_COLS =
  'location_id, outbox_id, seq, event_type, source_ref, status, occurred_on, subject_table, subject_id, created_at, released_at, acked_at, error_text, resent_count, age_days, next_action';

/** pm.dealer_outbox (the few columns a record's "sent to Merit Books" mark needs). */
export interface OutboxMarkRow {
  id: string;
  status: OutboxStatus;
  suppressed_reason: 'SAMPLE' | 'STANDALONE' | null;
  acked_at: string | null;
  error_text: string | null;
  invoice_number: string | null;
}
export const OUTBOX_MARK_COLS = 'id, status, suppressed_reason, acked_at, error_text, invoice_number';
