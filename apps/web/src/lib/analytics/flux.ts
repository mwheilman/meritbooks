/**
 * Materiality-filtered flux list — the pure helper the 3E flux / close gate builds on.
 *
 * Given account (or line) amounts for the current and comparison periods, return the
 * lines whose change passes the materiality rule ($ and/or %, AND/OR), sorted by the
 * size of the change, each marked "explanation required". Favourable / unfavourable
 * follows the line's nature (income vs expense); balance-sheet lines are neutral.
 */

import { isMaterial, varianceVerdict, type LineNature, type MaterialityRule } from './variance';

export interface FluxInputRow {
  key: string;
  label: string;
  /** income / expense for P&L lines; 'balance' for balance-sheet lines (no verdict). */
  nature: LineNature | 'balance';
  currentCents: number;
  comparisonCents: number;
  /** Optional drill target (account id). */
  accountId?: string;
}

export interface FluxRow extends FluxInputRow {
  changeCents: number;
  /** change ÷ |comparison|; null when the comparison is 0 (new line). */
  changePct: number | null;
  material: boolean;
  requiresExplanation: boolean;
  verdict: 'favourable' | 'unfavourable' | 'on_budget' | 'neutral';
}

export interface FluxOptions extends MaterialityRule {
  /** Include immaterial lines too (flagged material=false). Default false. */
  includeImmaterial?: boolean;
  /** Cap the list (after sorting). */
  limit?: number;
}

export function fluxList(rows: FluxInputRow[], opts: FluxOptions = {}): { rows: FluxRow[]; materialCount: number; totalLines: number } {
  const all: FluxRow[] = rows.map((r) => {
    const changeCents = r.currentCents - r.comparisonCents;
    const material = isMaterial(changeCents, r.comparisonCents, opts);
    return {
      ...r,
      changeCents,
      changePct: r.comparisonCents === 0 ? null : changeCents / Math.abs(r.comparisonCents),
      material,
      requiresExplanation: material,
      verdict: r.nature === 'balance' ? 'neutral' : varianceVerdict(r.nature, changeCents),
    };
  });
  const kept = (opts.includeImmaterial ? all : all.filter((r) => r.material)).sort(
    (a, b) => Math.abs(b.changeCents) - Math.abs(a.changeCents) || a.label.localeCompare(b.label),
  );
  return {
    rows: opts.limit !== undefined ? kept.slice(0, opts.limit) : kept,
    materialCount: all.filter((r) => r.material).length,
    totalLines: all.length,
  };
}
