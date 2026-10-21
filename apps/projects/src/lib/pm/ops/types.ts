/**
 * Row shapes for the industry modules (migrations 1104 field service, 1105 production,
 * 1106 selections, 1107 development) and the 1100 field records the ops pages read.
 * Column names are copied from the migrations (Rule 11); every select in lib/pm/ops
 * names exactly these. bigint cents arrive as JSON numbers; numeric columns are coerced
 * with num() where math happens.
 */

// ---------------------------------------------------------------- 1104 field service
export type WoKind =
  | 'SERVICE' | 'MAINTENANCE_VISIT' | 'INSTALL' | 'MEASURE' | 'DELIVERY' | 'REPAIR_ORDER' | 'PDI' | 'PRODUCTION' | 'INSPECTION';
export const WO_KINDS: ReadonlyArray<WoKind> = ['SERVICE', 'MAINTENANCE_VISIT', 'INSTALL', 'MEASURE', 'DELIVERY', 'REPAIR_ORDER', 'PDI', 'PRODUCTION', 'INSPECTION'];

export type WoStatus = 'NEW' | 'SCHEDULED' | 'DISPATCHED' | 'IN_PROGRESS' | 'ON_HOLD' | 'RELEASED' | 'COMPLETE' | 'CLOSED' | 'CANCELLED';
export type WoOutcome = 'FIXED' | 'COMPLETED' | 'PARTIAL' | 'NOT_FIXED' | 'NEEDS_PARTS' | 'NEEDS_QUOTE' | 'NO_PROBLEM_FOUND' | 'DECLINED' | 'NO_ACCESS';
export const WO_OUTCOMES: ReadonlyArray<WoOutcome> = ['FIXED', 'COMPLETED', 'PARTIAL', 'NOT_FIXED', 'NEEDS_PARTS', 'NEEDS_QUOTE', 'NO_PROBLEM_FOUND', 'DECLINED', 'NO_ACCESS'];
export type PayerType = 'CUSTOMER' | 'OEM' | 'INTERNAL' | 'THIRD_PARTY';

/** pm.work_orders (1104 + production columns from 1105) */
export interface WorkOrderRow {
  id: string;
  location_id: string;
  job_id: string;
  number: string | null;
  kind: WoKind;
  status: WoStatus;
  priority: number;
  summary: string;
  description: string | null;
  complaint: string | null;
  cause: string | null;
  resolution: string | null;
  outcome: WoOutcome | null;
  asset_id: string | null;
  agreement_id: string | null;
  visit_seq: number | null;
  due_on: string | null;
  due_by: string | null;
  requested_start: string | null;
  requested_end: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  estimated_minutes: number | null;
  required_skills: string[];
  promised_on: string | null;
  checked_in_at: string | null;
  meter_in: number | null;
  meter_out: number | null;
  payer_type: PayerType;
  payer_customer_id: string | null;
  is_callback: boolean;
  callback_of_id: string | null;
  follow_up_required: boolean;
  hold_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export const WO_COLS =
  'id, location_id, job_id, number, kind, status, priority, summary, description, complaint, cause, resolution, outcome, asset_id, ' +
  'agreement_id, visit_seq, due_on, due_by, requested_start, requested_end, scheduled_start, scheduled_end, estimated_minutes, ' +
  'required_skills, promised_on, checked_in_at, meter_in, meter_out, payer_type, payer_customer_id, is_callback, callback_of_id, ' +
  'follow_up_required, hold_reason, started_at, completed_at, closed_at, cancelled_at, cancel_reason, created_at, updated_at';

export type AssignmentStatus = 'ASSIGNED' | 'DISPATCHED' | 'EN_ROUTE' | 'ON_SITE' | 'DONE' | 'CANCELLED';

/** pm.dispatch_assignments; slot is a tstzrange string "[a,b)". */
export interface AssignmentRow {
  id: string;
  job_id: string;
  work_order_id: string;
  employee_id: string | null;
  crew_id: string | null;
  slot: string;
  status: AssignmentStatus;
  is_lead: boolean;
  dispatched_at: string | null;
  en_route_at: string | null;
  arrived_at: string | null;
  done_at: string | null;
}
export const ASSIGNMENT_COLS = 'id, job_id, work_order_id, employee_id, crew_id, slot, status, is_lead, dispatched_at, en_route_at, arrived_at, done_at';

/** pm.v_dispatch_board */
export interface DispatchBoardRow {
  location_id: string;
  day: string;
  employee_id: string | null;
  crew_id: string | null;
  assignments: number;
  booked_minutes: number;
  capacity_minutes: number;
  available_minutes: number;
}

/** pm.v_dispatch_queue */
export interface DispatchQueueRow {
  location_id: string;
  work_order_id: string;
  job_id: string;
  number: string | null;
  kind: WoKind;
  priority: number;
  summary: string;
  requested_start: string | null;
  requested_end: string | null;
  due_on: string | null;
  due_by: string | null;
  estimated_minutes: number | null;
  required_skills: string[];
  is_overdue: boolean | null;
  created_at: string;
}

/** pm.crews */
export interface CrewRow {
  id: string;
  location_id: string;
  name: string;
  kind: 'TECH' | 'INSTALL' | 'SHOP' | 'SUBCONTRACT';
  lead_employee_id: string | null;
  vendor_id: string | null;
  capacity_minutes_per_day: number;
  is_active: boolean;
}

/** pm.crew_members */
export interface CrewMemberRow {
  crew_id: string;
  employee_id: string;
  role: 'LEAD' | 'MEMBER' | 'APPRENTICE';
  is_primary: boolean;
}

/** pm.skills */
export interface SkillRow {
  id: string;
  code: string;
  name: string;
  kind: 'SKILL' | 'LICENSE' | 'CERTIFICATION' | 'BRAND';
  is_active: boolean;
}

/** pm.employee_skills */
export interface EmployeeSkillRow {
  employee_id: string;
  skill_id: string;
  level: number | null;
  expires_on: string | null;
}

/** core.employees (identity columns) */
export interface EmployeeRow {
  id: string;
  clerk_user_id: string | null;
  first_name: string;
  last_name: string;
  title: string | null;
  is_active: boolean;
}

export type LineKind = 'SERVICE' | 'PART' | 'LABOR' | 'EQUIPMENT' | 'FEE' | 'DISCOUNT' | 'SUBLET' | 'FREIGHT';
export type LineStatus = 'PROPOSED' | 'APPROVED' | 'DECLINED';

/** pm.work_order_lines */
export interface WoLineRow {
  id: string;
  work_order_id: string;
  sort: number;
  kind: LineKind;
  price_book_item_id: string | null;
  description: string;
  qty: number;
  uom: string;
  unit_price_cents: number | null;
  unit_cost_cents: number | null;
  discount_pct: number;
  labor_minutes: number | null;
  flag_hours: number | null;
  pay_type: 'CUSTOMER' | 'WARRANTY' | 'INTERNAL';
  option_group: string | null;
  status: LineStatus;
  price_overridden: boolean;
  decided_at: string | null;
  decided_by_name: string | null;
  amount_cents: number;
}
export const WO_LINE_COLS =
  'id, work_order_id, sort, kind, price_book_item_id, description, qty, uom, unit_price_cents, unit_cost_cents, discount_pct, labor_minutes, ' +
  'flag_hours, pay_type, option_group, status, price_overridden, decided_at, decided_by_name, amount_cents';

/** pm.price_book_items (1100) */
export interface PriceBookRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  unit: string;
  price_cents: number;
  cost_cents: number | null;
  labor_minutes: number | null;
  is_active: boolean;
}

export type AssetKind = 'CUSTOMER_EQUIPMENT' | 'DEALER_UNIT' | 'RENTAL_UNIT' | 'COMPANY_EQUIPMENT';
export type AssetStatus = 'ACTIVE' | 'REPLACED' | 'RETIRED' | 'SOLD';

/** pm.assets */
export interface AssetRow {
  id: string;
  location_id: string;
  kind: AssetKind;
  customer_id: string | null;
  serial_number: string | null;
  make: string | null;
  model: string | null;
  model_year: number | null;
  description: string | null;
  site_label: string | null;
  site_address_line1: string | null;
  site_city: string | null;
  site_state: string | null;
  site_zip: string | null;
  installed_on: string | null;
  warranty_expires_on: string | null;
  meter_reading: number | null;
  meter_read_on: string | null;
  last_service_on: string | null;
  status: AssetStatus;
  replaced_by_asset_id: string | null;
  retired_on: string | null;
  created_at: string;
}
export const ASSET_COLS =
  'id, location_id, kind, customer_id, serial_number, make, model, model_year, description, site_label, site_address_line1, site_city, ' +
  'site_state, site_zip, installed_on, warranty_expires_on, meter_reading, meter_read_on, last_service_on, status, replaced_by_asset_id, retired_on, created_at';

export type HistoryKind =
  | 'INSTALL' | 'REPAIR' | 'MAINTENANCE' | 'INSPECTION' | 'WARRANTY' | 'RECALL' | 'CALLBACK' | 'PDI' | 'REPLACEMENT' | 'METER_READING' | 'NOTE';

/** pm.v_asset_history */
export interface AssetHistoryRow {
  location_id: string;
  asset_id: string;
  serial_number: string | null;
  make: string | null;
  model: string | null;
  customer_id: string | null;
  history_id: string;
  kind: HistoryKind;
  performed_on: string;
  summary: string | null;
  meter_reading: number | null;
  employee_id: string | null;
  work_order_id: string | null;
  work_order_number: string | null;
  job_id: string | null;
}

export type AgreementStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED' | 'RENEWED';
export type Cadence = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL' | 'CUSTOM';
export type BillingFrequency = 'UPFRONT' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

/** pm.service_agreements */
export interface AgreementRow {
  id: string;
  location_id: string;
  job_id: string;
  customer_id: string;
  number: string | null;
  plan_name: string;
  tier: string | null;
  status: AgreementStatus;
  starts_on: string;
  ends_on: string;
  cadence: Cadence;
  interval_months: number | null;
  first_visit_on: string | null;
  visits_per_term: number | null;
  visit_window_days: number;
  visit_minutes: number;
  required_skills: string[];
  price_cents: number;
  billing_frequency: BillingFrequency;
  member_discount_pct: number | null;
  auto_renew: boolean;
  renewed_from_id: string | null;
  activated_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}
export const AGREEMENT_COLS =
  'id, location_id, job_id, customer_id, number, plan_name, tier, status, starts_on, ends_on, cadence, interval_months, first_visit_on, ' +
  'visits_per_term, visit_window_days, visit_minutes, required_skills, price_cents, billing_frequency, member_discount_pct, auto_renew, ' +
  'renewed_from_id, activated_at, cancelled_at, cancel_reason, created_at';

export type ClaimStatus = 'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'APPROVED' | 'PAID' | 'REJECTED' | 'WRITTEN_OFF';

/** pm.warranty_claims */
export interface WarrantyClaimRow {
  id: string;
  job_id: string;
  work_order_id: string;
  asset_id: string | null;
  payer_customer_id: string;
  claim_number: string | null;
  status: ClaimStatus;
  failure_code: string | null;
  labor_op: string | null;
  claimed_labor_cents: number;
  claimed_parts_cents: number;
  claimed_other_cents: number;
  claimed_cents: number;
  approved_cents: number | null;
  paid_cents: number;
  filing_deadline: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  paid_at: string | null;
  decision_reason: string | null;
  notes: string | null;
  created_at: string;
}
export const CLAIM_COLS =
  'id, job_id, work_order_id, asset_id, payer_customer_id, claim_number, status, failure_code, labor_op, claimed_labor_cents, ' +
  'claimed_parts_cents, claimed_other_cents, claimed_cents, approved_cents, paid_cents, filing_deadline, submitted_at, decided_at, ' +
  'paid_at, decision_reason, notes, created_at';

// ---------------------------------------------------------------- 1105 production
/** pm.v_production_status */
export interface ProductionStatusRow {
  location_id: string;
  job_id: string;
  work_order_id: string;
  number: string | null;
  summary: string;
  status: WoStatus;
  quantity: number;
  promised_on: string | null;
  released_at: string | null;
  completed_at: string | null;
  is_remake: boolean;
  drawings_approved_at: string | null;
  ops_total: number;
  ops_done: number;
  std_minutes: number;
  std_minutes_done: number;
  actual_minutes: number;
  remaining_std_minutes: number;
  pct_complete: number | null;
  current_work_center_id: string | null;
  current_operation: string | null;
  is_late: boolean | null;
}

/** pm.v_job_production */
export interface JobProductionRow {
  location_id: string;
  job_id: string;
  orders: number;
  in_engineering: number;
  in_shop: number;
  complete: number;
  std_minutes: number | null;
  actual_minutes: number | null;
  remaining_std_minutes: number | null;
  pct_complete: number | null;
  any_late: boolean | null;
}

/** pm.v_work_center_load */
export interface WorkCenterLoadRow {
  location_id: string;
  work_center_id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'DOWN' | 'INACTIVE';
  capacity_minutes_per_week: number;
  open_std_minutes: number;
  backlog_weeks: number | null;
}

/** pm.work_centers */
export interface WorkCenterRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  kind: string | null;
  capacity_minutes_per_week: number;
  rate_cents: number | null;
  status: 'ACTIVE' | 'DOWN' | 'INACTIVE';
  sort: number;
}

/** pm.routings */
export interface RoutingRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  version: number;
  is_active: boolean;
}

/** pm.routing_steps */
export interface RoutingStepRow {
  id: string;
  routing_id: string;
  seq: number;
  work_center_id: string;
  name: string;
  setup_minutes: number;
  run_minutes_per_unit: number;
}

export type OpStatus = 'PENDING' | 'READY' | 'IN_PROGRESS' | 'COMPLETE' | 'SKIPPED';

/** pm.wo_operations */
export interface OperationRow {
  id: string;
  job_id: string;
  work_order_id: string;
  work_center_id: string;
  seq: number;
  name: string;
  std_minutes: number;
  actual_minutes: number;
  status: OpStatus;
  is_rework: boolean;
  qty_good: number | null;
  qty_scrap: number;
  employee_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  notes: string | null;
}
export const OP_COLS = 'id, job_id, work_order_id, work_center_id, seq, name, std_minutes, actual_minutes, status, is_rework, qty_good, qty_scrap, employee_id, started_at, completed_at, notes';

export type BomKind = 'ASSEMBLY' | 'PART' | 'SHEET' | 'LUMBER' | 'EDGEBAND' | 'HARDWARE' | 'FINISH' | 'BUYOUT' | 'CONSUMABLE';
export const BOM_KINDS: ReadonlyArray<BomKind> = ['ASSEMBLY', 'PART', 'SHEET', 'LUMBER', 'EDGEBAND', 'HARDWARE', 'FINISH', 'BUYOUT', 'CONSUMABLE'];

/** pm.bom_lines */
export interface BomLineRow {
  id: string;
  work_order_id: string;
  parent_id: string | null;
  seq: number;
  line_kind: BomKind;
  part_code: string | null;
  description: string;
  material: string | null;
  qty: number;
  uom: string;
  length_mm: number | null;
  width_mm: number | null;
  thickness_mm: number | null;
  grain: 'NONE' | 'LENGTH' | 'WIDTH' | null;
  edgeband: string | null;
  assembly_ref: string | null;
}
export const BOM_COLS = 'id, work_order_id, parent_id, seq, line_kind, part_code, description, material, qty, uom, length_mm, width_mm, thickness_mm, grain, edgeband, assembly_ref';

/** Production columns on pm.work_orders the detail panel needs. */
export interface ProductionOrderRow {
  id: string;
  job_id: string;
  location_id: string;
  number: string | null;
  summary: string;
  status: WoStatus;
  quantity: number;
  routing_id: string | null;
  promised_on: string | null;
  drawings_approved_at: string | null;
  drawings_approved_by: string | null;
  released_at: string | null;
  is_remake: boolean;
  hold_reason: string | null;
}
export const PRODUCTION_COLS = 'id, job_id, location_id, number, summary, status, quantity, routing_id, promised_on, drawings_approved_at, drawings_approved_by, released_at, is_remake, hold_reason';

// ---------------------------------------------------------------- 1106 selections
export type SelectionStatus = 'OPEN' | 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'VOID';

/** pm.v_selection_status */
export interface SelectionStatusRow {
  location_id: string;
  job_id: string;
  selection_id: string;
  category: string;
  title: string;
  wbs_id: string | null;
  status: SelectionStatus;
  due_on: string | null;
  allowance_cents: number | null;
  chosen_total_cents: number | null;
  variance_cents: number | null;
  approved_at: string | null;
  approved_by_name: string | null;
  proposed_at: string | null;
  option_count: number;
  low_cents: number | null;
  high_cents: number | null;
  is_overdue: boolean | null;
  approved_late: boolean | null;
}

/** pm.selections (detail columns) */
export interface SelectionRow {
  id: string;
  job_id: string;
  category: string;
  title: string;
  description: string | null;
  allowance_cents: number | null;
  due_on: string | null;
  status: SelectionStatus;
  chosen_option_id: string | null;
  chosen_total_cents: number | null;
  allowance_applied_cents: number | null;
  variance_cents: number | null;
  approved_at: string | null;
  approved_by_name: string | null;
  client_approval_id: string | null;
  rejected_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
}
export const SELECTION_COLS =
  'id, job_id, category, title, description, allowance_cents, due_on, status, chosen_option_id, chosen_total_cents, allowance_applied_cents, ' +
  'variance_cents, approved_at, approved_by_name, client_approval_id, rejected_at, voided_at, void_reason';

/** pm.selection_options */
export interface SelectionOptionRow {
  id: string;
  selection_id: string;
  sort: number;
  label: string;
  description: string | null;
  vendor_sku: string | null;
  qty: number;
  uom: string;
  unit_cost_cents: number | null;
  markup_pct: number | null;
  unit_price_cents: number | null;
  freight_cents: number;
  lead_time_days: number | null;
  is_recommended: boolean;
  amount_cents: number;
}
export const OPTION_COLS = 'id, selection_id, sort, label, description, vendor_sku, qty, uom, unit_cost_cents, markup_pct, unit_price_cents, freight_cents, lead_time_days, is_recommended, amount_cents';

export type ApprovalMethod = 'IN_PERSON' | 'PORTAL' | 'EMAIL' | 'PHONE' | 'E_SIGNATURE';
export const APPROVAL_METHODS: ReadonlyArray<ApprovalMethod> = ['IN_PERSON', 'PORTAL', 'EMAIL', 'PHONE', 'E_SIGNATURE'];

/** pm.client_approvals */
export interface ClientApprovalRow {
  id: string;
  job_id: string;
  subject_table: string;
  subject_id: string;
  decision: 'APPROVED' | 'REJECTED';
  approver_name: string;
  approver_email: string | null;
  method: ApprovalMethod;
  amount_cents: number | null;
  snapshot: Record<string, unknown>;
  comment: string | null;
  decided_at: string;
  recorded_by: string | null;
}
export const APPROVAL_COLS = 'id, job_id, subject_table, subject_id, decision, approver_name, approver_email, method, amount_cents, snapshot, comment, decided_at, recorded_by';

export type ItemStatus =
  | 'SPECIFIED' | 'PROPOSED' | 'APPROVED' | 'ORDERED' | 'ACKNOWLEDGED' | 'BACK_ORDERED' | 'SHIPPED' | 'RECEIVED'
  | 'DAMAGED' | 'STORED' | 'DELIVERED' | 'INSTALLED' | 'RETURNED' | 'CANCELLED';

/** pm.v_procurement_status */
export interface ProcurementRow {
  location_id: string;
  job_id: string;
  item_id: string;
  description: string;
  vendor_id: string | null;
  sidemark: string | null;
  status: ItemStatus;
  qty: number;
  uom: string;
  unit_cost_cents: number | null;
  markup_pct: number | null;
  unit_sell_cents: number | null;
  freight_cents: number;
  cost_total_cents: number;
  sell_total_cents: number;
  margin_cents: number;
  margin_pct: number | null;
  po_number: string | null;
  commitment_id: string | null;
  expected_on: string | null;
  received_on: string | null;
  storage_location_id: string | null;
  install_on: string | null;
  delivered_on: string | null;
  installed_on: string | null;
  is_overdue: boolean | null;
  days_in_storage: number | null;
}

export type MeasureStatus = 'DRAFT' | 'FINAL' | 'SUPERSEDED';

/** pm.measures */
export interface MeasureRow {
  id: string;
  job_id: string;
  work_order_id: string | null;
  version: number;
  measured_on: string;
  source: string;
  status: MeasureStatus;
  finalized_at: string | null;
  notes: string | null;
}

export type AreaKind = 'FLOOR' | 'STAIRS' | 'WALL' | 'BASE' | 'TRANSITION' | 'OTHER';
export type ProductCategory = 'CARPET' | 'LVP' | 'HARDWOOD' | 'LAMINATE' | 'TILE' | 'VINYL_SHEET' | 'RUBBER' | 'OTHER';
export type MaterialUom = 'SF' | 'SY' | 'LF' | 'EA' | 'BOX';

/** pm.measure_areas */
export interface MeasureAreaRow {
  id: string;
  measure_id: string;
  room_name: string;
  area_kind: AreaKind;
  product_category: ProductCategory | null;
  length_ft: number | null;
  width_ft: number | null;
  sqft: number | null;
  linear_ft: number | null;
  each_count: number | null;
  waste_pct: number;
  material_uom: MaterialUom;
  coverage_sf_per_unit: number | null;
  material_qty: number | null;
  sort: number;
  notes: string | null;
}
export const AREA_COLS = 'id, measure_id, room_name, area_kind, product_category, length_ft, width_ft, sqft, linear_ft, each_count, waste_pct, material_uom, coverage_sf_per_unit, material_qty, sort, notes';

/** pm.v_measure_totals */
export interface MeasureTotalRow {
  job_id: string;
  measure_id: string;
  version: number;
  product_category: ProductCategory | null;
  material_uom: MaterialUom;
  areas: number;
  sqft: number | null;
  linear_ft: number | null;
  material_qty: number | null;
}

// ---------------------------------------------------------------- 1107 development
export type UnitStatus = 'PLANNED' | 'ENTITLED' | 'AVAILABLE' | 'UNDER_CONSTRUCTION' | 'COMPLETE' | 'UNDER_CONTRACT' | 'CLOSED' | 'LEASED' | 'HELD';
export type UnitKind = 'LOT' | 'SINGLE_FAMILY' | 'TOWNHOME' | 'CONDO' | 'APARTMENT' | 'COMMERCIAL' | 'PAD';

/** pm.units */
export interface UnitRow {
  id: string;
  job_id: string;
  unit_number: string;
  unit_kind: UnitKind;
  phase: string | null;
  plan_name: string | null;
  sqft: number | null;
  status: UnitStatus;
  list_price_cents: number | null;
  contract_price_cents: number | null;
  lender_release_price_cents: number | null;
  buyer_customer_id: string | null;
  contract_on: string | null;
  est_close_on: string | null;
  closed_on: string | null;
  notes: string | null;
  sort: number;
}
export const UNIT_COLS =
  'id, job_id, unit_number, unit_kind, phase, plan_name, sqft, status, list_price_cents, contract_price_cents, lender_release_price_cents, ' +
  'buyer_customer_id, contract_on, est_close_on, closed_on, notes, sort';

export type EntitlementKind =
  | 'LAND_ACQUISITION' | 'ZONING' | 'SITE_PLAN' | 'PRELIMINARY_PLAT' | 'FINAL_PLAT' | 'ENVIRONMENTAL' | 'UTILITY'
  | 'GRADING_PERMIT' | 'BUILDING_PERMIT' | 'CERTIFICATE_OF_OCCUPANCY' | 'OTHER';
export type EntitlementStatus =
  | 'NOT_STARTED' | 'IN_PREP' | 'SUBMITTED' | 'UNDER_REVIEW' | 'HEARING_SCHEDULED' | 'APPROVED' | 'APPROVED_WITH_CONDITIONS'
  | 'DENIED' | 'EXPIRED' | 'WITHDRAWN';

/** pm.v_entitlement_status (+ reference/conditions from pm.entitlements) */
export interface EntitlementRow {
  location_id: string;
  job_id: string;
  entitlement_id: string;
  unit_id: string | null;
  kind: EntitlementKind;
  name: string;
  authority: string | null;
  status: EntitlementStatus;
  target_on: string | null;
  submitted_on: string | null;
  hearing_on: string | null;
  approved_on: string | null;
  expires_on: string | null;
  is_late: boolean | null;
  expiring_soon: boolean | null;
}

export type DrawCategory = 'LAND' | 'HARD' | 'SOFT' | 'FINANCING' | 'INTEREST_RESERVE' | 'CONTINGENCY' | 'DEVELOPER_FEE' | 'OTHER';
export const DRAW_CATEGORIES: ReadonlyArray<DrawCategory> = ['LAND', 'HARD', 'SOFT', 'FINANCING', 'INTEREST_RESERVE', 'CONTINGENCY', 'DEVELOPER_FEE', 'OTHER'];

/** pm.draw_schedules */
export interface DrawScheduleRow {
  id: string;
  job_id: string;
  lender_name: string;
  loan_number: string | null;
  loan_commitment_cents: number;
  equity_required_cents: number;
  interest_reserve_cents: number;
  interest_rate: number | null;
  projected_monthly_interest_cents: number | null;
  retainage_pct: number;
  requires_inspection: boolean;
  equity_first: boolean;
  loan_closed_on: string | null;
  maturity_on: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'CLOSED';
  activated_at: string | null;
  notes: string | null;
}
export const SCHEDULE_COLS =
  'id, job_id, lender_name, loan_number, loan_commitment_cents, equity_required_cents, interest_reserve_cents, interest_rate, ' +
  'projected_monthly_interest_cents, retainage_pct, requires_inspection, equity_first, loan_closed_on, maturity_on, status, activated_at, notes';

/** pm.draw_budget_lines */
export interface DrawBudgetLineRow {
  id: string;
  draw_schedule_id: string;
  line_no: number;
  description: string;
  category: DrawCategory;
  original_cents: number;
  revised_cents: number | null;
  retainage_applies: boolean | null;
  sort: number;
}

/** pm.v_draw_line_status */
export interface DrawLineStatusRow {
  job_id: string;
  draw_schedule_id: string;
  draw_budget_line_id: string;
  line_no: number;
  description: string;
  category: DrawCategory;
  original_cents: number;
  revised_cents: number;
  drawn_cents: number;
  open_request_cents: number;
  remaining_cents: number;
  pct_drawn: number | null;
  retainage_held_cents: number;
}

/** pm.v_draw_schedule_status */
export interface DrawScheduleStatusRow {
  job_id: string;
  draw_schedule_id: string;
  lender_name: string;
  loan_number: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'CLOSED';
  loan_commitment_cents: number;
  equity_required_cents: number;
  loan_funded_cents: number;
  equity_contributed_cents: number;
  funded_draws: number;
  last_funded_on: string | null;
  original_budget_cents: number;
  revised_budget_cents: number;
  drawn_gross_cents: number;
  retainage_held_cents: number;
  cost_to_complete_cents: number;
  interest_reserve_cents: number;
  interest_reserve_used_cents: number;
  loan_remaining_cents: number;
  equity_remaining_cents: number;
  in_balance_gap_cents: number;
  interest_reserve_remaining_cents: number;
  monthly_interest_cents: number;
  interest_reserve_months: number | null;
  contingency_burn_ratio: number | null;
}

export type DrawStatus = 'DRAFT' | 'SUBMITTED' | 'INSPECTION' | 'APPROVED' | 'FUNDED' | 'RETURNED' | 'CANCELLED';
export type InspectionStatus = 'NOT_REQUESTED' | 'NOT_REQUIRED' | 'PENDING' | 'PASSED' | 'CONDITIONAL' | 'FAILED';

/** pm.v_draw_summary */
export interface DrawSummaryRow {
  job_id: string;
  draw_schedule_id: string;
  draw_id: string;
  draw_number: number;
  period_end: string;
  status: DrawStatus;
  inspection_status: InspectionStatus;
  inspector_pct_complete: number | null;
  lines_requested_cents: number;
  requested_cents: number | null;
  approved_cents: number | null;
  retainage_held_cents: number | null;
  retainage_released_cents: number | null;
  equity_applied_cents: number | null;
  loan_expected_cents: number | null;
  funded_cents: number | null;
  submitted_at: string | null;
  approved_at: string | null;
  funded_at: string | null;
  funded_on: string | null;
  cycle_days: number | null;
  package_missing: string[];
}

/** pm.draws (columns the summary view leaves out) */
export interface DrawDetailRow {
  id: string;
  inspected_on: string | null;
  inspector_name: string | null;
  inspection_notes: string | null;
  lender_approver_name: string | null;
  wire_ref: string | null;
  returned_reason: string | null;
  package: Record<string, unknown>;
  notes: string | null;
}

/** pm.draw_lines */
export interface DrawLineRow {
  id: string;
  draw_id: string;
  draw_budget_line_id: string;
  requested_cents: number;
  approved_cents: number | null;
  retainage_held_cents: number;
  retainage_released_cents: number;
  notes: string | null;
}

// ---------------------------------------------------------------- 1100 field records
export type ApprovalState = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'VOID';
export type PayType = 'REG' | 'OT' | 'DT' | 'PIECE' | 'FLAG';

/** pm.time_entries (+ work_order_id 1104, operation_id 1105) */
export interface TimeEntryRow {
  id: string;
  job_id: string;
  employee_id: string | null;
  user_id: string | null;
  work_date: string;
  hours: number;
  pay_type: PayType;
  cost_code_id: string | null;
  work_order_id: string | null;
  operation_id: string | null;
  billable: boolean;
  notes: string | null;
  approval_state: ApprovalState;
  approved_at: string | null;
  created_by: string | null;
  /** Pinned at approval (1108): pay + burden × pay-type factor. Never overhead. */
  cost_rate_cents: number | null;
  bill_rate_cents: number | null;
  approved_by: string | null;
  /** The JOB_TIME event of the current approval; null when not sent to Merit Books. */
  event_id: string | null;
}
export const TIME_COLS =
  'id, job_id, employee_id, user_id, work_date, hours, pay_type, cost_code_id, work_order_id, operation_id, billable, notes, approval_state, approved_at, ' +
  'created_by, cost_rate_cents, bill_rate_cents, approved_by, event_id';

export type LogKind = 'DAILY' | 'INSPECTION' | 'SAFETY' | 'DELIVERY' | 'VISIT';

/** pm.field_logs */
export interface FieldLogRow {
  id: string;
  job_id: string;
  kind: LogKind;
  log_date: string;
  body: string | null;
  weather: Record<string, unknown> | null;
  crew_count: number | null;
  hours: number | null;
  created_by: string | null;
  created_at: string;
}
export const LOG_COLS = 'id, job_id, kind, log_date, body, weather, crew_count, hours, created_by, created_at';

export type PunchKind = 'PUNCH' | 'WARRANTY' | 'CALLBACK';
export type PunchStatus = 'OPEN' | 'IN_PROGRESS' | 'READY_FOR_REVIEW' | 'CLOSED' | 'VOID';

/** pm.punch_items */
export interface PunchItemRow {
  id: string;
  job_id: string;
  kind: PunchKind;
  title: string;
  description: string | null;
  status: PunchStatus;
  area: string | null;
  responsible_vendor_id: string | null;
  assignee_user_id: string | null;
  due_on: string | null;
  closed_at: string | null;
  billable: boolean;
  created_at: string;
}
export const PUNCH_COLS = 'id, job_id, kind, title, description, status, area, responsible_vendor_id, assignee_user_id, due_on, closed_at, billable, created_at';

// ---------------------------------------------------------------- KPIs
/** pm.v_kpis (long form; one row per company metric, job_id set for per-project metrics) */
export interface KpiRow {
  location_id: string;
  job_id: string | null;
  metric: string;
  value: number | null;
  as_of: string;
  basis: string;
  sample_n: number;
}

/** pm.kpi_defs */
export interface KpiDefRow {
  location_id: string;
  key: string;
  label: string;
  metric: string;
  good_direction: 'up' | 'down';
  sort: number;
}

/** A job reference for labels and pickers. */
export interface JobRefLite {
  job_id: string;
  location_id: string;
  job_number: string | null;
  name: string;
  customer_id: string | null;
  customer_name: string | null;
  job_type_key: string;
  stage_is_terminal: boolean | null;
}

/** numeric → number (PostgREST may send big numerics as strings). */
export function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return 0;
}

export function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One /api/ops/lookup result. */
export interface LookupItem {
  id: string;
  label: string;
  sub: string | null;
  companyId: string | null;
  customerId?: string | null;
  customerName?: string | null;
  priceCents?: number;
  unit?: string;
  laborMinutes?: number | null;
}

