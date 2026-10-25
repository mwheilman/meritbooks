/**
 * Row shapes the commercial pages and routes read (migration 1120). Column names follow
 * packages/supabase/migrations/1120_pm_commercial_depth.sql exactly. Money columns are bigint
 * cents read through the masked views (pm.v_cm_*_masked) — null means the caller may not see
 * the figure, never zero. Client-safe (types only).
 */

export type ChangeEventStatus = 'OPEN' | 'PRICING' | 'PRICED' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'NO_COST' | 'VOID';
export type ChangeSource = 'RFI' | 'ASI' | 'BULLETIN' | 'CCD' | 'FIELD' | 'OWNER_REQUEST' | 'DESIGN' | 'BACKCHARGE' | 'TM' | 'ALLOWANCE' | 'DRAWING_REVISION' | 'OTHER';
export const CHANGE_SOURCES: readonly ChangeSource[] = ['FIELD', 'RFI', 'ASI', 'BULLETIN', 'CCD', 'OWNER_REQUEST', 'DESIGN', 'DRAWING_REVISION', 'TM', 'ALLOWANCE', 'BACKCHARGE', 'OTHER'];
export const SOURCE_WORDS: Readonly<Record<ChangeSource, string>> = {
  FIELD: 'Field condition', RFI: 'RFI', ASI: 'ASI', BULLETIN: 'Bulletin', CCD: 'Directive (CCD)', OWNER_REQUEST: 'Owner request', DESIGN: 'Design',
  DRAWING_REVISION: 'Drawing revision', TM: 'T&M', ALLOWANCE: 'Allowance', BACKCHARGE: 'Backcharge', OTHER: 'Other',
};

export interface ChangeEventRow {
  id: string;
  job_id: string;
  number: string;
  title: string;
  description: string | null;
  source_type: ChangeSource;
  scope: 'IN' | 'OUT' | 'TBD';
  reason_code: string | null;
  status: ChangeEventStatus;
  proceeding: boolean;
  directive_ref: string | null;
  proceeding_since: string | null;
  rom_revenue_cents: number | null;
  rom_cost_cents: number | null;
  schedule_days: number | null;
  pco_id: string | null;
  change_order_id: string | null;
  due_on: string | null;
  created_at: string;
}

export interface PcoRow {
  id: string;
  job_id: string;
  number: string;
  tier: 'PCO' | 'COR';
  parent_cor_id: string | null;
  title: string;
  status: string;
  cost_cents: number | null;
  markup_cents: number | null;
  amount_cents: number | null;
  schedule_days: number | null;
  change_order_id: string | null;
  submitted_at: string | null;
  due_on: string | null;
  decided_at: string | null;
}

export interface RfqRow {
  id: string;
  job_id: string;
  change_event_id: string;
  number: string;
  vendor_id: string;
  commitment_id: string | null;
  status: string;
  due_on: string | null;
  sent_at: string | null;
  responded_at: string | null;
  total_cents: number | null;
}

export interface ExposureRow {
  job_id: string;
  approved_cents: number | null;
  pending_cents: number | null;
  pending_count: number;
  pending_over_30_cents: number | null;
  rejected_cents: number | null;
  unpriced_count: number;
  unpriced_rom_cents: number | null;
  proceeding_count: number;
  proceeding_oldest_days: number | null;
  avg_owner_response_days: number | null;
  owner_co_without_sub_co_cents: number | null;
  sub_co_without_owner_co_cents: number | null;
}

export type RfiStatus = 'DRAFT' | 'OPEN' | 'ANSWERED' | 'CLOSED' | 'VOID';
export type BallKind = 'INTERNAL' | 'ARCHITECT' | 'ENGINEER' | 'OWNER' | 'SUB' | 'OTHER';
export const BALL_WORDS: Readonly<Record<BallKind, string>> = { INTERNAL: 'Our team', ARCHITECT: 'Architect', ENGINEER: 'Engineer', OWNER: 'Owner', SUB: 'Subcontractor', OTHER: 'Other' };

export interface RfiRow {
  id: string;
  job_id: string;
  number: string;
  subject: string;
  question: string;
  suggested_answer: string | null;
  discipline: string | null;
  spec_section: string | null;
  drawing_ref: string | null;
  location_text: string | null;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  status: RfiStatus;
  is_private: boolean;
  ball_in_court_kind: BallKind | null;
  ball_in_court_name: string | null;
  ball_in_court_email: string | null;
  due_on: string | null;
  opened_at: string | null;
  answered_at: string | null;
  closed_at: string | null;
  official_response: string | null;
  responded_by_name: string | null;
  cost_impact: 'YES' | 'NO' | 'TBD';
  schedule_impact: 'YES' | 'NO' | 'TBD';
  impact_days: number | null;
  change_event_id: string | null;
  created_at: string;
}

export interface RfiResponseRow {
  id: string;
  rfi_id: string;
  body: string;
  is_official: boolean;
  author_name: string | null;
  via: 'APP' | 'EMAIL' | 'PORTAL';
  created_at: string;
}

export interface SubmittalRow {
  id: string;
  job_id: string;
  number: string;
  revision: number;
  spec_section: string | null;
  title: string;
  submittal_type: string | null;
  package: string | null;
  status: string;
  responsible_vendor_id: string | null;
  ball_in_court_kind: string | null;
  ball_in_court_name: string | null;
  required_on_site: string | null;
  lead_time_days: number | null;
  review_days: number | null;
  submit_by: string | null;
  long_lead: boolean;
  submitted_at: string | null;
  returned_at: string | null;
  final_code: string | null;
  released_for_fab_on: string | null;
  procurement_status: string;
  generated: boolean;
}

export interface SubmittalReviewRow {
  id: string;
  submittal_id: string;
  revision: number;
  step: number;
  reviewer_kind: string;
  reviewer_name: string | null;
  status: 'PENDING' | 'ACTIVE' | 'RETURNED' | 'SKIPPED';
  due_on: string | null;
  response_code: string | null;
  comments: string | null;
  returned_at: string | null;
}

export interface MeetingRow {
  id: string;
  job_id: string;
  meeting_type: string;
  series_key: string | null;
  number: number;
  title: string;
  scheduled_at: string | null;
  location_text: string | null;
  status: string;
  agenda: string | null;
  minutes: string | null;
  previous_meeting_id: string | null;
  distributed_at: string | null;
}

export interface MeetingItemRow {
  id: string;
  job_id: string;
  origin_meeting_id: string;
  series_key: string | null;
  item_no: string;
  topic: string;
  description: string | null;
  owner_name: string | null;
  owner_company: string | null;
  due_on: string | null;
  status: 'OPEN' | 'CLOSED' | 'DEFERRED';
  closed_at: string | null;
}

export interface MeetingAttendeeRow {
  id: string;
  meeting_id: string;
  name: string;
  company: string | null;
  email: string | null;
  role: string | null;
  attended: boolean | null;
  accepted_minutes_at: string | null;
}

export type DailyLogStatus = 'DRAFT' | 'SIGNED' | 'AMENDED';
export interface DailyLogRow {
  id: string;
  job_id: string;
  field_log_id: string | null;
  log_date: string;
  status: DailyLogStatus;
  weather_summary: string | null;
  temp_high_f: number | null;
  temp_low_f: number | null;
  precipitation: string | null;
  wind: string | null;
  site_conditions: string | null;
  work_performed: string | null;
  safety_notes: string | null;
  signed_by_name: string | null;
  signed_at: string | null;
  amended_count: number;
  copied_from: string | null;
}

export type LogEntryKind = 'MANPOWER' | 'EQUIPMENT' | 'DELIVERY' | 'DELAY' | 'VISITOR' | 'INSPECTION' | 'WORK' | 'NOTE' | 'SAFETY';
export const LOG_ENTRY_KINDS: readonly LogEntryKind[] = ['MANPOWER', 'EQUIPMENT', 'DELIVERY', 'DELAY', 'INSPECTION', 'VISITOR', 'SAFETY', 'NOTE'];
export const LOG_ENTRY_WORDS: Readonly<Record<LogEntryKind, string>> = {
  MANPOWER: 'Manpower', EQUIPMENT: 'Equipment', DELIVERY: 'Delivery', DELAY: 'Delay', VISITOR: 'Visitor', INSPECTION: 'Inspection', WORK: 'Work', NOTE: 'Note', SAFETY: 'Safety',
};

export interface LogEntryRow {
  id: string;
  daily_log_id: string;
  kind: LogEntryKind;
  vendor_id: string | null;
  company_name: string | null;
  trade: string | null;
  headcount: number | null;
  hours: number | null;
  equipment: string | null;
  equipment_hours: number | null;
  supplier: string | null;
  description: string | null;
  cause: string | null;
  duration_hours: number | null;
  responsible_party: string | null;
  notice_sent: boolean | null;
  inspector: string | null;
  result: string | null;
  is_amendment: boolean;
  amendment_reason: string | null;
  created_at: string;
}

export interface WipRow {
  job_id: string;
  job_number: string | null;
  job_name: string | null;
  source: 'PROJECTS' | 'BOOKS_PINNED';
  contract_original_cents: number | null;
  approved_co_cents: number | null;
  contract_cents: number | null;
  eac_cents: number | null;
  cost_to_date_cents: number | null;
  uninstalled_materials_cents: number | null;
  pct_complete: number | null;
  earned_cents: number | null;
  billed_cents: number | null;
  over_billed_cents: number | null;
  under_billed_cents: number | null;
  gp_cents: number | null;
  gp_pct: number | null;
  prior_gp_pct: number | null;
  bid_gp_pct: number | null;
  fade_gain_pts: number | null;
  backlog_cents: number | null;
  loss_provision_cents: number | null;
  pending_co_cents: number | null;
  eac_forecast_id: string | null;
  eac_status: string | null;
  books_run_id: string | null;
  pinned: boolean;
}

export interface EacForecastRow {
  id: string;
  job_id: string;
  period_end: string;
  version: number;
  status: string;
  due_on: string | null;
  prepared_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  contract_cents: number | null;
  total_budget_cents: number | null;
  total_actual_cents: number | null;
  total_ctc_cents: number | null;
  total_eac_cents: number | null;
  prior_eac_cents: number | null;
  reason_code: string | null;
  commentary: string | null;
  loss_flag: boolean;
}

export interface EacLineRow {
  id: string;
  forecast_id: string;
  cost_code_id: string | null;
  cost_code: string | null;
  cost_code_name: string | null;
  cost_type: string | null;
  budget_cents: number | null;
  committed_cents: number | null;
  actual_cents: number | null;
  pending_cents: number | null;
  ctc_cents: number | null;
  eac_cents: number | null;
  prior_eac_cents: number | null;
  method: string;
  commentary: string | null;
  sort: number;
}

export interface ComplianceQueueRow {
  job_id: string;
  location_id: string;
  commitment_id: string;
  number: string | null;
  commitment_type: string;
  commitment_status: string;
  vendor_id: string | null;
  vendor_name: string | null;
  manual_hold: boolean;
  hold_reason: string | null;
  payment_hold_effective: boolean;
  blocking_docs: Array<{ id: string; doc_type: string; status: string; expires_on: string | null; covers_through: string | null; notes: string | null }>;
  coi_status: string | null;
  coi_expires_on: string | null;
  waivers_outstanding: number;
}

export interface SubPayAppRow {
  id: string;
  job_id: string;
  commitment_id: string;
  vendor_id: string | null;
  application_no: number;
  period_end: string;
  status: string;
  submitted_via: 'PORTAL' | 'INTERNAL' | null;
  submitted_at: string | null;
  scheduled_value_cents: number | null;
  gross_this_period_cents: number | null;
  work_to_date_cents: number | null;
  retainage_this_period_cents: number | null;
  net_due_cents: number | null;
  current_step: number | null;
  chain: Array<{ step: number; label: string; cap: string; action: string; executive: boolean }> | null;
  rejected_reason: string | null;
}

export interface LienWaiverRow {
  id: string;
  job_id: string;
  commitment_id: string | null;
  vendor_id: string | null;
  sub_pay_app_id: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  waiver_type: string;
  state_code: string | null;
  form_key: string | null;
  amount_cents: number | null;
  through_date: string | null;
  status: string;
  rejected_reason: string | null;
  requested_at: string | null;
  received_at: string | null;
  verified_at: string | null;
}

export interface CoiRow {
  id: string;
  vendor_id: string;
  job_id: string | null;
  commitment_id: string | null;
  carrier: string | null;
  earliest_expiry: string | null;
  status: string;
  verification: Array<{ requirement: string; ok: boolean; detail: string | null; required?: boolean }> | null;
  created_at: string;
}

export interface AuditFinding {
  job_id?: string;
  rule: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  amount_cents: number | null;
  title: string;
  detail: string | null;
  fix: string | null;
  ref_table: string | null;
  ref_id: string | null;
}

export interface InboxRow {
  kind: string;
  item_id: string;
  job_id: string | null;
  ref: string | null;
  title: string;
  status: string | null;
  due_on: string | null;
  days_overdue: number | null;
  age_days: number | null;
  waiting_on: string | null;
  mine: boolean;
  link: string | null;
}

export interface CloseGate {
  ready: boolean;
  blockers: Array<{ code: string; label: string; count: number }>;
}
