/**
 * Column totals for the WIP schedule table (live check Wave 1, fix 1G-8: Est. GP total was
 * blank and Fade / gain showed 0). Every money column gets a total, computed from the rows
 * actually shown (so a filtered table adds up to what's on screen).
 *
 *  - Fade / gain totals only jobs that HAVE a prior month to compare with; when none do,
 *    the total is null ("—"), never a misleading 0.
 *  - % complete total = Σ earned ÷ Σ contract — the same basis every row's % reads on (earned is
 *    % complete × contract under every method), so the total is the contract-weighted average
 *    of the rows. (It was Σ cost ÷ Σ EAC, which read 0.0% beside a 66.7% job on a non-cost
 *    method — Wave 2 live check.) null when Σ contract is 0.
 * Integer cents throughout.
 */

export interface WipTotalsLine {
  contractCents: number;
  eacCents: number;
  costToDateCents: number;
  earnedCents: number;
  billedCents: number;
  retainageCents: number;
  underCents: number;
  overCents: number;
  lossProvisionCents: number;
  estGrossProfitCents: number;
  fadeGainCents: number | null;
}

export interface WipColumnTotals {
  jobs: number;
  contractCents: number;
  eacCents: number;
  costToDateCents: number;
  earnedCents: number;
  billedCents: number;
  retainageCents: number;
  underCents: number;
  overCents: number;
  lossProvisionCents: number;
  estGrossProfitCents: number;
  /** null when no shown job has a prior month to compare with. */
  fadeGainCents: number | null;
  /** Jobs that contributed to the fade / gain total. */
  fadeComparedJobs: number;
  /** Contract-weighted % complete = Σ earned ÷ Σ contract (0..1), null when Σ contract is 0. */
  pctComplete: number | null;
}

export function wipColumnTotals(lines: ReadonlyArray<WipTotalsLine>): WipColumnTotals {
  const t: WipColumnTotals = {
    jobs: lines.length,
    contractCents: 0, eacCents: 0, costToDateCents: 0, earnedCents: 0, billedCents: 0, retainageCents: 0,
    underCents: 0, overCents: 0, lossProvisionCents: 0, estGrossProfitCents: 0,
    fadeGainCents: null, fadeComparedJobs: 0, pctComplete: null,
  };
  for (const l of lines) {
    t.contractCents += l.contractCents;
    t.eacCents += l.eacCents;
    t.costToDateCents += l.costToDateCents;
    t.earnedCents += l.earnedCents;
    t.billedCents += l.billedCents;
    t.retainageCents += l.retainageCents;
    t.underCents += l.underCents;
    t.overCents += l.overCents;
    t.lossProvisionCents += l.lossProvisionCents;
    t.estGrossProfitCents += l.estGrossProfitCents;
    if (l.fadeGainCents != null) {
      t.fadeGainCents = (t.fadeGainCents ?? 0) + l.fadeGainCents;
      t.fadeComparedJobs += 1;
    }
  }
  t.pctComplete = t.contractCents > 0 ? Math.min(1, Math.max(0, t.earnedCents / t.contractCents)) : null;
  return t;
}
