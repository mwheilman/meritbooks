/**
 * Jobs / WIP onboarding import — barrel.
 *
 * The construction-critical capture: import open jobs (CSV column-map OR drop-and-parse
 * a WIP schedule / contracts PDF) → compute the opening WIP schedule off the existing
 * engine → create jobs and stage the opening WIP totals so they TIE to the GL
 * (Σ costs = WIP, Σ unbilled = 1180, Σ billings-in-excess = 2410).
 */

export type {
  ProposedJob,
  ProposedCostCode,
  JobCostType,
  WipProposal,
  OpeningWipTotals,
} from './types';

export {
  WIP_IMPORT_FIELDS,
  normalizeWipCsvRows,
  normalizeWipExtraction,
  normalizeWipJob,
  mapCostType,
  toFraction,
  effectiveContractCents,
} from './normalize';

export {
  computeOpeningWip,
  toWipJobInputs,
  wipImportBlockers,
  type OpeningWipResult,
} from './opening-wip';

export {
  parseWipDocument,
  WIP_EXTRACT_FEATURE,
  WIP_EXTRACT_MODEL,
  type ParseWipResult,
} from './parse-wip';

export {
  createOpeningJobs,
  attachWipSubledgerDetail,
  budgetBuckets,
  type CreateJobsResult,
} from './commit';
