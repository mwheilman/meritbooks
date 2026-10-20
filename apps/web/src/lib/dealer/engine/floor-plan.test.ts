import { describe, it, expect } from 'vitest';
import { computeInterest, interestTrueUp, effectiveRateBps } from './interest';
import {
  planFlooring,
  buildCurtailmentSchedule,
  parseCurtailmentRules,
  transitionOnSale,
  applyPrincipalPayment,
  canAutoRelease,
  assertReleaser,
  payoffDueDate,
} from './notes';
import { flooringPlan, principalPaymentPlan, interestAccrualPlan, interestBilledPlan, openAccountFlooringPlan, feePlan } from './floor-plan-postings';
import { setupCostPlan, writeDownPlan, rentalMovePlan, returnToOemPlan, assertCostSign, unitCost } from './unit-cost';
import { assertBalanced, canonicalLines, totals, divRoundHalfUp, applyBps } from '../journal';
import { addDays } from '../dates';

// FPB §3 illustrative unit U-1: invoice 1,000,000¢, freight 25,000¢, setup 15,000¢
// (9,000 labor + 6,000 parts). Program: 90 free-floor days, 9.00% simple act/365,
// curtail 10% of original at day 180, pay-as-sold.
const PROGRAM = {
  free_floor_days: 90,
  max_term_days: 730,
  payoff_terms: 'PAY_AS_SOLD' as const,
  payoff_days: 0,
  curtailment_schedule: [{ after_days: 180, pct_bps: 1000 }],
};
const FLOORED = '2026-01-01';

const lines = (p: Parameters<typeof canonicalLines>[0]) =>
  canonicalLines(p).map((l) => [l.role, l.debitCents, l.creditCents]);

describe('rounding helpers', () => {
  it('rounds half up exactly', () => {
    expect(divRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divRoundHalfUp(15n, 10n)).toBe(2n);
    expect(applyBps(1_000_000, 1000)).toBe(100_000);
  });
});

describe('flooring (FPB §3.1, AC2)', () => {
  it('sets free-floor end, maturity and the day-180 curtailment', () => {
    const p = planFlooring({ flooredDate: FLOORED, originalPrincipalCents: 1_000_000, program: PROGRAM });
    expect(p.freeFloorEndDate).toBe(addDays(FLOORED, 90));
    expect(p.maturityDate).toBe(addDays(FLOORED, 730));
    expect(p.curtailments).toEqual([{ sequence: 1, dueDate: addDays(FLOORED, 180), amountCents: 100_000 }]);
  });

  it('posts DR whole goods inventory / CR floor plan payable 1,000,000', () => {
    const plan = flooringPlan({ principalCents: 1_000_000, inventoryRole: 'WHOLE_GOODS_INVENTORY', deptRole: 'WG_NEW', memo: 'U-1' });
    assertBalanced(plan);
    expect(lines(plan)).toEqual([
      ['WHOLE_GOODS_INVENTORY', 1_000_000, 0],
      ['FLOOR_PLAN_PAYABLE', 0, 1_000_000],
    ]);
    expect(plan.entryType).toBe('FLOOR_PLAN');
  });

  it('open-account parts flooring hits parts inventory', () => {
    expect(lines(openAccountFlooringPlan({ principalCents: 50_000, memo: 'OA' }))).toEqual([
      ['INVENTORY_ASSET', 50_000, 0],
      ['FLOOR_PLAN_PAYABLE', 0, 50_000],
    ]);
  });

  it('rejects malformed curtailment rules and caps cumulative curtailments at principal', () => {
    expect(() => parseCurtailmentRules([{ after_days: 0, pct_bps: 100 }])).toThrow();
    expect(() => parseCurtailmentRules([{ after_days: 30, pct_bps: 100, amount_cents: 5 }])).toThrow();
    expect(() => parseCurtailmentRules({})).toThrow();
    const s = buildCurtailmentSchedule(FLOORED, 100_000, [
      { after_days: 30, pct_bps: 6000 },
      { after_days: 60, pct_bps: 6000 },
    ]);
    expect(s.map((x) => x.amountCents)).toEqual([60_000, 40_000]);
  });
});

describe('interest (FPB §3.2, AC3)', () => {
  const ffe = addDays(FLOORED, 90);

  it('30 interest-bearing days on 1,000,000 at 900 bps = exactly 7,397¢', () => {
    const r = computeInterest({
      originalPrincipalCents: 1_000_000,
      events: [],
      freeFloorEndDate: ffe,
      rateBps: 900,
      dayCount: 'ACT_365',
      fromExclusive: ffe,
      toInclusive: addDays(ffe, 30),
    });
    expect(r.interestBearingDays).toBe(30);
    expect(r.interestCents).toBe(7_397);
  });

  it('accrues nothing during free-floor days', () => {
    const r = computeInterest({
      originalPrincipalCents: 1_000_000,
      events: [],
      freeFloorEndDate: ffe,
      rateBps: 900,
      dayCount: 'ACT_365',
      fromExclusive: FLOORED,
      toInclusive: ffe,
    });
    expect(r).toMatchObject({ interestCents: 0, interestBearingDays: 0 });
  });

  it('a window straddling the free-floor end only charges the days after it', () => {
    const r = computeInterest({
      originalPrincipalCents: 1_000_000,
      events: [],
      freeFloorEndDate: ffe,
      rateBps: 900,
      dayCount: 'ACT_365',
      fromExclusive: addDays(ffe, -10),
      toInclusive: addDays(ffe, 30),
    });
    expect(r.interestBearingDays).toBe(30);
    expect(r.interestCents).toBe(7_397);
  });

  it('a curtailment lowers the balance from its date; rounding happens once', () => {
    const r = computeInterest({
      originalPrincipalCents: 1_000_000,
      events: [{ date: addDays(ffe, 10), deltaCents: -100_000 }],
      freeFloorEndDate: ffe,
      rateBps: 900,
      dayCount: 'ACT_365',
      fromExclusive: ffe,
      toInclusive: addDays(ffe, 30),
    });
    // 9 days × 1,000,000 + 21 days × 900,000 = 27,900,000 ¢·days × 900 / 3,650,000
    expect(r.numerator).toBe(String(27_900_000 * 900));
    expect(r.interestCents).toBe(Math.round((27_900_000 * 900) / 3_650_000)); // 6,879.45 → 6,879
    expect(r.interestCents).toBe(6_879);
  });

  it('payoff stops interest on the payoff day; penalty rate applies after payoff due', () => {
    const due = addDays(ffe, 5);
    const r = computeInterest({
      originalPrincipalCents: 1_000_000,
      events: [{ date: addDays(ffe, 10), deltaCents: -1_000_000 }],
      freeFloorEndDate: ffe,
      rateBps: 900,
      dayCount: 'ACT_365',
      fromExclusive: ffe,
      toInclusive: addDays(ffe, 30),
      payoffDueDate: due,
      penaltyRateBps: 2190,
    });
    expect(r.interestBearingDays).toBe(9); // days 1..9 (day 10 balance is 0)
    expect(r.penaltyDays).toBe(4); // days 6..9
    expect(r.interestCents).toBe(Math.round((1_000_000 * (5 * 900 + 4 * 2190)) / 3_650_000));
  });

  it('ACT_360 basis is a program setting', () => {
    const r = computeInterest({
      originalPrincipalCents: 1_000_000,
      events: [],
      freeFloorEndDate: ffe,
      rateBps: 900,
      dayCount: 'ACT_360',
      fromExclusive: ffe,
      toInclusive: addDays(ffe, 30),
    });
    expect(r.interestCents).toBe(7_500);
  });

  it('index-plus rate = index + spread', () => {
    expect(effectiveRateBps({ rate_type: 'INDEX_PLUS', rate_bps: 0, index_rate_bps: 750, spread_bps: 200 })).toBe(950);
    expect(() => effectiveRateBps({ rate_type: 'INDEX_PLUS', rate_bps: 0 })).toThrow();
  });

  it('accrual JE: DR floor plan interest (by dept) / CR accrued 7,397', () => {
    const plan = interestAccrualPlan([{ amountCents: 7_397, deptRole: 'WG_NEW' }], 'Oct accrual');
    expect(lines(plan)).toEqual([
      ['FLOOR_PLAN_INTEREST', 7_397, 0],
      ['FLOOR_PLAN_INTEREST_ACCRUED', 0, 7_397],
    ]);
    expect(canonicalLines(plan)[0].deptRole).toBe('WG_NEW');
  });

  it('a 7,410¢ lender debit clears the 7,397 accrual with a 13¢ true-up', () => {
    const t = interestTrueUp({ billedCents: 7_410, accruedCents: 7_397, toleranceCents: 2_500, toleranceBps: 200 });
    expect(t).toMatchObject({ trueUpCents: 13, withinTolerance: true });
    const plan = interestBilledPlan({ billedCents: 7_410, accrualClearedCents: 7_397, deptRole: 'WG_NEW', memo: 'bill' });
    expect(lines(plan)).toEqual([
      ['FLOOR_PLAN_INTEREST_ACCRUED', 7_397, 0],
      ['FLOOR_PLAN_INTEREST', 13, 0],
      ['OPERATING_BANK', 0, 7_410],
    ]);
    assertBalanced(plan);
  });

  it('a 5,000¢ difference exceeds tolerance (DL-9) and must not post silently', () => {
    const t = interestTrueUp({ billedCents: 12_397, accruedCents: 7_397, toleranceCents: 2_500, toleranceBps: 200 });
    expect(t.trueUpCents).toBe(5_000);
    expect(t.toleranceAppliedCents).toBe(2_500);
    expect(t.withinTolerance).toBe(false);
  });

  it('an under-bill credits interest expense', () => {
    const plan = interestBilledPlan({ billedCents: 7_000, accrualClearedCents: 7_397, deptRole: 'WG_NEW', memo: 'bill' });
    expect(lines(plan)).toContainEqual(['FLOOR_PLAN_INTEREST', 0, 397]);
    assertBalanced(plan);
  });

  it('fees post to floor plan fees', () => {
    expect(lines(feePlan({ feeCents: 2_500, deptRole: 'WG_NEW', memo: 'late fee' }))).toEqual([
      ['FLOOR_PLAN_FEES', 2_500, 0],
      ['OPERATING_BANK', 0, 2_500],
    ]);
  });
});

describe('curtailment + payoff (FPB §3.3–3.4, AC4–5)', () => {
  it('curtailment reduces the note to 900,000 and touches only debt + bank', () => {
    const r = applyPrincipalPayment({ status: 'OPEN', principal_balance_cents: 1_000_000 }, 100_000);
    expect(r).toEqual({ balanceCents: 900_000, status: 'OPEN' });
    expect(lines(principalPaymentPlan({ amountCents: 100_000, deptRole: 'WG_NEW', kind: 'CURTAILMENT', memo: 'c' }))).toEqual([
      ['FLOOR_PLAN_PAYABLE', 100_000, 0],
      ['OPERATING_BANK', 0, 100_000],
    ]);
  });

  it('sale → SOLD_UNPAID, payoff due on the sale date (pay-as-sold), proposes 900,000', () => {
    const t = transitionOnSale({ status: 'OPEN', principal_balance_cents: 900_000 }, '2026-08-15', PROGRAM);
    expect(t).toEqual({ status: 'SOLD_UNPAID', soldDate: '2026-08-15', payoffDueDate: '2026-08-15', payoffCents: 900_000 });
    expect(payoffDueDate('2026-08-15', { payoff_terms: 'DAYS_AFTER_SALE', payoff_days: 10 })).toBe('2026-08-25');
  });

  it('payoff → PAID_OFF; over-payment refused', () => {
    expect(applyPrincipalPayment({ status: 'SOLD_UNPAID', principal_balance_cents: 900_000 }, 900_000)).toEqual({
      balanceCents: 0,
      status: 'PAID_OFF',
    });
    expect(() => applyPrincipalPayment({ status: 'SOLD_UNPAID', principal_balance_cents: 900_000 }, 900_001)).toThrow();
    expect(() => applyPrincipalPayment({ status: 'PAID_OFF', principal_balance_cents: 0 }, 1)).toThrow();
  });

  it('a payoff proposal never auto-releases, and the releaser must differ from the proposer', () => {
    expect(canAutoRelease()).toBe(false);
    expect(() => assertReleaser('user_a', 'user_a')).toThrow(/separation of duties/);
    expect(() => assertReleaser('user_a', null)).toThrow();
    expect(() => assertReleaser('user_a', 'user_b')).not.toThrow();
  });
});

describe('unit cost build-up (FPB §3.6, AC8)', () => {
  it('setup RO 9,000 labor + 6,000 parts adds 15,000 at actual cost', () => {
    const r = setupCostPlan({ inventoryRole: 'WHOLE_GOODS_INVENTORY', laborCents: 9_000, partsCents: 6_000, capitalizeLabor: true, memo: 'PDI' });
    expect(r.capitalizedCents).toBe(15_000);
    expect(lines(r.plan!)).toEqual([
      ['WHOLE_GOODS_INVENTORY', 15_000, 0],
      ['SETUP_LABOR_CAPITALIZED', 0, 9_000],
      ['INVENTORY_ASSET', 0, 6_000],
    ]);
    // No overhead / burden input exists anywhere on the engine (canon §2 guard).
    expect(Object.keys(r)).not.toContain('overheadRate');
  });

  it('unmapped setup-labor role capitalizes parts only, with a warning', () => {
    const r = setupCostPlan({ inventoryRole: 'WHOLE_GOODS_INVENTORY', laborCents: 9_000, partsCents: 6_000, capitalizeLabor: false, memo: 'PDI' });
    expect(r.capitalizedCents).toBe(6_000);
    expect(r.warnings).toHaveLength(1);
  });

  it('unit cost = 1,000,000 + 25,000 + 15,000 = 1,040,000 from posted rows only', () => {
    expect(
      unitCost([
        { amount_cents: 1_000_000, status: 'POSTED' },
        { amount_cents: 25_000, status: 'POSTED' },
        { amount_cents: 15_000, status: 'POSTED' },
        { amount_cents: 99_999, status: 'PROPOSED' },
      ]),
    ).toBe(1_040_000);
    expect(() => assertCostSign('WRITE_DOWN', 100)).toThrow();
    expect(() => assertCostSign('FREIGHT', -100)).toThrow();
  });

  it('write-down, rental move and return balance', () => {
    assertBalanced(writeDownPlan({ inventoryRole: 'WHOLE_GOODS_INVENTORY', amountCents: 50_000, deptRole: 'WG_NEW', memo: 'NRV' }));
    expect(lines(rentalMovePlan({ fromRole: 'WHOLE_GOODS_INVENTORY', costCents: 1_040_000, memo: 'rent' }))).toEqual([
      ['RENTAL_INVENTORY', 1_040_000, 0],
      ['WHOLE_GOODS_INVENTORY', 0, 1_040_000],
    ]);
    const ret = returnToOemPlan({ inventoryRole: 'WHOLE_GOODS_INVENTORY', costCents: 1_040_000, lenderCreditCents: 1_000_000, deptRole: 'WG_NEW', memo: 'ret' });
    const t = totals(assertBalanced(ret));
    expect(t.debit).toBe(1_040_000);
    expect(lines(ret)).toContainEqual(['INVENTORY_WRITEDOWN', 40_000, 0]);
  });
});
