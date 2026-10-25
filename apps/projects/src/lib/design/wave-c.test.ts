import { describe, expect, it } from 'vitest';
import { halfUp, markupOf, priceUnit } from './pricing';
import { buildDesignPlan } from './setup';

describe('design pricing (ID-14), mirrored by pm.dsn_price', () => {
  it('cost plus, discount from retail, tiered and the firm default', () => {
    expect(priceUnit({ method: 'COST_PLUS', pct: 0.4 }, 10000, null)).toBe(14000);
    expect(priceUnit({ method: 'DISCOUNT_FROM_RETAIL', pct: 0.15 }, null, 20000)).toBe(17000);
    const tiered = { method: 'TIERED' as const, pct: null, tiers: [{ up_to_cents: null, pct: 0.2 }, { up_to_cents: 50000, pct: 0.5 }] };
    expect(priceUnit(tiered, 40000, null)).toBe(60000);
    expect(priceUnit(tiered, 90000, null)).toBe(108000);
    expect(priceUnit(null, 1001, null)).toBe(1351); // 1351.35 → 1351
    expect(priceUnit(null, 1000, null, 0.5)).toBe(1500);
  });

  it('a retail rule refuses an item with no retail price', () => {
    expect(() => priceUnit({ method: 'DISCOUNT_FROM_RETAIL', pct: 0.1 }, 100, null)).toThrow(/retail/);
  });

  it('rounds half up in whole cents and reports realized markup', () => {
    expect(halfUp(2.5)).toBe(3);
    expect(halfUp(-2.5)).toBe(-3);
    expect(halfUp(2.4999)).toBe(2);
    expect(markupOf(14000, 10000)).toBe(0.4);
    expect(markupOf(100, 0)).toBeNull();
  });
});

describe('design firm setup (ID-01)', () => {
  it('clamps policy, drops blank receivers and adds procurement income only for that fee model', () => {
    const p = buildDesignPlan({ firmType: 'RESIDENTIAL_FULL_SERVICE', feeModels: [], markupPct: 20, productDepositPct: -1, retainerCents: 250000.6, retainerEvergreen: true,
      showCostToClients: false, receivers: [{ name: 'Acme Receiving', address: '1 Dock St' }, { name: '  ', address: '' }], taxStates: ['ia'], replacing: null });
    expect(p.settings.fee_models).toEqual(['HOURLY']);
    expect(p.settings.default_markup_pct).toBe(10);
    expect(p.settings.product_deposit_pct).toBe(0);
    expect(p.settings.retainer_cents).toBe(250001);
    expect(p.receivers).toHaveLength(1);
    expect(p.books_accounts.procurement_fees).toBeUndefined();
    expect(buildDesignPlan({ firmType: 'COMMERCIAL_FFE', feeModels: ['PROCUREMENT_FEE'], markupPct: 0.2, productDepositPct: 0.5, retainerCents: 0, retainerEvergreen: false,
      showCostToClients: true, receivers: [], taxStates: [], replacing: 'Studio Designer' }).books_accounts.procurement_fees).toBeDefined();
  });
});
