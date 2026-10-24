/**
 * Metric registry & evaluator (Wave 3B). Public surface for FP&A screens, packs,
 * role-home widgets and the AI narrative layer. See docs/FPB-reports-fpna.md §1.15a.
 *
 *   import { evaluateFromSource, createGlQuerySource, listMetrics } from '@/lib/metrics';
 */

export * from './types';
export { ACCOUNT_CLASSES, ACCOUNT_CLASS_KEYS, classifyAccounts, type AccountMeta, type AccountClassDef } from './classes';
export { OPERATIONAL_INPUTS, type OperationalInputDef } from './operational-inputs';
export { formatExpr, walk, metricRefs, classRefs, operationalRefs } from './expr';
export { METRICS, listMetrics, getMetric, metricName, formulaOf, metricsFor, UNIVERSAL_FINANCE_PACK, DEFAULT_DASHBOARD } from './registry';
export { evaluateMetric, evaluateMetrics, requiredRange, windowMonths, priorPeriodShift, toPresentation, benchmarkTone, comparisonLabel } from './evaluate';
export { describeChange, verdictFor, reasonMessage, REASON_TITLE, COMPARISON_LABEL } from './wording';
export { planLoad, evaluateFromSource, type MetricDataSource, type DataSourceRequest } from './data-source';
export { foldGl, foldBudgets, lookThroughOwnership, budgetMonth } from './fold';
export { createGlQuerySource, GL_QUERY_OPERATIONAL } from './adapters/gl-queries';
export { createPeriodBalanceSource, datasetFromFeed, type PeriodBalanceFeed } from './adapters/period-balances';
// Server code: `createMetricSource` from '@/lib/metrics/server-source' (engine store + GL fallback).
