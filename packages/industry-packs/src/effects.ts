/**
 * Question answers → deterministic effects. Shared by the compiler and the validator so "what an
 * answer does" has exactly one implementation.
 *
 * Effect semantics:
 *   toggle_module      bool answers only. module = answer ? whenTrue : !whenTrue.
 *   set_param          param = answer value (bool → bool, percent → number, choice → enum string).
 *   enable_job_types   bool: listed job types are on when true. multi: a listed job type is on when
 *                      its key is selected. choice: on when it is the chosen value. A job type named
 *                      by any enable_job_types effect is "governed": it is in the plan only if at
 *                      least one governing effect turns it on.
 *   set_default_billing choice answers whose values are billing modes. Applies to the named job type,
 *                      or (no job type) to every job type that allows the chosen mode.
 */
import type { BillingMode, ModuleKey, PackManifest } from './types';
import { BILLING_MODES } from './types';

type Question = PackManifest['questions'][number];
export type AnswerValue = boolean | number | string | string[];

export interface ResolvedAnswers {
  values: Record<string, AnswerValue>;
  /** question keys the caller answered (as opposed to defaults) */
  explicit: Set<string>;
}

export interface EffectResult {
  moduleToggles: Map<ModuleKey, boolean>;
  /** modules whose toggle came from an answer the caller gave (not a default) */
  explicitToggles: Set<ModuleKey>;
  paramSets: { param: string; value: boolean | number | string; explicit: boolean }[];
  /** governed job type → enabled */
  jobTypeGovernance: Map<string, boolean>;
  billingDefaults: Map<string, BillingMode>;
}

export function isValidAnswer(q: Question, value: unknown): value is AnswerValue {
  const a = q.answer;
  switch (a.type) {
    case 'bool':
      return typeof value === 'boolean';
    case 'choice':
      return typeof value === 'string' && a.options.some((o) => o.value === value);
    case 'multi':
      return (
        Array.isArray(value)
        && value.every((v) => typeof v === 'string' && a.options.some((o) => o.value === v))
        && new Set(value).size === value.length
      );
    case 'percent':
      return typeof value === 'number' && Number.isFinite(value) && value >= a.min && value <= a.max;
  }
}

export function defaultAnswer(q: Question): AnswerValue {
  const d = q.answer.default;
  return Array.isArray(d) ? [...d] : d;
}

export class AnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerError';
  }
}

/**
 * Fill defaults and check every provided answer. Unknown answer keys are ignored only when they
 * are namespaced for another pack ("pack_key.question_key"); otherwise they are an error, so a
 * typo never silently falls back to a default.
 */
export function resolveAnswers(
  manifest: PackManifest,
  provided: Record<string, unknown> | undefined,
  namespace?: string,
): ResolvedAnswers {
  const values: Record<string, AnswerValue> = {};
  const explicit = new Set<string>();
  const known = new Set(manifest.questions.map((q) => q.key));
  const prefix = namespace ? `${namespace}.` : '';
  for (const k of Object.keys(provided ?? {})) {
    if (namespace) {
      if (k.startsWith(prefix) && !known.has(k.slice(prefix.length))) {
        throw new AnswerError(`Unknown question "${k}" for pack ${manifest.key}`);
      }
    } else if (!k.includes('.') && !known.has(k)) {
      throw new AnswerError(`Unknown question "${k}" for pack ${manifest.key}`);
    }
  }
  for (const q of manifest.questions) {
    const key = `${prefix}${q.key}`;
    const has = provided !== undefined && Object.prototype.hasOwnProperty.call(provided, key);
    if (has) {
      const v = provided![key];
      if (!isValidAnswer(q, v)) {
        throw new AnswerError(`Invalid answer for "${key}": ${JSON.stringify(v)}`);
      }
      values[q.key] = Array.isArray(v) ? [...v] : v;
      explicit.add(q.key);
    } else {
      values[q.key] = defaultAnswer(q);
    }
  }
  return { values, explicit };
}

export function applyEffects(manifest: PackManifest, answers: ResolvedAnswers): EffectResult {
  const out: EffectResult = {
    moduleToggles: new Map(),
    explicitToggles: new Set(),
    paramSets: [],
    jobTypeGovernance: new Map(),
    billingDefaults: new Map(),
  };
  for (const q of manifest.questions) {
    const v = answers.values[q.key];
    const isExplicit = answers.explicit.has(q.key);
    for (const e of q.effects) {
      switch (e.kind) {
        case 'toggle_module': {
          if (typeof v !== 'boolean') break;
          out.moduleToggles.set(e.module, v ? e.whenTrue : !e.whenTrue);
          if (isExplicit) out.explicitToggles.add(e.module);
          else out.explicitToggles.delete(e.module);
          break;
        }
        case 'set_param': {
          if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
            out.paramSets.push({ param: e.param, value: v, explicit: isExplicit });
          }
          break;
        }
        case 'enable_job_types': {
          for (const jt of e.jobTypes) {
            let on: boolean;
            if (typeof v === 'boolean') on = v;
            else if (Array.isArray(v)) on = v.includes(jt);
            else if (typeof v === 'string') on = v === jt;
            else on = false;
            out.jobTypeGovernance.set(jt, (out.jobTypeGovernance.get(jt) ?? false) || on);
          }
          break;
        }
        case 'set_default_billing': {
          if (typeof v !== 'string' || !(BILLING_MODES as readonly string[]).includes(v)) break;
          const mode = v as BillingMode;
          const targets = e.jobType
            ? manifest.jobTypes.filter((j) => j.key === e.jobType)
            : manifest.jobTypes.filter((j) => j.billingModes.includes(mode));
          for (const j of targets) if (j.billingModes.includes(mode)) out.billingDefaults.set(j.key, mode);
          break;
        }
      }
    }
  }
  return out;
}

/** Job type keys in the plan for these answers, in manifest order. */
export function includedJobTypes(manifest: PackManifest, effects: EffectResult): string[] {
  return manifest.jobTypes
    .filter((j) => !effects.jobTypeGovernance.has(j.key) || effects.jobTypeGovernance.get(j.key) === true)
    .map((j) => j.key);
}
