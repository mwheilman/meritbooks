/**
 * Row shapes for the money spine (migrations 1102_pm_commitments_billing.sql and
 * 1103_pm_cost_drain.sql). Column names are copied from the migrations; every query
 * in src/lib/pm/money selects exactly these. bigint money arrives as JSON numbers
 * (integer cents); numeric rates arrive as JSON numbers (0.1 = 10%).
 */

export type EstimateStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED' | 'SUPERSEDED';
export type CommitmentType = 'PO' | 'SUBCONTRACT';
export type CommitmentStatus = 'DRAFT' | 'APPROVED' | 'EXECUTED' | 'CLOSED' | 'VOID';
export type CommitmentChangeStatus = 'DRAFT' | 'APPROVED' | 'REJECTED' | 'VOID';
export type ComplianceDocType =
  | 'COI' | 'LIEN_WAIVER_CONDITIONAL' | 'LIEN_WAIVER_UNCONDITIONAL' | 'LIEN_WAIVER_FINAL' | 'W9' | 'CERTIFIED_PAYROLL' | 'OTHER';
export type ComplianceStatus = 'MISSING' | 'RECEIVED' | 'VERIFIED' | 'EXPIRED' | 'REJECTED';
export type SovStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
export type BillingType = 'MILESTONE' | 'PROGRESS' | 'TIME_MATERIALS' | 'DRAW';
export type BillingSubtype = 'SOV' | 'RETAINAGE_RELEASE' | 'ALLOWANCE' | 'RECURRING' | 'FIXED';
export type BillingStatus = 'DRAFT' | 'EMITTED' | 'ISSUED' | 'REJECTED' | 'UNISSUED' | 'VOID';
export type BillingGeneratedBy = 'progress' | 'sov' | 'milestone' | 'tm' | 'retainage_release' | 'allowance';
export type BillingLineType = 'STANDARD' | 'RETAINAGE' | 'RETAINAGE_RELEASE';
export type SuppressedReason = 'STANDALONE' | 'SAMPLE';
export type SeamAlarm = 'OK' | 'WARN' | 'ALARM';

/** pm.estimates */
export interface EstimateRow {
  id: string;
  location_id: string;
  job_id: string;
  customer_id: string | null;
  number: string;
  version: number;
  title: string;
  status: EstimateStatus;
  retainage_pct: number | null;
  valid_until: string | null;
  notes: string | null;
  total_cents: number;
  cost_total_cents: number;
  supersedes_id: string | null;
  budget_id: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** pm.estimate_lines */
export interface EstimateLineRow {
  id: string;
  estimate_id: string;
  line_no: number;
  cost_code_id: string | null;
  description: string;
  qty: number | null;
  uom: string | null;
  unit_cost_cents: number | null;
  unit_price_cents: number | null;
  cost_cents: number | null;
  amount_cents: number;
  is_allowance: boolean;
  sort: number;
  ext: Record<string, unknown>;
  /** 1108: a labor line priced from a rate card (qty = hours; the trigger prices it). */
  labor_rate_card_id?: string | null;
  labor_hours?: number | null;
}

/** pm.commitments */
export interface CommitmentRow {
  id: string;
  location_id: string;
  job_id: string;
  vendor_id: string | null;
  commitment_type: CommitmentType;
  number: string;
  title: string | null;
  description: string | null;
  status: CommitmentStatus;
  retainage_pct: number;
  payment_hold: boolean;
  hold_reason: string | null;
  version: number;
  executed_on: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval: Record<string, unknown> | null;
  event_id: string | null;
  last_emitted_hold: boolean | null;
  suppressed_reason: SuppressedReason | null;
  void_reason: string | null;
  created_by: string | null;
  created_at: string;
}

/** pm.commitment_lines (member-readable columns the UI uses) */
export interface CommitmentLineRow {
  id: string;
  commitment_id: string;
  line_no: number;
  cost_code_id: string | null;
  cost_type: string | null;
  description: string;
  qty: number | null;
  uom: string | null;
  unit_cost_cents: number | null;
  amount_cents: number;
  original_amount_cents: number | null;
  received_qty: number;
  received_cents: number;
  billed_cents: number;
}

/** pm.commitment_changes */
export interface CommitmentChangeRow {
  id: string;
  job_id: string;
  commitment_id: string;
  number: string;
  commitment_line_id: string | null;
  cost_code_id: string | null;
  description: string;
  reason: string | null;
  amount_cents: number;
  owner_co_id: string | null;
  status: CommitmentChangeStatus;
  applied_line_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  reject_reason: string | null;
  created_by: string | null;
  created_at: string;
}

/** pm.receipts */
export interface ReceiptRow {
  id: string;
  job_id: string;
  commitment_id: string;
  commitment_line_id: string;
  qty: number | null;
  amount_cents: number;
  received_on: string;
  over_receipt: boolean;
  packing_slip: string | null;
  memo: string | null;
  status: 'RECEIVED' | 'VOID';
  created_by: string | null;
  created_at: string;
}

/** pm.compliance_docs */
export interface ComplianceDocRow {
  id: string;
  job_id: string;
  commitment_id: string | null;
  vendor_id: string | null;
  doc_type: ComplianceDocType;
  status: ComplianceStatus;
  required: boolean;
  expires_on: string | null;
  covers_through: string | null;
  amount_cents: number | null;
  notes: string | null;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

/** pm.v_commitment_status (one row per commitment line) */
export interface CommitmentStatusRow {
  org_id: string;
  job_id: string;
  location_id: string;
  commitment_id: string;
  number: string;
  commitment_type: CommitmentType;
  vendor_id: string | null;
  vendor_name: string | null;
  status: CommitmentStatus;
  version: number;
  retainage_pct: number;
  manual_hold: boolean;
  hold_reason: string | null;
  compliance_ok: boolean;
  payment_hold_effective: boolean;
  commitment_line_id: string;
  line_no: number;
  cost_code_id: string | null;
  cost_code: string | null;
  cost_type: string | null;
  description: string;
  original_amount_cents: number;
  approved_change_cents: number;
  revised_amount_cents: number;
  billed_cents: number;
  open_cents: number;
  over_billed_cents: number;
  qty: number | null;
  uom: string | null;
  unit_cost_cents: number | null;
  received_qty: number;
  received_cents: number;
  received_not_billed_cents: number;
  pct_billed: number | null;
}

/** pm.sov_versions */
export interface SovVersionRow {
  id: string;
  job_id: string;
  contract_id: string | null;
  version: number;
  status: SovStatus;
  retainage_pct: number | null;
  memo: string | null;
  activated_at: string | null;
  created_at: string;
}

/** pm.sov_lines */
export interface SovLineRow {
  id: string;
  sov_version_id: string;
  lineage_id: string;
  line_no: number;
  cost_code_id: string | null;
  description: string;
  scheduled_value_cents: number;
  retainage_pct: number | null;
  change_order_id: string | null;
  sort: number;
}

/** pm.v_sov_status */
export interface SovStatusRow {
  org_id: string;
  job_id: string;
  sov_version_id: string;
  sov_version: number;
  sov_status: SovStatus;
  sov_line_id: string;
  lineage_id: string;
  line_no: number;
  description: string;
  cost_code_id: string | null;
  scheduled_value_cents: number;
  work_completed_cents: number;
  stored_materials_cents: number;
  completed_and_stored_cents: number;
  pct_complete: number | null;
  balance_to_finish_cents: number;
  retainage_held_cents: number;
  retainage_released_cents: number;
  retainage_outstanding_cents: number;
  last_application_no: number | null;
}

/** pm.billing_requests */
export interface BillingRequestRow {
  id: string;
  location_id: string;
  job_id: string;
  contract_id: string | null;
  billing_type: BillingType;
  billing_subtype: BillingSubtype | null;
  status: BillingStatus;
  generated_by: BillingGeneratedBy | null;
  application_no: number | null;
  sov_version_id: string | null;
  period_start: string | null;
  period_end: string | null;
  occurred_on: string;
  memo: string | null;
  source_ref: string;
  gross_earned_cents: number;
  retainage_cents: number;
  retainage_released_cents: number;
  net_cents: number;
  suppressed_reason: SuppressedReason | null;
  event_id: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  error_text: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  emitted_at: string | null;
  issued_at: string | null;
  void_reason: string | null;
  created_at: string;
}

/** pm.billing_request_lines */
export interface BillingLineRow {
  id: string;
  billing_request_id: string;
  line_no: number;
  sort: number;
  line_type: BillingLineType;
  description: string;
  amount_cents: number;
  cost_code_id: string | null;
  sov_line_id: string | null;
  sov_lineage_id: string | null;
  task_id: string | null;
  wbs_id: string | null;
  allowance_id: string | null;
  scheduled_value_cents: number | null;
  previous_work_cents: number | null;
  this_period_work_cents: number | null;
  stored_materials_cents: number | null;
  previous_stored_cents: number | null;
  total_completed_cents: number | null;
  pct_complete: number | null;
  balance_to_finish_cents: number | null;
  retainage_rate: number | null;
  retainage_work_to_date_cents: number | null;
  retainage_stored_to_date_cents: number | null;
  retainage_this_period_cents: number;
}

/** pm.v_pay_application (AIA G702, one row per SOV request except VOID) */
export interface PayApplicationRow {
  org_id: string;
  job_id: string;
  billing_request_id: string;
  application_no: number;
  period_end: string | null;
  status: BillingStatus;
  sov_version_id: string;
  original_contract_cents: number;
  net_change_by_co_cents: number;
  contract_sum_to_date_cents: number;
  total_completed_stored_cents: number;
  retainage_work_cents: number;
  retainage_stored_cents: number;
  retainage_total_cents: number;
  total_earned_less_retainage_cents: number;
  previous_certificates_cents: number;
  current_payment_due_cents: number;
  balance_to_finish_incl_retainage_cents: number;
  request_net_cents: number;
}

/** pm.v_billing_queue */
export interface BillingQueueRow {
  kind: 'BILLING' | 'DEPOSIT';
  id: string;
  org_id: string;
  location_id: string;
  job_id: string;
  job_number: string | null;
  job_name: string | null;
  customer_name: string | null;
  billing_type: BillingType | null;
  billing_subtype: BillingSubtype | null;
  status: BillingStatus;
  application_no: number | null;
  occurred_on: string;
  period_end: string | null;
  gross_earned_cents: number;
  retainage_cents: number;
  retainage_released_cents: number;
  net_cents: number;
  created_by: string | null;
  created_at: string;
  approved_by: string | null;
  emitted_at: string | null;
  error_text: string | null;
  age_days: number;
  failing_preconditions: string[];
  next_action: 'APPROVE' | 'FIX_AND_RESEND' | 'AWAITING_BOOKS';
}

/** pm.deposit_requests */
export interface DepositRow {
  id: string;
  location_id: string;
  job_id: string;
  customer_id: string | null;
  amount_cents: number;
  memo: string | null;
  occurred_on: string;
  status: BillingStatus;
  suppressed_reason: SuppressedReason | null;
  source_ref: string;
  event_id: string | null;
  invoice_number: string | null;
  error_text: string | null;
  emitted_at: string | null;
  issued_at: string | null;
  created_by: string | null;
  created_at: string;
}

/** pm.allowances */
export interface AllowanceRow {
  id: string;
  job_id: string;
  cost_code_id: string | null;
  description: string;
  allowance_cents: number;
  actual_cents: number | null;
  status: 'OPEN' | 'CLOSED';
  estimate_line_id: string | null;
  variance_co_id: string | null;
  closed_at: string | null;
}

/** pm.v_job_retainage */
export interface JobRetainageRow {
  org_id: string;
  job_id: string;
  held_cents: number;
  released_cents: number;
  outstanding_cents: number;
}

/** pm.v_cost_code_status */
export interface CostCodeStatusRow {
  org_id: string;
  job_id: string;
  cost_code_id: string | null;
  cost_code: string | null;
  cost_code_name: string | null;
  cost_type: string | null;
  budget_cents: number;
  committed_cents: number;
  committed_open_cents: number;
  actual_cents: number;
  pending_cents: number;
  uncommitted_cost_cents: number;
  forecast_cents: number;
  variance_cents: number;
  pct_spent: number | null;
}

/** pm.v_job_financials */
export interface JobFinancialsRow {
  org_id: string;
  job_id: string;
  location_id: string;
  job_number: string | null;
  job_name: string | null;
  original_contract_cents: number;
  approved_co_cents: number;
  revised_contract_cents: number;
  pending_co_cents: number;
  budget_original_cents: number | null;
  revised_budget_cents: number;
  committed_cents: number;
  committed_open_cents: number;
  actual_cost_cents: number;
  pending_cost_cents: number;
  forecast_by_cost_code_cents: number;
  projected_final_cost_cents: number;
  cost_to_complete_cents: number;
  projected_margin_cents: number;
  projected_margin_pct: number | null;
  billed_to_date_cents: number;
  billed_net_to_date_cents: number;
  retainage_held_cents: number;
  retainage_released_cents: number;
  retainage_outstanding_cents: number;
  deposits_requested_cents: number;
  pct_complete_cost: number | null;
  earned_revenue_cents: number | null;
  over_under_billing_cents: number | null;
}

/** pm.v_seam_health */
export interface SeamHealthRow {
  org_id: string;
  event_type: string;
  pending_count: number;
  processed_count: number;
  rejected_count: number;
  oldest_pending_at: string | null;
  oldest_pending_age_minutes: number | null;
  last_processed_at: string | null;
  alarm: SeamAlarm;
  last_drain_at: string | null;
}

/** core.vendors (identity + the AP retainage default, which is a PERCENT 0–100: migration 036). */
export interface VendorRow {
  id: string;
  name: string;
  display_name: string | null;
  email: string | null;
  city: string | null;
  default_retainage_pct: number | null;
  is_active: boolean;
}

/** pm.tasks rows the milestone picker needs (1100 + 1102 billing values). */
export interface MilestoneTaskRow {
  id: string;
  title: string;
  status: string;
  is_milestone: boolean;
  due_on: string | null;
  completed_at: string | null;
  billing_amount_cents: number | null;
  billing_pct: number | null;
}

/** pm.wbs_nodes rows the milestone picker needs. */
export interface MilestoneWbsRow {
  id: string;
  name: string;
  kind: string;
  pct_complete: number | null;
  billing_amount_cents: number | null;
  billing_pct: number | null;
}
