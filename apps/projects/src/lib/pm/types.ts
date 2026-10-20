/**
 * Row shapes for the `pm` schema (migration 1100_pm_foundation.sql). Column names
 * are copied from the migration; every query in src/lib/pm selects exactly these.
 * bigint money columns arrive as JSON numbers (integer cents).
 */

export type CoreStatus = 'BID' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETE' | 'CLOSED' | 'CANCELLED';
export type ProgressBasis = 'NONE' | 'COST_TO_COST' | 'PHYSICAL_PCT' | 'UNITS' | 'MILESTONES';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
export type ChangeOrderStage = 'PCO' | 'COR' | 'APPROVED' | 'REJECTED' | 'VOID';
export type BudgetKind = 'ORIGINAL' | 'REVISED' | 'FORECAST';
export type BudgetStatus = 'DRAFT' | 'APPROVED' | 'SUPERSEDED';
export type CostType = 'LABOR' | 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER';
export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'VOID';
export type ContractKind = 'PRIME' | 'MASTER' | 'RELEASE' | 'SERVICE_AGREEMENT';

/** pm.v_project_list */
export interface ProjectListRow {
  org_id: string;
  location_id: string;
  job_id: string;
  job_number: string | null;
  name: string;
  core_status: CoreStatus;
  customer_id: string | null;
  customer_name: string | null;
  stage_key: string;
  stage_label: string | null;
  stage_sort: number | null;
  stage_is_terminal: boolean | null;
  stage_entered_at: string;
  job_type_key: string;
  job_type_label: string;
  archetype: string;
  pm_user_id: string | null;
  super_user_id: string | null;
  planned_start: string | null;
  planned_finish: string | null;
  is_sample: boolean;
  original_contract_cents: number;
  approved_co_cents: number;
  contract_revised_cents: number;
  pending_co_cents: number;
  budget_total_cents: number | null;
  cost_estimate_cents: number;
  created_at: string;
  updated_at: string;
}

/** pm.v_job_overview */
export interface JobOverviewRow {
  org_id: string;
  job_id: string;
  original_contract_cents: number;
  approved_co_cents: number;
  revised_contract_cents: number;
  pending_co_cents: number;
  pending_co_count: number;
  budget_original_cents: number | null;
  budget_revised_cents: number | null;
  cost_estimate_cents: number;
  projected_margin_cents: number;
  tasks_open: number;
  tasks_overdue: number;
  tasks_total: number;
  punch_open: number;
  last_log_date: string | null;
  last_activity_at: string | null;
  last_snapshot_version: number | null;
  last_snapshot_as_of: string | null;
}

/** pm.projects (the columns the job page reads) */
export interface ProjectRow {
  job_id: string;
  org_id: string;
  location_id: string;
  job_type_id: string;
  stage_key: string;
  stage_entered_at: string;
  pm_user_id: string | null;
  planned_start: string | null;
  planned_finish: string | null;
  actual_start: string | null;
  actual_finish: string | null;
  is_sample: boolean;
}

/** pm.job_types */
export interface JobTypeRow {
  id: string;
  location_id: string;
  key: string;
  label: string;
  archetype: string;
  billing_modes: string[];
  default_billing_mode: string;
  progress_basis: ProgressBasis;
  stage_machine_key: string;
  modules: Record<string, boolean>;
  sort: number;
  is_active: boolean;
}

/** pm.stage_defs */
export interface StageDefRow {
  location_id: string;
  machine_key: string;
  stage_key: string;
  label: string;
  sort: number;
  core_status: CoreStatus;
  is_terminal: boolean;
  is_initial: boolean;
}

/** pm.stage_transitions */
export interface StageTransitionRow {
  location_id: string;
  machine_key: string;
  from_stage: string;
  to_stage: string;
  guards: string[];
  approval_policy_key: string | null;
  sort: number;
}

/** pm.pack_installs (primary, ACTIVE), with the two plan fields the shell needs. */
export interface PackInstallRow {
  id: string;
  location_id: string;
  pack_key: string;
  pack_version: string;
  installed_at: string;
  modules: Record<string, boolean> | null;
  vocabulary: Record<string, string> | null;
}

/** pm.cost_codes */
export interface CostCodeRow {
  id: string;
  location_id: string;
  job_id: string | null;
  parent_id: string | null;
  code: string;
  name: string;
  cost_type: CostType;
  role_hint: string | null;
  install_id: string | null;
  source_pack: string | null;
  sort: number;
  is_active: boolean;
}

/** pm.budgets */
export interface BudgetRow {
  id: string;
  job_id: string;
  kind: BudgetKind;
  version: number;
  status: BudgetStatus;
  label: string | null;
  as_of: string | null;
  created_at: string;
  updated_at: string;
}

/** pm.budget_lines */
export interface BudgetLineRow {
  id: string;
  budget_id: string;
  cost_code_id: string;
  description: string | null;
  amount_cents: number;
  sort: number;
}

/** pm.tasks */
export interface TaskRow {
  id: string;
  job_id: string;
  title: string;
  status: TaskStatus;
  is_milestone: boolean;
  start_on: string | null;
  due_on: string | null;
  duration_days: number | null;
  sort: number;
  completed_at: string | null;
}

/** pm.change_orders */
export interface ChangeOrderRow {
  id: string;
  job_id: string;
  number: string | null;
  title: string;
  description: string | null;
  reason: string | null;
  stage: ChangeOrderStage;
  amount_cents: number;
  cost_impact_cents: number | null;
  schedule_days: number | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** pm.contracts */
export interface ContractRow {
  id: string;
  job_id: string;
  kind: ContractKind;
  number: string | null;
  title: string | null;
  original_cents: number;
  retention_pct: number | null;
  progress_basis: ProgressBasis;
  pct_complete: number | null;
  billing_mode: string | null;
  status: ContractStatus;
  executed_on: string | null;
  created_at: string;
}

/** pm.progress_snapshots */
export interface ProgressSnapshotRow {
  id: string;
  job_id: string;
  snapshot_version: number;
  as_of_date: string;
  trigger_name: string;
  contract_value_cents: number;
  cost_estimate_cents: number;
  pct_complete: number | null;
  pending_co_value_cents: number;
  emitted: boolean;
  suppressed_reason: 'STANDALONE' | 'SAMPLE' | null;
  created_at: string;
}

/** pm.activity */
export interface ActivityRow {
  id: string;
  location_id: string | null;
  job_id: string | null;
  actor_type: 'HUMAN' | 'AI' | 'SYSTEM';
  actor_id: string | null;
  verb: string;
  subject_table: string | null;
  subject_id: string | null;
  summary: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

/** core.customers (identity columns only) */
export interface CustomerRow {
  id: string;
  name: string;
  display_name: string | null;
  location_id: string | null;
}
