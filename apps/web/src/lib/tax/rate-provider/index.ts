/**
 * Tax rate provider FACTORY — the one place that decides which `TaxRateProvider`
 * backs calc-at-invoice for a tenant.
 *
 * Default: the credential-free `InternalTableProvider` (authoritative internal rate
 * table). If `TAX_PROVIDER` is set to a commercial vendor AND its API key is present,
 * an `ExternalTaxProvider` (Avalara/TaxJar) is returned behind the same interface —
 * the future go-live is purely this env/credential swap, no call-site changes. If a
 * vendor is named but NOT credentialed, we fall back to the internal table so nothing
 * breaks (the external scaffold would otherwise throw on use, which the write path
 * also tolerates).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TaxRateProvider } from './types';
import { InternalTableProvider } from './internal-table-provider';
import { ExternalTaxProvider, type ExternalTaxVendor } from './external-provider';

export type { TaxRateProvider, TaxAddress, ResolvedTaxRate } from './types';
export { InternalTableProvider, INTERNAL_SOURCE } from './internal-table-provider';
export { ExternalTaxProvider } from './external-provider';
export {
  resolveBestRate,
  recordApplies,
  recordSpecificity,
  recordEffectiveOn,
  type TaxRateRecord,
  type MatchAddress,
} from './precedence';

function selectedVendor(): ExternalTaxVendor | null {
  const raw = (process.env.TAX_PROVIDER ?? '').trim().toUpperCase();
  if (raw === 'AVALARA') return 'AVALARA';
  if (raw === 'TAXJAR') return 'TAXJAR';
  return null;
}

/**
 * Build the active rate provider for `orgId`. Internal-table by default; external
 * (Avalara/TaxJar) only when both selected via `TAX_PROVIDER` and credentialed —
 * otherwise the internal table, so resolution never hard-fails on a half-config.
 */
export function getTaxRateProvider(supabase: SupabaseClient, orgId: string): TaxRateProvider {
  const vendor = selectedVendor();
  if (vendor) {
    const apiKey = process.env.TAX_PROVIDER_API_KEY?.trim() || undefined;
    const baseUrl = process.env.TAX_PROVIDER_BASE_URL?.trim() || undefined;
    const external = new ExternalTaxProvider({ vendor, apiKey, baseUrl });
    if (external.isConfigured()) return external;
    // Named but not credentialed → stay on the authoritative internal table.
  }
  return new InternalTableProvider(supabase, orgId);
}
