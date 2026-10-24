/**
 * League tables: rank companies (or departments, jobs, people) by any metric.
 *
 * - Competition ranking ("1, 2, 2, 4"): ties share a rank.
 * - Direction aware: lower-is-better metrics rank ascending.
 * - Rows without a value are listed LAST, unranked, with their reason — never as 0.
 * - Money metrics get a share of the (optionally ownership-weighted) total.
 */

import { sum } from './numbers';

export type RankDirection = 'higher_better' | 'lower_better' | 'neutral';

export interface LeagueInput {
  id: string;
  label: string;
  value: number | null;
  /** Why value is null (e.g. "Not enough history"). */
  reason?: string;
  /** Ownership weight 0..1 for the weighted total (default 1). */
  weight?: number;
  /** "As of" month for stale-data flags. */
  asOf?: string;
}

export interface LeagueRow extends LeagueInput {
  rank: number | null;
  /** value × weight (null when value is null). */
  weightedValue: number | null;
  /** weightedValue ÷ Σ weightedValue (only when `share` requested and the total is positive). */
  share: number | null;
  stale: boolean;
}

export interface LeagueTable {
  rows: LeagueRow[];
  /** Σ weighted values of ranked rows. */
  weightedTotal: number;
  rankedCount: number;
}

export function leagueTable(
  inputs: LeagueInput[],
  opts: { direction?: RankDirection; share?: boolean; latestMonth?: string } = {},
): LeagueTable {
  const direction = opts.direction ?? 'higher_better';
  const ranked = inputs.filter((r) => r.value !== null);
  const unranked = inputs.filter((r) => r.value === null);
  const sorted = [...ranked].sort((a, b) => {
    const d = direction === 'lower_better' ? (a.value as number) - (b.value as number) : (b.value as number) - (a.value as number);
    return d !== 0 ? d : a.label.localeCompare(b.label);
  });
  const weightedTotal = sum(sorted.map((r) => (r.value as number) * (r.weight ?? 1)));
  const rows: LeagueRow[] = [];
  let lastValue: number | null = null;
  let lastRank = 0;
  sorted.forEach((r, i) => {
    const v = r.value as number;
    const rank = lastValue !== null && v === lastValue ? lastRank : i + 1;
    lastValue = v;
    lastRank = rank;
    const weightedValue = v * (r.weight ?? 1);
    rows.push({
      ...r,
      rank,
      weightedValue,
      share: opts.share && weightedTotal > 0 ? weightedValue / weightedTotal : null,
      stale: Boolean(opts.latestMonth && r.asOf && r.asOf < opts.latestMonth),
    });
  });
  for (const r of [...unranked].sort((a, b) => a.label.localeCompare(b.label))) {
    rows.push({ ...r, rank: null, weightedValue: null, share: null, stale: Boolean(opts.latestMonth && r.asOf && r.asOf < opts.latestMonth) });
  }
  return { rows, weightedTotal, rankedCount: sorted.length };
}
