/**
 * Sales-tax CALCULATION — the deterministic, I/O-free rate model + math that turns
 * a taxable base into an accrued tax figure AT invoice creation.
 *
 * This is the "what tax do I charge THIS sale" companion to the EC-7 nexus tripwire
 * ("where should I be registered?") and the return-prep worksheet ("what did I
 * collect and does it tie?"). Those two are read-only/after-the-fact; this one runs
 * on the write path, so it must be pure, deterministic, and unit-tested — the DB
 * reads (loading the tenant's rate rows, the customer's ship-to) live in the
 * assembler (`resolve-invoice-tax.ts`), exactly the pure+I/O split the other two use.
 *
 * DESIGN INVARIANTS (canon):
 *   • Pure & deterministic: everything in THIS file is I/O-free and unit-tested.
 *   • All money is bigint cents. No floats for money. Rates are percentages
 *     (numeric, e.g. 7.0 = 7%), used only to DERIVE a cents figure.
 *   • Most-specific-wins, effective-dated jurisdiction resolution: a city/county row
 *     beats a bare state row; an expired or not-yet-effective row never applies.
 *   • DEGRADE-SAFE: no rate resolved → tax = 0 (the invoice behaves exactly as it did
 *     before this feature existed — no regression).
 *   • Jurisdiction resolution mirrors EC-7 / return-prep (ship-to → customer state),
 *     reusing `normalizeState` from the nexus control so the surfaces can't disagree.
 */

import { normalizeState } from '@/lib/controls/sales-tax-nexus';

export { normalizeState };

/** One effective-dated combined-rate row for a jurisdiction. Rates are percentages. */
export interface SalesTaxRate {
  id?: string;
  /** normalized 2-letter state code. */
  state: string;
  /** finer jurisdiction (nullable) — a non-null value must match the sale to apply. */
  county: string | null;
  city: string | null;
  /** display label, e.g. "Iowa — Des Moines (Polk)". */
  jurisdictionLabel: string;
  /** combined state+local rate as a percentage, e.g. 7.0 for 7%. */
  combinedRatePct: number;
  /** inclusive effective date 'YYYY-MM-DD'. */
  effectiveDate: string;
  /** inclusive end date 'YYYY-MM-DD' or null (open-ended). */
  endDate: string | null;
}

/** The sale's destination, used to pick the applicable rate row. */
export interface RateContext {
  /** normalized destination state (or null → cannot resolve → no tax). */
  state: string | null;
  county?: string | null;
  city?: string | null;
  /** sale date 'YYYY-MM-DD' — the effective-dating anchor. */
  onDate: string;
}

/** Case-insensitive, trimmed equality for jurisdiction labels. */
function eqCI(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').trim().toLowerCase();
  const y = (b ?? '').trim().toLowerCase();
  return x.length > 0 && x === y;
}

/** Is `rate` in effect on `onDate` (inclusive both ends)? Pure. */
export function isEffectiveOn(rate: Pick<SalesTaxRate, 'effectiveDate' | 'endDate'>, onDate: string): boolean {
  if (!onDate) return false;
  if (rate.effectiveDate && rate.effectiveDate > onDate) return false;
  if (rate.endDate && rate.endDate < onDate) return false;
  return true;
}

/**
 * Does this rate row apply to the sale destination? A row with a non-null city or
 * county only applies when that finer field MATCHES the sale; a null field is a
 * wildcard (state-wide). Pure.
 */
export function rateApplies(rate: SalesTaxRate, ctx: RateContext): boolean {
  if (!ctx.state) return false;
  if (normalizeState(rate.state) !== ctx.state) return false;
  if (rate.city != null && !eqCI(rate.city, ctx.city)) return false;
  if (rate.county != null && !eqCI(rate.county, ctx.county)) return false;
  return isEffectiveOn(rate, ctx.onDate);
}

/** Specificity: city (2) + county (1). A more specific matched row wins. Pure. */
export function specificity(rate: SalesTaxRate): number {
  return (rate.city != null ? 2 : 0) + (rate.county != null ? 1 : 0);
}

/**
 * Resolve the single applicable rate row for a sale, most-specific-wins and
 * effective-dated. Ties (same specificity) break to the LATEST effective date, then
 * the higher rate, then id — fully deterministic. Returns null when nothing applies
 * (→ the caller charges no tax; degrade-safe). Pure.
 */
export function resolveRate(rates: SalesTaxRate[], ctx: RateContext): SalesTaxRate | null {
  const applicable = rates.filter((r) => rateApplies(r, ctx));
  if (applicable.length === 0) return null;
  applicable.sort((a, b) => {
    const s = specificity(b) - specificity(a);
    if (s !== 0) return s;
    if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? 1 : -1; // latest first
    if (a.combinedRatePct !== b.combinedRatePct) return b.combinedRatePct - a.combinedRatePct;
    return (a.id ?? '').localeCompare(b.id ?? '');
  });
  return applicable[0];
}

/** Tax on a taxable base at a rate. Rounds once, non-negative, bigint cents. Pure. */
export function computeTaxCents(taxableCents: number, ratePct: number | null | undefined): number {
  const base = Math.max(0, Math.round(Number(taxableCents) || 0));
  const rate = Number(ratePct);
  if (!Number.isFinite(rate) || rate <= 0 || base === 0) return 0;
  return Math.max(0, Math.round((base * rate) / 100));
}

export interface InvoiceTaxResult {
  /** tax accrued for the invoice (single round on the taxable subtotal — authoritative). */
  taxCents: number;
  /** the taxable base the tax was computed on (0 when exempt). */
  taxableSubtotalCents: number;
  /** per-line tax (each rounded independently) — for display; may differ from taxCents
   *  by a penny across many lines. The invoice-level `taxCents` is what accrues. */
  perLineCents: number[];
  /** the rate applied (%), or 0 when exempt / no rate. */
  ratePct: number;
  /** true when tax was suppressed because the customer is tax-exempt. */
  exempt: boolean;
}

/**
 * Compute invoice + per-line tax from line amounts and a resolved rate. When `exempt`
 * (customer is resale/nonprofit/govt) or no rate is resolved, tax is 0 and the
 * invoice is unchanged from pre-feature behavior. Pure.
 */
export function computeInvoiceTax(args: {
  lineAmountsCents: number[];
  ratePct: number | null | undefined;
  exempt?: boolean;
}): InvoiceTaxResult {
  const lines = (args.lineAmountsCents ?? []).map((c) => Math.max(0, Math.round(Number(c) || 0)));
  const taxableSubtotalCents = lines.reduce((s, c) => s + c, 0);
  const rate = Number(args.ratePct);
  const usableRate = !args.exempt && Number.isFinite(rate) && rate > 0 ? rate : 0;

  if (usableRate === 0) {
    return {
      taxCents: 0,
      taxableSubtotalCents: args.exempt ? 0 : taxableSubtotalCents,
      perLineCents: lines.map(() => 0),
      ratePct: 0,
      exempt: !!args.exempt,
    };
  }

  return {
    taxCents: computeTaxCents(taxableSubtotalCents, usableRate),
    taxableSubtotalCents,
    perLineCents: lines.map((c) => computeTaxCents(c, usableRate)),
    ratePct: usableRate,
    exempt: false,
  };
}
