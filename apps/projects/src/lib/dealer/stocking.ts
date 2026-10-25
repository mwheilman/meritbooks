/**
 * Stock-level math for suggested parts orders (DLR-33). Mirrors pm._d5_stocking in migration 1125
 * exactly (a parity test replays both):
 *
 *   season  = clamp(season index, 0.25, 4)
 *   rate    = avg monthly demand × season / 30 (per day)
 *   safety  = z × σ(monthly) × √((lead + review) / 30)
 *   min     = ceil(rate × lead + safety)
 *   max     = max(ceil(rate × (lead + review) + safety), min)
 *   order   = max(max − on hand − on order, 0)
 *
 * Demand is counter + RO issues plus logged lost sales, so a part the store keeps running out of
 * still earns a stocking level.
 */

export interface StockingInput {
  avgMonthly: number;
  sdMonthly: number;
  season: number;
  leadDays: number;
  reviewDays: number;
  z: number;
  onHand: number;
  onOrder: number;
}

export interface StockingResult {
  min: number;
  max: number;
  order: number;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function stocking(i: StockingInput): StockingResult {
  const s = Math.min(Math.max(Number.isFinite(i.season) ? i.season : 1, 0.25), 4);
  const rate = (i.avgMonthly || 0) * s / 30;
  const safety = (i.z || 0) * (i.sdMonthly || 0) * Math.sqrt(Math.max((i.leadDays || 0) + (i.reviewDays || 0), 0) / 30);
  const min = Math.ceil(r6(rate * (i.leadDays || 0) + safety));
  const max = Math.max(Math.ceil(r6(rate * ((i.leadDays || 0) + (i.reviewDays || 0)) + safety)), min);
  return { min, max, order: Math.max(max - (i.onHand || 0) - (i.onOrder || 0), 0) };
}

/** Seasonal index: demand in the coverage months last year vs the 12-month average (1 with no history). */
export function seasonIndex(monthly: readonly number[], coverageMonths: number, startOffset = 1): number {
  const avg = monthly.reduce((a, b) => a + b, 0) / Math.max(monthly.length, 1);
  if (avg === 0) return 1;
  const window = monthly.slice(startOffset, startOffset + coverageMonths).reduce((a, b) => a + b, 0);
  return window / (avg * coverageMonths);
}

export function stdDev(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}
