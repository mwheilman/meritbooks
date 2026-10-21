/** Row shapes from 1108_pm_parties_and_labor.sql (Rule 11: columns copied from the migration). */

/** pm.labor_settings — percents are fractions (0.25 = 25 %). */
export interface LaborSettingsRow {
  location_id: string;
  default_burden_pct: number;
  default_overhead_pct: number;
  notes: string | null;
  updated_by: string | null;
  updated_at: string;
}
export const LABOR_SETTINGS_COLS = 'location_id, default_burden_pct, default_overhead_pct, notes, updated_by, updated_at';

/** pm.v_labor_rates — cost rate (pay + burden) vs estimating rate (+ overhead). */
export interface LaborRateRow {
  rate_card_id: string;
  location_id: string;
  key: string;
  label: string;
  base_rate_cents: number | null;
  card_burden_pct: number | null;
  card_overhead_pct: number | null;
  burden_pct: number;
  overhead_pct: number;
  burden_inherited: boolean;
  overhead_inherited: boolean;
  cost_rate_cents: number | null;
  estimating_rate_cents: number | null;
  overhead_rate_cents: number | null;
  bill_rate_cents: number | null;
  effective_from: string;
  is_active: boolean;
  employee_count: number;
  updated_at: string;
}
export const LABOR_RATE_COLS =
  'rate_card_id, location_id, key, label, base_rate_cents, card_burden_pct, card_overhead_pct, burden_pct, overhead_pct, burden_inherited, ' +
  'overhead_inherited, cost_rate_cents, estimating_rate_cents, overhead_rate_cents, bill_rate_cents, effective_from, is_active, employee_count, updated_at';

/** pm.employee_rate_cards */
export interface EmployeeCardRow {
  employee_id: string;
  location_id: string;
  rate_card_id: string;
}
export const EMPLOYEE_CARD_COLS = 'employee_id, location_id, rate_card_id';

/** pm.time_entry_events */
export interface TimeEntryEventRow {
  time_entry_id: string;
  action: 'APPROVED' | 'UNAPPROVED';
  revision: number;
  event_id: string | null;
  suppressed_reason: 'STANDALONE' | 'SAMPLE' | 'SEAM_V1' | 'NOT_EMITTED' | null;
  created_at: string;
}
export const TIME_EVENT_COLS = 'time_entry_id, action, revision, event_id, suppressed_reason, created_at';
