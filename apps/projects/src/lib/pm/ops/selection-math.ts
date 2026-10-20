/**
 * Selections, allowances and procurement pricing on integer cents. Pure (unit-tested);
 * mirrors 1106: variance = chosen − allowance (positive = over allowance, the client owes;
 * negative = a credit back to the client, shown in parentheses), option sell = round(cost ×
 * (1 + markup)) when no sell is given, amount = round(qty × sell), procurement cost total =
 * round(qty × cost) + freight, sell total = round(qty × sell).
 */
import { money, pct } from '@meritbooks/merit-ui';
import { pgRound } from './draw-math';

/** The allowance the database applies: the column, else the pack ext key `allowance_cents`. */
export function effectiveAllowance(column: number | null | undefined, ext: Record<string, unknown> | null | undefined): number | null {
  if (column != null) return column;
  const v = ext?.allowance_cents;
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

/** chosen − allowance; null when there is no allowance to compare. */
export function variance(chosenCents: number | null | undefined, allowanceCents: number | null | undefined): number | null {
  if (chosenCents == null || allowanceCents == null) return null;
  return chosenCents - allowanceCents;
}

/** Table cell: "1,250.00" over, "(400.00)" credit, "—" when no allowance. */
export function varianceCell(v: number | null | undefined): string {
  return v == null ? '—' : money(v);
}

/** One phrase: "1,250.00 over allowance" · "(400.00) credit to the client" · "At allowance". */
export function varianceText(v: number | null | undefined): string {
  if (v == null) return 'No allowance set';
  if (v > 0) return `${money(v)} over allowance`;
  if (v < 0) return `${money(v)} credit to the client`;
  return 'At allowance';
}

/** Tone for the variance word: over allowance is a client conversation, a credit is not. */
export function varianceTone(v: number | null | undefined): 'neg' | 'pos' | 'default' {
  if (v == null || v === 0) return 'default';
  return v > 0 ? 'neg' : 'pos';
}

/** tg_selection_option / tg_procurement_item: sell from cost × (1 + markup) when sell is blank. */
export function sellFromMarkup(unitCostCents: number | null, markupPct: number | null): number | null {
  if (unitCostCents == null || markupPct == null) return null;
  return pgRound(unitCostCents * (1 + markupPct));
}

/** The generated amount_cents: round(qty × unit price). */
export function lineAmount(qty: number, unitCents: number | null): number {
  return pgRound(qty * (unitCents ?? 0));
}

export interface ItemTotals {
  cost: number;
  sell: number;
  margin: number;
  marginPct: number | null;
}

/** pm.procurement_items generated totals + the v_procurement_status margin. */
export function itemTotals(qty: number, unitCostCents: number | null, unitSellCents: number | null, freightCents: number): ItemTotals {
  const cost = pgRound(qty * (unitCostCents ?? 0)) + freightCents;
  const sell = pgRound(qty * (unitSellCents ?? 0));
  const margin = sell - cost;
  return { cost, sell, margin, marginPct: sell > 0 ? margin / sell : null };
}

/** "32.0% markup" from a fraction (0.32). */
export function markupText(m: number | null | undefined): string {
  return m == null ? '—' : pct(m);
}

/** Range of option prices for a row: "1,200.00–2,450.00" or one figure. */
export function optionRange(low: number | null, high: number | null): string {
  if (low == null || high == null) return '—';
  return low === high ? money(low) : `${money(low)}–${money(high)}`;
}
