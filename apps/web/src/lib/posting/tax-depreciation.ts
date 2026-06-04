/**
 * Tax-depreciation engine (parallel, NOT posted to the financial GL).
 *
 * The financial GL carries BOOK depreciation. This computes TAX depreciation for
 * the tax return and the book-vs-tax timing difference (deferred tax). It writes
 * only to tax_depreciation_runs and fixed_assets.tax_accumulated_depreciation_cents
 * — it never posts a journal entry.
 *
 * Tax depreciation is an ANNUAL concept, so one tax_depreciation_runs row is
 * logged per tax year (recorded at period_month = 12). Idempotent on
 * (asset, year). Mechanics:
 *
 *   year-1 special allowances (caller supplies the allowed amounts; IRS annual
 *     caps/phaseouts are NOT hardcoded — they change yearly):
 *       s179  = min(section_179_cents, cost)
 *       bonus = bonus_pct% of (cost − s179)
 *   regular method on the remaining basis (cost − s179 − bonus):
 *       MACRS  → published half-year percentage tables (3/5/7/10/15/20-yr)
 *       SL     → straight-line over tax_life_months (salvage honored)
 *   year-1 tax depreciation = special + regular-year-1; cumulative capped at cost.
 *
 * Half-year convention is fully computed. MID_QUARTER and MID_MONTH are reported
 * as unsupported rather than approximated (no silent wrong numbers).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { PostingError } from './account-roles';

type DB = SupabaseClient;

// IRS MACRS half-year percentage tables (annual %, year 1..N+1).
const MACRS_HALF_YEAR: Record<number, number[]> = {
  3: [33.33, 44.45, 14.81, 7.41],
  5: [20.0, 32.0, 19.2, 11.52, 11.52, 5.76],
  7: [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
  10: [10.0, 18.0, 14.4, 11.52, 9.22, 7.37, 6.55, 6.55, 6.56, 6.55, 3.28],
  15: [5.0, 9.5, 8.55, 7.7, 6.93, 6.23, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.95],
  20: [3.75, 7.219, 6.677, 6.177, 5.713, 5.285, 4.888, 4.522, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 2.231],
};

interface TaxAssetRow {
  id: string;
  name: string;
  acquisition_date: string;
  acquisition_cost_cents: number;
  salvage_value_cents: number;
  tax_method: string; // NONE | SL | MACRS | SECTION_179 | BONUS
  tax_recovery_years: number | null;
  tax_convention: string;
  tax_life_months: number | null;
  section_179_cents: number;
  bonus_pct: number | null;     // null ⇒ use the tax-year default
  tax_accumulated_depreciation_cents: number;
  tax_last_depreciation_date: string | null;
  status: string;
}

export interface TaxDepreciationRunResult {
  asOf: string;
  assets_processed: number;
  years_logged: number;
  skipped: { asset_id: string; reason: string }[];
}

interface TaxYearParams {
  section_179_max_cents: number;
  section_179_phaseout_threshold_cents: number;
  bonus_pct: number;
}

/**
 * Get the statutory params for a tax year. If the year is missing, carry forward
 * the most recent CONFIRMED year's values as an UNCONFIRMED proposal (so the
 * engine is never silently without values), and flag it for the annual review /
 * AI proposal + human confirmation. Returns null only if no params exist at all.
 */
export async function ensureTaxYearParams(db: DB, orgId: string, taxYear: number): Promise<TaxYearParams | null> {
  const { data: exact } = await db
    .from('tax_year_params')
    .select('section_179_max_cents, section_179_phaseout_threshold_cents, bonus_pct')
    .eq('org_id', orgId)
    .eq('tax_year', taxYear)
    .maybeSingle();
  if (exact) return exact as TaxYearParams;

  // Carry forward the latest confirmed (or any) prior year as an unconfirmed proposal.
  const { data: prior } = await db
    .from('tax_year_params')
    .select('section_179_max_cents, section_179_phaseout_threshold_cents, bonus_pct, tax_year')
    .eq('org_id', orgId)
    .lte('tax_year', taxYear)
    .order('tax_year', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!prior) return null;

  const p = prior as TaxYearParams & { tax_year: number };
  await db.from('tax_year_params').insert({
    org_id: orgId,
    tax_year: taxYear,
    section_179_max_cents: p.section_179_max_cents,
    section_179_phaseout_threshold_cents: p.section_179_phaseout_threshold_cents,
    bonus_pct: p.bonus_pct,
    source: `Carried forward from ${p.tax_year} — REVIEW: confirm against the IRS revenue procedure`,
    confirmed: false,
  });
  return { section_179_max_cents: p.section_179_max_cents, section_179_phaseout_threshold_cents: p.section_179_phaseout_threshold_cents, bonus_pct: p.bonus_pct };
}

function yearOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCFullYear();
}

/** Compute + log all due annual tax depreciation through the tax year of asOf. */
export async function runTaxDepreciation(db: DB, orgId: string, asOf: string): Promise<TaxDepreciationRunResult> {
  const { data, error } = await db
    .from('fixed_assets')
    .select('id, name, acquisition_date, acquisition_cost_cents, salvage_value_cents, tax_method, tax_recovery_years, tax_convention, tax_life_months, section_179_cents, bonus_pct, tax_accumulated_depreciation_cents, tax_last_depreciation_date, status')
    .eq('org_id', orgId)
    .in('status', ['ACTIVE', 'FULLY_DEPRECIATED']);
  if (error) throw new PostingError(error.message);

  const assets = (data ?? []) as TaxAssetRow[];
  const result: TaxDepreciationRunResult = { asOf, assets_processed: 0, years_logged: 0, skipped: [] };

  // Pre-pass: per placed-in-service year, resolve the statutory params and the
  // EFFECTIVE Section 179 cap after the dollar-for-dollar phase-out, using total
  // qualifying property placed in service that year. Track cumulative 179 elected
  // so the org total never exceeds the year cap.
  const eligible = assets.filter((a) => a.tax_method !== 'NONE');
  const yearParams = new Map<number, TaxYearParams | null>();
  const yearEffective179 = new Map<number, number>();
  const year179Used = new Map<number, number>();
  const qualifyingByYear = new Map<number, number>();
  for (const a of eligible) {
    const y = yearOf(a.acquisition_date);
    qualifyingByYear.set(y, (qualifyingByYear.get(y) ?? 0) + a.acquisition_cost_cents);
  }
  for (const [y, totalQualifying] of qualifyingByYear) {
    const params = await ensureTaxYearParams(db, orgId, y);
    yearParams.set(y, params);
    if (params) {
      const overage = Math.max(0, totalQualifying - params.section_179_phaseout_threshold_cents);
      yearEffective179.set(y, Math.max(0, params.section_179_max_cents - overage));
    } else {
      yearEffective179.set(y, Number.MAX_SAFE_INTEGER); // no params at all ⇒ don't cap
    }
  }

  for (const a of assets) {
    result.assets_processed++;
    if (a.tax_method === 'NONE') {
      result.skipped.push({ asset_id: a.id, reason: 'tax_method NONE (tax = book)' });
      continue;
    }
    if (a.tax_convention !== 'HALF_YEAR') {
      result.skipped.push({ asset_id: a.id, reason: `convention ${a.tax_convention} not yet supported (half-year only)` });
      continue;
    }

    const cost = a.acquisition_cost_cents;
    const acqYearForCap = yearOf(a.acquisition_date);
    const params = yearParams.get(acqYearForCap) ?? null;

    // Section 179: elect up to the asset's amount, capped by the remaining year cap.
    const capRemaining = (yearEffective179.get(acqYearForCap) ?? Number.MAX_SAFE_INTEGER) - (year179Used.get(acqYearForCap) ?? 0);
    const s179 = Math.max(0, Math.min(a.section_179_cents, cost, capRemaining));
    year179Used.set(acqYearForCap, (year179Used.get(acqYearForCap) ?? 0) + s179);

    // Bonus %: per-asset override (incl. 0 = elected out) wins; else the tax-year default.
    const effBonusPct = a.bonus_pct != null ? a.bonus_pct : (params?.bonus_pct ?? 0);
    const bonus = Math.round((effBonusPct / 100) * (cost - s179));
    const year1Special = s179 + bonus;
    const remainingBasis = cost - year1Special;

    const regularMethod = a.tax_method === 'MACRS' ? 'MACRS' : 'SL';
    let macrsTable: number[] | undefined;
    if (regularMethod === 'MACRS') {
      macrsTable = a.tax_recovery_years ? MACRS_HALF_YEAR[a.tax_recovery_years] : undefined;
      if (!macrsTable) {
        result.skipped.push({ asset_id: a.id, reason: `no MACRS table for recovery_years=${a.tax_recovery_years}` });
        continue;
      }
    }
    let slAnnual = 0;
    if (regularMethod === 'SL') {
      if (!a.tax_life_months || a.tax_life_months <= 0) {
        result.skipped.push({ asset_id: a.id, reason: 'SL tax requires tax_life_months' });
        continue;
      }
      const slBase = Math.max(0, remainingBasis - a.salvage_value_cents);
      slAnnual = Math.round(slBase / (a.tax_life_months / 12));
    }

    const acqYear = yearOf(a.acquisition_date);
    const throughYear = yearOf(asOf);
    let accumulated = a.tax_accumulated_depreciation_cents;
    let lastDate = a.tax_last_depreciation_date;

    for (let taxYear = acqYear; taxYear <= throughYear; taxYear++) {
      const yearIdx = taxYear - acqYear; // 0-based

      let regular = 0;
      if (regularMethod === 'MACRS' && macrsTable) {
        regular = Math.round(((macrsTable[yearIdx] ?? 0) / 100) * remainingBasis);
      } else {
        const slLifeYears = Math.ceil((a.tax_life_months ?? 0) / 12);
        regular = yearIdx < slLifeYears ? slAnnual : 0;
      }
      const special = yearIdx === 0 ? year1Special : 0;
      let yearAmount = special + regular;
      if (accumulated + yearAmount > cost) yearAmount = cost - accumulated; // cap at cost
      if (yearAmount <= 0) continue;

      const { data: existing } = await db
        .from('tax_depreciation_runs')
        .select('id')
        .eq('fixed_asset_id', a.id)
        .eq('period_year', taxYear)
        .eq('period_month', 12)
        .maybeSingle();
      if (existing) continue;

      await db.from('tax_depreciation_runs').insert({
        org_id: orgId,
        fixed_asset_id: a.id,
        period_year: taxYear,
        period_month: 12,
        amount_cents: yearAmount,
        method: a.tax_method,
        memo: `Tax depreciation — ${a.name} ${taxYear}`,
      });

      accumulated += yearAmount;
      lastDate = `${taxYear}-12-31`;
      result.years_logged++;
    }

    await db
      .from('fixed_assets')
      .update({ tax_accumulated_depreciation_cents: accumulated, tax_last_depreciation_date: lastDate, updated_at: new Date().toISOString() })
      .eq('id', a.id);
  }

  return result;
}

/**
 * Book-minus-tax accumulated-depreciation timing difference for an asset
 * (positive = book has depreciated more than tax → future taxable difference).
 */
export async function bookTaxDifference(
  db: DB,
  orgId: string,
  fixedAssetId: string
): Promise<{ book_accumulated_cents: number; tax_accumulated_cents: number; difference_cents: number } | null> {
  const { data } = await db
    .from('fixed_assets')
    .select('accumulated_depreciation_cents, tax_accumulated_depreciation_cents')
    .eq('org_id', orgId)
    .eq('id', fixedAssetId)
    .maybeSingle();
  if (!data) return null;
  const row = data as { accumulated_depreciation_cents: number; tax_accumulated_depreciation_cents: number };
  return {
    book_accumulated_cents: row.accumulated_depreciation_cents,
    tax_accumulated_cents: row.tax_accumulated_depreciation_cents,
    difference_cents: row.accumulated_depreciation_cents - row.tax_accumulated_depreciation_cents,
  };
}
