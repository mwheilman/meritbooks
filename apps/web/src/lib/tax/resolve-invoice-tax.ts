/**
 * Sales-tax RESOLUTION assembler (I/O — RLS-scoped).
 *
 * Loads the tenant's configured rate rows + the sale's destination (invoice ship-to
 * snapshot → customer city/state), hands them to the pure calc (`sales-tax-calc.ts`),
 * and returns the tax to accrue AT invoice creation. Everything here is best-effort
 * and NEVER throws: a missing rates table, an absent customer, or no configured rate
 * all degrade to `taxCents = 0` (the invoice behaves exactly as it did before this
 * feature — no regression). RLS enforces org isolation; reads never hand-filter org_id.
 *
 * The `public.sales_tax_rates` table + `invoices.tax_rate_pct/tax_jurisdiction`
 * columns are RESERVED-migration additions (reported to the lead). Until applied, the
 * `select` here fails and this returns "no rate" — safe by construction.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveRate,
  computeInvoiceTax,
  normalizeState,
  type SalesTaxRate,
  type RateContext,
} from './sales-tax-calc';
import { getTaxRateProvider, INTERNAL_SOURCE } from './rate-provider';

interface RateRow {
  id: string;
  state: string | null;
  county: string | null;
  city: string | null;
  jurisdiction_label: string | null;
  combined_rate_pct: number | string | null;
  effective_date: string | null;
  end_date: string | null;
  is_active: boolean | null;
}

/** Load the tenant's ACTIVE rate rows. Degrade-safe: any error → []. */
export async function loadActiveRates(supabase: SupabaseClient): Promise<SalesTaxRate[]> {
  try {
    const { data, error } = await supabase
      .from('sales_tax_rates')
      .select('id, state, county, city, jurisdiction_label, combined_rate_pct, effective_date, end_date, is_active')
      .eq('is_active', true)
      .limit(5000);
    if (error || !data) return [];
    return (data as RateRow[])
      .map((r): SalesTaxRate | null => {
        const state = normalizeState(r.state);
        if (!state || !r.effective_date) return null;
        return {
          id: r.id,
          state,
          county: r.county ?? null,
          city: r.city ?? null,
          jurisdictionLabel: r.jurisdiction_label ?? state,
          combinedRatePct: Number(r.combined_rate_pct) || 0,
          effectiveDate: r.effective_date,
          endDate: r.end_date ?? null,
        };
      })
      .filter((r): r is SalesTaxRate => r != null);
  } catch {
    return [];
  }
}

export interface ResolvedInvoiceTax {
  /** tax to accrue on the invoice (0 when exempt / no rate). */
  taxCents: number;
  /** the taxable base the tax was computed on. */
  taxableSubtotalCents: number;
  /** rate applied (%), 0 when none/exempt. */
  ratePct: number;
  /** display label for the resolved jurisdiction (null when unresolved). */
  jurisdictionLabel: string | null;
  /** normalized destination state, or null. */
  state: string | null;
  /** true when tax was suppressed because the customer is tax-exempt. */
  exempt: boolean;
  /** true when a configured rate actually resolved (vs degraded to 0). */
  rateResolved: boolean;
  /** provenance of the applied rate ('INTERNAL_TABLE' | 'AVALARA' | …), null when none. */
  source: string | null;
  perLineCents: number[];
}

const ZERO = (taxable: number): ResolvedInvoiceTax => ({
  taxCents: 0,
  taxableSubtotalCents: taxable,
  ratePct: 0,
  jurisdictionLabel: null,
  state: null,
  exempt: false,
  rateResolved: false,
  source: null,
  perLineCents: [],
});

function jsonState(snapshot: Record<string, unknown> | null | undefined): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return normalizeState(snapshot['state'] ?? snapshot['region'] ?? null);
}
function jsonStr(snapshot: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  for (const k of keys) {
    const v = snapshot[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
function jsonCity(snapshot: Record<string, unknown> | null | undefined): string | null {
  return jsonStr(snapshot, 'city');
}
function jsonCounty(snapshot: Record<string, unknown> | null | undefined): string | null {
  return jsonStr(snapshot, 'county');
}
function jsonPostal(snapshot: Record<string, unknown> | null | undefined): string | null {
  return jsonStr(snapshot, 'postal_code', 'postalCode', 'zip', 'zip_code');
}

/**
 * Resolve + compute the tax for a sale. Destination resolution mirrors EC-7 /
 * return-prep (ship_to → customer state/city). Never throws.
 */
export async function resolveInvoiceTax(
  supabase: SupabaseClient,
  args: {
    orgId: string;
    customerId: string | null;
    onDate: string;
    lineAmountsCents: number[];
    /** optional ship-to snapshot ({ state, city, county, postal_code }) — wins over customer HQ when present. */
    shipTo?: Record<string, unknown> | null;
    /** optional product/service tax category — selects a category-specific rate row when present. */
    category?: string | null;
  },
): Promise<ResolvedInvoiceTax> {
  const taxableSubtotal = (args.lineAmountsCents ?? []).reduce((s, c) => s + Math.max(0, Math.round(Number(c) || 0)), 0);
  try {
    // Customer taxability + HQ jurisdiction fallback.
    let exempt = false;
    let custState: string | null = null;
    let custCity: string | null = null;
    let custPostal: string | null = null;
    if (args.customerId) {
      try {
        const { data: cust } = await supabase
          .schema('core')
          .from('customers')
          .select('state, city, zip, tax_exempt')
          .eq('id', args.customerId)
          .maybeSingle();
        const c = cust as { state: string | null; city: string | null; zip: string | null; tax_exempt: boolean | null } | null;
        exempt = c?.tax_exempt === true;
        custState = normalizeState(c?.state ?? null);
        custCity = c?.city ?? null;
        custPostal = c?.zip ?? null;
      } catch {
        /* degrade: treat as no jurisdiction */
      }
    }

    if (exempt) {
      const t = computeInvoiceTax({ lineAmountsCents: args.lineAmountsCents, ratePct: 0, exempt: true });
      return { ...ZERO(0), exempt: true, perLineCents: t.perLineCents };
    }

    // Destination: explicit ship-to wins, else customer HQ. A ship-to snapshot is used
    // whole (state + finer fields) when it carries a state; otherwise customer HQ.
    const shipState = jsonState(args.shipTo);
    const useShip = shipState != null;
    const state = shipState ?? custState;
    const city = useShip ? jsonCity(args.shipTo) : custCity;
    const county = useShip ? jsonCounty(args.shipTo) : null;
    const postalCode = useShip ? jsonPostal(args.shipTo) : custPostal;
    if (!state) return ZERO(taxableSubtotal);

    // PROVIDER-FIRST: consult the provider-agnostic tax adapter (internal rate table by
    // default; Avalara/TaxJar behind the same interface once credentialed). If it
    // resolves a rate, that rate is authoritative and we record its source. The adapter
    // is called inside try/catch so an unconfigured external provider's throw degrades
    // to the fallback below rather than breaking invoice creation.
    let providerResolved: { ratePct: number; jurisdictionLabel: string; source: string } | null = null;
    try {
      const provider = getTaxRateProvider(supabase, args.orgId);
      providerResolved = await provider.resolveRate(
        { country: 'US', state, county, city, postalCode },
        args.onDate,
        args.category ?? null,
      );
    } catch {
      providerResolved = null; // e.g. external adapter not configured → fall back
    }

    if (providerResolved && providerResolved.ratePct > 0) {
      const t = computeInvoiceTax({ lineAmountsCents: args.lineAmountsCents, ratePct: providerResolved.ratePct });
      return {
        taxCents: t.taxCents,
        taxableSubtotalCents: t.taxableSubtotalCents,
        ratePct: t.ratePct,
        jurisdictionLabel: providerResolved.jurisdictionLabel,
        state,
        exempt: false,
        rateResolved: t.ratePct > 0,
        source: providerResolved.source,
        perLineCents: t.perLineCents,
      };
    }

    // FALLBACK: the ORIGINAL behavior (unchanged) — load the tenant's active rows and
    // resolve most-specific-wins via the pure calc. Guarantees no regression when the
    // provider returns no match (or an external adapter threw).
    const rates = await loadActiveRates(supabase);
    if (rates.length === 0) return ZERO(taxableSubtotal);

    const ctx: RateContext = { state, city, county, onDate: args.onDate };
    const resolved = resolveRate(rates, ctx);
    if (!resolved) return ZERO(taxableSubtotal);

    const t = computeInvoiceTax({ lineAmountsCents: args.lineAmountsCents, ratePct: resolved.combinedRatePct });
    return {
      taxCents: t.taxCents,
      taxableSubtotalCents: t.taxableSubtotalCents,
      ratePct: t.ratePct,
      jurisdictionLabel: resolved.jurisdictionLabel,
      state,
      exempt: false,
      rateResolved: t.taxCents >= 0 && t.ratePct > 0,
      source: INTERNAL_SOURCE,
      perLineCents: t.perLineCents,
    };
  } catch {
    return ZERO(taxableSubtotal);
  }
}
