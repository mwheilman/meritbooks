/**
 * compilePlan(): (pack@version, add-ons, params, answers) → WorkspacePlan. Pure and deterministic:
 * the same inputs always produce the same plan and the same plan_hash. The model never reaches
 * this function; it only proposes inputs that the user confirms.
 *
 * Precedence for a param: explicit answer > explicit param > default answer > param default.
 * Precedence for a module on a job type: explicit answer toggle > explicit uses_retainage >
 * default answer toggle > job-type override > pack default. A job type that sets a module to
 * false explicitly never has it turned on by a toggle; retainage only turns on for job types with
 * a progress, pay-app or draw billing mode.
 */
import { createHash } from 'node:crypto';
import {
  ACCOUNT_ROLE_HINTS, COST_TYPES, MODULES, PLAN_SCHEMA_VERSION,
  type AccountRoleHint, type BillingMode, type CostType, type ModuleKey, type PackManifest,
  type PlanApprovalPolicy, type PlanCostCode, type PlanFieldDef, type PlanJobType, type PlanPriceBookItem,
  type PlanStage, type PlanTransition, type RevRecHint, type WorkspacePlan,
} from './types';
import { DEFAULT_COST_TYPE_ROLES, RETAINAGE_BILLING_MODES } from './constants';
import { resolveManifest } from './catalog';
import { checkParams, type ParamValue } from './params';
import { AnswerError, applyEffects, includedJobTypes, resolveAnswers, type AnswerValue } from './effects';
import { resolveVocabulary } from './vocab';

export { diffPlans, type PlanDiff, type SectionDiff } from './diff';
export { describePlan, type PreviewCard } from './describe';

export interface CompileInput {
  /** pack key (resolved from the catalog) or an already-resolved manifest */
  pack: string | PackManifest;
  /** catalog version when `pack` is a key; latest if omitted */
  version?: string;
  /** add-on packs installed on the same company; their job types and cost codes are appended */
  addons?: (string | PackManifest)[];
  /** params for the primary pack (validated against its params spec) */
  params?: Record<string, unknown>;
  /** answers keyed by question key; add-on answers are keyed "addon_key.question_key" */
  answers?: Record<string, unknown>;
  locationId: string;
  includeSample?: boolean;
}

export class PlanCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanCompileError';
  }
}

interface CompiledPart {
  manifest: PackManifest;
  params: Record<string, ParamValue>;
  answers: Record<string, AnswerValue>;
  jobTypes: PlanJobType[];
  stages: PlanStage[];
  transitions: PlanTransition[];
  policies: PlanApprovalPolicy[];
  costCodes: PlanCostCode[];
  fieldDefs: PlanFieldDef[];
  priceBook: PlanPriceBookItem[];
  kpis: WorkspacePlan['kpis'];
}

function toManifest(p: string | PackManifest, version?: string): PackManifest {
  return typeof p === 'string' ? resolveManifest(p, version) : p;
}

function moduleApplies(module: ModuleKey, billingModes: readonly BillingMode[]): boolean {
  if (module === 'retainage') return billingModes.some((b) => RETAINAGE_BILLING_MODES.includes(b));
  return true;
}

function compilePart(
  manifest: PackManifest,
  providedParams: Record<string, unknown> | undefined,
  providedAnswers: Record<string, unknown> | undefined,
  namespace?: string,
): CompiledPart {
  const pc = checkParams(manifest, providedParams);
  if (!pc.ok) throw new PlanCompileError(`Invalid params for ${manifest.key}: ${pc.issues.join('; ')}`);
  const params = { ...pc.params };
  const explicitParams = new Set(Object.keys(providedParams ?? {}));

  let answers;
  try {
    answers = resolveAnswers(manifest, providedAnswers, namespace);
  } catch (err) {
    if (err instanceof AnswerError) throw new PlanCompileError(err.message);
    throw err;
  }
  const eff = applyEffects(manifest, answers);

  for (const ps of eff.paramSets) {
    if (ps.explicit) {
      params[ps.param] = ps.value;
      explicitParams.add(ps.param);
    } else if (!explicitParams.has(ps.param)) {
      params[ps.param] = ps.value;
    }
  }

  const toggles = new Map(eff.moduleToggles);
  if (explicitParams.has('uses_retainage') && typeof params.uses_retainage === 'boolean' && !eff.explicitToggles.has('retainage')) {
    toggles.set('retainage', params.uses_retainage);
  }

  const included = new Set(includedJobTypes(manifest, eff));
  const jobTypes: PlanJobType[] = [];
  for (const jt of manifest.jobTypes) {
    if (!included.has(jt.key)) continue;
    const modules = {} as Record<ModuleKey, boolean>;
    for (const mk of MODULES) {
      const override = jt.modules?.[mk];
      const base = override ?? manifest.modules[mk] ?? false;
      const t = toggles.get(mk);
      modules[mk] = t === undefined ? base : t && override !== false && moduleApplies(mk, jt.billingModes);
    }
    let retainage: number | null = null;
    if (modules.retainage) {
      const pct = params.retainage_pct;
      if (explicitParams.has('retainage_pct') && typeof pct === 'number') retainage = pct;
      else retainage = jt.defaultRetainagePct ?? (typeof pct === 'number' ? pct : null);
    }
    jobTypes.push({
      key: jt.key,
      label: jt.label,
      archetype: jt.archetype,
      billing_modes: [...jt.billingModes],
      default_billing_mode: eff.billingDefaults.get(jt.key) ?? jt.defaultBillingMode,
      progress_basis: jt.progressBasis,
      stage_machine_key: jt.stageMachine,
      rev_rec_hint: jt.revRecHint ?? null,
      modules,
      default_retainage_pct: retainage,
    });
  }
  if (jobTypes.length === 0) throw new PlanCompileError(`These answers turn off every job type in ${manifest.key}`);

  const usedMachines = new Set(jobTypes.map((j) => j.stage_machine_key));
  const stages: PlanStage[] = [];
  const transitions: PlanTransition[] = [];
  for (const sm of manifest.stageMachines) {
    if (!usedMachines.has(sm.key)) continue;
    sm.stages.forEach((s, i) => stages.push({
      machine_key: sm.key,
      stage_key: s.key,
      label: s.label,
      sort: (i + 1) * 10,
      core_status: s.coreStatus,
      is_terminal: s.terminal,
      is_initial: s.key === sm.initial,
    }));
    for (const t of sm.transitions) {
      transitions.push({
        machine_key: sm.key,
        from_stage: t.from,
        to_stage: t.to,
        guards: [...t.guards],
        approval_policy_key: t.approval ?? null,
      });
    }
  }

  return {
    manifest,
    params,
    answers: answers.values,
    jobTypes,
    stages,
    transitions,
    policies: manifest.approvalPolicies.map((p) => ({
      key: p.key,
      label: p.label,
      tiers: p.tiers.map((t) => ({ max_cents: t.maxCents, roles: [...t.roles], count: t.count })),
    })),
    costCodes: manifest.costCodes.map((c) => ({
      code: c.code,
      name: c.name,
      cost_type: c.costType,
      parent_code: c.parent ?? null,
      role_hint: c.roleHint ?? null,
    })),
    fieldDefs: manifest.fieldDefs
      .filter((f) => !f.jobType || included.has(f.jobType))
      .map((f) => ({
        object_type: f.object,
        job_type_key: f.jobType ?? null,
        field_key: f.key,
        label: f.label,
        data_type: f.type,
        options: f.options ? [...f.options] : null,
        required: f.required,
        promote: f.promote,
      })),
    priceBook: manifest.priceBook.map((p) => ({
      code: p.code,
      name: p.name,
      unit: p.unit,
      price_cents: p.priceCents,
      cost_cents: p.costCents ?? null,
      labor_minutes: p.laborMinutes ?? null,
      cost_code: p.costCode ?? null,
    })),
    kpis: manifest.kpis.map((k) => ({ key: k.key, label: k.label, metric: k.metric, good_direction: k.goodDirection })),
  };
}

function appendUnique<T>(into: T[], items: T[], keyOf: (x: T) => string): void {
  const seen = new Set(into.map(keyOf));
  for (const it of items) {
    const k = keyOf(it);
    if (!seen.has(k)) {
      seen.add(k);
      into.push(it);
    }
  }
}

/**
 * Role per cost type: the role a strict majority of that type's codes carry, otherwise the default
 * role for the type (a 2–2 split between freight and warranty is not a reason to move "Other").
 */
function costTypeRoles(codes: PlanCostCode[]): Partial<Record<CostType, AccountRoleHint>> {
  const out: Partial<Record<CostType, AccountRoleHint>> = {};
  for (const ct of COST_TYPES) {
    const ofType = codes.filter((c) => c.cost_type === ct);
    if (ofType.length === 0) continue;
    const counts = new Map<AccountRoleHint, number>();
    for (const c of ofType) {
      const role = c.role_hint ?? DEFAULT_COST_TYPE_ROLES[ct];
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    let pick: AccountRoleHint = DEFAULT_COST_TYPE_ROLES[ct];
    for (const role of ACCOUNT_ROLE_HINTS) {
      if ((counts.get(role) ?? 0) * 2 > ofType.length) pick = role;
    }
    out[ct] = pick;
  }
  return out;
}

/** JSON with object keys sorted at every level (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha256 of the canonical plan, excluding answers, sample_job and the hash itself. */
export function planHash(plan: Omit<WorkspacePlan, 'plan_hash'> | WorkspacePlan): string {
  const { answers: _a, sample_job: _s, ...rest } = plan as WorkspacePlan;
  const hashable: Record<string, unknown> = { ...rest };
  delete hashable.plan_hash;
  return createHash('sha256').update(canonicalJson(hashable)).digest('hex');
}

export function compilePlan(input: CompileInput): WorkspacePlan {
  if (!input.locationId) throw new PlanCompileError('locationId is required');
  const primary = toManifest(input.pack, input.version);
  const addons = (input.addons ?? []).map((a) => toManifest(a)).filter((a) => a.key !== primary.key);
  const addonKeys = new Set(addons.map((a) => a.key));
  if (addonKeys.size !== addons.length) throw new PlanCompileError('An add-on pack is listed twice');

  for (const k of Object.keys(input.answers ?? {})) {
    const dot = k.indexOf('.');
    if (dot > 0 && !addonKeys.has(k.slice(0, dot))) {
      throw new PlanCompileError(`Answer "${k}" is for a pack that is not being installed`);
    }
  }

  const main = compilePart(primary, input.params, input.answers);
  const parts = [main, ...addons.map((a) => compilePart(a, undefined, input.answers, a.key))];

  const jobTypes: PlanJobType[] = [];
  const stages: PlanStage[] = [];
  const transitions: PlanTransition[] = [];
  const policies: PlanApprovalPolicy[] = [];
  const costCodes: PlanCostCode[] = [];
  const fieldDefs: PlanFieldDef[] = [];
  const priceBook: PlanPriceBookItem[] = [];
  const kpis: WorkspacePlan['kpis'] = [];
  const params: Record<string, ParamValue> = {};
  const answers: Record<string, unknown> = {};

  for (const part of parts) {
    const ns = part === main ? '' : `${part.manifest.key}.`;
    const newJobTypes = part.jobTypes.filter((j) => !jobTypes.some((x) => x.key === j.key));
    const machinesHere = new Set(newJobTypes.map((j) => j.stage_machine_key));
    const machinesHave = new Set(stages.map((s) => s.machine_key));
    jobTypes.push(...newJobTypes);
    stages.push(...part.stages.filter((s) => machinesHere.has(s.machine_key) && !machinesHave.has(s.machine_key)));
    transitions.push(...part.transitions.filter((t) => machinesHere.has(t.machine_key) && !machinesHave.has(t.machine_key)));
    appendUnique(policies, part.policies, (p) => p.key);
    appendUnique(costCodes, part.costCodes, (c) => c.code);
    appendUnique(fieldDefs, part.fieldDefs, (f) => `${f.object_type}:${f.job_type_key ?? ''}:${f.field_key}`);
    appendUnique(priceBook, part.priceBook, (p) => p.code);
    appendUnique(kpis, part.kpis, (k) => k.key);
    for (const [k, v] of Object.entries(part.params)) if (!(k in params)) params[k] = v;
    for (const [k, v] of Object.entries(part.answers)) answers[`${ns}${k}`] = v;
  }

  const modules = {} as Record<ModuleKey, boolean>;
  for (const mk of MODULES) modules[mk] = jobTypes.some((j) => j.modules[mk]);

  const revRec: Record<string, RevRecHint> = {};
  for (const j of jobTypes) if (j.rev_rec_hint) revRec[j.key] = j.rev_rec_hint;

  const sample = primary.sampleJob;
  const sampleJob = input.includeSample && jobTypes.some((j) => j.key === sample.jobType)
    ? JSON.parse(JSON.stringify(sample)) as WorkspacePlan['sample_job']
    : null;

  const plan: Omit<WorkspacePlan, 'plan_hash'> = {
    schema_version: PLAN_SCHEMA_VERSION,
    location_id: input.locationId,
    primary_pack: { key: primary.key, version: primary.version },
    addon_packs: addons.map((a) => ({ key: a.key, version: a.version })),
    params: Object.fromEntries(Object.keys(params).sort().map((k) => [k, params[k]])),
    answers,
    vocabulary: resolveVocabulary(primary.vocabulary),
    modules,
    job_types: jobTypes,
    stages,
    transitions,
    approval_policies: policies,
    cost_codes: costCodes,
    field_defs: fieldDefs,
    price_book: priceBook,
    kpis,
    books_proposal: {
      cost_type_roles: costTypeRoles(costCodes),
      rev_rec_by_job_type: revRec,
    },
    sample_job: sampleJob,
  };
  return { ...plan, plan_hash: planHash(plan) };
}
