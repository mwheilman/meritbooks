import { clsx } from 'clsx';
import { getTenantBrand } from '@/lib/brand/tenant-brand';

/**
 * Tenant monogram + wordmark. White-label safe: identity comes from
 * `getTenantBrand()` and every color from CSS variables (`--brand-navy`,
 * `--brand-accent`, …), so a tenant re-skins by changing the token layer only.
 *
 * The default mark is an ORIGINAL geometric "M": two square-cut stems joined by
 * a centred V, set in the accent on a navy tile, with a thin rule beneath — the
 * accountant's underline under a total. If the tenant supplies `logoSrc`, that
 * file replaces the generated monogram.
 */

interface BrandMonogramProps {
  /** Rendered size in px (square). */
  size?: number;
  /** Draw a 1px light keyline around the tile — use on navy backgrounds so the tile reads. */
  keyline?: boolean;
  className?: string;
  title?: string;
}

export function BrandMonogram({ size = 28, keyline = false, className, title }: BrandMonogramProps) {
  const brand = getTenantBrand();
  const label = title ?? brand.productName;

  if (brand.logoSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={brand.logoSrc} alt={label} width={size} height={size} className={clsx('shrink-0', className)} />
    );
  }

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={clsx('shrink-0', className)}
    >
      <rect
        x="0.5"
        y="0.5"
        width="99"
        height="99"
        rx="24"
        style={{ fill: 'rgb(var(--brand-navy))' }}
        stroke={keyline ? 'rgb(255 255 255 / 0.14)' : 'none'}
        strokeWidth={keyline ? 2 : 0}
      />
      {/* The M: stems + centred V, square-cut so it reads crisp at 16px. */}
      <path
        d="M27 70V31L50 55L73 31V70"
        fill="none"
        style={{ stroke: 'rgb(var(--brand-accent-bright))' }}
        strokeWidth="10"
        strokeLinecap="square"
        strokeLinejoin="miter"
        strokeMiterlimit="4"
      />
      {/* The underline — a single rule under the total. */}
      <rect x="22" y="79" width="56" height="4" rx="1" style={{ fill: 'rgb(var(--brand-accent))' }} />
    </svg>
  );
}

interface BrandLockupProps {
  /** `onDark` = white wordmark (navy shell); `onLight` = navy wordmark. */
  tone?: 'onDark' | 'onLight';
  /** Monogram size in px; the wordmark scales with it. */
  size?: number;
  className?: string;
}

export function BrandLockup({ tone = 'onLight', size = 28, className }: BrandLockupProps) {
  const brand = getTenantBrand();
  return (
    <span className={clsx('inline-flex items-center gap-2.5', className)}>
      <BrandMonogram size={size} keyline={tone === 'onDark'} title={brand.productName} />
      <span
        aria-hidden="true"
        className={clsx(
          'font-display font-bold leading-none tracking-[-0.01em]',
          tone === 'onDark' ? 'text-shell-fg' : 'text-ink-hi',
        )}
        style={{ fontSize: Math.round(size * 0.64) }}
      >
        {brand.productName}
      </span>
    </span>
  );
}
