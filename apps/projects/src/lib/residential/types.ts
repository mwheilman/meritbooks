/**
 * Row shapes of migration 1119 (pm.res_*) as the app reads them. Money columns that 1119 masks
 * (cost, overhead, markup, land cost …) are `number | null`: a member without the money capability
 * reads them as null through the pm.v_<table>_masked views, and the screen draws a dash, never $0.
 */
import type { ContractType, TaxCategory, TaxForm } from './pricing';

export type ProposalStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED' | 'SUPERSEDED';
export type SignMethod = 'IN_PERSON' | 'PORTAL' | 'EMAIL' | 'PHONE' | 'E_SIGNATURE';

export interface ProposalRow {
  id: string;
  location_id: string;
  job_id: string;
  estimate_id: string | null;
  lead_id: string | null;
  customer_id: string | null;
  number: string | null;
  version: number;
  title: string;
  job_type_key: string | null;
  contract_type: ContractType;
  fee_pct: number | null;
  fee_cents: number | null;
  gmp_cents: number | null;
  savings_split_pct: number | null;
  tax_contract_form: TaxForm;
  tax_rate: number;
  state_code: string | null;
  scope_narrative: string | null;
  inclusions: string[];
  exclusions: string[];
  terms: string | null;
  cancellation_notice: string | null;
  cancel_days: number | null;
  deposit_pct: number | null;
  deposit_cents: number | null;
  deposit_refundable: boolean;
  design_proposal_id: string | null;
  credit_to_build: boolean;
  retainer_credit_cents: number;
  schedule_template_key: string | null;
  planned_start: string | null;
  valid_until: string | null;
  status: ProposalStatus;
  base_price_cents: number;
  options_price_cents: number;
  allowance_cents: number;
  contingency_cents: number;
  contingency_pct: number | null;
  fee_total_cents: number;
  tax_cents: number;
  use_tax_cents: number | null;
  total_cents: number;
  grand_total_cents: number;
  cost_cents: number | null;
  overhead_cents: number | null;
  deposit_due_cents: number;
  sent_at: string | null;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  file_id: string | null;
  envelope_id: string | null;
  signed_at: string | null;
  signed_by_name: string | null;
  sign_method: SignMethod | null;
  accepted_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  result: AcceptResult | Record<string, never>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AcceptResult {
  job_id: string;
  estimate_id: string;
  contract_cents: number;
  grand_total_cents: number;
  deposit_cents: number;
  selections_created: number;
  household_invites: number;
  warnings: string[];
  method: SignMethod;
  signer: string | null;
  payment_schedule: Array<{ seq: number; kind: string; amount_cents: number; task_id?: string | null; billing_task_id?: string | null; deposit_request_id?: string | null }>;
}

export interface ProposalOptionRow {
  id: string;
  proposal_id: string;
  kind: 'ALTERNATE' | 'ADD_ON';
  group_key: string | null;
  tier: 'GOOD' | 'BETTER' | 'BEST' | null;
  label: string;
  description: string | null;
  image_url: string | null;
  is_selected: boolean;
  sort: number;
}

export interface ProposalLineRow {
  id: string;
  proposal_id: string;
  option_id: string | null;
  catalog_item_id: string | null;
  assembly_id: string | null;
  cost_code_id: string | null;
  cost_type: string;
  room: string | null;
  description: string;
  qty: number;
  uom: string;
  waste_pct: number;
  unit_cost_cents: number | null;
  markup_pct: number | null;
  margin_pct: number | null;
  unit_price_cents: number | null;
  labor_rate_card_id: string | null;
  labor_hours: number | null;
  cost_cents: number | null;
  overhead_cents: number | null;
  price_cents: number;
  is_allowance: boolean;
  allowance_category: string | null;
  selection_titles: string[];
  is_contingency: boolean;
  tax_category: TaxCategory;
  client_visible: boolean;
  sort: number;
}

export interface PaymentScheduleRow {
  id: string;
  job_id: string;
  proposal_id: string | null;
  seq: number;
  label: string;
  kind: 'DEPOSIT' | 'MILESTONE' | 'FINAL';
  pct: number | null;
  amount_cents: number | null;
  added_cents: number;
  trigger_ref: string | null;
  task_id: string | null;
  billing_task_id: string | null;
  requires_photo: boolean;
  requires_checklist: boolean;
  status: 'PLANNED' | 'SCHEDULED' | 'HELD' | 'DRAFTED' | 'BILLED' | 'VOID';
  hold_reason: string | null;
  billing_request_id: string | null;
  deposit_request_id: string | null;
}

export interface CatalogItemRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  cost_code_id: string | null;
  cost_type: string;
  uom: string;
  unit_cost_cents: number | null;
  waste_pct: number;
  markup_pct: number | null;
  margin_pct: number | null;
  unit_price_cents: number | null;
  price_locked: boolean;
  supplier_sku: string | null;
  vendor_id: string | null;
  lead_time_days: number | null;
  labor_rate_card_id: string | null;
  labor_hours_per_unit: number | null;
  tax_category: TaxCategory;
  is_active: boolean;
}

export interface AssemblyRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  uom: string;
  items: Array<{ catalog_item_id: string; qty_per_unit: number }>;
}

export interface SelectionPreview {
  selection_id: string;
  job_id: string;
  title: string;
  category: string;
  room: string | null;
  status: string;
  due_on: string | null;
  needed_by_on: string | null;
  at_risk: boolean;
  allowance_id: string | null;
  shared: boolean;
  allowance_cents: number | null;
  used_by_others_cents: number | null;
  remaining_cents: number | null;
  money_visible: boolean;
  options: Array<{
    id: string; label: string; description: string | null; vendor_id: string | null; vendor_sku: string | null; finish: string | null;
    image_url: string | null; vendor_url: string | null; lead_time_days: number | null; is_recommended: boolean; qty: number; uom: string;
    amount_cents: number | null; over_cents: number | null; under_cents: number | null; needed_by_on: string | null;
  }>;
}

export interface ChooseResult {
  client_approval_id: string;
  over_cents: number;
  under_cents: number;
  change_order_id: string | null;
  change_order_state: 'approved' | 'awaiting_internal_approval' | null;
  overage_billing: 'UPFRONT' | 'NEXT_MILESTONE' | null;
  deposit_request_id: string | null;
  commitment_id: string | null;
  procurement_item_id: string | null;
  vendor_deposit_id: string | null;
  delivery_task_id: string | null;
  warnings: string[];
}

export interface CoExposureRow {
  id: string;
  job_id: string;
  number: string;
  title: string;
  co_type: 'CLIENT' | 'FIELD_REQUEST' | 'DEMO_DISCOVERY' | 'ALLOWANCE' | 'NO_CHARGE';
  stage: string;
  reason_code: string | null;
  stop_work: boolean;
  emergency: boolean;
  signed_at: string | null;
  signer_name: string | null;
  age_days: number;
  exposure_state: 'unpriced' | 'sent' | 'signed' | 'approved' | 'rejected' | 'void';
  work_logged_unsigned: boolean;
}

export interface TradeConfirmationRow {
  id: string;
  job_id: string;
  task_id: string;
  task_title: string;
  start_on: string | null;
  vendor_id: string;
  status: 'ASSIGNED' | 'NOTIFIED' | 'CONFIRMED' | 'DECLINED' | 'PROPOSED' | 'CANCELLED';
  proposed_on: string | null;
  response_note: string | null;
  at_risk: boolean;
  date_moved_since_confirm: boolean;
}

export interface HomeProfileRow {
  job_id: string;
  occupied: boolean;
  year_built: number | null;
  lockbox_code: string | null;
  alarm_code: string | null;
  garage_code: string | null;
  gate_code: string | null;
  pets: string | null;
  children: string | null;
  work_hours: string | null;
  parking: string | null;
  off_limits: string | null;
  utility_notice: string | null;
  temp_kitchen: string | null;
  bathroom_for_crew: string | null;
  notes: string | null;
  rrp_required: boolean;
  asbestos_suspect: boolean;
  mold_suspect: boolean;
}

export interface RrpRow {
  job_id: string;
  required: boolean;
  renovator_name: string | null;
  renovator_cert_number: string | null;
  renovator_cert_expires_on: string | null;
  pamphlet_ack_name: string | null;
  pamphlet_ack_at: string | null;
  containment_verified_at: string | null;
  cleaning_verified_at: string | null;
  cleaning_card_result: 'PASS' | 'FAIL' | 'RECLEAN_PASS' | null;
  asbestos_test: string;
  mold_test: string;
  retain_until: string | null;
  status: 'OPEN' | 'COMPLETE' | 'NOT_REQUIRED';
}

export interface ProtectionCheckRow {
  id: string;
  kind: 'DAY1_CONTAINMENT' | 'DAILY_CLEANUP' | 'PROTECTION_REMOVAL';
  check_date: string;
  items: Array<{ key: string; label: string; done: boolean }>;
  photo_document_ids: string[];
  status: 'OPEN' | 'PASSED' | 'FAILED';
}

export interface ChainStepRow {
  id: string;
  chain_id: string;
  seq: number;
  step_key: string;
  label: string;
  vendor_id: string | null;
  lead_days: number;
  planned_on: string | null;
  actual_on: string | null;
  status: 'PENDING' | 'SCHEDULED' | 'DONE' | 'SKIPPED';
  homeowner_visible: boolean;
  homeowner_label: string | null;
}

export interface WalkRow {
  id: string;
  kind: 'FINAL_WALKTHROUGH' | 'ORIENTATION' | 'WARRANTY_30' | 'WARRANTY_11M' | 'WARRANTY_2Y' | 'CUSTOM';
  due_on: string | null;
  status: 'PLANNED' | 'SCHEDULED' | 'DONE' | 'SKIPPED';
  punch_created: number;
  accepted_by_name: string | null;
  accepted_at: string | null;
}

export interface PermitRow {
  id: string;
  kind: string;
  number: string | null;
  authority: string | null;
  status: string;
  applied_on: string | null;
  issued_on: string | null;
  expires_on: string | null;
  delivered_on: string | null;
  removal_on: string | null;
  notes: string | null;
}

export interface InspectionRow {
  id: string;
  permit_id: string | null;
  kind: string;
  task_id: string | null;
  requested_on: string;
  scheduled_on: string | null;
  result: 'PENDING' | 'PASS' | 'FAIL' | 'PARTIAL' | 'CANCELLED';
  result_on: string | null;
  inspector: string | null;
  notes: string | null;
  reinspect_of: string | null;
}

export interface HouseholdRow {
  id: string;
  contact_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  relation: string;
  can_sign: boolean;
  can_pay: boolean;
  portal_status: 'PENDING_INVITE' | 'INVITED' | 'ACTIVE' | 'REVOKED' | 'NONE';
}

export interface DecisionItem {
  kind: 'selection' | 'change_order' | 'deposit' | 'proposal' | 'walkthrough';
  id: string;
  title: string;
  due_on: string | null;
  at_risk?: boolean;
  stop_work?: boolean;
  amount_cents?: number | null;
  allowance_cents?: number | null;
  status?: string;
}

export interface IntegrityItem {
  kind: 'milestone_held' | 'milestone_unbilled' | 'change_order_unbilled' | 'cost_plus_unbilled' | 'time_unapproved' | 'coi_expired';
  job_id: string;
  subject_id?: string;
  label?: string;
  reason?: string | null;
  amount_cents?: number | null;
  count?: number;
  expires_on?: string;
}

export interface CommunityRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  status: string;
}

export interface LotBoardRow {
  lot_id: string;
  location_id: string;
  community_id: string;
  community: string;
  lot_number: string;
  block: string | null;
  status: 'RAW' | 'DEVELOPED' | 'AVAILABLE' | 'HELD' | 'SOLD' | 'STARTED' | 'COMPLETE' | 'CLOSED';
  is_spec: boolean;
  plan_id: string | null;
  plan_code: string | null;
  plan_name: string | null;
  standard_cycle_days: number | null;
  job_id: string | null;
  started_on: string | null;
  completed_on: string | null;
  cycle_days: number | null;
  current_stage: string | null;
  pct_complete: number | null;
  behind_standard: boolean | null;
}

export interface PlanRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  base_cost_cents: number | null;
  target_margin_pct: number | null;
  standard_cycle_days: number | null;
  schedule_template_key: string | null;
  job_type_key: string | null;
  is_active: boolean;
}

export interface OptionRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  category: string | null;
  cutoff_stage: 'PRE_START' | 'PRE_FRAME' | 'PRE_DRYWALL' | 'PRE_TRIM' | 'ANYTIME';
  is_structural: boolean;
  cost_cents: number | null;
  is_active: boolean;
}

export interface LotQuote {
  lot_id: string;
  plan_id: string;
  base_price_cents: number | null;
  elevation_cents: number;
  lot_premium_cents: number;
  options: Array<{ option_id: string; code: string; name: string; price_cents: number; cutoff_stage: string; is_structural: boolean; margin_pct: number | null }>;
  options_cents: number;
  total_cents: number;
  issues: string[];
  margin_pct: number | null;
  below_target: boolean | null;
}

export interface PurchaseAgreementRow {
  id: string;
  lot_id: string;
  job_id: string | null;
  customer_id: string | null;
  number: string | null;
  plan_id: string;
  elevation_id: string | null;
  base_price_cents: number;
  elevation_cents: number;
  lot_premium_cents: number;
  options_cents: number;
  incentives_cents: number;
  fees_cents: number;
  total_cents: number;
  earnest_money_cents: number;
  earnest_in_escrow: boolean;
  contingencies: Array<{ kind: string; due_on: string | null; status: string }>;
  status: 'DRAFT' | 'SIGNED' | 'CANCELLED' | 'CLOSED';
  signed_at: string | null;
  signed_by_name: string | null;
}
