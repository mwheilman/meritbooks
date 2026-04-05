/**
 * Money utilities.
 * All monetary values in the database are stored as cents (bigint).
 * These helpers convert between cents and display values.
 */

/**
 * Convert cents to a formatted dollar string.
 * formatMoney(150099) → "$1,500.99"
 * formatMoney(-150099) → "($1,500.99)"
 * formatMoney(0) → "$0.00"
 */
export function formatMoney(cents: number | bigint, options?: {
  showSign?: boolean;
  compact?: boolean;
  currency?: string;
}): string {
  const { showSign = false, compact = false, currency = 'USD' } = options ?? {};
  const value = Number(cents) / 100;

  if (compact && Math.abs(value) >= 1_000_000) {
    const m = value / 1_000_000;
    return `$${m.toFixed(1)}M`;
  }
  if (compact && Math.abs(value) >= 1_000) {
    const k = value / 1_000;
    return `$${k.toFixed(1)}K`;
  }

  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));

  if (value < 0) return `(${formatted})`;
  if (showSign && value > 0) return `+${formatted}`;
  return formatted;
}

/**
 * Convert a dollar amount to cents.
 * dollarsToCents(15.99) → 1599
 * dollarsToCents("1,500.99") → 150099
 */
export function dollarsToCents(dollars: number | string): number {
  const cleaned = typeof dollars === 'string'
    ? parseFloat(dollars.replace(/[,$\s]/g, ''))
    : dollars;
  return Math.round(cleaned * 100);
}

/**
 * Convert cents to dollars (number).
 * centsToDollars(150099) → 1500.99
 */
export function centsToDollars(cents: number | bigint): number {
  return Number(cents) / 100;
}

/**
 * Sum an array of cent values safely.
 */
export function sumCents(values: (number | bigint | null | undefined)[]): number {
  return values.reduce<number>((acc, v) => acc + (Number(v) || 0), 0);
}

/**
 * Calculate percentage, safe against division by zero.
 * pct(50, 200) → 25.00
 */
export function pct(numerator: number, denominator: number, decimals = 2): number {
  if (denominator === 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(decimals));
}
