import { describe, it, expect } from 'vitest';
import { computeRollForward, type RollForwardAsset, type RollForwardRun } from './fixed-asset-rollforward';

// Period under test: calendar 2026.
const START = '2026-01-01';
const END = '2026-12-31';

describe('computeRollForward', () => {
  it('classifies additions, disposals, depreciation and ties out per class + total', () => {
    const assets: RollForwardAsset[] = [
      // Held all year, acquired prior year.
      { id: 'v1', category: 'Vehicles', acquisitionDate: '2025-01-31', acquisitionCostCents: 1_200_000, disposalDate: null },
      // Acquired in-period (addition).
      { id: 'v2', category: 'Vehicles', acquisitionDate: '2026-06-30', acquisitionCostCents: 600_000, disposalDate: null },
      // Prior-year, disposed in-period.
      { id: 'e1', category: 'Equipment', acquisitionDate: '2024-01-31', acquisitionCostCents: 300_000, disposalDate: '2026-09-30' },
    ];
    const runs: RollForwardRun[] = [
      // v1: 12 prior-year months (2025) then 12 in-period (2026), 10k/mo.
      ...Array.from({ length: 12 }, (_, i) => ({ fixedAssetId: 'v1', periodYear: 2025, periodMonth: i + 1, amountCents: 10_000 })),
      ...Array.from({ length: 12 }, (_, i) => ({ fixedAssetId: 'v1', periodYear: 2026, periodMonth: i + 1, amountCents: 10_000 })),
      // v2: 6 in-period months (Jul-Dec 2026), 5k/mo.
      ...Array.from({ length: 6 }, (_, i) => ({ fixedAssetId: 'v2', periodYear: 2026, periodMonth: i + 7, amountCents: 5_000 })),
      // e1: 24 prior months (2024-25) + 9 in-period (Jan-Sep 2026) before disposal, 2k/mo.
      ...Array.from({ length: 12 }, (_, i) => ({ fixedAssetId: 'e1', periodYear: 2024, periodMonth: i + 1, amountCents: 2_000 })),
      ...Array.from({ length: 12 }, (_, i) => ({ fixedAssetId: 'e1', periodYear: 2025, periodMonth: i + 1, amountCents: 2_000 })),
      ...Array.from({ length: 9 }, (_, i) => ({ fixedAssetId: 'e1', periodYear: 2026, periodMonth: i + 1, amountCents: 2_000 })),
    ];

    const rf = computeRollForward(assets, runs, START, END);

    const vehicles = rf.classes.find((c) => c.className === 'Vehicles')!;
    const equipment = rf.classes.find((c) => c.className === 'Equipment')!;
    expect(vehicles).toBeDefined();
    expect(equipment).toBeDefined();

    // Vehicles cost: beg 1.2M (v1), additions 600k (v2), no disposals, end 1.8M.
    expect(vehicles.begCostCents).toBe(1_200_000);
    expect(vehicles.additionsCents).toBe(600_000);
    expect(vehicles.disposalsCostCents).toBe(0);
    expect(vehicles.endCostCents).toBe(1_800_000);
    // Vehicles accum: beg 120k (12*10k), depreciation 120k(v1) + 30k(v2), end 270k.
    expect(vehicles.begAccumCents).toBe(120_000);
    expect(vehicles.depreciationCents).toBe(150_000);
    expect(vehicles.endAccumCents).toBe(270_000);

    // Equipment: disposed in period, so ends at zero.
    expect(equipment.begCostCents).toBe(300_000);
    expect(equipment.disposalsCostCents).toBe(300_000);
    expect(equipment.endCostCents).toBe(0);
    expect(equipment.begAccumCents).toBe(48_000); // 24 * 2k
    expect(equipment.depreciationCents).toBe(18_000); // 9 * 2k in-period
    expect(equipment.disposalsAccumCents).toBe(66_000); // 33 * 2k total at disposal
    expect(equipment.endAccumCents).toBe(0);
    expect(equipment.endNbvCents).toBe(0);
  });

  it('the accumulated continuity identity holds for the total row', () => {
    const assets: RollForwardAsset[] = [
      { id: 'a', category: 'X', acquisitionDate: '2025-01-31', acquisitionCostCents: 100_000, disposalDate: null },
      { id: 'b', category: 'Y', acquisitionDate: '2024-01-31', acquisitionCostCents: 50_000, disposalDate: '2026-05-31' },
    ];
    const runs: RollForwardRun[] = [
      ...Array.from({ length: 18 }, (_, i) => ({ fixedAssetId: 'a', periodYear: 2025 + Math.floor(i / 12), periodMonth: (i % 12) + 1, amountCents: 1_000 })),
      ...Array.from({ length: 17 }, (_, i) => ({ fixedAssetId: 'b', periodYear: 2024 + Math.floor(i / 12), periodMonth: (i % 12) + 1, amountCents: 500 })),
    ];
    const { total } = computeRollForward(assets, runs, START, END);
    expect(total.begAccumCents + total.depreciationCents - total.disposalsAccumCents).toBe(total.endAccumCents);
    expect(total.begCostCents + total.additionsCents - total.disposalsCostCents).toBe(total.endCostCents);
    expect(total.endNbvCents).toBe(total.endCostCents - total.endAccumCents);
  });

  it('buckets missing categories under Unclassified', () => {
    const rf = computeRollForward(
      [{ id: 'z', category: null, acquisitionDate: '2026-02-01', acquisitionCostCents: 10_000, disposalDate: null }],
      [],
      START,
      END
    );
    expect(rf.classes[0].className).toBe('Unclassified');
    expect(rf.classes[0].additionsCents).toBe(10_000);
  });

  it('rejects an inverted period', () => {
    expect(() => computeRollForward([], [], END, START)).toThrow();
  });
});
