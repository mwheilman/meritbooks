/**
 * Stock-valuation report engine (GATE 11c depth) — pure, deterministic, unit-tested.
 *
 * Turns the per-item on-hand rollups the valuation engine maintains
 * (`qty_on_hand`, `avg_cost_cents`, `total_value_cents`) into a stock-valuation
 * report: every item's on-hand value, grouped by location (the white-label
 * entity/company dimension — there is no separate "category" column in the
 * inventory schema, so location is the reporting grouping), with subtotals, a
 * valuation-method breakdown, and a percent-of-total for each line.
 *
 * The integer source of truth for an item's value is `total_value_cents` (the
 * valuation engine keeps it exact); `avg_cost_cents` is the derived display unit
 * cost. This module NEVER re-multiplies qty × unit cost to get value — it carries
 * `total_value_cents` straight through so the report reconciles to the ledger to
 * the cent. Quantities may be fractional; money is always bigint cents.
 *
 * No database or framework imports — the API route feeds it plain rows and the
 * tests exercise it directly.
 */

import type { ValuationMethod } from './valuation';

/** One item's persisted rollup, as the report consumes it. */
export interface ValuationItemInput {
  id: string;
  sku: string;
  name: string;
  uom: string;
  valuationMethod: ValuationMethod;
  qtyOnHand: number;
  avgCostCents: number;
  totalValueCents: number;
  locationId: string | null;
  isActive: boolean;
}

/** A single item line in the report. */
export interface ValuationReportLine {
  id: string;
  sku: string;
  name: string;
  uom: string;
  valuationMethod: ValuationMethod;
  qtyOnHand: number;
  avgCostCents: number;
  valueCents: number;
  /** Share of the report's total on-hand value, 0..1 (0 when total is 0). */
  pctOfTotal: number;
  isActive: boolean;
}

/** Items sharing a location, with a subtotal. */
export interface ValuationReportGroup {
  locationId: string | null;
  locationName: string;
  lines: ValuationReportLine[];
  itemCount: number;
  totalValueCents: number;
}

/** Value + item count carried under one valuation method. */
export interface MethodBreakdown {
  method: ValuationMethod;
  itemCount: number;
  totalValueCents: number;
}

export interface StockValuationReport {
  groups: ValuationReportGroup[];
  summary: {
    itemCount: number;
    /** Items carrying nonzero on-hand quantity. */
    itemsOnHand: number;
    totalValueCents: number;
    byMethod: MethodBreakdown[];
  };
}

export interface BuildReportOptions {
  /** id → display name for locations; a null / missing id renders as `unassignedLabel`. */
  locationNames?: Record<string, string>;
  /** Label for items with no location. Default "Unassigned". */
  unassignedLabel?: string;
  /** Drop items whose on-hand quantity AND value are both zero. Default true. */
  excludeZero?: boolean;
}

const QTY_EPSILON = 1e-9;

function hasOnHand(item: ValuationItemInput): boolean {
  return Math.abs(Number(item.qtyOnHand ?? 0)) > QTY_EPSILON || Number(item.totalValueCents ?? 0) !== 0;
}

/**
 * PURE. Build the stock-valuation report from item rollups. Items are grouped by
 * location and sorted (within a group) by descending value, then SKU; groups are
 * sorted by descending subtotal so the biggest holdings surface first.
 */
export function buildStockValuationReport(
  items: ValuationItemInput[],
  options: BuildReportOptions = {},
): StockValuationReport {
  const { locationNames = {}, unassignedLabel = 'Unassigned', excludeZero = true } = options;

  const included = excludeZero ? items.filter(hasOnHand) : items;

  const totalValueCents = included.reduce((s, i) => s + Number(i.totalValueCents ?? 0), 0);

  // Group by location.
  const groupMap = new Map<string, ValuationItemInput[]>();
  for (const item of included) {
    const key = item.locationId ?? '__unassigned__';
    (groupMap.get(key) ?? groupMap.set(key, []).get(key)!).push(item);
  }

  const groups: ValuationReportGroup[] = [];
  for (const [key, rows] of groupMap) {
    const locationId = key === '__unassigned__' ? null : key;
    const locationName = locationId ? locationNames[locationId] ?? 'Unknown location' : unassignedLabel;

    const lines: ValuationReportLine[] = rows
      .map((r) => {
        const valueCents = Number(r.totalValueCents ?? 0);
        return {
          id: r.id,
          sku: r.sku,
          name: r.name,
          uom: r.uom,
          valuationMethod: r.valuationMethod,
          qtyOnHand: Number(r.qtyOnHand ?? 0),
          avgCostCents: Number(r.avgCostCents ?? 0),
          valueCents,
          pctOfTotal: totalValueCents > 0 ? valueCents / totalValueCents : 0,
          isActive: r.isActive,
        };
      })
      .sort((a, b) => b.valueCents - a.valueCents || a.sku.localeCompare(b.sku));

    groups.push({
      locationId,
      locationName,
      lines,
      itemCount: lines.length,
      totalValueCents: lines.reduce((s, l) => s + l.valueCents, 0),
    });
  }

  groups.sort((a, b) => b.totalValueCents - a.totalValueCents || a.locationName.localeCompare(b.locationName));

  // Method breakdown.
  const methodMap = new Map<ValuationMethod, MethodBreakdown>();
  for (const item of included) {
    const m = item.valuationMethod;
    const entry = methodMap.get(m) ?? { method: m, itemCount: 0, totalValueCents: 0 };
    entry.itemCount += 1;
    entry.totalValueCents += Number(item.totalValueCents ?? 0);
    methodMap.set(m, entry);
  }

  return {
    groups,
    summary: {
      itemCount: included.length,
      itemsOnHand: included.filter((i) => Math.abs(Number(i.qtyOnHand ?? 0)) > QTY_EPSILON).length,
      totalValueCents,
      byMethod: Array.from(methodMap.values()).sort((a, b) => b.totalValueCents - a.totalValueCents),
    },
  };
}

/**
 * The stock ledger (subledger) valued at on-hand cost, reconciled against the GL
 * Inventory Asset control account balance. In this build a RECEIPT is valuation-only
 * (the bill books the asset), so a variance is an informational reconciling item —
 * NOT an error. `inSync` is an exact-cent tie.
 */
export interface GlTieOut {
  subledgerCents: number;
  glCents: number;
  varianceCents: number; // subledger − GL (positive: stock ledger carries more than the GL)
  inSync: boolean;
}

/** PURE. Reconcile the subledger on-hand value to the GL inventory-asset balance. */
export function computeGlTieOut(subledgerCents: number, glCents: number): GlTieOut {
  const s = Math.round(Number(subledgerCents ?? 0));
  const g = Math.round(Number(glCents ?? 0));
  const varianceCents = s - g;
  return { subledgerCents: s, glCents: g, varianceCents, inSync: varianceCents === 0 };
}
