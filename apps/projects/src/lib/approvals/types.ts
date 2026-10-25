/**
 * Approvals engine — shared types (migration 1113_pm_approvals.sql is the authority).
 * Pure and client-safe: the inbox, the phone API and the settings pages import these.
 */

export const APPROVAL_OBJECT_TYPES = [
  'change_order', 'commitment', 'commitment_change', 'billing_request', 'draw', 'time_entry',
  'estimate', 'budget_transfer', 'dealer_deal', 'stage_transition',
] as const;
export type ApprovalObjectType = (typeof APPROVAL_OBJECT_TYPES)[number];

/** Types the inbox may approve in bulk (mirror of pm.approval_bulk_types()). */
export const BULK_TYPES: ReadonlySet<ApprovalObjectType> = new Set<ApprovalObjectType>([
  'change_order', 'commitment', 'commitment_change', 'billing_request', 'time_entry',
]);

export const APPROVAL_TABS = ['mine', 'waiting', 'decided', 'all'] as const;
export type ApprovalTab = (typeof APPROVAL_TABS)[number];

export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type StepStatus = 'WAITING' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';
export type ActionDecision = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'CANCEL' | 'ESCALATE' | 'REOPEN';
export type Channel = 'web' | 'phone' | 'api';

/** What a decide / act call did (pm._approval_state). */
export type DecideStatus = 'not_needed' | 'submitted' | 'pending' | 'approved' | 'rejected' | 'reopened' | 'cancelled';

export interface DecideResult {
  status: DecideStatus;
  request_id?: string;
  object_type: ApprovalObjectType;
  object_id: string;
  title?: string;
  step?: number;
  step_count?: number;
  request_status?: RequestStatus;
  waiting_on?: string | null;
  self_approval_allowed?: boolean;
  message?: string | null;
  result?: Record<string, unknown> | null;
}

export interface ApprovalFacts {
  over_budget?: boolean;
  below_margin_floor?: boolean;
  overtime?: boolean;
  hours?: number;
  week_hours?: number;
  lines?: number;
  codes_changed?: number;
  from?: string;
  to?: string;
  failing_guards?: string[];
}

/** Money context — present only when the caller holds the money capability for the item. */
export interface ApprovalMoneyFacts {
  overrun_cents?: number;
  margin_pct?: number | null;
  margin_floor_pct?: number | null;
  cost_impact_cents?: number | null;
  moved_cents?: number;
  net_change_cents?: number;
  front_gross_cents?: number | null;
  back_gross_cents?: number | null;
  front_gross_pct?: number | null;
  discount_cents?: number | null;
  gross_cents?: number;
  retainage_cents?: number;
  amount_cents?: number;
}

/** One inbox row (pm._approval_row). amount_cents is null when the money is not the caller's to see. */
export interface ApprovalItem {
  id: string;
  object_type: ApprovalObjectType;
  object_id: string;
  object_ref: string | null;
  location_id: string;
  company: string | null;
  job_id: string | null;
  job_label: string | null;
  title: string;
  summary: string | null;
  href: string | null;
  status: RequestStatus;
  amount_cents: number | null;
  money_visible: boolean;
  facts: ApprovalFacts;
  facts_money: ApprovalMoneyFacts | null;
  step: number;
  step_count: number;
  round: number;
  step_label: string | null;
  escalated: boolean;
  due_at: string | null;
  overdue: boolean;
  submitted_at: string;
  submitted_by: string | null;
  prepared_by: string | null;
  decided_at: string | null;
  decided_by: string | null;
  reject_reason: string | null;
  can_act: boolean;
  on_behalf_of: string | null;
  self_approval: boolean;
  bulk_ok: boolean;
  needs_reason: boolean;
  sod_exception: boolean;
  mine: boolean;
}

export interface ApprovalCounts {
  mine: number;
  mine_overdue: number;
  waiting: number;
}

export interface InboxResult {
  tab: ApprovalTab;
  items: ApprovalItem[];
  counts: ApprovalCounts;
}

export interface ApprovalStepView {
  step: number;
  label: string;
  status: StepStatus;
  roles: string[];
  condition: string | null;
  due_at: string | null;
  escalated: boolean;
  decided_at: string | null;
  decided_by: string | null;
  on_behalf_of: string | null;
}

export interface ApprovalHistoryEntry {
  decision: ActionDecision;
  round: number;
  step: number | null;
  actor: string;
  on_behalf_of: string | null;
  reason: string | null;
  sod_exception: boolean;
  channel: string;
  at: string;
}

export interface ApprovalLine {
  description?: string | null;
  type?: string | null;
  amount_cents?: number | null;
  requested_cents?: number | null;
  from_cents?: number | null;
  to_cents?: number | null;
  cost_code_id?: string | null;
}

export interface ApprovalDetail extends ApprovalItem {
  steps: ApprovalStepView[];
  history: ApprovalHistoryEntry[];
  lines: ApprovalLine[];
  my_limit_cents: number | null;
}

export interface BulkResultRow {
  id: string;
  ok: boolean;
  status?: DecideStatus;
  message?: string | null;
  error?: string;
  code?: string;
}

export interface BulkResult {
  results: BulkResultRow[];
  done: number;
  refused: number;
}

export interface Delegation {
  id: string;
  delegator_membership_id: string;
  delegator: string | null;
  delegate_membership_id: string;
  delegate: string | null;
  starts_at: string;
  ends_at: string;
  max_amount_cents: number | null;
  object_types: ApprovalObjectType[];
  notify_delegator: boolean;
  reason: string | null;
  revoked_at: string | null;
  state: 'active' | 'scheduled' | 'ended';
  used: number;
}

export interface MyDelegations {
  me: string | null;
  outgoing: Delegation[];
  incoming: Delegation[];
  managed: Delegation[];
}

export interface DelegateCandidate {
  membership_id: string;
  name: string | null;
  roles: string[] | null;
  management: boolean;
}

export type SizeBucket = 'xs' | 's' | 'm' | 'l';
export type RuleCondition = 'over_budget' | 'below_margin_floor' | 'overtime';

export interface ApprovalRuleRow {
  id: string;
  location_id: string;
  object_type: ApprovalObjectType;
  policy_key: string | null;
  min_amount_cents: number;
  max_amount_cents: number | null;
  step_order: number;
  role_set: string | null;
  approver_roles: string[];
  approver_capability: string | null;
  min_approver_limit_cents: number | null;
  require_distinct: boolean;
  due_days: number;
  condition: RuleCondition | null;
  label: string;
  source: 'default' | 'pack' | 'custom';
  is_active: boolean;
}

export interface ApprovalSettingsRow {
  location_id: string;
  size_bucket: SizeBucket;
  solo_mode: boolean;
  margin_floor_pct: number;
  escalation_roles: string[];
  seeded_at: string | null;
}

export interface ApprovalPolicy {
  location_id: string;
  company: string | null;
  people: number;
  suggested_size: SizeBucket;
  can_configure: boolean;
  settings: ApprovalSettingsRow | null;
  rules: ApprovalRuleRow[];
}

export interface ExceptionRow {
  action_id: string;
  request_id: string;
  acted_at: string;
  object_type: ApprovalObjectType;
  title: string;
  href: string | null;
  company: string | null;
  job_label: string | null;
  actor: string | null;
  reason: string | null;
  amount_cents: number | null;
  request_status: RequestStatus;
}

export function isObjectType(v: unknown): v is ApprovalObjectType {
  return typeof v === 'string' && (APPROVAL_OBJECT_TYPES as readonly string[]).includes(v);
}
