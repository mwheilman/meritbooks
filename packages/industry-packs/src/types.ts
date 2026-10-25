/**
 * @meritbooks/industry-packs — the CONTRACT (lead-authored, binding).
 *
 * An industry pack is versioned, declarative data. It configures the Merit Projects engine;
 * it never invents schema, never references a GL account number (account ROLES only), and
 * never carries executable expressions (stage guards are names from a closed vocabulary that
 * the database implements as `pm.guard_<name>(job_id)`).
 *
 * Flow: classify(input) → choose pack(s) → compilePlan(manifest, params, answers) → WorkspacePlan
 *       → user previews/edits → `pm.apply_pack_plan(plan jsonb)` (idempotent) in the database.
 *
 * Changing a shape here is a contract change: bump PLAN_SCHEMA_VERSION and update the SQL apply fn.
 */
import { z } from 'zod';

export const PLAN_SCHEMA_VERSION = 2 as const;
/** Plan versions pm.apply_pack_plan accepts (1 = no experience section; 2 = adds `experience`). */
export const SUPPORTED_PLAN_SCHEMA_VERSIONS = [1, 2] as const;

// ---------------------------------------------------------------------------
// Closed vocabularies (engine-level; packs choose from these, never extend them)
// ---------------------------------------------------------------------------

export const ARCHETYPES = [
  'project', 'field_service', 'eto', 'retail_order',
  'engagement', 'recurring_service', 'development', 'dealer_service',
] as const;
export type Archetype = (typeof ARCHETYPES)[number];

export const MODULES = [
  'estimates', 'budget', 'schedule', 'change_orders', 'commitments', 'billing', 'retainage',
  'allowances', 'selections', 'daily_logs', 'punch_warranty', 'time', 'dispatch',
  'service_agreements', 'assets', 'production', 'procurement_markup', 'lots_units',
  'lender_draws', 'rfis_submittals', 'compliance', 'documents', 'client_approvals',
] as const;
export type ModuleKey = (typeof MODULES)[number];

/** Wire-level billing modes. Maps to frozen-v3 `billing_type` + additive `billing_subtype`. */
export const BILLING_MODES = [
  'FIXED', 'PROGRESS_PCT', 'SOV', 'MILESTONE', 'TIME_MATERIALS', 'DRAW', 'DEPOSIT', 'RECURRING',
] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const PROGRESS_BASES = ['NONE', 'COST_TO_COST', 'PHYSICAL_PCT', 'UNITS', 'MILESTONES'] as const;
export type ProgressBasis = (typeof PROGRESS_BASES)[number];

export const COST_TYPES = ['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER'] as const;
export type CostType = (typeof COST_TYPES)[number];

/** core.jobs.status values a stage may map to. */
export const CORE_JOB_STATUSES = ['BID', 'ACTIVE', 'ON_HOLD', 'COMPLETE', 'CLOSED', 'CANCELLED'] as const;
export type CoreJobStatus = (typeof CORE_JOB_STATUSES)[number];

/**
 * Closed guard vocabulary. Each is implemented in SQL as `pm.guard_<name>(p_job uuid) returns boolean`.
 * Adding one = engine change (migration + this list), never a pack change.
 */
export const GUARDS = [
  'has_customer',            // core.jobs.customer_id is set
  'has_contract_value',      // an active pm.contracts row with original_cents > 0
  'has_budget',              // a pm.budgets ORIGINAL version exists with ≥1 line
  'estimate_accepted',       // a pm.estimates row for the job is ACCEPTED
  'deposit_requested',       // a DEPOSIT billing request exists (any status beyond DRAFT)
  'selections_approved',     // no pm.selections for the job in a non-approved state
  'no_open_change_orders',   // no PCO/COR change orders open
  'punch_complete',          // no open PUNCH items
  'final_billed',            // contract fully billed (billed ≥ revised contract)
  'compliance_current',      // no expired required compliance docs on active commitments
  'work_orders_closed',      // no open work orders on the job
  'production_complete',     // all production operations complete
] as const;
export type GuardName = (typeof GUARDS)[number];

/** Account roles a cost code may hint at (Books resolves roles → accounts; Projects never sees numbers). */
export const ACCOUNT_ROLE_HINTS = [
  'DIRECT_LABOR_COST', 'MATERIALS_COST', 'SUBCONTRACT_COST', 'EQUIPMENT_COST', 'OTHER_JOB_COST',
  'PERMITS_FEES_COST', 'FREIGHT_COST', 'DESIGN_FEE_REVENUE', 'SERVICE_REVENUE', 'CONTRACT_REVENUE',
  'PRODUCT_REVENUE', 'WARRANTY_COST', 'LAND_COST', 'SOFT_COST',
] as const;
export type AccountRoleHint = (typeof ACCOUNT_ROLE_HINTS)[number];

/** Rev-rec HINT labels (Books owns the method; this only seeds Books' onboarding proposal). */
export const REV_REC_HINTS = [
  'PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'COMPLETED_CONTRACT', 'MILESTONE', 'AS_BILLED',
  'RATABLY', 'SUBSCRIPTION', 'POINT_IN_TIME',
] as const;
export type RevRecHint = (typeof REV_REC_HINTS)[number];

/** Base vocabulary keys every pack may rename. UI looks these up; missing keys fall back to defaults. */
export const VOCAB_KEYS = [
  'job', 'jobs', 'customer', 'customers', 'estimate', 'estimates', 'change_order', 'change_orders',
  'commitment', 'commitments', 'subcontractor', 'subcontractors', 'billing', 'invoice_request',
  'task', 'tasks', 'daily_log', 'daily_logs', 'work_order', 'work_orders', 'crew', 'crews',
  'site', 'phase', 'phases', 'selection', 'selections', 'draw', 'draws', 'pm', 'superintendent',
] as const;
export type VocabKey = (typeof VOCAB_KEYS)[number];

export const FIELD_OBJECTS = ['project', 'task', 'work_order', 'asset', 'selection', 'field_log', 'commitment'] as const;
export const FIELD_TYPES = ['text', 'number', 'integer', 'date', 'bool', 'enum', 'money_cents'] as const;


// ---------------------------------------------------------------------------
// Manifest v2: the experience slots (UX seat §3a "What changes per industry", PLT-01).
// Closed vocabularies: packs pick keys the app implements; they never add a screen.
// ---------------------------------------------------------------------------

/** Persona role templates (WAVE0 spec §2.2). Mirrors apps/projects lib/access/types PERSONAS. */
export const PERSONA_TEMPLATES = [
  'projects_owner', 'projects_gm', 'projects_office_manager', 'projects_project_accountant',
  'projects_dispatcher', 'projects_purchasing', 'projects_pm', 'projects_supervisor', 'projects_labor',
  'projects_sales',
] as const;
export type PersonaTemplate = (typeof PERSONA_TEMPLATES)[number];

/** The rails the app builds (one per persona group). */
export const PERSONA_GROUPS = ['management', 'admin', 'pm', 'supervisor', 'labor', 'sales'] as const;
export type PersonaGroupKey = (typeof PERSONA_GROUPS)[number];

export const PERSONA_TEMPLATE_GROUP: Readonly<Record<PersonaTemplate, PersonaGroupKey>> = {
  projects_owner: 'management',
  projects_gm: 'management',
  projects_office_manager: 'admin',
  projects_project_accountant: 'admin',
  projects_dispatcher: 'admin',
  projects_purchasing: 'admin',
  projects_pm: 'pm',
  projects_supervisor: 'supervisor',
  projects_labor: 'labor',
  projects_sales: 'sales',
};

/** Rail destinations the app has a route for. A pack orders and relabels these; it never adds one. */
export const NAV_ITEMS = [
  'home', 'today', 'inbox', 'approvals', 'to_review', 'me', 'jobs', 'my_jobs', 'leads', 'customers',
  'estimates', 'change_orders', 'selections', 'units', 'schedule', 'dispatch', 'work_orders', 'agreements',
  'equipment', 'logs', 'punch', 'time', 'crew_time', 'production', 'commitments', 'subcontractors',
  'billing', 'retainage', 'draws', 'job_cost', 'wip', 'margin', 'backlog', 'compare', 'activity',
  'ai_decisions', 'onboarding', 'settings', 'documents', 'stock', 'deals', 'parts', 'rentals', 'warranty',
  // field service depth (1117), approvals (1113), notifications (1114)
  'calls', 'campaigns', 'price_book', 'capacity', 'scorecards', 'out_of_office', 'approval_rules', 'company_messages',
] as const;
export type NavItemKey = (typeof NAV_ITEMS)[number];

/** Home modules (UX seat §3b). The app renders each; a pack picks and orders them per persona group. */
export const HOME_WIDGETS = [
  // management
  'weekly_brief', 'cash_ar', 'jobs_at_risk', 'backlog_capacity', 'over_under_billing', 'pipeline', 'approvals_queue',
  // admin
  'needs_you', 'today_schedule', 'billing_ready', 'new_leads', 'setup_card',
  // pm
  'my_jobs', 'week_schedule', 'billing_due', 'client_updates',
  // supervisor
  'today_on_site', 'lookahead_constraints', 'crew_time_to_approve', 'open_punch', 'daily_report_status',
  // labor
  'current_assignment', 'rest_of_today', 'timecard', 'earnings', 'office_messages',
  // industry signature screens (each opens a real board)
  'dispatch_board', 'service_board', 'capacity_board', 'install_board', 'crew_board', 'draw_status',
  'selections_queue', 'item_tracker', 'utilization', 'unit_aging', 'pay_apps_due', 'productivity',
] as const;
export type HomeWidgetKey = (typeof HOME_WIDGETS)[number];

/**
 * Job page tab kinds. Each is a screen the app renders (or, for the few marked later in the app,
 * an honest placeholder with a link to where the work lives today). A pack orders and relabels.
 */
export const JOB_TAB_KINDS = [
  'overview', 'estimates', 'budget', 'schedule', 'change_orders', 'contract', 'commitments', 'billing',
  'job_cost', 'work_orders', 'production', 'selections', 'draws', 'units', 'logs', 'punch', 'time',
  'documents', 'activity', 'team',
  // not built yet: rendered as an honest placeholder that links to where the work lives
  'rfis', 'client_view', 'equipment', 'agreement', 'parts', 'warranty_claim', 'capital_stack', 'bom',
  'tm_tickets', 'receiving', 'productivity',
] as const;
export type JobTabKind = (typeof JOB_TAB_KINDS)[number];

/** Field-app primary actions (UX seat §3a last column, §3e). */
export const MOBILE_ACTIONS = [
  'clock_in', 'on_my_way', 'start', 'finish', 'photo', 'note', 'checklist', 'daily_log', 'punch_item',
  'crew_time', 'inspection', 'report_quantities', 'tm_ticket', 'request_change_order', 'todo',
  'stage_complete', 'trade_check_in', 'present_options', 'take_payment', 'scan_equipment', 'sell_agreement',
  'operation_start_stop', 'good_scrap_qty', 'scan_label', 'flag_issue', 'measure_room', 'start_ticket',
  'confirm_dye_lot', 'customer_sign_off', 'clip_product', 'receive_item', 'log_time', 'install_checklist',
  'clock_on_ro_line', 'check_in_unit', 'request_part', 'voice_notes', 'rental_inspection', 'site_visit_report',
  'timer', 'expense_receipt', 'approve_crew_time',
] as const;
export type MobileActionKey = (typeof MOBILE_ACTIONS)[number];

/** Schedule lenses (UX seat §3c). */
export const SCHEDULE_VIEWS = [
  'gantt', 'lookahead', 'calendar', 'crew_board', 'dispatch', 'production_capacity', 'install_board',
  'milestone_timeline', 'service_board', 'resource_planner',
] as const;
export type ScheduleViewKey = (typeof SCHEDULE_VIEWS)[number];

/** Document templates a pack may ship (keys only today; the template bodies live with Documents). */
export const DOC_TEMPLATES = [
  'proposal', 'estimate', 'contract', 'change_order', 'pay_app', 'invoice', 'work_order', 'install_ticket',
  'purchase_order', 'subcontract', 'daily_report', 'buyers_order', 'draw_request', 'closeout', 'lien_waiver',
  'tm_ticket', 'measure_sheet', 'delivery_receipt', 'inspection_report', 'service_agreement', 'warranty_claim',
  'repair_order', 'design_agreement', 'selection_sheet', 'punch_list', 'rental_agreement',
] as const;
export type DocTemplateKey = (typeof DOC_TEMPLATES)[number];

/** Job-type key slot that applies to every job type without its own entry. */
export const ANY_JOB_TYPE = '*' as const;
/** The visible tab row holds this many; the rest go behind "More" (UX seat §3d). */
export const MAX_VISIBLE_JOB_TABS = 7;

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

const keyRe = /^[a-z][a-z0-9_]{1,47}$/;
/** Keys that reach Object.prototype when used as a record key; never a pack key. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['constructor', 'prototype']);
const Key = z.string().regex(keyRe, 'lower_snake key').refine((k) => !RESERVED_KEYS.has(k), 'reserved key');

export const StageDefSchema = z.object({
  key: Key,
  label: z.string().min(1).max(40),
  coreStatus: z.enum(CORE_JOB_STATUSES),
  terminal: z.boolean().default(false),
});

export const TransitionSchema = z.object({
  from: Key,
  to: Key,
  guards: z.array(z.enum(GUARDS)).default([]),
  /** optional approval policy key defined in `approvalPolicies` */
  approval: Key.optional(),
});

export const StageMachineSchema = z.object({
  key: Key,
  initial: Key,
  stages: z.array(StageDefSchema).min(2),
  transitions: z.array(TransitionSchema).min(1),
});

export const ApprovalPolicySchema = z.object({
  key: Key,
  label: z.string(),
  /** ascending tiers; an amount ≤ maxCents needs `count` approvers from `roles` (preparer ≠ approver enforced in SQL) */
  tiers: z.array(z.object({
    maxCents: z.number().int().nonnegative().nullable(), // null = no upper bound
    roles: z.array(z.string()).min(1),
    count: z.number().int().min(1).max(3).default(1),
  })).min(1),
});

export const JobTypeSchema = z.object({
  key: Key,
  label: z.string().min(1).max(48),
  archetype: z.enum(ARCHETYPES),
  billingModes: z.array(z.enum(BILLING_MODES)).min(1),
  defaultBillingMode: z.enum(BILLING_MODES),
  progressBasis: z.enum(PROGRESS_BASES).default('NONE'),
  stageMachine: Key,
  revRecHint: z.enum(REV_REC_HINTS).optional(),
  /** module overrides for this job type (on top of pack modules) */
  modules: z.record(z.string(), z.boolean()).optional(), // keys validated against MODULES by validateManifest()
  defaultRetainagePct: z.number().min(0).max(0.2).optional(),
  description: z.string().max(200).optional(),
});

export const CostCodeSchema = z.object({
  code: z.string().min(1).max(24),
  name: z.string().min(1).max(80),
  costType: z.enum(COST_TYPES),
  parent: z.string().max(24).optional(),
  roleHint: z.enum(ACCOUNT_ROLE_HINTS).optional(),
});

export const FieldDefSchema = z.object({
  object: z.enum(FIELD_OBJECTS),
  key: Key,
  label: z.string().max(48),
  type: z.enum(FIELD_TYPES),
  jobType: Key.optional(),
  options: z.array(z.string()).optional(), // for enum
  required: z.boolean().default(false),
  promote: z.boolean().default(false),
});

export const PriceBookItemSchema = z.object({
  code: z.string().max(24),
  name: z.string().max(80),
  unit: z.string().max(12),
  priceCents: z.number().int().nonnegative(),
  costCents: z.number().int().nonnegative().optional(),
  laborMinutes: z.number().int().nonnegative().optional(),
  costCode: z.string().max(24).optional(),
});

export const KpiSchema = z.object({
  key: Key,
  label: z.string().max(48),
  /** metric id from the Projects metric catalog (closed list owned by the app) */
  metric: Key,
  goodDirection: z.enum(['up', 'down']),
});

/**
 * A follow-up question with a deterministic effect. Effects are a closed set so the compiler,
 * not the model, decides what an answer does.
 */
export const QuestionEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('toggle_module'), module: z.enum(MODULES), whenTrue: z.boolean().default(true) }),
  z.object({ kind: z.literal('set_param'), param: Key }),
  z.object({ kind: z.literal('enable_job_types'), jobTypes: z.array(Key).min(1) }),
  z.object({ kind: z.literal('set_default_billing'), jobType: Key.optional() }),
]);

export const QuestionSchema = z.object({
  key: Key,
  prompt: z.string().max(120),
  help: z.string().max(200).optional(),
  answer: z.discriminatedUnion('type', [
    z.object({ type: z.literal('bool'), default: z.boolean() }),
    z.object({ type: z.literal('choice'), options: z.array(z.object({ value: z.string(), label: z.string() })).min(2), default: z.string() }),
    z.object({ type: z.literal('multi'), options: z.array(z.object({ value: z.string(), label: z.string() })).min(2), default: z.array(z.string()) }),
    z.object({ type: z.literal('percent'), min: z.number(), max: z.number(), default: z.number() }),
  ]),
  effects: z.array(QuestionEffectSchema).min(1),
});

export const SampleJobSchema = z.object({
  name: z.string().max(80),
  jobType: Key,
  customerName: z.string().max(80),
  contractCents: z.number().int().nonnegative(),
  /** budget lines by cost code (codes must exist in costCodes) */
  budget: z.array(z.object({ code: z.string(), amountCents: z.number().int().nonnegative() })).min(1),
  tasks: z.array(z.object({ title: z.string().max(80), offsetDays: z.number().int(), durationDays: z.number().int().min(0) })).default([]),
  stage: Key,
});


// ---- manifest v2 experience slots (all optional: v1 manifests parse unchanged) ----

const Label = z.string().min(1).max(40);
/** '*' or a job type key. */
const JobTypeSlot = z.string().regex(/^(\*|[a-z][a-z0-9_]{1,47})$/, 'job type key or "*"').refine((k) => !RESERVED_KEYS.has(k), 'reserved key');

export const RoleTitleSchema = z.object({
  /** Industry title shown to people ("Comfort advisor"). */
  title: Label,
  /** Persona template it maps to. */
  template: z.enum(PERSONA_TEMPLATES),
});

export const NavEntrySchema = z.union([
  z.enum(NAV_ITEMS),
  z.object({ item: z.enum(NAV_ITEMS), label: Label }),
]);

export const JobTabEntrySchema = z.union([
  z.enum(JOB_TAB_KINDS),
  z.object({ tab: z.enum(JOB_TAB_KINDS), label: Label }),
]);

export const JobTabSetSchema = z.object({
  tabs: z.array(JobTabEntrySchema).min(2).max(12),
  /** Tab the job opens on (defaults to the first). field_service opens on Visits. */
  defaultTab: z.enum(JOB_TAB_KINDS).optional(),
});

export const MobileProfileSchema = z.object({
  /** group → job type ('*' = any) → primary actions, first is the big button. */
  actions: z.record(z.enum(PERSONA_GROUPS), z.record(JobTypeSlot, z.array(z.enum(MOBILE_ACTIONS)).min(1).max(6))).default({}),
  /** Shop / wall-screen kiosk (QR or PIN, one work center's queue). */
  kiosk: z.boolean().default(false),
});

export const ScheduleProfileSchema = z.object({
  /** job type ('*' = any) → the view the job's Schedule tab opens on. */
  job: z.record(JobTypeSlot, z.enum(SCHEDULE_VIEWS)).default({}),
  /** The global Schedule rail item's multi-job view. */
  multiJob: z.enum(SCHEDULE_VIEWS).default('calendar'),
  /** Per persona group override of the multi-job view (supers on look-ahead, foremen on the crew board). */
  byGroup: z.record(z.enum(PERSONA_GROUPS), z.enum(SCHEDULE_VIEWS)).default({}),
});

export const ChecklistRefSchema = z.object({
  key: Key,
  label: z.string().min(1).max(60),
  /** Job types it applies to (omit = all). */
  jobTypes: z.array(Key).optional(),
});

export const PackManifestSchema = z.object({
  key: Key,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  extends: Key.optional(),
  name: z.string().max(48),
  tagline: z.string().max(120),
  /** classifier inputs */
  tile: z.object({ label: z.string().max(32), examples: z.string().max(80) }),
  naics: z.array(z.string().regex(/^\d{2,6}$/)).default([]),
  keywords: z.array(z.object({ term: z.string().min(2), weight: z.number().min(0.1).max(3) })).min(3),
  archetypes: z.array(z.enum(ARCHETYPES)).min(1),
  vocabulary: z.record(z.string(), z.string()).default({}),
  modules: z.record(z.string(), z.boolean()),
  jobTypes: z.array(JobTypeSchema).min(1),
  stageMachines: z.array(StageMachineSchema).min(1),
  approvalPolicies: z.array(ApprovalPolicySchema).default([]),
  costCodes: z.array(CostCodeSchema).min(5),
  fieldDefs: z.array(FieldDefSchema).default([]),
  priceBook: z.array(PriceBookItemSchema).default([]),
  kpis: z.array(KpiSchema).default([]),
  questions: z.array(QuestionSchema).max(5).default([]),
  /** bounded params the AI may fill (all must have defaults) */
  params: z.record(z.string(), z.object({
    type: z.enum(['bool', 'percent', 'enum', 'integer']),
    default: z.union([z.boolean(), z.number(), z.string()]),
    min: z.number().optional(), max: z.number().optional(),
    options: z.array(z.string()).optional(),
    label: z.string().max(60),
  })).default({}),
  aiProfile: z.object({
    watchFor: z.array(z.string().max(120)).max(8).default([]),
    tone: z.string().max(80).default('plain, direct, numbers first'),
  }).default({ watchFor: [], tone: 'plain, direct, numbers first' }),
  sampleJob: SampleJobSchema,
  // ---- manifest v2 (PLT-01). Optional so every v1 manifest still parses. ----
  /** Industry titles → persona templates. First title per template is the display title. */
  roles: z.array(RoleTitleSchema).max(30).optional(),
  /** Rail per persona group, top to bottom. Items the person can't reach are dropped by the app. */
  nav: z.record(z.enum(PERSONA_GROUPS), z.array(NavEntrySchema).min(1).max(14)).optional(),
  /** Home modules per persona group, top-left first. */
  home: z.record(z.enum(PERSONA_GROUPS), z.array(z.enum(HOME_WIDGETS)).min(1).max(10)).optional(),
  /** Job page tabs per job type ('*' = every job type without its own set). */
  jobTabs: z.record(JobTypeSlot, JobTabSetSchema).optional(),
  mobile: MobileProfileSchema.optional(),
  schedule: ScheduleProfileSchema.optional(),
  docTemplates: z.array(z.enum(DOC_TEMPLATES)).max(26).optional(),
  checklists: z.array(ChecklistRefSchema).max(30).optional(),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;
export type PackManifestInput = z.input<typeof PackManifestSchema>;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  /** free text the user typed ("we build custom cabinets and install them") */
  description?: string;
  /** a tile the user picked (pack key) */
  tilePackKey?: string;
  /** hints inherited from Books */
  naics?: string;
  companyIndustry?: string;      // core.locations.industry (free text)
  revRecMethod?: string;         // core.locations.rev_rec_method
  companyName?: string;
  /** header row of an uploaded file, if any */
  fileHeaders?: string[];
}

export interface PackCandidate {
  packKey: string;
  confidence: number;            // 0..1
  reasons: string[];             // human-readable; each cites its evidence
  source: 'tile' | 'rules' | 'ai' | 'merged';
}

export interface ClassifyResult {
  candidates: PackCandidate[];   // sorted desc, ≤ 3
  abstain: boolean;              // true → show tiles, don't guess
}

// ---------------------------------------------------------------------------
// Compiled plan (what the database applies). JSON-serializable. snake_case keys on purpose:
// this object is passed verbatim to `pm.apply_pack_plan(plan jsonb)`.
// ---------------------------------------------------------------------------

export interface PlanJobType {
  key: string; label: string; archetype: Archetype;
  billing_modes: BillingMode[]; default_billing_mode: BillingMode;
  progress_basis: ProgressBasis; stage_machine_key: string;
  rev_rec_hint: RevRecHint | null;
  modules: Record<ModuleKey, boolean>;   // fully resolved (pack ∪ job-type overrides ∪ answers)
  default_retainage_pct: number | null;
}

export interface PlanStage {
  machine_key: string; stage_key: string; label: string; sort: number;
  core_status: CoreJobStatus; is_terminal: boolean; is_initial: boolean;
}

export interface PlanTransition {
  machine_key: string; from_stage: string; to_stage: string;
  guards: GuardName[]; approval_policy_key: string | null;
}

export interface PlanCostCode {
  code: string; name: string; cost_type: CostType; parent_code: string | null;
  role_hint: AccountRoleHint | null;
}

export interface PlanFieldDef {
  object_type: (typeof FIELD_OBJECTS)[number]; job_type_key: string | null; field_key: string;
  label: string; data_type: (typeof FIELD_TYPES)[number]; options: string[] | null;
  required: boolean; promote: boolean;
}

export interface PlanApprovalPolicy {
  key: string; label: string;
  tiers: { max_cents: number | null; roles: string[]; count: number }[];
}

export interface PlanPriceBookItem {
  code: string; name: string; unit: string; price_cents: number;
  cost_cents: number | null; labor_minutes: number | null; cost_code: string | null;
}

export interface WorkspacePlan {
  schema_version: typeof PLAN_SCHEMA_VERSION;
  location_id: string;                 // company the pack installs on
  primary_pack: { key: string; version: string };
  addon_packs: { key: string; version: string }[];
  params: Record<string, boolean | number | string>;
  answers: Record<string, unknown>;
  vocabulary: Record<string, string>;  // fully resolved, base keys included
  modules: Record<ModuleKey, boolean>; // company-level union
  job_types: PlanJobType[];
  stages: PlanStage[];
  transitions: PlanTransition[];
  approval_policies: PlanApprovalPolicy[];
  cost_codes: PlanCostCode[];
  field_defs: PlanFieldDef[];
  price_book: PlanPriceBookItem[];
  kpis: { key: string; label: string; metric: string; good_direction: 'up' | 'down' }[];
  /** proposal for Books (never applied by Projects): cost type → account role; rev-rec hint per job type */
  books_proposal: {
    cost_type_roles: Partial<Record<CostType, AccountRoleHint>>;
    rev_rec_by_job_type: Record<string, RevRecHint>;
  };
  sample_job: z.infer<typeof SampleJobSchema> | null; // included only if the user opts in
  /** v2: the compiled experience (roles, rails, homes, job tabs, field actions, schedule views, templates). */
  experience: PlanExperience;
  /** stable hash of everything above except answers/sample_job; idempotency + drift detection */
  plan_hash: string;
}

// ---------------------------------------------------------------------------
// Compiled experience (plan v2). snake_case like the rest of the plan.
// ---------------------------------------------------------------------------

export interface PlanNavEntry { item: NavItemKey; label: string | null }
export interface PlanJobTab { tab: JobTabKind; label: string | null }
export interface PlanJobTabSet { tabs: PlanJobTab[]; default_tab: JobTabKind }

export interface PlanExperience {
  roles: { title: string; template: PersonaTemplate }[];
  /** Missing group = the app's built-in rail for that persona. */
  nav: Partial<Record<PersonaGroupKey, PlanNavEntry[]>>;
  home: Partial<Record<PersonaGroupKey, HomeWidgetKey[]>>;
  /** Keyed by job type key or '*'. */
  job_tabs: Record<string, PlanJobTabSet>;
  mobile_actions: Partial<Record<PersonaGroupKey, Record<string, MobileActionKey[]>>>;
  kiosk: boolean;
  schedule_views: { job: Record<string, ScheduleViewKey>; multi_job: ScheduleViewKey; by_group: Partial<Record<PersonaGroupKey, ScheduleViewKey>> };
  doc_templates: DocTemplateKey[];
  checklists: { key: string; label: string; job_types: string[] | null }[];
  /** Which pack each job type's slots came from (primary or an add-on). */
  sources: Record<string, string>;
}
