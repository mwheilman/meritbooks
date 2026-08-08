import { clsx } from 'clsx';

/**
 * A small mono chip that surfaces a record's ISO currency code.
 *
 * Records store amounts in their own currency's minor unit; this chip makes that
 * currency explicit so a foreign record is never read as a home-currency one. When
 * the record's currency equals the tenant home currency it is drawn subdued (or, with
 * `onlyForeign`, omitted entirely to keep single-currency views quiet); a FOREIGN
 * currency is drawn in amber to draw the eye. Purely presentational.
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
      className={clsx(
        'inline-flex items-center rounded px-1 py-0.5 font-mono text-[10px] leading-none tracking-wide',
        foreign
          ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
          : 'bg-slate-700/40 text-slate-400',
        className,
      )}
    >
      {c}
    </span>
  );
}
