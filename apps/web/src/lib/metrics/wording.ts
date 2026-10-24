/**
 * Plain-English wording for metric cards: unavailable-state messages, change verdicts
 * ("improvement / erosion", "favourable / unfavourable") and comparison labels.
 * Deterministic — these sentences double as accessible text.
 */

import { growthRate, roundTo } from '@/lib/analytics/numbers';
import type { CannotComputeReason, ComparisonKind, MetricChange, MetricDirection, MetricUnit, Verdict } from './types';

export const REASON_TITLE: Record<CannotComputeReason, string> = {
  not_enough_history: 'Not enough history',
  not_on_file: 'Not on file',
  not_mapped: 'Not mapped',
  not_meaningful: 'Not meaningful',
  no_approved_budget: 'No approved budget',
  no_jobs: 'No jobs',
  zero_denominator: 'Zero denominator',
};

/** "Not mapped — no account is assigned to Accounts receivable (role AR_CONTROL)." */
export function reasonMessage(reason: CannotComputeReason, detail?: string): string {
  return detail ? `${REASON_TITLE[reason]} — ${detail}` : REASON_TITLE[reason];
}

export const COMPARISON_LABEL: Record<Exclude<ComparisonKind, 'none'>, string> = {
  prior_year: 'the same period last year',
  prior_period: 'the prior period',
  budget: 'the approved budget',
};

/** Verdict for a change given the metric's direction and the comparison kind. */
export function verdictFor(delta: number, direction: MetricDirection, comparison: Exclude<ComparisonKind, 'none'>): Verdict {
  if (delta === 0) return 'unchanged';
  if (direction === 'neutral') return delta > 0 ? 'higher' : 'lower';
  const good = direction === 'higher_better' ? delta > 0 : delta < 0;
  if (comparison === 'budget') return good ? 'favourable' : 'unfavourable';
  return good ? 'improvement' : 'erosion';
}

const VERDICT_WORD: Record<Verdict, string> = {
  improvement: 'Improvement',
  erosion: 'Erosion',
  favourable: 'Favourable',
  unfavourable: 'Unfavourable',
  higher: 'Higher',
  lower: 'Lower',
  unchanged: 'Unchanged',
};

/** Tolerance below which a presentation-unit change reads as "unchanged". */
function epsilonFor(unit: MetricUnit): number {
  switch (unit) {
    case 'money':
      return 0.5; // half a cent
    case 'percent':
    case 'points':
      return 0.005; // 0.005 pts
    default:
      return 1e-9;
  }
}

/**
 * Change between two presentation-unit values. Percent metrics move in POINTS (no %
 * change). Other units carry a % change, n/m when the base is ≤ 0 or the sign flips.
 */
export function describeChange(
  current: number,
  comparison: number,
  unit: MetricUnit,
  direction: MetricDirection,
  kind: Exclude<ComparisonKind, 'none'>,
): MetricChange {
  const rawDelta = current - comparison;
  const delta = Math.abs(rawDelta) < epsilonFor(unit) ? 0 : rawDelta;
  const inPoints = unit === 'percent' || unit === 'points';
  let pct: number | null = null;
  let pctNotMeaningful = false;
  if (!inPoints) {
    const g = growthRate(current, comparison);
    if (g.value === null) pctNotMeaningful = true;
    else pct = roundTo(g.value * 100, 1);
  }
  const verdict = verdictFor(delta, direction, kind);
  return {
    delta: unit === 'money' ? Math.round(delta) : roundTo(delta, 4),
    pct,
    pctNotMeaningful,
    inPoints,
    verdict,
    arrow: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    sentence: `${VERDICT_WORD[verdict]} vs ${COMPARISON_LABEL[kind]}`,
  };
}
