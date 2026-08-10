/**
 * Provider-agnostic sales-tax rate ADAPTER contract.
 *
 * The write path (calc-at-invoice) asks a `TaxRateProvider` "what combined rate
 * applies to THIS destination on THIS date (for THIS product/service category)?"
 * and gets back a single resolved rate — or null when nothing applies (degrade-safe:
 * the caller then charges no tax). The default implementation resolves against the
 * tenant's authoritative internal rate table (`public.sales_tax_rates`); an
 * Avalara/TaxJar implementation is a later CREDENTIAL swap behind this SAME interface
 * (no call-site changes), so the resolution seam never forks.
 *
 * Rates are PERCENTAGES (e.g. 7.0 = 7%); the invoice tax stays bigint cents and is
 * derived downstream. Nothing here touches GL posting.
 */

/** A sale destination used to pick the applicable jurisdiction rate. */
export interface TaxAddress {
  /** ISO country code; defaults to 'US' when omitted. */
  country?: string | null;
  /** normalized 2-letter state code, or null → cannot resolve → no tax. */
  state: string | null;
  county?: string | null;
  city?: string | null;
  /** ZIP / postal code (finest specificity when the table has a postal row). */
  postalCode?: string | null;
}

/** The single rate a provider resolved for a sale. */
export interface ResolvedTaxRate {
  /** combined state+local rate as a percentage, e.g. 7.0 for 7%. */
  ratePct: number;
  /** human display label for the resolved jurisdiction. */
  jurisdictionLabel: string;
  /** provenance of the rate: 'INTERNAL_TABLE' | 'AVALARA' | 'TAXJAR' | … */
  source: string;
}

/**
 * A pluggable sales-tax rate resolver. Implementations MUST be deterministic given
 * their backing data and MUST return null (never throw for a plain miss) when no rate
 * applies — an unconfigured EXTERNAL adapter is the one allowed exception and throws a
 * clearly-worded "not configured" error, which callers on the write path catch and
 * degrade from.
 */
export interface TaxRateProvider {
  /** stable identifier used as `ResolvedTaxRate.source`. */
  readonly name: string;
  /**
   * Resolve the applicable combined rate for `address` on `onDate` (inclusive), for an
   * optional product/service `category`. Returns null when nothing applies.
   */
  resolveRate(
    address: TaxAddress,
    onDate: string,
    category?: string | null,
  ): Promise<ResolvedTaxRate | null>;
}
