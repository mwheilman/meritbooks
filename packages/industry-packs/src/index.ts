/**
 * @meritbooks/industry-packs: the declarative industry-pack catalog for Merit Projects.
 *
 *   classify(input)            rules classifier (tile, NAICS, keywords, Books rev-rec method)
 *   buildConfiguratorTool()    forced tool for the Core gateway; validateAiProposal() checks its output
 *   mergeAiAndRules()          one candidate list
 *   compilePlan()              deterministic WorkspacePlan for pm.apply_pack_plan(plan jsonb)
 *   describePlan()/diffPlans() preview cards and upgrade diffs
 */
export * from './types';
export * from './vocab';
export * from './metrics';
export * from './constants';
export {
  CATALOG_KEYS, MERGE_POLICY, PackNotFoundError, getPack, getPackInput, isPackKey, latestVersions, listPacks,
  listVersions, mergeManifestInputs, resolveInput, resolveManifest, resolveManifestInput,
  type MergePolicy, type PackSummary,
} from './catalog';
export { assertValidManifest, validateManifest, type ValidationIssue, type ValidationResult } from './validate';
export {
  ABSTAIN_BELOW, AMBIGUITY_CEILING, AMBIGUITY_GAP, CONFIDENCE_SCALE, CONFIGURATOR_TOOL_NAME, MAX_CANDIDATES,
  UNVERIFIED_CONFIDENCE_CAP, buildConfiguratorTool, classify, mergeAiAndRules, scorePacks, validateAiProposal,
  type AiProposalResult, type AiRejection, type AnthropicToolDefinition,
} from './classify';
export {
  EXPERIENCE_POINTER_ROOT, PlanExperienceSchema, applyExperienceOverrides, applyPatch, compileExperience, experienceOf,
  homeFor, jobTabsFor, mobileActionsFor, multiJobViewFor, navFor, parsePointer, roleTitleFor, roleTitlesFor,
  scheduleViewFor,
  type ExperiencePart, type OverrideResult, type PackOverride,
} from './experience';
export {
  OVERRIDE_ROOTS, PlanCompileError, canonicalJson, compilePlan, describePlan, diffPlans, planHash,
  type CompileInput, type PlanDiff, type PreviewCard, type SectionDiff,
} from './compile';
export { formatCents } from './describe';
export { checkParams, defaultParams, paramsSchemaFor, type ParamCheck, type ParamValue } from './params';
export {
  AnswerError, applyEffects, defaultAnswer, includedJobTypes, isValidAnswer, resolveAnswers,
  type AnswerValue, type EffectResult, type ResolvedAnswers,
} from './effects';
export { tokenize } from './text';
export { PACK_MANIFESTS } from './packs';
