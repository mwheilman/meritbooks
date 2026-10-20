/**
 * Estimate line extension: qty × unit cost → cost (the budget), qty × unit price → amount
 * (the contract). Markup sets the unit price from the unit cost. Rounds like the
 * estimate-line trigger in 1102 (round(qty × unit), half away from zero). Pure.
 */
import { extendCents, markupOf, priceFromMarkup } from './aia';

export interface EstimateLineInput {
  /** Decimal string ("12.5"); null = a lump-sum line. */
  qty: string | null;
  unitCostCents: number | null;
  /** Wins over markup when given. */
  unitPriceCents: number | null;
  /** Fraction (0.2 = 20%) applied to the unit cost, or to the lump cost. */
  markupPct: number | null;
  /** Lump-sum lines only. */
  costCents: number | null;
  amountCents: number | null;
}

export interface EstimateLineValues {
  qty: string | null;
  unit_cost_cents: number | null;
  unit_price_cents: number | null;
  cost_cents: number | null;
  amount_cents: number;
  markup: number | null;
}

export function estimateLineValues(i: EstimateLineInput): EstimateLineValues {
  if (i.qty != null && i.qty !== '') {
    const unitPrice = i.unitPriceCents ?? (i.unitCostCents != null ? priceFromMarkup(i.unitCostCents, i.markupPct ?? 0) : null);
    const cost = i.unitCostCents != null ? extendCents(i.qty, i.unitCostCents) : null;
    const amount = unitPrice != null ? extendCents(i.qty, unitPrice) : i.amountCents ?? 0;
    return { qty: i.qty, unit_cost_cents: i.unitCostCents, unit_price_cents: unitPrice, cost_cents: cost, amount_cents: amount, markup: i.markupPct ?? markupOf(i.unitCostCents, unitPrice) };
  }
  const cost = i.costCents;
  const amount = i.amountCents ?? (cost != null ? priceFromMarkup(cost, i.markupPct ?? 0) : 0);
  return { qty: null, unit_cost_cents: null, unit_price_cents: null, cost_cents: cost, amount_cents: amount, markup: i.markupPct ?? markupOf(cost, amount) };
}
