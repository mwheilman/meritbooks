/**
 * Signature ledger-pattern table helpers.
 * (MeritBooks-Platform-Design-Criteria.md §3 "Tables — the ledger pattern".)
 *
 * Presentation only — these NEVER change a value. Money stays bigint cents and
 * `formatMoney()` already renders negatives in parentheses "(4,454.42)", so the
 * helpers below add only the visual treatment: JetBrains Mono column headers,
 * the --red-fig tint on negative figures, the emerald double-rule on a genuine
 * balanced/final total, and a single em-deep hairline on a subtotal.
 *
 * Pair with the CSS utilities in globals.css: `.mono-fig`, `.fig-neg`,
 * `.fig-pos`, `.ledger-total`.
 */

/**
 * Column-header treatment for the ledger pattern: JetBrains Mono + wide caps
 * tracking. Append to a header cell that already carries the 10px / uppercase /
 * --text-mid (`text-2xs uppercase text-slate-500`) classes and a hairline
 * underline on the row, e.g.:
 *   `className={clsx('px-4 py-2.5 text-left text-2xs uppercase text-slate-500', LEDGER_TH)}`
 */
export const LEDGER_TH = 'font-mono tracking-caps';

/**
 * Figure color for a monetary cell. Negatives get --red-fig (parentheses come
 * from formatMoney); everything else keeps the caller's chosen positive color.
 * Returning a SINGLE color class avoids two competing `text-*` utilities on one
 * cell (whose paint order would otherwise be undefined).
 */
export function figColor(
  cents: number | bigint | null | undefined,
  positive = 'text-slate-200',
): string {
  return Number(cents ?? 0) < 0 ? 'text-red-fig' : positive;
}

/**
 * The balanced grand-total / final-total row: the emerald double-rule mark (the
 * logo motif). Apply to each cell of a GENUINE balanced/final total only —
 * trial-balance total, statement net, balance-sheet total, aging total.
 */
export const LEDGER_TOTAL = 'ledger-total';

/** A subtotal row: a single 1px em-deep hairline above it. */
export const LEDGER_SUBTOTAL = 'border-t border-em-deep';
