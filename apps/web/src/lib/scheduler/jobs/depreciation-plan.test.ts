import { describe, it, expect } from 'vitest';
import { periodKey, planAsset, planSchedule, rollupByCompany, type AssetForPlan } from './depreciation-plan';

const asset = (over: Partial<AssetForPlan> = {}): AssetForPlan => ({
  id: 'a1',
  location_id: 'L1',
  category: 'EQUIPMENT',
  acquisition_date: '2026-07-01',
  acquisition_cost_cents: 120_000,
  salvage_value_cents: 0,
  useful_life_months: 12,
  depreciation_method: 'STRAIGHT_LINE',
  accumulated_depreciation_cents: 0,
  last_depreciation_date: null,
  ...over,
});

describe('planAsset (what runDepreciation / runAmortization would post)', () => {
  it('straight line: every month from acquisition through asOf, inclusive', () => {
    expect(planAsset(asset(), '2026-09-30', new Set())).toMatchObject({ periods: 3, amountCents: 30_000, kind: 'depreciation', blockedByLock: null });
  });
  it('is idempotent per period: months already posted are not proposed again', () => {
    const a = asset({ last_depreciation_date: '2026-08-31', accumulated_depreciation_cents: 20_000 });
    expect(planAsset(a, '2026-09-30', new Set())).toMatchObject({ periods: 1, amountCents: 10_000 });
    expect(planAsset(asset({ last_depreciation_date: '2026-09-30', accumulated_depreciation_cents: 30_000 }), '2026-09-30', new Set())).toMatchObject({ periods: 0 });
  });
  it('stops at a hard-closed month (the GL refuses it; the engine stops that asset there)', () => {
    const locked = new Set([periodKey('L1', 2026, 8)]);
    expect(planAsset(asset(), '2026-09-30', locked)).toMatchObject({ periods: 1, amountCents: 10_000, blockedByLock: '2026-08' });
  });
  it('never exceeds the depreciable base', () => {
    const a = asset({ acquisition_date: '2025-01-01', accumulated_depreciation_cents: 115_000, last_depreciation_date: '2025-10-31' });
    expect(planAsset(a, '2026-09-30', new Set())).toMatchObject({ amountCents: 5_000 });
  });
  it('intangibles amortize; goodwill and tax methods are skipped', () => {
    expect(planAsset(asset({ category: 'INTANGIBLE_SOFTWARE' }), '2026-07-31', new Set())).toMatchObject({ kind: 'amortization', periods: 1 });
    expect(planAsset(asset({ category: 'INTANGIBLE_GOODWILL' }), '2026-09-30', new Set()).skipped).toMatch(/goodwill/);
    expect(planAsset(asset({ depreciation_method: 'MACRS_5' }), '2026-09-30', new Set()).skipped).toMatch(/tax method/);
  });
  it('units of production charges the meter once for the asOf month', () => {
    const a = asset({ depreciation_method: 'UNITS_OF_PRODUCTION', total_expected_units: 1000, units_used: 250, accumulated_depreciation_cents: 10_000 });
    expect(planAsset(a, '2026-09-30', new Set())).toMatchObject({ periods: 1, amountCents: 20_000 });
    expect(planAsset(a, '2026-09-30', new Set([periodKey('L1', 2026, 9)]))).toMatchObject({ periods: 0, blockedByLock: '2026-09' });
  });
});

describe('planSchedule (insurance)', () => {
  it('due periods through asOf, stops at a locked month', () => {
    const s = { id: 's1', location_id: 'L2', total_cents: 12_000, months: 12, start_date: '2026-07-01', periods_posted: 0 };
    expect(planSchedule(s, '2026-09-30', new Set())).toMatchObject({ periods: 3, amountCents: 3_000 });
    expect(planSchedule({ ...s, periods_posted: 3 }, '2026-09-30', new Set())).toMatchObject({ periods: 0 });
    expect(planSchedule(s, '2026-09-30', new Set([periodKey('L2', 2026, 9)]))).toMatchObject({ periods: 2, blockedByLock: '2026-09' });
  });
});

describe('rollupByCompany', () => {
  it('one line per company, biggest first, blocked counted', () => {
    const r = rollupByCompany([
      { locationId: 'A', periods: 2, amountCents: 500, blockedByLock: null },
      { locationId: 'B', periods: 1, amountCents: 900, blockedByLock: null },
      { locationId: 'A', periods: 1, amountCents: 100, blockedByLock: null },
      { locationId: 'C', periods: 0, amountCents: 0, blockedByLock: '2026-08' },
      { locationId: 'D', periods: 0, amountCents: 0, blockedByLock: null },
    ]);
    expect(r).toEqual([
      { locationId: 'B', periods: 1, amountCents: 900, items: 1, blocked: 0 },
      { locationId: 'A', periods: 3, amountCents: 600, items: 2, blocked: 0 },
      { locationId: 'C', periods: 0, amountCents: 0, items: 0, blocked: 1 },
    ]);
  });
});
