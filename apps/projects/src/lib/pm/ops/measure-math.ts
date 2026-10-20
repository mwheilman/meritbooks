/**
 * Flooring takeoff quantities, computed exactly as the generated column
 * pm.measure_areas.material_qty (1106) so the preview and the stored figure match:
 *
 *   SF   ceil(sqft × (1 + waste))
 *   SY   ceil(sqft × (1 + waste) ÷ 9)
 *   BOX  ceil(sqft × (1 + waste) ÷ coverage_sf_per_unit)
 *   LF   ceil(linear_ft × (1 + waste))
 *   EA   ceil(each_count × (1 + waste))
 *
 * and sqft = round(length × width, 2) when only dimensions are given (tg_measure_area).
 * Postgres numeric is exact; JS floats are not (100 × 1.1 = 110.00000000000001 would ceil to
 * 111), so everything is done in scaled integers with BigInt: sqft/linear/each have 2 decimals
 * (numeric(12,2)/(10,2)), waste 4 (numeric(5,4)), coverage 4 (numeric(10,4)).
 */
import type { MaterialUom } from './types';

const big = (x: number, scale: number): bigint => BigInt(Math.round(x * scale));

/** ceil(a ÷ b) for non-negative BigInts. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  return a <= 0n ? 0n : (a + b - 1n) / b;
}

/** round(length × width, 2) — half away from zero, as Postgres rounds numeric. */
export function sqftFromDims(lengthFt: number | null, widthFt: number | null): number | null {
  if (lengthFt == null || widthFt == null) return null;
  const p = big(lengthFt, 100) * big(widthFt, 100); // scale 1e4
  const r = (p + 50n) / 100n; // scale 1e2, half up (inputs are positive)
  return Number(r) / 100;
}

export interface AreaInput {
  material_uom: MaterialUom;
  sqft: number | null;
  linear_ft: number | null;
  each_count: number | null;
  waste_pct: number;
  coverage_sf_per_unit: number | null;
  length_ft?: number | null;
  width_ft?: number | null;
}

/** The material quantity the database will store for this area (null when BOX lacks coverage). */
export function materialQty(a: AreaInput): number | null {
  const sqft = a.sqft ?? sqftFromDims(a.length_ft ?? null, a.width_ft ?? null) ?? 0;
  const w = 10000n + big(a.waste_pct, 10000); // (1 + waste) at scale 1e4
  switch (a.material_uom) {
    case 'SF':
      return Number(ceilDiv(big(sqft, 100) * w, 1_000_000n));
    case 'SY':
      return Number(ceilDiv(big(sqft, 100) * w, 9_000_000n));
    case 'BOX': {
      if (!a.coverage_sf_per_unit || a.coverage_sf_per_unit <= 0) return null;
      // sqft(1e2) × w(1e4) = 1e6 ; ÷ (coverage(1e4) × 1e2) → unitless
      return Number(ceilDiv(big(sqft, 100) * w, big(a.coverage_sf_per_unit, 10000) * 100n));
    }
    case 'LF':
      return Number(ceilDiv(big(a.linear_ft ?? 0, 100) * w, 1_000_000n));
    case 'EA':
      return Number(ceilDiv(big(a.each_count ?? 0, 100) * w, 1_000_000n));
  }
}

export const UOM_WORDS: Readonly<Record<MaterialUom, string>> = { SF: 'sq ft', SY: 'sq yd', LF: 'lin ft', EA: 'each', BOX: 'boxes' };

/** "1,342 sq ft" — the takeoff quantity with its unit. */
export function qtyText(qty: number | null, uom: MaterialUom): string {
  if (qty == null) return '—';
  return `${qty.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${UOM_WORDS[uom]}`;
}
