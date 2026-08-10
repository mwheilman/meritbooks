/**
 * Internal-table `TaxRateProvider` — resolves a combined rate from the tenant's
 * authoritative `public.sales_tax_rates` table (the default, credential-free adapter).
 *
 * It loads the org's ACTIVE, effective-dated rows (RLS scopes the read to the tenant;
 * the extra `org_id` predicate is defense-in-depth) and hands them to the PURE
 * `resolveBestRate` core, which picks most-specific-wins POSTAL > CITY > COUNTY >
 * STATE. Degrade-safe: a missing table / query error / no match all return null so the
 * write path charges no tax and the invoice behaves exactly as before.
 *
 * `source` on a resolved rate is 'INTERNAL_TABLE'. Swapping to Avalara/TaxJar later is
 * a construction-time change in the factory (`index.ts`) behind the SAME interface.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeState } from '@/lib/controls/sales-tax-nexus';
import type { ResolvedTaxRate, TaxAddress, TaxRateProvider } from './types';
import { resolveBestRate, type TaxRateRecord } from './precedence';

/** Raw DB shape (migration 144 extended columns included). */
interface DbRateRow {
  id: string;
  country: string | null;
  state: string | null;
  county: string | null;
  city: string | null;
  postal_code: string | null;
  category: string | null;
  jurisdiction_label: string | null;
  combined_rate_pct: number | string | null;
  effective_date: string | null;
  end_date: string | null;
}

export const INTERNAL_SOURCE = 'INTERNAL_TABLE';

export class InternalTableProvider implements TaxRateProvider {
  readonly name = INTERNAL_SOURCE;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly orgId: string,
  ) {}

  /** Load the tenant's ACTIVE, well-formed rate records. Degrade-safe: any error → []. */
  private async loadRecords(): Promise<TaxRateRecord[]> {
    try {
      const { data, error } = await this.supabase
        .from('sales_tax_rates')
        .select(
          'id, country, state, county, city, postal_code, category, jurisdiction_label, combined_rate_pct, effective_date, end_date',
        )
        .eq('org_id', this.orgId)
        .eq('is_active', true)
        .limit(5000);
      if (error || !data) return [];
      return (data as DbRateRow[])
        .map((r): TaxRateRecord | null => {
          const state = normalizeState(r.state);
          if (!state || !r.effective_date) return null;
          return {
            id: r.id,
            country: r.country ?? null,
            state,
            county: r.county ?? null,
            city: r.city ?? null,
            postalCode: r.postal_code ?? null,
            category: r.category ?? null,
            jurisdictionLabel: r.jurisdiction_label ?? state,
            ratePct: Number(r.combined_rate_pct) || 0,
            effectiveDate: r.effective_date,
            endDate: r.end_date ?? null,
          };
        })
        .filter((r): r is TaxRateRecord => r != null);
    } catch {
      return [];
    }
  }

  async resolveRate(
    address: TaxAddress,
    onDate: string,
    category?: string | null,
  ): Promise<ResolvedTaxRate | null> {
    const state = normalizeState(address.state);
    if (!state) return null;

    const records = await this.loadRecords();
    if (records.length === 0) return null;

    const best = resolveBestRate(
      records,
      {
        country: address.country ?? null,
        state,
        county: address.county ?? null,
        city: address.city ?? null,
        postalCode: address.postalCode ?? null,
      },
      onDate,
      category ?? null,
    );
    if (!best || !(best.ratePct > 0)) return null;

    return {
      ratePct: best.ratePct,
      jurisdictionLabel: best.jurisdictionLabel,
      source: this.name,
    };
  }
}
