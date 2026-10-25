/**
 * Row shapes the Wave C commercial screens read (migration 1120 column names, exactly). Money
 * columns are bigint cents; null means masked or not set, never zero. Client-safe (types only).
 */
import type { SheetLine } from './screen-logic';

export interface DirectoryEntry {
  job_id: string;
  directory_id: string;
  party_role: string;
  vendor_id: string | null;
  customer_id: string | null;
  contact_id: string | null;
  company_name: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  trade: string | null;
  csi_divisions: string[] | null;
  distribution_groups: string[] | null;
  is_primary: boolean;
  union_local: string | null;
  dbe: boolean | null;
  mbe: boolean | null;
  wbe: boolean | null;
  emr: number | null;
  licenses: Array<{ state?: string; number?: string; class?: string; expires?: string }> | null;
  prequal_status: string | null;
  prequal_expires: string | null;
}

export interface CompanyProfile {
  id: string;
  location_id: string | null;
  vendor_id: string | null;
  customer_id: string | null;
  csi_divisions: string[];
  trades: string[];
  licenses: Array<{ state?: string; number?: string; class?: string; expires?: string }>;
  union_local: string | null;
  dbe: boolean;
  mbe: boolean;
  wbe: boolean;
  sdvob: boolean;
  emr: number | null;
  emr_year: number | null;
  bonding_single_cents: number | null;
  bonding_aggregate_cents: number | null;
  prequal_status: string;
  prequal_expires: string | null;
  notes: string | null;
}

export interface ProjectTemplate {
  id: string;
  location_id: string | null;
  key: string;
  name: string;
  kind: string;
  description: string | null;
  version: number;
  payload: TemplatePayload;
  is_active: boolean;
  updated_at: string;
}

export interface TemplatePayload {
  contract_settings?: Partial<Record<'change_tiers' | 'billing_cutoff_day' | 'rfi_default_days' | 'submittal_review_days', number>> &
    Partial<Record<'billing_form' | 'retainage_step_mode', string>> &
    Partial<Record<'architect_certification' | 'bonded' | 'prevailing_wage', boolean>> & { stored_retainage_pct?: number; px_threshold_cents?: number };
  markup_rules?: Array<{ kind: string; label?: string; applies_to?: string; cost_type?: string | null; pct: number; compounding?: boolean; sort?: number }>;
  retainage_steps?: Array<{ side?: string; from_pct: number; rate: number; note?: string }>;
  compliance_requirements?: Array<{ requirement: string; min_limit_cents?: number; endorsement_forms?: string[] }>;
  closeout?: Array<{ category: string; title: string; form_ref?: string; required?: boolean }>;
  meetings?: Array<{ type: string; title?: string; series_key?: string }>;
  [k: string]: unknown;
}

export interface TemplateApplication { job_id: string; template_id: string; version: number; applied_at: string }

export interface TradeProposal {
  id: string;
  location_id: string;
  customer_id: string | null;
  number: string | null;
  project_name: string;
  base_bid_cents: number | null;
  alternates: Array<{ label: string; amount_cents: number; accepted?: boolean }>;
  unit_prices: Array<{ item: string; uom: string; unit_cents: number }>;
  inclusions: string[];
  exclusions: string[];
  qualifications: string[];
  schedule_assumptions: string | null;
  valid_until: string | null;
  status: string;
  sent_at: string | null;
  accepted_at: string | null;
  job_id: string | null;
  created_at: string;
}

export interface PayAppStatusRow {
  id: string;
  job_id: string;
  billing_request_id: string;
  application_no: number;
  revision: number;
  stage: string;
  pencil_sent_at: string | null;
  pencil_sent_to: string | null;
  returned_note: string | null;
  architect_name: string | null;
  certified_at: string | null;
  certified_amount_cents: number | null;
  /** Who recorded the certification (never the preparer). */
  certified_by?: string | null;
  contractor_signed_at: string | null;
  notarized_at: string | null;
  owner_approved_at: string | null;
  portal: string | null;
  portal_status: string | null;
  portal_submitted_at: string | null;
  superseded_by: string | null;
}

/** pm.v_pay_application (G702 face). */
export interface G702Row {
  job_id: string;
  billing_request_id: string;
  application_no: number;
  period_end: string | null;
  status: string;
  original_contract_cents: number | null;
  net_change_by_co_cents: number | null;
  contract_sum_to_date_cents: number | null;
  total_completed_stored_cents: number | null;
  retainage_work_cents: number | null;
  retainage_stored_cents: number | null;
  retainage_total_cents: number | null;
  total_earned_less_retainage_cents: number | null;
  previous_certificates_cents: number | null;
  current_payment_due_cents: number | null;
  balance_to_finish_incl_retainage_cents: number | null;
  request_net_cents: number | null;
}

export interface PayAppListRow extends G702Row { stage: string | null; revision: number; portal: string | null; portal_status: string | null }

export interface PayAppRevision { id: string; revision: number; reason: string | null; totals: { gross_earned_cents?: number; retainage_cents?: number; net_cents?: number }; created_at: string; lines: Array<Record<string, unknown>> }

export interface PayAppPreview {
  gross_earned_cents: number | null;
  retainage_cents: number | null;
  net_cents: number | null;
  billed_to_date_cents: number | null;
  earned_revenue_cents: number | null;
  over_under_before_cents: number | null;
  over_under_after_cents: number | null;
  preconditions: string[];
  warnings: Array<{ code: string; text: string }>;
}

export interface ContractSettings {
  billing_cutoff_day: number;
  billing_form: string;
  billing_portal_url: string | null;
  retainage_step_mode: string;
  stored_retainage_pct: number | null;
  architect_certification: boolean;
  notarization_required: boolean;
}

export interface EnvelopeLite { id: string; status: string; title: string; sent_at: string | null; completed_at: string | null; signers: Array<{ name: string; status: string; signed_at: string | null; role_label: string | null }> }

export interface PayAppWorkspaceData {
  jobId: string;
  jobLabel: string;
  requestId: string;
  requestStatus: string;
  periodEnd: string | null;
  applicationNo: number | null;
  g702: G702Row | null;
  lines: SheetLine[];
  status: PayAppStatusRow | null;
  revisions: PayAppRevision[];
  preview: PayAppPreview | null;
  settings: ContractSettings | null;
  steps: Array<{ from_pct: number; rate: number; note: string | null }>;
  envelopes: EnvelopeLite[];
  /** Other applications on the job (for the switcher). */
  siblings: Array<{ id: string; application_no: number | null; revision: number; stage: string | null; period_end: string | null }>;
}

export interface CostCodeLite { id: string; code: string; name: string }
export interface CommitmentMoney { commitment_id: string; number: string; vendor_name: string | null; committed: number | null; invoiced: number | null; paid: number | null; open: number | null }

export interface SpecSection { id: string; job_id: string; number: string; title: string; division: string | null; revision: number; addendum: string | null; document_id: string | null; page_start: number | null; page_end: number | null; updated_at: string }

export interface Transmittal { id: string; job_id: string; number: string | null; subject: string; to_name: string | null; to_company: string | null; to_email: string | null; purpose: string; items: Array<{ description: string; copies?: number; document_id?: string | null }>; notes: string | null; status: string; sent_at: string | null; acknowledged_at: string | null; acknowledged_by: string | null; created_at: string }
export interface Correspondence { id: string; job_id: string; corr_type: string; number: string | null; direction: string; subject: string; body: string | null; from_name: string | null; to_name: string | null; to_company: string | null; sent_on: string | null; response_required_by: string | null; responded_on: string | null; status: string; change_event_id: string | null; created_at: string }

export interface Inspection { id: string; job_id: string; template_id: string | null; number: string | null; title: string; category: string | null; area: string | null; inspected_on: string; inspector_name: string | null; status: string; result: string | null; signed_by_name: string | null; signed_at: string | null }
export interface InspectionItem { id: string; sort: number; section: string | null; label: string; requires_photo: boolean; response: 'PASS' | 'FAIL' | 'NA' | null; value: string | null; note: string | null; photo_ids: string[]; observation_id: string | null }
export interface ChecklistTemplate { id: string; name: string; category: string; items?: Array<{ label: string; requires_photo?: boolean; section?: string }> }

export interface Observation { id: string; job_id: string; number: string | null; obs_type: string; priority: string; title: string; description: string | null; hazard: string | null; contributing_condition: string | null; assignee_vendor_id: string | null; assignee_name: string | null; due_on: string | null; status: string; closed_at: string | null; inspection_item_id: string | null; created_at: string }

export interface ToolboxTalk { id: string; job_id: string; held_on: string; topic: string; language: string; presenter_name: string | null; notes: string | null; attendees: number }
export interface Jha { id: string; job_id: string; work_date: string; task_description: string; area: string | null; steps: Array<{ step: string; hazard?: string; control?: string; hazards?: string[]; controls?: string[] }>; ppe: string[]; permits: string[]; status: string; signoffs: Array<{ name: string; company?: string | null; signed_at?: string }> }
export interface Incident {
  id: string; job_id: string; number: string | null; incident_type: string; occurred_at: string; reported_at: string; person_name: string | null; job_title: string | null; company: string | null;
  is_employee: boolean; description: string; where_occurred: string | null; body_part: string | null; injury_nature: string | null; object_substance: string | null;
  witnesses: Array<{ name: string; phone?: string; statement?: string }>; root_cause: string | null; corrective_actions: Array<{ action: string; owner?: string; due?: string; done?: boolean }>;
  osha_recordable: boolean | null; osha_classification: string | null; injury_or_illness: string | null; days_away: number; days_restricted: number; privacy_case: boolean;
  case_number: string | null; wc_claim_ref: string | null; status: string;
}
export interface Osha300Row { case_number: string | null; person_name: string; job_title: string | null; occurred_on: string; where_occurred: string | null; description: string | null; classification: string | null; days_away: number; days_restricted: number; injury_or_illness: string | null; job_id: string; incident_id: string }
export interface Osha300A {
  year: number; deaths: number; days_away_cases: number; restricted_cases: number; other_recordable_cases: number; total_days_away: number; total_days_restricted: number;
  injuries: number; skin_disorders: number; respiratory: number; poisonings: number; hearing_loss: number; other_illnesses: number;
  hours_worked: number; hours_from_time: number; hours_manual: number; near_misses: number; trir: number | null; dart: number | null;
}

export interface ProductivityRow {
  cost_code_id: string; cost_code: string | null; cost_code_name: string | null; uom: string | null; budget_qty: number | null; budget_hours: number | null; unit_hours: number | null;
  installed_qty: number | null; pct_complete: number | null; earned_hours: number | null; actual_hours: number | null; productivity_factor: number | null;
  pct_hours_used: number | null; projected_hours: number | null; variance_hours: number | null;
}
export interface FadeAlert { id: string; job_id: string; cost_code_id: string; week_start: string; budget_hours: number | null; earned_hours: number | null; actual_hours: number | null; week_earned_hours: number | null; week_actual_hours: number | null; productivity_factor: number | null; pct_hours_used: number | null; pct_complete: number | null; projected_hours: number | null; severity: string; cause_hint: string | null; status: string }
export interface InstalledQty { id: string; job_id: string; cost_code_id: string; work_date: string; qty: number | null; pct_complete: number | null; uom: string | null; area: string | null; note: string | null; created_at: string }
export interface CostCodeUnit { id: string; job_id: string; cost_code_id: string; budget_qty: number | null; uom: string | null; budget_hours: number; unit_hours: number | null; pct_complete_entry: boolean }

export interface ForemanPlan {
  date: string;
  crew: Array<{ employee_id: string; role: string; name: string | null }>;
  tasks: Array<{ id: string; title: string; status: string; start_on: string | null; due_on: string | null; cost_code_id: string | null; pct_complete: number | null }>;
  deliveries: Array<{ title: string; number: string | null; status: string | null; delivered_on: string | null; ship_on: string | null }>;
  jha: Array<{ id: string; task: string; status: string; steps: Jha['steps']; ppe: string[] }>;
  hazards: Array<{ id: string; number: string | null; title: string; priority: string }>;
  sheets: Array<{ id: string; sheet_number: string | null; title: string | null }>;
  yesterday: Array<{ cost_code: string | null; earned_hours: number | null; actual_hours: number | null; productivity_factor: number | null; pct_complete: number | null }>;
}

export interface CloseoutItem { id: string; job_id: string; category: string; title: string; form_ref: string | null; commitment_id: string | null; vendor_id: string | null; spec_section: string | null; required: boolean; status: string; due_on: string | null; document_id: string | null; warranty_starts_on: string | null; warranty_years: number | null; warranty_ends_on: string | null; accepted_at: string | null; notes: string | null }

export interface ReviewPackage {
  id: string; job_id: string; location_id: string; period_end: string; status: string; pm_commentary: string | null; built_at: string | null; submitted_at: string | null; signed_at: string | null;
  submitted_by: string | null; signed_by: string | null; content: ReviewContent;
}
export interface ReviewContent {
  financials?: Record<string, number | string | null> | null;
  cost_codes?: Array<Record<string, number | string | null>>;
  eac?: { status?: string; total_eac_cents?: number | null; prior_eac_cents?: number | null; commentary?: string | null; reason_code?: string | null; loss?: boolean; period_end?: string } | null;
  change_orders?: Array<{ number: string | null; title: string; stage: string; amount_cents: number | null; cost_impact_cents: number | null; approved_at: string | null }>;
  exposure?: Record<string, number | null> | null;
  buyout?: Array<Record<string, number | string | null>>;
  billing?: Array<{ application_no: number | null; status: string; period_end: string | null; gross_earned_cents: number | null; retainage_cents: number | null; net_cents: number | null; invoice_number: string | null }>;
  retainage?: Record<string, number | string | boolean | null> | null;
  schedule?: { tasks: number; done: number; late: number } | null;
  documents?: { rfis_open: number; rfis_overdue: number; submittals_open: number; submittals_late: number } | null;
  safety?: { incidents: number; recordables: number } | null;
  period_end?: string;
  built_at?: string;
}
