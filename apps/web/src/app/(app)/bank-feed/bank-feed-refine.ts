/**
 * Bank-feed REVIEW refinement — pure, I/O-free helpers for the client-side
 * "refine the loaded view" affordances (confidence bands, vendor filter, and
 * selection tallies).
 *
 * These are deliberately view-only: they never post, categorize, or move money.
 * They narrow / tally the already-loaded, RLS-scoped rows so a reviewer can work
 * a slice (e.g. "just the low-confidence Home Depot lines") without changing what
 * the server returns. Everything here is deterministic and unit-tested.
 *
 * Band cutoffs follow the documented Bank Feed Matching rule (CLAUDE.md):
 *   >= 90% auto-categorize · 70–89% review · < 70% flagged · (null) uncoded.
 */

import type { BankFeedRow } from '@meritbooks/shared';

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'uncoded';
export type ConfidenceBandFilter = 'all' | ConfidenceBand;

export const BAND_HIGH_MIN = 0.9;
export const BAND_MEDIUM_MIN = 0.7;

/** Classify a 0..1 AI confidence (or null) into its review band. */
export function confidenceBandOf(value: number | null | undefined): ConfidenceBand {
  if (value == null || Number.isNaN(value)) return 'uncoded';
  if (value >= BAND_HIGH_MIN) return 'high';
  if (value >= BAND_MEDIUM_MIN) return 'medium';
  return 'low';
}

/** True when a row falls in the selected band filter ('all' matches everything). */
export function matchesBand(row: BankFeedRow, band: ConfidenceBandFilter): boolean {
  if (band === 'all') return true;
  return confidenceBandOf(row.ai_confidence) === band;
}

/** The display label a row is grouped under for the vendor filter/selection. */
export function vendorLabelOf(row: BankFeedRow): string | null {
  return row.ai_vendor?.display_name ?? row.ai_vendor?.name ?? null;
}

/** Distinct, sorted vendor labels present in the loaded rows (for the filter menu). */
export function distinctVendors(rows: BankFeedRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const label = vendorLabelOf(r);
    if (label) set.add(label);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export interface RefineFilter {
  band: ConfidenceBandFilter;
  /** null / '' = no vendor filter. */
  vendor: string | null;
}

/** Narrow the loaded rows by confidence band + vendor. Order is preserved. */
export function filterByRefine(rows: BankFeedRow[], filter: RefineFilter): BankFeedRow[] {
  const { band, vendor } = filter;
  if (band === 'all' && !vendor) return rows;
  return rows.filter((r) => {
    if (!matchesBand(r, band)) return false;
    if (vendor && vendorLabelOf(r) !== vendor) return false;
    return true;
  });
}

export interface SelectionTotals {
  count: number;
  /** Sum of the ABSOLUTE cents of the selected rows (magnitude moved, sign-agnostic). */
  totalCents: number;
}

/**
 * Count + absolute-dollar total of the currently-selected rows, restricted to the
 * rows actually visible (a selection made before a filter narrowed the list should
 * only tally what the reviewer can still see).
 */
export function selectionTotals(
  visibleRows: BankFeedRow[],
  selectedIds: ReadonlySet<string>,
): SelectionTotals {
  let count = 0;
  let totalCents = 0;
  for (const r of visibleRows) {
    if (selectedIds.has(r.id)) {
      count += 1;
      totalCents += Math.abs(Number(r.amount_cents) || 0);
    }
  }
  return { count, totalCents };
}

/** Ids of the visible rows in a given band (for select-all-by-band). */
export function idsInBand(visibleRows: BankFeedRow[], band: ConfidenceBand): string[] {
  return visibleRows.filter((r) => confidenceBandOf(r.ai_confidence) === band).map((r) => r.id);
}
