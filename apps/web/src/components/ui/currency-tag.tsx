/**
 * A small tag that surfaces a record's ISO currency code (kit `.tag`).
 *
 * Records store amounts in their own currency's minor unit; this chip makes that
 * currency explicit so a foreign record is never read as a home-currency one. When
 * the record's currency equals the tenant home currency it is drawn quiet (or, with
 * `onlyForeign`, omitted entirely to keep single-currency views quiet); a FOREIGN
 * currency is drawn on the ochre wash to draw the eye. Purely presentational.
 */
export function CurrencyTag({
  code,
  homeCurrency = 'USD',
  onlyForeign = false,
  className,
}: {
  code: string | null | undefined;
  homeCurrency?: string;
  onlyForeign?: boolean;
  className?: string;
}) {
  const c = (code ?? '').trim().toUpperCase() || homeCurrency.toUpperCase();
  const foreign = c !== homeCurrency.toUpperCase();
  if (onlyForeign && !foreign) return null;
  return (
    <span
      title={foreign ? `Foreign currency — reported in ${homeCurrency}` : `Home currency (${c})`}
      className={['tag', foreign && 'tag--warn', 'tnum', className].filter(Boolean).join(' ')}
    >
      {c}
    </span>
  );
}
