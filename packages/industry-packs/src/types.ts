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

export const PLAN_SCHEMA_VERSION = 1 as const;

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
// Manifest schema
// ---------------------------------------------------------------------------

const keyRe = /^[a-z][a-z0-9_]{1,47}$/;
const Key = z.string().regex(keyRe, 'lower_snake key');

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
  /** stable hash of everything above except answers/sample_job; idempotency + drift detection */
  plan_hash: string;
}
