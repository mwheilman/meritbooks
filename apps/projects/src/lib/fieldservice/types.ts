/**
 * Field-service row shapes (migration 1117). Column names match the SQL exactly; money is integer
 * cents and is null when the database masked it for the caller.
 */

export type CallChannel = 'PHONE' | 'WALK_IN' | 'INTERNAL' | 'WEB' | 'AI_AGENT' | 'SMS' | 'EMAIL' | 'PORTAL' | 'LSA' | 'ANGI' | 'THUMBTACK';
export type CallStatus = 'OPEN' | 'REQUEST' | 'BOOKED' | 'NOT_BOOKED' | 'CANCELLED';

export interface BusinessUnitRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  trade: 'HVAC' | 'PLUMBING' | 'ELECTRICAL' | 'GENERAL' | 'OTHER';
  kind: 'SERVICE' | 'INSTALL' | 'MAINTENANCE' | 'COMMERCIAL' | 'OTHER';
  is_active: boolean;
  sort: number;
}
export const BU_COLS = 'id, location_id, code, name, trade, kind, is_active, sort';

export interface ZoneRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  zips: string[];
  color: string | null;
  is_active: boolean;
}
export const ZONE_COLS = 'id, location_id, code, name, zips, color, is_active';

export interface WindowRow {
  id: string;
  location_id: string;
  label: string;
  start_time: string;
  end_time: string;
  days_of_week: number[];
  is_after_hours: boolean;
  online: boolean;
  sort: number;
  is_active: boolean;
}
export const WINDOW_COLS = 'id, location_id, label, start_time, end_time, days_of_week, is_after_hours, online, sort, is_active';

export interface CampaignRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  channel: string;
  tracking_phone: string | null;
  is_active: boolean;
}
export const CAMPAIGN_COLS = 'id, location_id, code, name, channel, tracking_phone, is_active';

export type ScriptQuestionKind = 'yesno' | 'text' | 'choice';
export interface ScriptQuestion {
  id: string;
  prompt: string;
  kind: ScriptQuestionKind;
  options?: string[];
  required?: boolean;
}
export interface ScriptDisclosure {
  id: string;
  fee: 'diagnostic' | 'after_hours' | null;
  text: string;
}
export interface ScriptRebuttal {
  objection: string;
  answer: string;
}
export interface CsrScript {
  questions?: ScriptQuestion[];
  disclosures?: ScriptDisclosure[];
  rebuttals?: ScriptRebuttal[];
}

export interface BookingJobTypeRow {
  id: string;
  location_id: string;
  key: string;
  label: string;
  business_unit_id: string | null;
  work_order_kind: string;
  default_priority: number;
  estimated_minutes: number;
  required_skills: string[];
  diagnostic_fee_cents: number | null;
  after_hours_fee_cents: number | null;
  member_waives_diagnostic: boolean;
  is_recall: boolean;
  online: boolean;
  script: CsrScript;
  is_active: boolean;
  sort: number;
}
export const BOOKING_TYPE_COLS =
  'id, location_id, key, label, business_unit_id, work_order_kind, default_priority, estimated_minutes, required_skills, diagnostic_fee_cents, after_hours_fee_cents, member_waives_diagnostic, is_recall, online, script, is_active, sort';

export interface CapacityLimitRow {
  id: string;
  location_id: string;
  business_unit_id: string;
  zone_id: string | null;
  arrival_window_id: string;
  day_of_week: number | null;
  on_date: string | null;
  max_jobs: number | null;
  max_minutes: number | null;
  note: string | null;
}
export const CAPACITY_COLS = 'id, location_id, business_unit_id, zone_id, arrival_window_id, day_of_week, on_date, max_jobs, max_minutes, note';

/** One row of pm.fs_capacity_grid. */
export interface CapacityCell {
  service_day: string;
  business_unit_id: string;
  arrival_window_id: string;
  window_label: string;
  start_time: string;
  end_time: string;
  is_after_hours: boolean;
  limited: boolean;
  max_jobs: number | null;
  max_minutes: number | null;
  used_jobs: number;
  used_minutes: number;
  jobs_left: number | null;
  minutes_left: number | null;
  is_open: boolean;
}

export interface CallRow {
  id: string;
  location_id: string;
  number: string | null;
  channel: CallChannel;
  status: CallStatus;
  caller_phone: string | null;
  caller_name: string | null;
  customer_id: string | null;
  site_zip: string | null;
  site_address: string | null;
  booking_job_type_id: string | null;
  business_unit_id: string | null;
  campaign_id: string | null;
  arrival_window_id: string | null;
  service_day: string | null;
  summary: string | null;
  not_booked_reason: string | null;
  job_id: string | null;
  work_order_id: string | null;
  capacity_override: boolean;
  override_reason: string | null;
  created_at: string;
  booked_at: string | null;
}
export const CALL_COLS =
  'id, location_id, number, channel, status, caller_phone, caller_name, customer_id, site_zip, site_address, booking_job_type_id, business_unit_id, campaign_id, arrival_window_id, service_day, summary, not_booked_reason, job_id, work_order_id, capacity_override, override_reason, created_at, booked_at';

/** pm.fs_caller_pop result. */
export interface CallerPop {
  phone: string | null;
  matches: Array<{ customer_id: string; name: string; matched: string }>;
  tracking_campaign: { id: string; name: string; channel: string } | null;
  customer?: { id: string; name: string; phone: string | null; email: string | null; address: string | null };
  contacts?: Array<{ id: string; name: string; phone: string | null; email: string | null; roles: string[]; sms_consent: boolean; is_primary: boolean }>;
  sites?: Array<{ id: string; name: string | null; address: string; zip: string | null; zone_id: string | null; gate_code: string | null; pets: string | null; access_notes: string | null; do_not_service: boolean; do_not_service_reason: string | null }>;
  recent_visits?: Array<{ work_order_id: string; number: string; summary: string; status: string; outcome: string | null; when: string; is_callback: boolean; resolution: string | null }>;
  open_work?: Array<{ work_order_id: string; number: string; summary: string; status: string; site_id: string | null; service_day: string | null; kind: string }>;
  equipment?: Array<{ asset_id: string; type: string | null; make: string | null; model: string | null; serial: string | null; installed_on: string | null; age_years: number | null; parts_warranty_ends_on: string | null; labor_warranty_ends_on: string | null; refrigerant: string | null; site_id: string | null }>;
  agreements?: Array<{ agreement_id: string; number: string; plan: string; tier: string | null; status: string; ends_on: string; suspended: boolean; discount_pct: number | null; visits_owed: number }>;
  is_member?: boolean;
  open_estimates?: Array<{ estimate_id: string; number: string; title: string; status: string; created_at: string }>;
  ar?: { available: boolean; has_balance: boolean; past_due: boolean; oldest_past_due_days: number | null; amounts_visible: boolean; open_cents: number | null; past_due_cents: number | null };
  summary?: string | null;
}

export interface PricebookItemRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  unit: string;
  kind: 'SERVICE' | 'MATERIAL' | 'EQUIPMENT' | 'FEE' | 'MEMBERSHIP';
  category_id: string | null;
  business_unit_id: string | null;
  task_hours: number | null;
  target_gm_pct: number | null;
  price_locked: boolean;
  price_cents: number;
  member_price_cents: number | null;
  after_hours_price_cents: number | null;
  /** null for callers without projects.financials (masked view). */
  cost_cents: number | null;
  material_cost_cents: number | null;
  labor_cost_cents: number | null;
  customer_description: string | null;
  gbb_tier: 'GOOD' | 'BETTER' | 'BEST' | null;
  is_active: boolean;
  priced_at: string | null;
}
export const PRICEBOOK_COLS =
  'id, location_id, code, name, unit, kind, category_id, business_unit_id, task_hours, target_gm_pct, price_locked, price_cents, member_price_cents, after_hours_price_cents, cost_cents, material_cost_cents, labor_cost_cents, customer_description, gbb_tier, is_active, priced_at';

export interface PricebookCategoryRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  trade: string | null;
  sort: number;
}

export interface PricebookSettingsRow {
  id: string;
  location_id: string;
  burdened_rate_cents: number;
  target_gm_pct: number;
  equipment_gm_pct: number;
  member_discount_pct: number;
  after_hours_multiplier: number;
  rounding: 'NONE' | 'WHOLE' | 'FIVE' | 'NINE';
  price_floor_gm_pct: number;
}

export interface MarkupTierRow {
  id: string;
  location_id: string;
  up_to_cents: number | null;
  markup_pct: number;
}

export interface BulkPreviewRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  old_price_cents: number;
  price_cents: number;
  member_price_cents: number;
  after_hours_price_cents: number;
  cost_cents: number;
  old_margin_pct: number | null;
  margin_pct: number | null;
}
export interface BulkPreview {
  count: number;
  applied: boolean;
  rows: BulkPreviewRow[];
  avg_margin_before: number | null;
  avg_margin_after: number | null;
  below_floor: number;
}

export interface PricebookImportReport {
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  errors: Array<{ row: number; code: string; error: string }>;
  error_count: number;
  dry_run: boolean;
}

export interface FinancingPlanRow {
  id: string;
  location_id: string;
  provider: string;
  code: string;
  name: string;
  apr: number;
  term_months: number;
  promo: string | null;
  /** masked without financials */
  dealer_fee_pct: number | null;
  min_cents: number;
  max_cents: number | null;
  is_default: boolean;
  is_active: boolean;
}
export const FINANCING_COLS = 'id, location_id, provider, code, name, apr, term_months, promo, dealer_fee_pct, min_cents, max_cents, is_default, is_active';

export interface FsEstimateRow {
  id: string;
  location_id: string;
  job_id: string;
  work_order_id: string | null;
  number: string | null;
  title: string;
  status: 'DRAFT' | 'PRESENTED' | 'SOLD' | 'DECLINED' | 'EXPIRED';
  customer_id: string | null;
  member_pricing: boolean;
  sold_option_ids: string[];
  signed_name: string | null;
  signed_at: string | null;
  deposit_cents: number;
  financing_plan_id: string | null;
  agreement_id: string | null;
  decline_reason: string | null;
  created_at: string;
}
export const FS_ESTIMATE_COLS =
  'id, location_id, job_id, work_order_id, number, title, status, customer_id, member_pricing, sold_option_ids, signed_name, signed_at, deposit_cents, financing_plan_id, agreement_id, decline_reason, created_at';

export interface FsOptionRow {
  id: string;
  estimate_id: string;
  tier: 'GOOD' | 'BETTER' | 'BEST' | 'OPTION';
  sort: number;
  name: string;
  description: string | null;
  rebate_cents: number;
  rebate_note: string | null;
  financing_plan_id: string | null;
  recommended: boolean;
  status: 'OPEN' | 'SOLD' | 'DISMISSED';
  dismiss_reason: string | null;
}
export const FS_OPTION_COLS = 'id, estimate_id, tier, sort, name, description, rebate_cents, rebate_note, financing_plan_id, recommended, status, dismiss_reason';

export interface FsOptionItemRow {
  id: string;
  option_id: string;
  sort: number;
  price_book_item_id: string | null;
  kind: string;
  description: string;
  qty: number;
  unit_price_cents: number;
  member_unit_price_cents: number | null;
  unit_cost_cents: number | null;
  is_optional: boolean;
  is_selected: boolean;
}
export const FS_OPTION_ITEM_COLS = 'id, option_id, sort, price_book_item_id, kind, description, qty, unit_price_cents, member_unit_price_cents, unit_cost_cents, is_optional, is_selected';

export interface OptionTotalsRow {
  option_id: string;
  estimate_id: string;
  regular_cents: number;
  member_cents: number;
  rebate_cents: number;
}

export interface AgreementTemplateRow {
  id: string;
  location_id: string;
  key: string;
  label: 'MEMBERSHIP' | 'MAINTENANCE_AGREEMENT';
  plan_name: string;
  tier: string | null;
  term_months: number;
  cadence: string;
  visits_per_term: number;
  price_cents: number;
  billing_frequency: string;
  member_discount_pct: number;
  perks: Record<string, boolean>;
  revenue_policy: 'PER_VISIT' | 'STRAIGHT_LINE';
  renewal_uplift_pct: number;
  is_active: boolean;
}
export const TEMPLATE_COLS = 'id, location_id, key, label, plan_name, tier, term_months, cadence, visits_per_term, price_cents, billing_frequency, member_discount_pct, perks, revenue_policy, renewal_uplift_pct, is_active';

export interface VisitDueRow {
  location_id: string;
  work_order_id: string;
  job_id: string;
  number: string;
  summary: string;
  status: string;
  visit_seq: number | null;
  due_on: string | null;
  due_by: string | null;
  service_day: string | null;
  arrival_window_id: string | null;
  zone_id: string | null;
  business_unit_id: string | null;
  agreement_id: string;
  agreement_number: string;
  plan_name: string;
  tier: string | null;
  customer_id: string;
  is_overdue: boolean;
  due_month: string;
  last_tech_id: string | null;
  entitlements_suspended: boolean;
}

export interface RenewalRow {
  location_id: string;
  agreement_id: string;
  number: string;
  plan_name: string;
  tier: string | null;
  customer_id: string;
  ends_on: string;
  auto_renew: boolean;
  price_cents: number;
  renewal_uplift_pct: number;
  renewal_price_cents: number;
  days_left: number;
  bucket: 30 | 60 | 90;
  failed_payment_count: number;
}

export interface DeferredRow {
  location_id: string;
  agreement_id: string;
  number: string;
  plan_name: string;
  tier: string | null;
  status: string;
  revenue_policy: string;
  opening_cents: number;
  billed_cents: number;
  recognized_cents: number;
  released_cents: number;
  deferred_cents: number;
  visits_included: number;
  visits_delivered: number;
  facts_pending: number;
}

export interface BillingScheduleRow {
  id: string;
  agreement_id: string;
  period_no: number;
  period_start: string;
  period_end: string;
  bill_on: string;
  amount_cents: number;
  status: 'SCHEDULED' | 'REQUESTED' | 'PAID' | 'FAILED' | 'VOID';
  billing_request_id: string | null;
  attempts: number;
}

export interface AgreementImportReport {
  rows: number;
  ok: number;
  errors: Array<{ row: number; ref: string | null; error: string }>;
  error_count: number;
  deferred_cents: number;
  visits_owed: number;
  by_tier: Record<string, { count: number; deferred_cents: number; visits_owed: number }>;
  no_billing: Array<{ row: number; ref: string | null; plan: string }>;
  no_visits: Array<{ row: number; ref: string | null; plan: string }>;
  dry_run: boolean;
  source_system: string;
  import_id?: string;
}

export interface ScorecardRow {
  employee_id: string;
  tech_name: string;
  is_me: boolean;
  completed_jobs: number;
  opportunities: number;
  sold_jobs: number;
  conversion_pct: number | null;
  revenue_cents: number | null;
  sold_cents: number | null;
  avg_ticket_cents: number | null;
  tgl_set: number;
  tgl_sold: number;
  memberships_sold: number;
  recalls: number;
  recall_rate_pct: number | null;
  clocked_hours: number;
  billable_hours: number;
  review_avg: number | null;
  reviews: number;
  commission_cents: number | null;
  spiff_cents: number | null;
  tgl_bonus_cents: number | null;
  membership_spiff_cents: number | null;
  chargeback_cents: number | null;
  pay_total_cents: number | null;
  pay_visible: boolean;
  revenue_visible: boolean;
}

export interface CampaignReportRow {
  campaign_id: string | null;
  campaign_code: string;
  campaign_name: string;
  campaign_channel: string;
  calls: number;
  booked: number;
  not_booked: number;
  booking_rate_pct: number | null;
  completed_jobs: number;
  revenue_cents: number | null;
  cost_cents: number | null;
  margin_cents: number | null;
  revenue_visible: boolean;
  cost_visible: boolean;
}

export interface EligibleTech {
  employee_id: string;
  tech_name: string;
  eligible: boolean;
  reasons: string[];
  in_zone: boolean;
  on_call: boolean;
  booked_minutes: number;
  missing_skills: string[];
  expired_skills: string[];
}

export interface TechEventRow {
  id: string;
  location_id: string;
  employee_id: string;
  kind: 'PTO' | 'TRAINING' | 'MEETING' | 'SHOP' | 'SUPPLY_HOUSE' | 'OTHER';
  slot: string;
  note: string | null;
}

export interface OnCallRow {
  id: string;
  location_id: string;
  business_unit_id: string | null;
  employee_id: string;
  role: 'PRIMARY' | 'BACKUP';
  starts_at: string;
  ends_at: string;
}

export interface PrejobBrief extends CallerPop {
  work_order: { id: string; number: string; summary: string; complaint: string | null; kind: string; service_day: string | null; requested_start: string | null; requested_end: string | null; is_callback: boolean; site_id: string | null; asset_id: string | null };
  site: { address: string; gate_code: string | null; pets: string | null; access_notes: string | null } | null;
  call: { number: string | null; answers: Record<string, string | boolean>; channel: string } | null;
}
