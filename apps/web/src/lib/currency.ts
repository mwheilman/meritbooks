/**
 * Multi-currency display helpers (GATE 11a — surface currency on records/reports).
 *
 * The DB carries a `currency` column (NOT NULL, home-currency default) on every
 * monetary-bearing table (migration 029), and the group reporting currency lives on
 * `core.organizations.home_currency`. Amounts are stored as bigint in the record
 * currency's MINOR unit — so a record's own amounts must be formatted in its own
 * currency, and we surface the ISO code so a foreign record is never mistaken for a
 * home-currency one. Single-currency tenants (everything 'USD') are unaffected.
 *
 * These are read-only presentation helpers — they NEVER change how money is stored.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const DEFAULT_HOME_CURRENCY = 'USD';

/**
 * The tenant's reporting (home) currency from core.organizations.home_currency.
 * Degrades safe to USD when the row/column is missing or unreadable, so a route
 * that surfaces currency never fails on the currency lookup alone.
 */
export async function getHomeCurrency(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string> {
  try {
    const { data } = await supabase
      .schema('core')
      .from('organizations')
      .select('home_currency')
      .eq('id', orgId)
      .limit(1);
    const home = (data?.[0] as { home_currency?: string } | undefined)?.home_currency;
    return (home && home.trim()) || DEFAULT_HOME_CURRENCY;
  } catch {
    return DEFAULT_HOME_CURRENCY;
  }
}

/** Normalize a possibly-null/blank currency code to a 3-letter upper code (USD default). */
export function normalizeCurrency(code: unknown): string {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : '';
  return c.length === 3 ? c : DEFAULT_HOME_CURRENCY;
}

/** True when a record's currency differs from the tenant's home currency. */
export function isForeignCurrency(code: unknown, homeCurrency: string): boolean {
  return normalizeCurrency(code) !== normalizeCurrency(homeCurrency);
}
