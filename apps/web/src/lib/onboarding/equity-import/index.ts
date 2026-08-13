/**
 * Equity / cap-table onboarding import — barrel.
 *
 * PURE modules (types, normalize) are safe anywhere; parse-equity + commit touch the
 * gateway / Supabase and are server-only.
 */

export * from './types';
export {
  OWNERSHIP_TOLERANCE_PCT,
  CAPITAL_RECONCILE_TOLERANCE_CENTS,
  normalizeOwner,
  normalizeEquityExtraction,
  csvRowsToOwners,
  ownershipSumCheck,
  reconcileOpeningCapital,
  capTableBlockers,
  deriveConsolidationMethod,
  mapEquityClass,
  mapEntityForm,
  type EquityColumnMap,
} from './normalize';
export {
  parseEquityDocument,
  EQUITY_EXTRACT_FEATURE,
  EQUITY_EXTRACT_MODEL,
  type ParseEquityResult,
} from './parse-equity';
export {
  commitCapTable,
  loadOpeningCapitalCents,
  type CommitCapTableInput,
  type CommitCapTableResult,
} from './commit';
