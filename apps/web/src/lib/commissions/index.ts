/**
 * Commissions engine (docs/FPB-commissions.md) — pure calculation, no I/O.
 * Loaders / routes / persistence come after the schema (see the FPB §16 proposal).
 */
export * from './types';
export { applyBps, prorate, allocateByWeights } from './money';
export { validatePlan, basisDate, evaluateSource, computeTieredAmount, type SourceEvaluation } from './evaluate';
export { reconcileSource, runCommissions, activePlansFor, lineKey, type PlanAssignment, type RunCommissionsInput } from './reconcile';
export {
  buildStatement,
  assertStatementTransition,
  statementsToEarnings,
  buildAccrualLines,
  buildPayoutReclassLines,
  isBalanced,
  STATEMENT_TRANSITIONS,
  StatementTransitionError,
  type CommissionStatement,
  type NegativeBalancePolicy,
  type StatementStatus,
  type StatementForPayout,
  type CommissionGlAccounts,
  type GlLine,
} from './statement';
