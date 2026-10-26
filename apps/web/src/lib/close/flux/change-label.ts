/**
 * The flux "Change %" label (PURE, client-safe) — one rule for the review screen, its panel, the
 * CSV export and the close package:
 *   • nothing either month      → "no activity"  (0.00 vs 0.00 is not "new")
 *   • nothing in the comparison → "new"
 *   • otherwise                 → "+12.5%" (signed) / "12.5%" (unsigned)
 */
export function fluxChangeLabel(
  bps: number | null,
  currentCents: number,
  comparisonCents: number,
  opts: { signed?: boolean } = {},
): string {
  if (currentCents === 0 && comparisonCents === 0) return 'no activity';
  if (bps === null) return 'new';
  const signed = opts.signed ?? true;
  return `${signed && bps > 0 ? '+' : ''}${(bps / 100).toFixed(1)}%`;
}
