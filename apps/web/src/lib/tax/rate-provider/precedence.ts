/**
 * PURE, I/O-free most-specific-wins rate resolution for the internal rate table.
 *
 * This is the deterministic core the `InternalTableProvider` sits on: given a set of
 * rate records + a destination + a date (+ optional category), pick the single row
 * that applies, favouring specificity POSTAL > CITY > COUNTY > STATE (with a
 * category-specific row beating an equally-specific generic one). Effective-dated:
 * a not-yet-effective or expired row never applies. Ties break to the LATEST
 * effective date, then the higher rate, then id — fully deterministic.
 *
 * Everything here is unit-tested (`precedence.test.ts`); the Supabase read that feeds
 * it lives in `internal-table-provider.ts`, keeping the same pure+I/O split the rest
 * of the tax code uses. No floats-for-money here — rates are percentages that only
 * DERIVE a cents figure downstream.
 */

import { normalizeState } from '@/lib/controls/sales-tax-nexus';

/** One effective-dated rate row, already normalized off the DB shape. */
export interface TaxRateRecord {
  id?: string;
  /** ISO country; null is treated as a US wildcard. */
  country: string | null;
  /** normalized 2-letter state code. */
  state: string;
  county: string | null;
  city: string | null;
  postalCode: string | null;
  /** product/service tax class; null = applies to all categories. */
  category: string | null;
  jurisdictionLabel: string;
  /** combined rate as a percentage (7.0 = 7%). */
  ratePct: number;
  /** inclusive 'YYYY-MM-DD'. */
  effectiveDate: string;
  /** inclusive end 'YYYY-MM-DD' or null (open-ended). */
  endDate: string | null;
}

/** The destination + timing the resolution keys off. */
export interface MatchAddress {
  country?: string | null;
  state: string | null;
  county?: string | null;
  city?: string | null;
  postalCode?: string | null;
}

/** Case-insensitive, trimmed non-empty equality. */
function eqCI(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').trim().toLowerCase();
  const y = (b ?? '').trim().toLowerCase();
  return x.length > 0 && x === y;
}

/** Postal equality on the first 5 digits (US ZIP / ZIP+4 tolerant), trimmed. */
function eqPostal(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? '').trim().replace(/\s+/g, '').slice(0, 5).toLowerCase();
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && x === y;
}

/** Country equality; a null record country is a US wildcard, address defaults to US. */
function countryMatches(recordCountry: string | null, addrCountry: string | null | undefined): boolean {
  if (recordCountry == null) return true;
  const addr = (addrCountry ?? 'US').trim().toUpperCase();
  return recordCountry.trim().toUpperCase() === addr;
}

/** Is `record` in effect on `onDate` (inclusive both ends)? Pure. */
export function recordEffectiveOn(
  record: Pick<TaxRateRecord, 'effectiveDate' | 'endDate'>,
  onDate: string,
): boolean {
  if (!onDate) return false;
  if (record.effectiveDate && record.effectiveDate > onDate) return false;
  if (record.endDate && record.endDate < onDate) return false;
  return true;
}

/**
 * Does this record apply to the destination + date + category? A non-null finer field
 * (postal/city/county) only applies when it MATCHES the sale; a null field is a
 * state-wide wildcard. A non-null category only applies to that requested category.
 * Pure.
 */
export function recordApplies(
  record: TaxRateRecord,
  addr: MatchAddress,
  onDate: string,
  category?: string | null,
): boolean {
  if (!addr.state) return false;
  if (normalizeState(record.state) !== addr.state) return false;
  if (!countryMatches(record.country, addr.country)) return false;
  if (record.postalCode != null && !eqPostal(record.postalCode, addr.postalCode)) return false;
  if (record.city != null && !eqCI(record.city, addr.city)) return false;
  if (record.county != null && !eqCI(record.county, addr.county)) return false;
  // A category-specific row only applies when the sale's category matches it.
  if (record.category != null && !eqCI(record.category, category ?? null)) return false;
  return recordEffectiveOn(record, onDate);
}

/**
 * Specificity: postal (8) beats city (4) beats county (2); a category-specific row
 * (+1) breaks a tie against an equally-geographic generic row. Higher wins. Pure.
 */
export function recordSpecificity(record: TaxRateRecord): number {
  return (
    (record.postalCode != null ? 8 : 0) +
    (record.city != null ? 4 : 0) +
    (record.county != null ? 2 : 0) +
    (record.category != null ? 1 : 0)
  );
}

/**
 * Resolve the single applicable rate record, most-specific-wins and effective-dated.
 * Ties (same specificity) break to the LATEST effective date, then the higher rate,
 * then id. Returns null when nothing applies (→ caller charges no tax; degrade-safe).
 * Pure.
 */
export function resolveBestRate(
  records: TaxRateRecord[],
  addr: MatchAddress,
  onDate: string,
  category?: string | null,
): TaxRateRecord | null {
  const applicable = records.filter((r) => recordApplies(r, addr, onDate, category));
  if (applicable.length === 0) return null;
  applicable.sort((a, b) => {
    const s = recordSpecificity(b) - recordSpecificity(a);
    if (s !== 0) return s;
    if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? 1 : -1; // latest first
    if (a.ratePct !== b.ratePct) return b.ratePct - a.ratePct;
    return (a.id ?? '').localeCompare(b.id ?? '');
  });
  return applicable[0];
}
