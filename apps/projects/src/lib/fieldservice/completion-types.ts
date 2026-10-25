import type { FormField } from './rules';
/**
 * Row and payload shapes for the field-service completion screens (migration 1123). Money fields
 * are null whenever the database stripped them for the caller (contract value / financials).
 */

export interface CallLogRow {
  id: string;
  provider: 'RINGCENTRAL' | 'DIALPAD' | 'TWILIO_VOICE';
  direction: 'INBOUND' | 'OUTBOUND';
  from_number: string | null;
  to_number: string | null;
  campaign_id: string | null;
  customer_id: string | null;
  service_call_id: string | null;
  work_order_id: string | null;
  job_id: string | null;
  started_at: string;
  duration_seconds: number | null;
  outcome: 'IN_PROGRESS' | 'ANSWERED' | 'MISSED' | 'VOICEMAIL' | 'ABANDONED' | 'BUSY' | 'FAILED';
  agent_name: string | null;
  recording_ref: string | null;
}
export const CALL_LOG_COLS = 'id, provider, direction, from_number, to_number, campaign_id, customer_id, service_call_id, work_order_id, job_id, started_at, duration_seconds, outcome, agent_name, recording_ref';

export interface PhoneProviderRow {
  id: string;
  location_id: string;
  provider: 'RINGCENTRAL' | 'DIALPAD' | 'TWILIO_VOICE';
  status: 'DISABLED' | 'ACTIVE';
  account_label: string | null;
  main_numbers: string[];
  record_calls: boolean;
  recording_disclosure: string | null;
}
export const PHONE_PROVIDER_COLS = 'id, location_id, provider, status, account_label, main_numbers, record_calls, recording_disclosure';

export interface CallReportRow {
  campaign_id: string | null;
  campaign: string;
  calls: number;
  answered: number;
  missed: number;
  booked: number;
  booked_rate: number | null;
  talk_seconds: number;
}

export interface ThreadRow {
  id: string;
  location_id: string;
  customer_id: string | null;
  unknown_from: string | null;
  contact_id: string | null;
  job_id: string | null;
  work_order_id: string | null;
  subject: string | null;
  status: 'OPEN' | 'CLOSED';
  last_message_at: string;
  last_direction: 'IN' | 'OUT' | 'NOTE' | null;
  unread_count: number;
}
export const THREAD_COLS = 'id, location_id, customer_id, unknown_from, contact_id, job_id, work_order_id, subject, status, last_message_at, last_direction, unread_count';

export interface ThreadMessageRow {
  id: string;
  thread_id: string;
  direction: 'IN' | 'OUT' | 'NOTE';
  channel: 'SMS' | 'EMAIL' | 'NOTE' | 'PORTAL';
  body: string;
  status: string;
  status_reason: string | null;
  intent: string | null;
  author_name: string | null;
  created_at: string;
}
export const THREAD_MESSAGE_COLS = 'id, thread_id, direction, channel, body, status, status_reason, intent, author_name, created_at';

export interface MessageTemplateRow {
  id: string;
  key: string;
  label: string;
  kind: string;
  channel: 'SMS' | 'EMAIL';
  body: string;
}
export const MESSAGE_TEMPLATE_COLS = 'id, key, label, kind, channel, body';

export interface Flag {
  code: string;
  severity: 'BLOCK' | 'WARN';
  message: string;
  line_id?: string;
}

export interface ReviewRow {
  id: string;
  status: 'PENDING' | 'FLAGGED' | 'APPROVED' | 'RETURNED' | 'VOID';
  work_order_id: string;
  number: string | null;
  summary: string;
  job_id: string;
  customer_id: string | null;
  customer: string | null;
  completed_at: string | null;
  age_days: number;
  flags: Flag[];
  flag_count: number;
  blocking_count: number;
  billing_request_id: string | null;
  billing_status: string | null;
  invoice_number: string | null;
  return_reason: string | null;
  technician: string | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
}

export interface InstallReadiness {
  code: 'EQUIPMENT_NOT_ORDERED' | 'EQUIPMENT_NOT_RECEIVED' | 'PERMIT_NOT_ISSUED';
  message: string;
}

export type InstallStage = 'SOLD' | 'ORDERED' | 'PERMITTED' | 'SCHEDULED' | 'INSTALLED' | 'INSPECTED' | 'CLOSED' | 'CANCELLED';
export const INSTALL_STAGES: readonly InstallStage[] = ['SOLD', 'ORDERED', 'PERMITTED', 'SCHEDULED', 'INSTALLED', 'INSPECTED', 'CLOSED'];

export interface InstallBoardRow {
  id: string;
  number: string;
  title: string;
  stage: InstallStage;
  job_id: string;
  customer_id: string | null;
  customer: string | null;
  install_work_order_id: string | null;
  permit_required: boolean;
  is_commercial: boolean;
  install_days: number;
  crew_size: number;
  days_in_stage: number;
  stuck: boolean;
  install_on: string | null;
  permit_status: string | null;
  readiness: InstallReadiness[];
  final_billed: boolean;
  contract_cents: number | null;
}

export interface InstallItemRow {
  id: string;
  project_id: string;
  kind: string;
  description: string;
  qty: number;
  unit_price_cents: number | null;
  unit_cost_cents: number | null;
  commitment_line_id: string | null;
  received_qty: number;
}
export const INSTALL_ITEM_COLS = 'id, project_id, kind, description, qty, unit_price_cents, unit_cost_cents, commitment_line_id, received_qty';

export interface InstallCosting {
  contract_cents: number | null;
  estimated: Record<string, number | null>;
  actual: Record<string, number | null>;
  estimated_total_cents: number;
  actual_total_cents: number;
  committed_cents: number;
  billed_cents: number;
  estimated_margin_cents: number;
  actual_margin_cents: number;
  estimated_margin_pct: number | null;
  actual_margin_pct: number | null;
  variances: Array<{ category: string; estimated_cents: number; actual_cents: number; variance_cents: number; explanation: string }>;
  complete: boolean;
}

export interface FollowupQueueRow {
  id: string;
  number: string | null;
  title: string;
  job_id: string;
  customer_id: string | null;
  customer: string | null;
  presented_at: string | null;
  age_days: number;
  valid_until: string | null;
  owner_employee_id: string | null;
  from_cents: number | null;
  to_cents: number | null;
  next_step: { id: string; step: number; channel: 'SMS' | 'EMAIL' | 'CALL_TASK'; due_at: string; status: string } | null;
  calls_due: number;
  touches: number;
}

export interface PipelineAdvisorRow {
  advisor_id: string | null;
  advisor: string;
  opportunities: number;
  appointments: number;
  proposals: number;
  sold: number;
  lost: number;
  close_rate: number | null;
  sold_cents: number | null;
}
export interface PipelineSourceRow {
  source: string;
  opportunities: number;
  sold: number;
  lost: number;
  close_rate: number | null;
  sold_cents: number | null;
}
export interface PipelineOpenRow {
  id: string;
  title: string;
  stage: 'LEAD' | 'APPOINTMENT' | 'PROPOSAL';
  source: string;
  customer_id: string | null;
  customer: string | null;
  advisor_employee_id: string | null;
  appointment_at: string | null;
  estimate_id: string | null;
  job_id: string | null;
  days_in_stage: number;
  stalled: boolean;
  next_step: string;
}
export interface Pipeline {
  by_advisor: PipelineAdvisorRow[];
  by_source: PipelineSourceRow[];
  open: PipelineOpenRow[];
}

export interface OnlineAcceptanceRow {
  id: string;
  estimate_id: string;
  option_id: string;
  job_id: string;
  typed_name: string;
  accepted_at: string;
  status: string;
}
export const ONLINE_ACCEPTANCE_COLS = 'id, estimate_id, option_id, job_id, typed_name, accepted_at, status';

export interface FinancingRow {
  id: string;
  estimate_id: string;
  estimate_number: string | null;
  job_id: string;
  customer: string | null;
  provider: string;
  application_ref: string | null;
  status: 'APPLIED' | 'APPROVED' | 'DOCS_SIGNED' | 'FUNDING_REQUESTED' | 'FUNDED' | 'SHORT_FUNDED' | 'CANCELLED';
  sold_on: string;
  funded_on: string | null;
  days_outstanding: number;
  chase: boolean;
  amount_financed_cents: number | null;
  funded_cents: number | null;
  dealer_fee_pct: number | null;
  dealer_fee_cents: number | null;
  expected_net_cents: number | null;
  short_cents: number | null;
}
export interface FinancingRecon {
  rows: FinancingRow[];
  unfunded: number;
  chase: number;
  unfunded_cents: number | null;
}

export interface TimeFlag {
  code: 'LONG_DRIVE' | 'MISSING_CLOCK_OUT' | 'GAP' | 'OVERTIME_DAY' | 'OVERTIME_WEEK' | 'NO_TIME' | 'NOT_SUBMITTED';
  message: string;
  fix: string;
  minutes?: number;
  hours?: number;
  work_order?: string;
}
export interface TimesheetDay {
  employee_id: string;
  employee: string;
  day: string;
  hours: number;
  entries: Array<{ id: string; job_id: string; hours: number; state: string; pay_type: string }>;
  submitted_ids: string[];
  flags: TimeFlag[];
  clean: boolean;
}

export interface FindingRow {
  id: string;
  location_id: string;
  job_id: string | null;
  kind: string;
  subject_table: string;
  subject_id: string;
  detail: string;
  amount_cents: number | null;
  status: 'OPEN' | 'TASKED' | 'RESOLVED' | 'DISMISSED';
  task_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
}
export const FINDING_COLS = 'id, location_id, job_id, kind, subject_table, subject_id, detail, amount_cents, status, task_id, first_seen_at, last_seen_at';

export interface MetricRow {
  label: string;
  ref_table?: string;
  ref_id?: string;
  job_id?: string;
  value?: number;
  [k: string]: unknown;
}
export interface MetricAnswer {
  metric: string;
  label: string;
  unit: 'count' | 'cents' | 'ratio';
  from: string;
  to: string;
  value: number;
  rows: MetricRow[];
  masked: boolean;
}

export type DashboardRole = 'gm' | 'dispatcher' | 'service_manager' | 'install_pm';
export type Dashboard = { role: DashboardRole; from: string; to: string } & Record<string, unknown>;

export interface SetupStep {
  key: string;
  label: string;
  href: string;
  count: number;
  done: boolean;
}
export interface SetupStatus {
  steps: SetupStep[];
  done: number;
  total: number;
}

export interface ShadowSide {
  jobs: number;
  memberships: number;
  estimates_sold: number;
  revenue_cents: number | null;
  payments_cents: number | null;
}
export interface ShadowDay {
  day: string;
  system: string;
  status: 'MATCH' | 'VARIANCE';
  notes: string | null;
  legacy: ShadowSide;
  merit: ShadowSide;
  diff: ShadowSide;
}
export interface ShadowReport {
  days: ShadowDay[];
  matched_days: number;
}

export interface FormTemplateRow {
  id: string;
  key: string;
  name: string;
  kind: string;
  job_type_keys: string[];
  wo_kinds: string[];
  fields: FormField[];
  requires_signature: boolean;
  is_active: boolean;
  version: number;
}
export const FORM_TEMPLATE_COLS = 'id, key, name, kind, job_type_keys, wo_kinds, fields, requires_signature, is_active, version';

export interface WillCall {
  commitment_id: string;
  number: string;
  title: string | null;
  status: string;
  job_id: string;
  vendor: string | null;
  pickup_code: string | null;
  expected_on: string | null;
  note: string | null;
  ready: boolean;
  lines: Array<{ line_id: string; description: string; qty: number | null; received_qty: number }>;
}

/**
 * pm.fs_visit_context (GET /api/field/fs-tools). invoice_review is null unless the caller may read it
 * (projects.billing or projects.dispatch view); total_cents is null without contract value on the job.
 */
export interface VisitContext {
  work_order_id: string;
  job_id: string;
  customer_id: string | null;
  invoice_review: {
    id: string;
    status: 'PENDING' | 'FLAGGED' | 'APPROVED' | 'RETURNED';
    flag_count: number;
    blocking_count: number;
    invoiced: boolean;
    can_send_pay_link: boolean;
    total_cents: number | null;
  } | null;
}
