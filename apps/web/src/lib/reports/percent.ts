/**
 * Percent-of-base for report columns (% of revenue, margins, variance %) — PURE.
 *
 * A zero base has no meaningful percentage: the old `Math.abs(revenue) || 1`
 * guard divided by ONE CENT and printed 5,000,000% / 120000% on a P&L with no
 * revenue (audit L8). Every report % now goes through here and renders "—" when
 * the base is 0 (or not finite).
 */

export const NO_PCT = '—';

/** part ÷ |base| × 100, rounded to `decimals`; null when the base is 0. */
export function pctOfBase(part: number, base: number, decimals = 1): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(base) || base === 0) return null;
  const f = 10 ** decimals;
  return Math.round((part / Math.abs(base)) * 100 * f) / f;
}

/** Display form: "12.5%", or "—" when undefined. `absolute` drops the sign. */
export function formatPctOfBase(
  part: number,
  base: number,
  opts: { decimals?: number; absolute?: boolean; signed?: boolean } = {},
): string {
  const p = pctOfBase(opts.absolute ? Math.abs(part) : part, base, opts.decimals ?? 1);
  if (p == null) return NO_PCT;
  const sign = opts.signed && p > 0 ? '+' : '';
  return `${sign}${p}%`;
}

/** Margin display for a summary that carries a precomputed pct: "—" when revenue is 0. */
export function formatMarginPct(marginPct: number | null | undefined, revenueCents: number): string {
  if (revenueCents === 0 || marginPct == null || !Number.isFinite(marginPct)) return NO_PCT;
  return `${marginPct}%`;
}
