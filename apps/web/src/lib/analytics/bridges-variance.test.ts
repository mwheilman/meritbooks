import { describe, expect, it } from 'vitest';
import { BridgeTieError, buildBridge, cashBridge, ebitdaBridge, eliminationBridge, workingCapitalBridge, type Bridge } from './bridge';
import { budgetVsActual, isMaterial, natureOfAccountType, priceVolumeMix, type PvmItem } from './variance';
import { fluxList } from './flux';

const ties = (b: Bridge) => b.steps.reduce((s, x) => s + x.cents, 0) === b.end.cents - b.start.cents;

describe('bridges sum exactly (AC-C1, AC-K8)', () => {
  it('EBITDA bridge: volume at prior margin → rate → opex', () => {
    const prior = { revenueCents: 1_000_000, grossProfitCents: 400_000, opexExDaCents: 250_000, ebitdaCents: 150_000 };
    const current = { revenueCents: 1_200_000, grossProfitCents: 456_000, opexExDaCents: 270_000, ebitdaCents: 186_000 };
    const b = ebitdaBridge(prior, current);
    expect(b.steps.map((s) => [s.key, s.cents])).toEqual([
      ['volume', 80_000], // +200,000 × 40%
      ['rate', -24_000], // margin 40% → 38% on 1.2M
      ['opex', -20_000],
    ]);
    expect(ties(b)).toBe(true);
  });
  it('EBITDA bridge rounds volume to cents and the rate step absorbs the remainder', () => {
    const prior = { revenueCents: 300_001, grossProfitCents: 100_000, opexExDaCents: 33_333, ebitdaCents: 66_667 };
    const current = { revenueCents: 412_345, grossProfitCents: 140_101, opexExDaCents: 41_111, ebitdaCents: 98_990 };
    const b = ebitdaBridge(prior, current);
    expect(b.steps.every((s) => Number.isInteger(s.cents))).toBe(true);
    expect(ties(b)).toBe(true);
  });
  it('adjusted EBITDA bridge adds an add-backs step; other operating items are named', () => {
    const prior = { revenueCents: 100, grossProfitCents: 50, opexExDaCents: 30, ebitdaCents: 25, addBacksCents: 5 };
    const current = { revenueCents: 120, grossProfitCents: 60, opexExDaCents: 30, ebitdaCents: 32, addBacksCents: 9 };
    const b = ebitdaBridge(prior, current, { adjusted: true });
    expect(b.start.cents).toBe(30);
    expect(b.end.cents).toBe(41);
    expect(b.steps.find((s) => s.key === 'addbacks')?.cents).toBe(4);
    expect(b.steps.find((s) => s.key === 'other_operating')?.cents).toBe(-3);
    expect(ties(b)).toBe(true);
  });
  it('no prior revenue → one gross-profit step', () => {
    const b = ebitdaBridge({ revenueCents: 0, grossProfitCents: 0, opexExDaCents: 10, ebitdaCents: -10 }, { revenueCents: 50, grossProfitCents: 20, opexExDaCents: 15, ebitdaCents: 5 });
    expect(b.steps[0]).toMatchObject({ key: 'gross_profit', cents: 20 });
    expect(ties(b)).toBe(true);
  });
  it('working-capital bridge', () => {
    const start = { receivablesCents: 500, inventoryCents: 300, otherCurrentAssetsCents: 50, payablesCents: 400, otherCurrentLiabilitiesCents: 100 };
    const end = { receivablesCents: 650, inventoryCents: 250, otherCurrentAssetsCents: 60, payablesCents: 450, otherCurrentLiabilitiesCents: 90 };
    const b = workingCapitalBridge(start, end);
    expect(b.start.cents).toBe(350);
    expect(b.end.cents).toBe(420);
    expect(b.steps.map((s) => s.cents)).toEqual([150, -50, 10, -50, 10]);
    expect(ties(b)).toBe(true);
  });
  it('cash bridge names its residual', () => {
    const b = cashBridge(1_000, 1_450, { netIncomeCents: 500, depreciationAmortizationCents: 100, workingCapitalIncreaseCents: 80, capexCents: 200, netBorrowingCents: 150, equityNetCents: -50 });
    const other = b.steps.find((s) => s.residual);
    expect(other).toMatchObject({ label: 'Other balance-sheet movements', cents: 30 });
    expect(ties(b)).toBe(true);
    const exact = cashBridge(0, 420, { netIncomeCents: 500, depreciationAmortizationCents: 100, workingCapitalIncreaseCents: 80, capexCents: 200, netBorrowingCents: 150, equityNetCents: -50 });
    expect(exact.steps.some((s) => s.residual)).toBe(false);
  });
  it('elimination bridge: Σ companies + eliminations = consolidated', () => {
    const b = eliminationBridge([{ id: 'a', label: 'A', cents: 700 }, { id: 'b', label: 'B', cents: 300 }], -120);
    expect(b.end.cents).toBe(880);
    expect(ties(b)).toBe(true);
  });
  it('a bridge that does not tie throws unless a residual is allowed', () => {
    expect(() => buildBridge({ label: 's', cents: 0 }, { label: 'e', cents: 10 }, [{ key: 'x', label: 'x', cents: 7 }])).toThrow(BridgeTieError);
    expect(() => buildBridge({ label: 's', cents: 0 }, { label: 'e', cents: 10 }, [{ key: 'x', label: 'x', cents: 7.5 }])).toThrow(/integer cents/);
  });
});

describe('price / volume / mix (AC-K8)', () => {
  const prior: PvmItem[] = [
    { key: 'install', units: 100, revenueCents: 1_000_000 }, // $100.00
    { key: 'service', units: 400, revenueCents: 1_200_000 }, // $30.00
    { key: 'legacy', units: 10, revenueCents: 50_000 },
  ];
  const current: PvmItem[] = [
    { key: 'install', units: 130, revenueCents: 1_365_000 }, // $105.00
    { key: 'service', units: 380, revenueCents: 1_140_000 }, // $30.00
    { key: 'membership', units: 50, revenueCents: 75_000 },
  ];
  it('effects sum exactly to the revenue change', () => {
    const r = priceVolumeMix(prior, current);
    if (!r.ok) throw new Error('expected ok');
    expect(r.totalChangeCents).toBe(2_580_000 - 2_250_000);
    expect(r.priceCents + r.volumeCents + r.mixCents + r.newItemsCents + r.discontinuedCents).toBe(r.totalChangeCents);
    expect(r.priceCents).toBe(65_000); // $5 × 130
    expect(r.newItemsCents).toBe(75_000);
    expect(r.discontinuedCents).toBe(-50_000);
    // Continuing: Q0 500, Q1 510, P̄0 = 2,200,000/500 = 4,400 → volume = 10 × 4,400
    expect(r.volumeCents).toBe(44_000);
    // Mix = Σ Q1·P0 − Q1·P̄0 = (130×10,000 + 380×3,000) − 510×4,400 = 2,440,000 − 2,244,000
    expect(r.mixCents).toBe(196_000);
  });
  it('sub-cent rounding is absorbed by mix', () => {
    const r = priceVolumeMix([{ key: 'a', units: 3, revenueCents: 1_000 }, { key: 'b', units: 7, revenueCents: 2_001 }], [{ key: 'a', units: 4, revenueCents: 1_337 }, { key: 'b', units: 6, revenueCents: 1_999 }]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.priceCents + r.volumeCents + r.mixCents).toBe(r.totalChangeCents);
  });
  it('refuses without units', () => {
    expect(priceVolumeMix([{ key: 'a', units: Number.NaN, revenueCents: 1 }], [])).toEqual({ ok: false, reason: 'no_units' });
  });
});

describe('budget vs actual', () => {
  it('favourable follows the account nature; materiality AND/OR', () => {
    const r = budgetVsActual(
      [
        { key: 'rev', label: 'Revenue', nature: 'income', actualCents: 1_100_000, budgetCents: 1_000_000 },
        { key: 'cogs', label: 'COGS', nature: 'expense', actualCents: 520_000, budgetCents: 500_000 },
        { key: 'rent', label: 'Rent', nature: 'expense', actualCents: 49_000, budgetCents: 50_000 },
      ],
      { amountCents: 10_000, pct: 0.05, mode: 'and' },
    );
    expect(r.rows.map((x) => [x.key, x.verdict, x.material])).toEqual([
      ['rev', 'favourable', true],
      ['cogs', 'unfavourable', false], // $200 but only 4%
      ['rent', 'favourable', false],
    ]);
    expect(r.totals.netVarianceCents).toBe(100_000 - 20_000 + 1_000);
    expect(r.rows[0].variancePct).toBeCloseTo(0.1, 12);
  });
  it('natureOfAccountType: no EXPENSE type; OTHER splits by sub-type', () => {
    expect(natureOfAccountType('REVENUE')).toBe('income');
    expect(natureOfAccountType('OPEX')).toBe('expense');
    expect(natureOfAccountType('OTHER', 'OTHER_INCOME')).toBe('income');
    expect(natureOfAccountType('OTHER', 'OTHER_EXPENSE')).toBe('expense');
    expect(natureOfAccountType('ASSET')).toBeNull();
  });
  it('isMaterial: a new line passes the % test', () => {
    expect(isMaterial(500, 0, { pct: 0.1 })).toBe(true);
    expect(isMaterial(0, 0, { pct: 0.1 })).toBe(false);
    expect(isMaterial(999, 10_000, { amountCents: 1_000, pct: 0.05, mode: 'or' })).toBe(true);
  });
});

describe('flux helper (for 3E)', () => {
  it('filters by materiality and sorts by size of change', () => {
    const r = fluxList(
      [
        { key: 'a', label: 'Fuel', nature: 'expense', currentCents: 12_000, comparisonCents: 10_000 },
        { key: 'b', label: 'Revenue', nature: 'income', currentCents: 90_000, comparisonCents: 100_000 },
        { key: 'c', label: 'Cash', nature: 'balance', currentCents: 5_000, comparisonCents: 5_100 },
        { key: 'd', label: 'New account', nature: 'expense', currentCents: 3_000, comparisonCents: 0 },
      ],
      { amountCents: 1_500, pct: 0.1, mode: 'or' },
    );
    expect(r.rows.map((x) => x.key)).toEqual(['b', 'd', 'a']);
    expect(r.rows[0]).toMatchObject({ verdict: 'unfavourable', requiresExplanation: true, changePct: -0.1 });
    expect(r.rows[1].changePct).toBeNull();
    expect(r.materialCount).toBe(3);
    expect(r.totalLines).toBe(4);
    const all = fluxList([{ key: 'c', label: 'Cash', nature: 'balance', currentCents: 5_000, comparisonCents: 5_100 }], { amountCents: 1_500, includeImmaterial: true });
    expect(all.rows[0]).toMatchObject({ material: false, verdict: 'neutral' });
  });
});
