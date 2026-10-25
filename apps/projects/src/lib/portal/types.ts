/**
 * Shapes the portal database functions return (migration 1118, schema `portal`). Pure and
 * client-safe. Money is integer cents; dates are ISO strings.
 */
export type Audience = 'customer' | 'vendor' | 'lender' | 'investor';
export type Locale = 'en' | 'es';

export interface Brand {
  company_name: string;
  org_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
}

export interface JobBrief {
  id: string;
  name: string;
  number: string;
  company: string;
  status: string;
  stage: string | null;
}

export type QueueKind =
  | 'estimate' | 'change_order' | 'selection' | 'draw' | 'invoice'
  | 'assignment' | 'commitment' | 'compliance' | 'punch' | 'signature';

export type QueueAction = 'sign' | 'approve' | 'choose' | 'review' | 'pay' | 'confirm' | 'accept' | 'upload' | 'complete';

export type AmountKind = 'total' | 'change' | 'vs_allowance' | 'requested' | 'balance' | 'waiver';

export interface QueueItem {
  kind: QueueKind;
  id: string;
  job: JobBrief | null;
  title: string;
  number?: string | null;
  deadline?: string | null;
  finish?: string | null;
  amount_cents?: number | null;
  amount_kind?: AmountKind;
  allowance_cents?: number | null;
  schedule_days?: number | null;
  options?: number;
  area?: string | null;
  state: string;
  action: QueueAction;
  signer_id?: string | null;
  pay_token?: string | null;
  can_act: boolean;
  grant_id: string;
}

export interface GrantSummary {
  id: string;
  audience: Audience;
  company: string;
  party: string;
  role: 'approver' | 'viewer';
  can_sign: boolean;
  can_pay: boolean;
  expires_at: string | null;
  brand: Brand | null;
}

export interface PortalHome {
  org: { id: string; name: string };
  grants: GrantSummary[];
  verified: 'sms' | 'phone_code' | 'email' | null;
  jobs: (JobBrief & { audiences: Audience[]; next_milestone: { title: string; on: string | null } | null })[];
  queue: QueueItem[];
}

export interface PortalOrg {
  org_id: string;
  org_name: string;
  companies: string[] | null;
  audiences: Audience[] | null;
  brand: Brand | null;
  phone_hint: string | null;
}

export interface PortalMe {
  person: { name: string | null; locale: Locale; email: string | null; phone_hint: string | null; verified: PortalHome['verified']; has_phone: boolean };
  orgs: PortalOrg[];
  /** Other companies where the same address has access — switching needs a fresh code from that company. */
  other_orgs: { org_id: string; org_name: string }[];
}

export interface Milestone { id: string; title: string; milestone: boolean; status: string; start: string | null; finish: string | null; pct: number | null }
export interface SharedDoc { id: string; title: string; kind: string; updated_at: string; file_name: string }
export interface Photo { id: string; taken_at: string; area: string | null }
export interface LogEntry { id: string; date: string; kind: string; body: string | null; weather: string | null }
export interface HouseholdMember { name: string; role: 'approver' | 'viewer'; can_sign: boolean; can_pay: boolean; you: boolean }
export interface RequestRow { id: string; kind: 'warranty' | 'service'; title: string; status: string; created_at: string }
export interface TaskResponse { response: 'confirmed' | 'declined' | 'proposed'; proposed_start: string | null; resolution: string | null }
export interface Assignment { id: string; title: string; status: string; start: string | null; finish: string | null; response: TaskResponse | null; job?: JobBrief }
export interface CommitmentRow { id: string; number: string; title: string | null; type: string; status: string; executed_on: string | null; amount_cents: number }
export interface PunchRow { id: string; title: string; area: string | null; status: string; due_on: string | null }
export interface DrawRow { id: string; number: number; period_end: string; status: string; requested_cents: number | null; approved_cents: number | null; funded_cents: number | null; funded_on: string | null; lender: string }

export interface PortalJob {
  job: JobBrief;
  audiences: Audience[];
  brand: Brand | null;
  milestones?: Milestone[];
  documents?: SharedDoc[];
  photos?: Photo[];
  logs?: LogEntry[];
  household?: HouseholdMember[];
  requests?: RequestRow[];
  assignments?: Assignment[];
  commitments?: CommitmentRow[];
  punch?: PunchRow[];
  vendor_documents?: SharedDoc[];
  draws?: DrawRow[];
}

export interface ItemLine { description: string; qty: number | null; uom: string | null; unit_price_cents?: number | null; amount_cents: number; allowance?: boolean }
export interface SelectionOption { id: string; label: string; description: string | null; qty: number; uom: string; amount_cents: number; recommended: boolean; lead_time_days: number | null; delta_cents: number | null }
export interface CommitmentLine { id: string; line_no: number; description: string; qty: number | null; uom: string | null; amount_cents: number; billed_cents: number }
export interface PayAppRow { id: string; application_no: number; period_end: string; gross_cents: number; retainage_cents: number; net_cents: number; status: string; submitted_at: string; decision_note: string | null }

export interface PortalItem {
  kind: 'estimate' | 'change_order' | 'selection' | 'commitment';
  id: string;
  title: string | null;
  number?: string;
  status: string;
  description?: string | null;
  category?: string;
  valid_until?: string | null;
  due_on?: string | null;
  total_cents?: number;
  amount_cents?: number;
  schedule_days?: number | null;
  allowance_cents?: number | null;
  chosen_option_id?: string | null;
  retainage_pct?: number | null;
  payment_hold?: boolean;
  type?: string;
  lines?: (ItemLine | CommitmentLine)[];
  options?: SelectionOption[];
  pay_apps?: PayAppRow[];
  decided?: string | null;
  signer_id?: string | null;
  job: JobBrief;
  can_act: boolean;
  can_sign: boolean;
  verified: PortalHome['verified'];
}

export interface DrawLine { line_id: string; line_no: number; description: string; category: string; budget_cents: number; previous_cents: number; this_period_cents: number; approved_cents: number | null; retainage_cents: number }
export interface PortalDraw {
  draw: { id: string; number: number; period_end: string; status: string; inspection_status: string; inspector_pct: number | null; inspected_on: string | null;
          requested_cents: number | null; approved_cents: number | null; retainage_held_cents: number | null; funded_cents: number | null; funded_on: string | null; submitted_at: string | null };
  job: JobBrief;
  loan: { lender: string; loan_number: string | null; commitment_cents: number; retainage_pct: number };
  can_decide: boolean;
  decided: string | null;
  verified: PortalHome['verified'];
  lines: DrawLine[];
}

export interface InvoiceRow {
  id: string; number: string; date: string; due_date: string; status: string; total_cents: number; paid_cents: number; balance_cents: number;
  retainage_cents: number; job: JobBrief | null; company: string; pay_token: string | null; view_token: string | null;
  payments: { date: string; amount_cents: number; method: string | null }[];
}

export interface VendorBill {
  id: string; number: string | null; date: string; due_date: string; status: string; total_cents: number; paid_cents: number; balance_cents: number;
  retainage_cents: number; scheduled_on: string | null; paid_at: string | null; on_hold: boolean; company: string;
  payments: { date: string; amount_cents: number; method: string | null }[];
}
export interface VendorRequirement { name: string; w9: boolean; coi: boolean; min_gl_each_occurrence_cents: number | null; min_gl_aggregate_cents: number | null; wc: boolean; additional_insured: boolean; certificate_holder: string | null; blocks_payment: boolean }
export interface PortalVendor {
  bills: VendorBill[];
  requirements: VendorRequirement[];
  submissions: { id: string; kind: 'W9' | 'COI'; status: string; received_at: string; decision_reason: string | null }[];
  coverages: { type: string; carrier: string | null; expires: string | null }[];
  job_compliance: { id: string; type: string; status: string; expires_on: string | null; amount_cents: number | null; job: JobBrief }[];
  lookahead: (Assignment & { job: JobBrief })[];
}

export interface PortalMessage { id: string; author: string; mine: boolean; from_team: boolean; body: string; at: string; files: number }
