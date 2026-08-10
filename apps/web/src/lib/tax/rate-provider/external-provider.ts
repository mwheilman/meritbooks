/**
 * External sales-tax provider SCAFFOLD (Avalara / TaxJar) — implements the SAME
 * `TaxRateProvider` interface as the internal-table adapter so that going live with a
 * commercial rate/nexus engine is a CREDENTIAL swap, not a call-site rewrite.
 *
 * Until credentialed, `resolveRate` throws a clearly-worded "not configured" error.
 * The write path (`resolve-invoice-tax.ts`) calls providers inside a try/catch and
 * degrades on any throw, so an accidentally-selected-but-unconfigured external
 * provider NEVER breaks invoice creation — it just falls through to the internal table.
 *
 * TO IMPLEMENT (later, no schema change): construct with the tenant's API key +
 * base URL, POST the destination address + date + category to the provider's
 * "rate for address" endpoint, and map its response to `ResolvedTaxRate`
 * ({ ratePct, jurisdictionLabel, source }). Nothing else in the codebase changes.
 */

import type { ResolvedTaxRate, TaxAddress, TaxRateProvider } from './types';

export type ExternalTaxVendor = 'AVALARA' | 'TAXJAR';

export interface ExternalTaxConfig {
  vendor: ExternalTaxVendor;
  apiKey?: string;
  baseUrl?: string;
}

export class ExternalTaxProvider implements TaxRateProvider {
  readonly name: string;

  constructor(private readonly config: ExternalTaxConfig) {
    this.name = config.vendor;
  }

  /** True once credentials are present and this adapter could actually resolve. */
  isConfigured(): boolean {
    return !!this.config.apiKey;
  }

  async resolveRate(
    _address: TaxAddress,
    _onDate: string,
    _category?: string | null,
  ): Promise<ResolvedTaxRate | null> {
    // Deliberate throw (not a null "miss"): signals mis-selection so the caller can
    // degrade to the internal table. Replace this body with the real API call once
    // `this.config.apiKey` / `baseUrl` are wired.
    throw new Error(
      `Sales-tax provider "${this.config.vendor}" is not configured. ` +
        'Set the provider credentials (TAX_PROVIDER_API_KEY) to enable the live adapter; ' +
        'until then the internal rate table is authoritative.',
    );
  }
}
