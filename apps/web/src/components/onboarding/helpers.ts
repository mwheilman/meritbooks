/**
 * Pure helpers for the onboarding component kit.
 *
 * These are the small, load-bearing mappings the kit + the shell share. They are
 * isomorphic (no React, no I/O) so the shell, the section builders, and unit tests
 * all read the same source of truth for "how confident is this proposal" and "what
 * state is this Setup-Home card in".
 *
 * See docs/ONBOARDING-DESIGN-SPEC.md §5 (AI seam / confidence thresholds) and §3
 * (Setup Home board — Done / Detected / Add-later).
 */

/** The three confidence bands a `ProposalCard` renders (text + icon, never color alone). */
export type ConfidenceBand = 'high' | 'review' | 'needs-you';

/** The source that produced a proposal (mirrors the conversion `MappingSource`). */
export type ProposalSource = 'ai' | 'heuristic' | 'human' | 'unmapped';

/**
 * Map a raw proposal confidence (0..1) + its source onto a display band, using the
 * canon thresholds (design spec §5):
 *   • ≥ 0.90  → 'high'      (pre-filled / bulk-acceptable)
 *   • 0.60–0.89 → 'review'  (pre-filled but worth a look)
 *   • < 0.60 / null → 'needs-you' (never silently guessed)
 *
 * A `human`-sourced value is always 'high' (a person already decided); an `unmapped`
 * value is always 'needs-you'. Pure and total — safe on `null`/`NaN`.
 */
export function confidenceBand(
  confidence: number | null | undefined,
  source?: ProposalSource,
): ConfidenceBand {
  if (source === 'human') return 'high';
  if (source === 'unmapped') return 'needs-you';
  if (confidence == null || !Number.isFinite(confidence)) return 'needs-you';
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.6) return 'review';
  return 'needs-you';
}

/** The three states a Setup-Home board card can be in (design spec §3). */
export type BoardCardStatus = 'done' | 'detected' | 'add-later';

/**
 * Derive a board card's status from two signals:
 *   • `done`     — the domain is satisfied by real tenant state (imported / entered).
 *   • `detected` — an import surfaced the domain but it still needs a look.
 * Anything else is the neutral 'add-later' (never a red nag). Pure and total.
 */
export function deriveBoardCardStatus(input: { done?: boolean; detected?: boolean }): BoardCardStatus {
  if (input.done) return 'done';
  if (input.detected) return 'detected';
  return 'add-later';
}

/** Human-readable label for a confidence band (plain-language primary). */
export function confidenceLabel(band: ConfidenceBand): string {
  switch (band) {
    case 'high':
      return 'High confidence';
    case 'review':
      return 'Worth a look';
    case 'needs-you':
      return 'Needs you';
  }
}
