/**
 * Step 2 — compile the workspace plan and shape the "Here's your workspace" preview.
 * Server-side (the compiler hashes with node:crypto). Deterministic: the same inputs
 * give the same plan_hash, so the apply route recompiles from the same inputs and
 * refuses to apply anything other than what the user previewed.
 *
 * Module switches: the compiler has no module input, so a switch is an explicit
 * company-level override applied AFTER compile (every job type on/off; retainage only
 * on job types that bill by progress, pay app or draw), recorded on the plan as the
 * additive key `module_overrides`, and re-hashed with the package's planHash().
 */
import {
  BILLING_MODE_LABELS, MODULES, MODULE_LABELS, PlanCompileError, RETAINAGE_BILLING_MODES, compilePlan, describePlan, diffPlans,
  getPack, listPacks, planHash, t,
  type ModuleKey, type PackManifest, type WorkspacePlan,
} from '@meritbooks/industry-packs';
import type {
  AnswerValue, CardDTO, ClassifyResponse, DiffSummary, JobTypeDTO, ModuleDTO, PlanInputs, PlanPreview, QuestionDTO,
} from './types';

export { PlanCompileError };

export type CompiledPlan = WorkspacePlan & { module_overrides?: Partial<Record<ModuleKey, boolean>> };
/** What pm.apply_pack_plan(p_plan) receives: the plan + the additive ai_decision_id key. */
export type ApplyPayload = CompiledPlan & { ai_decision_id?: string };

const isModule = (k: string): k is ModuleKey => (MODULES as readonly string[]).includes(k);

export function cleanOverrides(raw: Record<string, unknown> | undefined): Partial<Record<ModuleKey, boolean>> {
  const out: Partial<Record<ModuleKey, boolean>> = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (isModule(k) && typeof v === 'boolean') out[k] = v;
  return out;
}

/** Apply company-level module switches to a compiled plan and re-hash it. */
export function applyModuleOverrides(plan: WorkspacePlan, overrides: Partial<Record<ModuleKey, boolean>>): CompiledPlan {
  const keys = Object.keys(overrides).filter(isModule).sort();
  if (keys.length === 0) return plan;
  const next: CompiledPlan = JSON.parse(JSON.stringify(plan));
  const effective: Partial<Record<ModuleKey, boolean>> = {};
  for (const m of keys) {
    const on = overrides[m] === true;
    for (const jt of next.job_types) {
      const allowed = m !== 'retainage' || jt.billing_modes.some((b) => RETAINAGE_BILLING_MODES.includes(b));
      jt.modules[m] = on && allowed;
      if (m === 'retainage') {
        if (!jt.modules.retainage) jt.default_retainage_pct = null;
        else if (jt.default_retainage_pct === null) {
          const pct = next.params.retainage_pct;
          jt.default_retainage_pct = typeof pct === 'number' ? pct : 0.1;
        }
      }
    }
    // only record a switch that actually differs from what the pack compiled
    if (plan.modules[m] !== on) effective[m] = on;
  }
  for (const mk of MODULES) next.modules[mk] = next.job_types.some((j) => j.modules[mk]);
  if (Object.keys(effective).length > 0) next.module_overrides = effective;
  else delete next.module_overrides;
  const { plan_hash: _old, ...rest } = next;
  next.plan_hash = planHash(rest as Omit<WorkspacePlan, 'plan_hash'>);
  return next;
}

/** Compile + overrides. Throws PlanCompileError (unknown pack, bad params, bad answers). */
export function buildPlan(inputs: PlanInputs): CompiledPlan {
  const pack = getPack(inputs.packKey);
  if (!pack) throw new PlanCompileError(`Unknown industry pack "${inputs.packKey}"`);
  const addons = [...new Set(inputs.addons ?? [])].filter((a) => a !== inputs.packKey);
  for (const a of addons) if (!getPack(a)) throw new PlanCompileError(`Unknown add-on pack "${a}"`);
  const params = inputs.params && Object.keys(inputs.params).length > 0 ? inputs.params : undefined;
  const plan = compilePlan({
    pack: inputs.packKey,
    addons,
    params,
    answers: inputs.answers ?? {},
    locationId: inputs.companyId,
    includeSample: true, // load_sample_job reads the installed plan's sample_job
  });
  return applyModuleOverrides(plan, cleanOverrides(inputs.moduleOverrides as Record<string, unknown> | undefined));
}

/** The payload for pm.apply_pack_plan: plan + ai_decision_id (additive key, optional). */
export function buildApplyPayload(plan: CompiledPlan, aiDecisionId: string | null | undefined): ApplyPayload {
  return aiDecisionId ? { ...plan, ai_decision_id: aiDecisionId } : { ...plan };
}

// ---------------------------------------------------------------------------- preview

function jobTypeDTOs(plan: WorkspacePlan): JobTypeDTO[] {
  return plan.job_types.map((j) => {
    const stages = plan.stages.filter((s) => s.machine_key === j.stage_machine_key).sort((a, b) => a.sort - b.sort);
    const success = stages.find((s) => s.is_terminal && s.core_status !== 'CANCELLED');
    const path = [...stages.filter((s) => !s.is_terminal && s.core_status !== 'ON_HOLD').map((s) => s.label), ...(success ? [success.label] : [])];
    const exits = stages.filter((s) => (s.is_terminal && s !== success) || s.core_status === 'ON_HOLD').map((s) => s.label);
    const others = j.billing_modes.filter((b) => b !== j.default_billing_mode).map((b) => BILLING_MODE_LABELS[b]);
    let billing = `Bills by ${BILLING_MODE_LABELS[j.default_billing_mode]}`;
    if (others.length) billing += `; can also bill by ${others.join(', ')}`;
    if (j.default_retainage_pct !== null) billing += `; ${Math.round(j.default_retainage_pct * 1000) / 10}% retainage`;
    return { key: j.key, label: j.label, archetype: j.archetype, stages: path, exits, billing };
  });
}

function moduleLabel(m: ModuleKey, v: Record<string, string>): string {
  switch (m) {
    case 'estimates': return t(v, 'estimates');
    case 'change_orders': return t(v, 'change_orders');
    case 'selections': return t(v, 'selections');
    case 'daily_logs': return t(v, 'daily_logs');
    default: return MODULE_LABELS[m];
  }
}

function prefillFor(classification: ClassifyResponse | null, packKey: string): Record<string, { value: AnswerValue; evidence: string }> {
  // prefilled answers were validated against the AI's top pack only
  if (!classification || classification.aiPackKey !== packKey) return {};
  return classification.prefilledAnswers ?? {};
}

function questionDTOs(manifest: PackManifest, ns: string, answers: Record<string, unknown>, prefill: Record<string, { value: AnswerValue; evidence: string }>): QuestionDTO[] {
  return manifest.questions.map((q) => {
    const key = `${ns}${q.key}`;
    const a = q.answer;
    const has = Object.prototype.hasOwnProperty.call(answers, key);
    const value = (has ? answers[key] : a.default) as AnswerValue;
    const pf = ns === '' ? prefill[q.key] : undefined;
    const suggested = pf && JSON.stringify(pf.value) === JSON.stringify(value) ? pf.evidence : null;
    return {
      key,
      packKey: manifest.key,
      prompt: q.prompt,
      help: q.help ?? null,
      type: a.type,
      options: a.type === 'choice' || a.type === 'multi' ? a.options.map((o) => ({ value: o.value, label: o.label })) : [],
      min: a.type === 'percent' ? a.min : null,
      max: a.type === 'percent' ? a.max : null,
      value,
      suggestedFrom: suggested,
    };
  });
}

/** Initial answers for a pack: verified AI prefill for the AI's top pack, defaults otherwise. */
export function initialAnswers(packKey: string, classification: ClassifyResponse | null): Record<string, AnswerValue> {
  const out: Record<string, AnswerValue> = {};
  for (const [k, v] of Object.entries(prefillFor(classification, packKey))) out[k] = v.value;
  return out;
}

/** Params to compile with: the AI's validated params only when the chosen pack is the one they were checked against. */
export function initialParams(packKey: string, classification: ClassifyResponse | null): Record<string, unknown> | undefined {
  if (classification && classification.paramsPackKey === packKey && Object.keys(classification.params).length > 0) return classification.params;
  return undefined;
}

function addonOptions(primary: string, addons: string[], classification: ClassifyResponse | null): PlanPreview['addonOptions'] {
  return listPacks()
    .filter((p) => p.key !== primary && p.key !== 'general')
    .map((p) => {
      const cand = classification?.candidates.find((c) => c.packKey === p.key && c.confidence >= 45);
      return { key: p.key, name: p.name, label: p.tile.label, suggested: Boolean(cand) || addons.includes(p.key), reason: cand?.reasons[0] ?? null };
    })
    .sort((a, b) => Number(b.suggested) - Number(a.suggested));
}

const DIFF_LABELS: Record<string, string> = {
  pack: 'Industry pack', params: 'Settings', vocabulary: 'Words', modules: 'Tools', job_types: 'Kinds of work',
  stages: 'Stages', transitions: 'Stage rules', approval_policies: 'Approvals', cost_codes: 'Cost codes', field_defs: 'Fields',
  price_book: 'Price book', kpis: 'Numbers we watch', books_proposal: 'Suggestions to Books',
};

export function summarizeDiff(prev: WorkspacePlan, next: WorkspacePlan): DiffSummary {
  const d = diffPlans(prev, next);
  const lines = Object.entries(d.sections)
    .map(([section, s]) => ({
      section: DIFF_LABELS[section] ?? section,
      added: s.added.slice(0, 12),
      removed: s.removed.slice(0, 12),
      changed: s.changed.map((c) => c.key).slice(0, 12),
    }))
    .filter((l) => l.added.length + l.removed.length + l.changed.length > 0);
  return { identical: d.identical, lines };
}

export function previewPlan(
  plan: CompiledPlan,
  inputs: PlanInputs,
  classification: ClassifyResponse | null,
  installed: WorkspacePlan | null,
): PlanPreview {
  const manifest = getPack(inputs.packKey)!;
  const v = plan.vocabulary;
  const answers = inputs.answers ?? {};
  const cards: CardDTO[] = describePlan(plan)
    .filter((c) => c.section !== 'sample_job')
    .map((c) => ({ section: c.section, title: c.title, summary: c.summary, items: c.items }));
  const vocab = cards.find((c) => c.section === 'vocabulary');
  const overrides = plan.module_overrides ?? {};
  const modules: ModuleDTO[] = MODULES.map((m) => ({ key: m, label: moduleLabel(m, v), on: plan.modules[m], overridden: m in overrides }));
  const questions = [
    ...questionDTOs(manifest, '', answers, prefillFor(classification, inputs.packKey)),
    ...(inputs.addons ?? []).flatMap((a) => {
      const m = getPack(a);
      return m ? questionDTOs(m, `${a}.`, answers, {}) : [];
    }),
  ];
  return {
    packKey: manifest.key,
    packName: manifest.name,
    version: manifest.version,
    planHash: plan.plan_hash,
    vocabularyHeadline: vocab?.summary ?? "We'll use the standard terms.",
    jobsWord: t(v, 'jobs'),
    cards,
    jobTypes: jobTypeDTOs(plan),
    costCodes: {
      count: plan.cost_codes.length,
      items: plan.cost_codes.map((c) => ({ code: c.code, name: c.name, costType: c.cost_type })),
    },
    modules,
    kpis: plan.kpis.map((k) => k.label),
    questions,
    addonOptions: addonOptions(inputs.packKey, inputs.addons ?? [], classification),
    diff: installed ? summarizeDiff(installed, plan) : null,
    sampleJob: plan.sample_job
      ? { name: plan.sample_job.name, customerName: plan.sample_job.customerName, contractCents: plan.sample_job.contractCents }
      : null,
  };
}
