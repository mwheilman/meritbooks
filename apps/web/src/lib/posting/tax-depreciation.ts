/**
 * Tax-depreciation engine (parallel, NOT posted to the financial GL).
 *
 * The financial GL carries BOOK depreciation. This computes TAX depreciation for
 * the tax return (MACRS / §179 / bonus / SL) and the book-vs-tax timing difference
 * (deferred tax). It writes only to tax_depreciation_runs and
 * fixed_assets.tax_accumulated_depreciation_cents — it NEVER posts a journal entry.
 *
 * Two layers:
 *   1. A PURE, I/O-free MACRS engine (`computeTaxDepreciationSchedule`,
 *      `macrsAnnualPercentages`) — deterministic, integer-cents, exhaustively unit-
 *      testable against the published IRS GDS tables. It knows nothing about the DB.
 *   2. A thin DB runner (`runTaxDepreciation`) that resolves the per-year §179 dollar
 *      cap / phase-out from `tax_year_params`, calls the pure engine, and logs the due
 *      annual tax depreciation into `tax_depreciation_runs` (idempotent per asset/year).
 *
 * MACRS mechanics (GDS):
 *   - 3/5/7/10-year property → 200% declining balance with a straight-line switch.
 *   - 15/20-year property    → 150% declining balance with a straight-line switch.
 *   - Half-year convention   → the published IRS percentage tables (exact).
 *   - Mid-quarter convention → computed from the DB-with-SL-switch algorithm using the
 *                              placed-in-service quarter's mid-point fraction.
 *   - §179 immediate expensing + bonus depreciation reduce the MACRS basis; the caller
 *     supplies the elected amounts (IRS annual caps/phase-outs are NOT hardcoded — they
 *     change yearly and are resolved per tax year at the run layer).
 *
 * MID_MONTH (real property) is reported as unsupported rather than approximated.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { PostingError } from './account-roles';

type DB = SupabaseClient;

// IRS MACRS half-year percentage tables (annual %, year 1..N+1). These are the
// published Rev. Proc. figures (including the well-known alternating-rounding cents in
// the 7-year table), so a half-year schedule ties to a real return exactly.
export const MACRS_HALF_YEAR: Record<number, number[]> = {
  3: [33.33, 44.45, 14.81, 7.41],
  5: [20.0, 32.0, 19.2, 11.52, 11.52, 5.76],
  7: [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
  10: [10.0, 18.0, 14.4, 11.52, 9.22, 7.37, 6.55, 6.55, 6.56, 6.55, 3.28],
  15: [5.0, 9.5, 8.55, 7.7, 6.93, 6.23, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.95],
  20: [3.75, 7.219, 6.677, 6.177, 5.713, 5.285, 4.888, 4.522, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 2.231],
};

export type TaxConvention = 'HALF_YEAR' | 'MID_QUARTER' | 'MID_MONTH';
export type TaxRegularMethod = 'MACRS' | 'SL';

/** The MACRS GDS classes that carry a published half-year table / DB factor. */
export const MACRS_CLASSES = [3, 5, 7, 10, 15, 20] as const;

/** GDS declining-balance factor for a recovery class: 200% for ≤10-yr, 150% for 15/20-yr. */
export function macrsDbFactor(recoveryYears: number): number {
  return recoveryYears <= 10 ? 2.0 : 1.5;
}

/**
 * Fraction of a full year of service in tax year 1 under the convention. Half-year =
 * 0.5; mid-quarter treats the asset as placed at the MID-POINT of its quarter, so a
 * Q1 asset gets 10.5/12, Q2 7.5/12, Q3 4.5/12, Q4 1.5/12.
 */
export function firstYearServiceFraction(convention: TaxConvention, quarter: number): number {
  if (convention === 'MID_QUARTER') {
    const midMonthsRemaining = [10.5, 7.5, 4.5, 1.5][Math.min(3, Math.max(0, quarter - 1))];
    return midMonthsRemaining / 12;
  }
  // HALF_YEAR (MID_MONTH is not a personal-property MACRS convention — treated as half-year
  // only as an internal fallback; the runner refuses MID_MONTH explicitly).
  return 0.5;
}

/**
 * MACRS annual depreciation percentages (as fractions of the depreciable basis, summing
 * to 1.0) for a recovery class + convention, computed with declining balance and the
 * textbook straight-line switch. For the HALF_YEAR convention this reproduces the
 * published IRS tables (5-year exactly; 7-year within the published ±0.01% rounding
 * artifact); it is the authority for MID_QUARTER, which the published tables don't inline.
 */
export function macrsAnnualPercentages(
  recoveryYears: number,
  convention: TaxConvention = 'HALF_YEAR',
  quarter = 1,
): number[] {
  const n = recoveryYears;
  if (!(n > 0)) throw new PostingError('recoveryYears must be positive');
  const factor = macrsDbFactor(n);
  const rate = factor / n;
  const firstFrac = firstYearServiceFraction(convention, quarter);

  const out: number[] = [];
  let remaining = 1; // fraction of basis left
  for (let y = 1; y <= n + 1; y++) {
    if (remaining <= 0) {
      out.push(0);
      continue;
    }
    // Recovery-life years elapsed at the START of this tax year (year 1 gets firstFrac).
    const elapsed = y === 1 ? 0 : firstFrac + (y - 2);
    const lifeRemaining = n - elapsed;
    if (lifeRemaining <= 0) {
      out.push(remaining);
      remaining = 0;
      continue;
    }
    // Fraction of a full year of service falling in THIS tax year.
    const portion = y === 1 ? firstFrac : Math.min(1, lifeRemaining);
    const db = remaining * rate * portion;
    const sl = (remaining / lifeRemaining) * portion; // straight-line over remaining life
    let dep = Math.max(db, sl);
    if (dep > remaining) dep = remaining;
    out.push(dep);
    remaining -= dep;
  }
  if (remaining > 1e-12 && out.length > 0) out[out.length - 1] += remaining;
  return out;
}

/** The MACRS percentage series used for a schedule: exact IRS table for half-year, else computed. */
export function macrsPercentSeries(recoveryYears: number, convention: TaxConvention, quarter: number): number[] {
  if (convention === 'HALF_YEAR' && MACRS_HALF_YEAR[recoveryYears]) {
    return MACRS_HALF_YEAR[recoveryYears].map((p) => p / 100);
  }
  return macrsAnnualPercentages(recoveryYears, convention, quarter);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure tax-depreciation schedule (integer cents)
// ─────────────────────────────────────────────────────────────────────────────

export interface TaxDepreciationInput {
  costCents: number;
  /** placed-in-service date (YYYY-MM-DD) — sets the first tax year and the quarter. */
  inServiceDate: string;
  method: TaxRegularMethod;
  /** MACRS GDS recovery class (3/5/7/10/15/20). Required for method 'MACRS'. */
  recoveryYears?: number | null;
  convention?: TaxConvention;
  /** SL tax life in months. Required for method 'SL'. */
  taxLifeMonths?: number | null;
  /** salvage honored by SL only; MACRS depreciates to zero. */
  salvageCents?: number;
  /** §179 immediate expensing elected on this asset (already dollar-capped by the caller). */
  section179Cents?: number;
  /** bonus depreciation % (0..100) on the post-§179 basis. */
  bonusPct?: number;
}

export interface TaxDepreciationYear {
  /** 1-based position within the asset's recovery period. */
  ordinal: number;
  /** calendar tax year (placed-in-service year + ordinal − 1). */
  year: number;
  section179Cents: number;
  bonusCents: number;
  regularCents: number;
  totalCents: number;
  accumulatedCents: number;
  remainingBasisCents: number;
}

export interface TaxDepreciationSchedule {
  costCents: number;
  section179Cents: number;
  bonusCents: number;
  /** cost − §179 − bonus: the basis the regular method (MACRS/SL) depreciates. */
  depreciableBasisCents: number;
  method: TaxRegularMethod;
  convention: TaxConvention;
  recoveryYears: number | null;
  quarter: number;
  years: TaxDepreciationYear[];
  /** total lifetime tax depreciation (== cost for MACRS; == cost − salvage for SL). */
  totalCents: number;
}

function yearOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCFullYear();
}

export function quarterOf(date: string): number {
  const m = new Date(`${date}T00:00:00Z`).getUTCMonth(); // 0-based
  return Math.floor(m / 3) + 1;
}

/** Allocate `baseCents` across `fractions` (Σ≈1) with cumulative rounding; the last slot absorbs the remainder. */
function allocateByFractions(baseCents: number, fractions: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < fractions.length; i++) {
    const isLast = i === fractions.length - 1;
    let amt = isLast ? baseCents - acc : Math.round(baseCents * fractions[i]);
    if (acc + amt > baseCents) amt = baseCents - acc;
    if (amt < 0) amt = 0;
    out.push(amt);
    acc += amt;
  }
  return out;
}

/** Straight-line (tax) percentage series with the half-year convention: 0.5, 1, …, 1, 0.5 over L years. */
function slHalfYearFractions(lifeYears: number): number[] {
  const L = Math.max(1, lifeYears);
  const fr: number[] = [0.5 / L];
  for (let i = 1; i < L; i++) fr.push(1 / L);
  fr.push(0.5 / L);
  return fr;
}

/**
 * Compute the full TAX depreciation schedule for a single asset, in integer cents.
 * Deterministic and I/O-free. §179 and bonus are year-1 special allowances that reduce
 * the MACRS/SL basis; the remaining basis is recovered by the regular method.
 */
export function computeTaxDepreciationSchedule(input: TaxDepreciationInput): TaxDepreciationSchedule {
  const cost = Math.max(0, Math.round(input.costCents));
  const convention: TaxConvention = input.convention ?? 'HALF_YEAR';
  const quarter = quarterOf(input.inServiceDate);
  const acqYear = yearOf(input.inServiceDate);

  const s179 = Math.max(0, Math.min(Math.round(input.section179Cents ?? 0), cost));
  const bonusPct = Math.max(0, Math.min(100, input.bonusPct ?? 0));
  const bonus = Math.round((bonusPct / 100) * (cost - s179));
  const special = s179 + bonus;
  const depreciableBasis = Math.max(0, cost - special);

  let regularCents: number[];
  let recoveryYears: number | null = null;

  if (input.method === 'MACRS') {
    const ry = input.recoveryYears ?? null;
    if (!ry || !MACRS_HALF_YEAR[ry]) {
      throw new PostingError(`unsupported MACRS recovery class: ${String(ry)} (expected one of ${MACRS_CLASSES.join('/')})`);
    }
    recoveryYears = ry;
    const fractions = macrsPercentSeries(ry, convention, quarter);
    regularCents = allocateByFractions(depreciableBasis, fractions);
  } else {
    // Straight-line tax method (ADS-style), half-year convention, salvage honored.
    if (!input.taxLifeMonths || input.taxLifeMonths <= 0) {
      throw new PostingError('SL tax method requires taxLifeMonths');
    }
    const salvage = Math.max(0, Math.round(input.salvageCents ?? 0));
    const slBase = Math.max(0, depreciableBasis - salvage);
    const lifeYears = Math.max(1, Math.ceil(input.taxLifeMonths / 12));
    regularCents = allocateByFractions(slBase, slHalfYearFractions(lifeYears));
  }

  const years: TaxDepreciationYear[] = [];
  let accumulated = 0;
  for (let i = 0; i < regularCents.length; i++) {
    const sp179 = i === 0 ? s179 : 0;
    const spBonus = i === 0 ? bonus : 0;
    const total = regularCents[i] + sp179 + spBonus;
    if (total === 0 && i > 0 && accumulated >= cost) break; // stop trailing zeros
    accumulated += total;
    years.push({
      ordinal: i + 1,
      year: acqYear + i,
      section179Cents: sp179,
      bonusCents: spBonus,
      regularCents: regularCents[i],
      totalCents: total,
      accumulatedCents: accumulated,
      remainingBasisCents: Math.max(0, cost - accumulated),
    });
  }

  return {
    costCents: cost,
    section179Cents: s179,
    bonusCents: bonus,
    depreciableBasisCents: depreciableBasis,
    method: input.method,
    convention,
    recoveryYears,
    quarter,
    years,
    totalCents: accumulated,
  };
}

/** Tax depreciation charged in a specific calendar year for an asset (0 if outside the schedule). */
export function taxDepreciationForYear(schedule: TaxDepreciationSchedule, taxYear: number): number {
  const row = schedule.years.find((y) => y.year === taxYear);
  return row ? row.totalCents : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB runner: resolve §179 caps, call the pure engine, log annual tax runs
// ─────────────────────────────────────────────────────────────────────────────

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
  bonus_pct: number | null; // null ⇒ use the tax-year default
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
 * Get the statutory params for a tax year. If the year is missing, carry forward the
 * most recent prior year's values as an UNCONFIRMED proposal (so the engine is never
 * silently without values), flagged for the annual review. Returns null only if no
 * params exist at all.
 */
export async function ensureTaxYearParams(db: DB, orgId: string, taxYear: number): Promise<TaxYearParams | null> {
  const { data: exact } = await db
    .from('tax_year_params')
    .select('section_179_max_cents, section_179_phaseout_threshold_cents, bonus_pct')
    .eq('org_id', orgId)
    .eq('tax_year', taxYear)
    .maybeSingle();
  if (exact) return exact as TaxYearParams;

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
  return {
    section_179_max_cents: p.section_179_max_cents,
    section_179_phaseout_threshold_cents: p.section_179_phaseout_threshold_cents,
    bonus_pct: p.bonus_pct,
  };
}

/** Map a stored tax_method to the pure engine's regular method (MACRS or SL). */
function regularMethodFor(taxMethod: string): TaxRegularMethod {
  // MACRS / SECTION_179 / BONUS all recover the post-special basis by MACRS; SL is SL.
  return taxMethod === 'SL' ? 'SL' : 'MACRS';
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

  // Pre-pass: resolve the EFFECTIVE §179 cap per placed-in-service year after the
  // dollar-for-dollar phase-out, and track cumulative §179 elected so the org total
  // never exceeds the year cap.
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

  const throughYear = yearOf(asOf);

  for (const a of assets) {
    result.assets_processed++;
    if (a.tax_method === 'NONE') {
      result.skipped.push({ asset_id: a.id, reason: 'tax_method NONE (tax = book)' });
      continue;
    }
    const convention = a.tax_convention as TaxConvention;
    if (convention === 'MID_MONTH') {
      result.skipped.push({ asset_id: a.id, reason: 'MID_MONTH (real property) not yet supported' });
      continue;
    }

    const cost = a.acquisition_cost_cents;
    const acqYearForCap = yearOf(a.acquisition_date);

    // §179: elect up to the asset's amount, capped by the remaining year cap.
    const capRemaining =
      (yearEffective179.get(acqYearForCap) ?? Number.MAX_SAFE_INTEGER) - (year179Used.get(acqYearForCap) ?? 0);
    const s179 = Math.max(0, Math.min(a.section_179_cents, cost, capRemaining));
    year179Used.set(acqYearForCap, (year179Used.get(acqYearForCap) ?? 0) + s179);

    // Bonus %: per-asset override (incl. 0 = elected out) wins; else the tax-year default.
    const params = yearParams.get(acqYearForCap) ?? null;
    const effBonusPct = a.bonus_pct != null ? a.bonus_pct : params?.bonus_pct ?? 0;

    let schedule: TaxDepreciationSchedule;
    try {
      schedule = computeTaxDepreciationSchedule({
        costCents: cost,
        inServiceDate: a.acquisition_date,
        method: regularMethodFor(a.tax_method),
        recoveryYears: a.tax_recovery_years,
        convention,
        taxLifeMonths: a.tax_life_months,
        salvageCents: a.salvage_value_cents,
        section179Cents: s179,
        bonusPct: effBonusPct,
      });
    } catch (e) {
      result.skipped.push({ asset_id: a.id, reason: e instanceof Error ? e.message : 'schedule error' });
      continue;
    }

    let accumulated = a.tax_accumulated_depreciation_cents;
    let lastDate = a.tax_last_depreciation_date;

    for (const yr of schedule.years) {
      if (yr.year > throughYear) break;
      if (yr.totalCents <= 0) continue;

      const { data: existing } = await db
        .from('tax_depreciation_runs')
        .select('id')
        .eq('fixed_asset_id', a.id)
        .eq('period_year', yr.year)
        .eq('period_month', 12)
        .maybeSingle();
      if (existing) continue;

      await db.from('tax_depreciation_runs').insert({
        org_id: orgId,
        fixed_asset_id: a.id,
        period_year: yr.year,
        period_month: 12,
        amount_cents: yr.totalCents,
        method: a.tax_method,
        memo: `Tax depreciation — ${a.name} ${yr.year}`,
      });

      accumulated += yr.totalCents;
      lastDate = `${yr.year}-12-31`;
      result.years_logged++;
    }

    await db
      .from('fixed_assets')
      .update({
        tax_accumulated_depreciation_cents: accumulated,
        tax_last_depreciation_date: lastDate,
        updated_at: new Date().toISOString(),
      })
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
  fixedAssetId: string,
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
