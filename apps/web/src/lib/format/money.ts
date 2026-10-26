/**
 * Compact money (PURE): "$1.2M", "$840.0K", "−$120.0K", "$512". The sign always comes BEFORE
 * the currency symbol and is a true minus (U+2212) — never "$-120.0K". Integer cents in.
 *
 * (packages/shared `formatMoney(…, { compact: true })` still prints "$-120.0K" for negatives;
 * that shared helper is owned by the lead — see the Wave-3 fix report — and should delegate here.)
 */
const MINUS = '−';

export function formatCompactMoney(cents: number | null | undefined, opts: { empty?: string; decimals?: number } = {}): string {
  const { empty = '—', decimals = 1 } = opts;
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return empty;
  const dollars = Math.round(cents) / 100;
  const abs = Math.abs(dollars);
  const sign = dollars < 0 ? MINUS : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(decimals)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(decimals)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
