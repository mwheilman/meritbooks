/**
 * Report engine — public entry (Wave 3A). See docs/report-engine-api.md.
 *
 * Pure core (safe anywhere): types, periods, layout, plan, build, format.
 * Server only: adapter (runReport / runDrill / runTieOut / loadBalances) — import it from
 * '@/lib/reports/engine/adapter' in route handlers and server modules.
 */
export * from './types';
export {
  resolvePeriod,
  priorPeriod,
  priorYear,
  buckets,
  fiscalYearStart,
  fiscalQuarterStart,
  monthStart,
  monthEnd,
  addMonths,
  addDays,
  rangeLabel,
  monthLabel,
  isMonthAligned,
  rangeKey,
} from './periods';
export { planReport, fyStartFor, type Plan, type PlannedColumn, type PlanContext, type FetchPlan } from './plan';
export { buildReport, fillDerived, tieViolations, basisLabel, cashFlowCategory } from './build';
export { validateLayout, parseFormula, evalFormula, standardPnl, ebitdaPnl, standardBalanceSheet, MAX_LAYOUT_ROWS, type LayoutIssue } from './layout';
export { formatAmount, formatPercent, formatPoints, scaleCents, ROUNDING_UNIT_LABEL } from './format';
export { Ledger, ALL_KINDS, PNL_KINDS, basisKey } from './aggregate';
export { applyGovernance, registerGovernance, type GovernanceContext, type GovernanceFn } from './governance-hook';
