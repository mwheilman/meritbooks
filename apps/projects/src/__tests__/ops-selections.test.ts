import { describe, expect, it } from 'vitest';
import {
  effectiveAllowance, itemTotals, lineAmount, optionRange, sellFromMarkup, variance, varianceCell, varianceText, varianceTone,
} from '@/lib/pm/ops/selection-math';
import { materialQty, qtyText, sqftFromDims, type AreaInput } from '@/lib/pm/ops/measure-math';

describe('selection variance (chosen − allowance)', () => {
  it('is positive over allowance and negative for a credit', () => {
    expect(variance(525_000, 400_000)).toBe(125_000);
    expect(variance(360_000, 400_000)).toBe(-40_000);
    expect(variance(400_000, null)).toBeNull();
    expect(variance(null, 400_000)).toBeNull();
  });
  it('shows credits in parentheses, never with a minus sign', () => {
    expect(varianceCell(125_000)).toBe('1,250.00');
    expect(varianceCell(-40_000)).toBe('(400.00)');
    expect(varianceCell(null)).toBe('—');
  });
  it('reads as one phrase', () => {
    expect(varianceText(125_000)).toBe('1,250.00 over allowance');
    expect(varianceText(-40_000)).toBe('(400.00) credit to the client');
    expect(varianceText(0)).toBe('At allowance');
    expect(varianceText(null)).toBe('No allowance set');
  });
  it('tones over as a client conversation and a credit as good news', () => {
    expect(varianceTone(1)).toBe('neg');
    expect(varianceTone(-1)).toBe('pos');
    expect(varianceTone(0)).toBe('default');
  });
  it('falls back to the pack ext allowance when the column is empty', () => {
    expect(effectiveAllowance(null, { allowance_cents: 250_000 })).toBe(250_000);
    expect(effectiveAllowance(100, { allowance_cents: 250_000 })).toBe(100);
    expect(effectiveAllowance(null, { allowance_cents: 'lots' })).toBeNull();
    expect(effectiveAllowance(undefined, null)).toBeNull();
  });
});

describe('option and item pricing (1106 triggers and generated columns)', () => {
  it('sell = round(cost × (1 + markup)), half away from zero', () => {
    expect(sellFromMarkup(10_000, 0.35)).toBe(13_500);
    expect(sellFromMarkup(333, 0.5)).toBe(500); // 499.5 → 500
    expect(sellFromMarkup(null, 0.3)).toBeNull();
    expect(sellFromMarkup(1_000, null)).toBeNull();
  });
  it('amount = round(qty × unit)', () => {
    expect(lineAmount(2.5, 1_999)).toBe(4_998); // 4,997.5 → 4,998
    expect(lineAmount(3, null)).toBe(0);
  });
  it('item cost adds freight; margin is on sell', () => {
    expect(itemTotals(4, 12_500, 18_000, 2_500)).toEqual({ cost: 52_500, sell: 72_000, margin: 19_500, marginPct: 19_500 / 72_000 });
    expect(itemTotals(1, 1_000, null, 0).marginPct).toBeNull();
  });
  it('states an option range or one figure', () => {
    expect(optionRange(120_000, 245_000)).toBe('1,200.00–2,450.00');
    expect(optionRange(120_000, 120_000)).toBe('1,200.00');
    expect(optionRange(null, 5)).toBe('—');
  });
});

describe('flooring measure quantity, parity with pm.measure_areas.material_qty', () => {
  const area = (p: Partial<AreaInput>): AreaInput => ({
    material_uom: 'SF', sqft: null, linear_ft: null, each_count: null, waste_pct: 0, coverage_sf_per_unit: null, ...p,
  });
  it('SF: ceil(sqft × (1 + waste)) is exact (100 × 1.1 = 110, not 111)', () => {
    expect(100 * 1.1).toBeGreaterThan(110); // the float trap the BigInt path avoids
    expect(materialQty(area({ sqft: 100, waste_pct: 0.1 }))).toBe(110);
    expect(materialQty(area({ sqft: 100.01, waste_pct: 0.1 }))).toBe(111);
    expect(materialQty(area({ sqft: 245.5, waste_pct: 0.07 }))).toBe(263); // 262.685 → 263
  });
  it('SY divides by 9 after waste', () => {
    expect(materialQty(area({ material_uom: 'SY', sqft: 90, waste_pct: 0.1 }))).toBe(11); // 99 / 9 = 11 exactly
    expect(materialQty(area({ material_uom: 'SY', sqft: 90.01, waste_pct: 0.1 }))).toBe(12);
  });
  it('BOX divides by coverage, and is null without one', () => {
    expect(materialQty(area({ material_uom: 'BOX', sqft: 200, waste_pct: 0.1, coverage_sf_per_unit: 22 }))).toBe(10); // 220 / 22 = 10
    expect(materialQty(area({ material_uom: 'BOX', sqft: 200, waste_pct: 0.1, coverage_sf_per_unit: 21.5 }))).toBe(11); // 10.23 → 11
    expect(materialQty(area({ material_uom: 'BOX', sqft: 200, coverage_sf_per_unit: null }))).toBeNull();
  });
  it('LF and EA use their own counts', () => {
    expect(materialQty(area({ material_uom: 'LF', linear_ft: 80, waste_pct: 0.05 }))).toBe(84);
    expect(materialQty(area({ material_uom: 'EA', each_count: 3, waste_pct: 0.1 }))).toBe(4); // 3.3 → 4
  });
  it('a blank quantity counts as zero, as coalesce(…, 0) does', () => {
    expect(materialQty(area({ sqft: null, waste_pct: 0.1 }))).toBe(0);
  });
  it('sqft from dimensions is round(length × width, 2)', () => {
    expect(sqftFromDims(12.5, 10.25)).toBe(128.13); // 128.125 → 128.13 (half up)
    expect(sqftFromDims(null, 10)).toBeNull();
    expect(materialQty(area({ length_ft: 10, width_ft: 10, waste_pct: 0.1 }))).toBe(110);
  });
  it('says the unit', () => {
    expect(qtyText(1342, 'SF')).toBe('1,342 sq ft');
    expect(qtyText(11, 'BOX')).toBe('11 boxes');
    expect(qtyText(null, 'SY')).toBe('—');
  });
});
