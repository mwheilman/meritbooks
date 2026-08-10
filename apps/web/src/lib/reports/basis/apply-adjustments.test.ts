import { describe, it, expect } from 'vitest';
import {
  applyBasisOverlay,
  summarizeByAccount,
  toDebitPositive,
  basisPresentationLabel,
  type GaapAccountBalance,
  type BasisAdjustment,
} from './apply-adjustments';
import { deriveTaxAdjustmentsFromM1, type PerAccountTaxDifference } from './derive-tax';

const gaap: GaapAccountBalance[] = [
  { accountId: 'meals', accountNumber: '6300', accountName: 'Meals & Entertainment', normalBalance: 'DEBIT', naturalCents: 10_000 },
  { accountId: 'rev', accountNumber: '4000', accountName: 'Service Revenue', normalBalance: 'CREDIT', naturalCents: 100_000 },
  { accountId: 're', accountNumber: '3020', accountName: 'Retained Earnings', normalBalance: 'CREDIT', naturalCents: 500_000 },
];

describe('applyBasisOverlay — signed natural deltas per account', () => {
  it('applies a signed natural delta to the matching account and leaves others untouched', () => {
    const adjustments: BasisAdjustment[] = [
      { accountId: 'meals', amountCents: -5_000 }, // remove the nondeductible half
      { accountId: 're', amountCents: -5_000 }, // balancing equity offset
    ];
    const res = applyBasisOverlay(gaap, adjustments);
    const meals = res.rows.find((r) => r.accountId === 'meals')!;
    const rev = res.rows.find((r) => r.accountId === 'rev')!;
    expect(meals.gaapCents).toBe(10_000);
    expect(meals.adjustmentCents).toBe(-5_000);
    expect(meals.adjustedCents).toBe(5_000);
    // an account with no adjustment is passed through unchanged
    expect(rev.adjustmentCents).toBe(0);
    expect(rev.adjustedCents).toBe(rev.gaapCents);
    expect(res.adjustmentCount).toBe(2);
  });

  it('flags a net-zero balance when a P&L delta is matched by an equity offset', () => {
    // meals is DEBIT-normal (dp delta = −5000), retained earnings CREDIT-normal (dp = +5000).
    const adjustments: BasisAdjustment[] = [
      { accountId: 'meals', amountCents: -5_000 },
      { accountId: 're', amountCents: -5_000 },
    ];
    const res = applyBasisOverlay(gaap, adjustments);
    expect(res.netDebitPositiveCents).toBe(0);
    expect(res.balances).toBe(true);
  });

  it('surfaces an imbalance (does not silently force) when adjustments do not net to zero', () => {
    const adjustments: BasisAdjustment[] = [{ accountId: 'meals', amountCents: -5_000 }];
    const res = applyBasisOverlay(gaap, adjustments);
    // one unmatched debit-normal decrease → debit-positive net is −5000, not balanced
    expect(res.netDebitPositiveCents).toBe(-5_000);
    expect(res.balances).toBe(false);
  });

  it('is provably a pass-through of GAAP when there are no adjustments (Accrual default untouched)', () => {
    const res = applyBasisOverlay(gaap, []);
    expect(res.adjustmentCount).toBe(0);
    expect(res.balances).toBe(true);
    expect(res.netDebitPositiveCents).toBe(0);
    for (const row of res.rows) {
      expect(row.adjustmentCents).toBe(0);
      expect(row.adjustedCents).toBe(row.gaapCents);
    }
  });

  it('creates a row for an adjustment-only account using supplied metadata', () => {
    const meta = new Map([
      ['dta', { accountNumber: '1810', accountName: 'Deferred Tax Asset', normalBalance: 'DEBIT' as const }],
    ]);
    const res = applyBasisOverlay(gaap, [{ accountId: 'dta', amountCents: 2_500 }], meta);
    const dta = res.rows.find((r) => r.accountId === 'dta')!;
    expect(dta.accountNumber).toBe('1810');
    expect(dta.gaapCents).toBe(0);
    expect(dta.adjustedCents).toBe(2_500);
  });

  it('aggregates multiple adjustments on the same account and itemizes them', () => {
    const adjustments: BasisAdjustment[] = [
      { accountId: 'meals', amountCents: -3_000, description: 'a' },
      { accountId: 'meals', amountCents: -2_000, description: 'b' },
    ];
    const summary = summarizeByAccount(adjustments);
    expect(summary.get('meals')!.naturalCents).toBe(-5_000);
    expect(summary.get('meals')!.items).toHaveLength(2);
  });
});

describe('toDebitPositive + basisPresentationLabel', () => {
  it('converts natural deltas to debit-positive by normal balance', () => {
    expect(toDebitPositive(100, 'DEBIT')).toBe(100);
    expect(toDebitPositive(100, 'CREDIT')).toBe(-100);
  });
  it('labels custom basis from its custom_label, else a default', () => {
    expect(basisPresentationLabel('TAX')).toBe('Tax basis');
    expect(basisPresentationLabel('CUSTOM', 'Bank covenant basis')).toBe('Bank covenant basis');
    expect(basisPresentationLabel('CUSTOM', '')).toBe('Custom basis');
  });
});

describe('deriveTaxAdjustmentsFromM1 — reuse of book-tax M-1 output', () => {
  it('produces a balanced set: nondeductible meals + tax-exempt interest, offset to equity', () => {
    const diffs: PerAccountTaxDifference[] = [
      // meals: 50% nondeductible add-back of $50 → +$25 taxable income
      { accountId: 'meals', normalBalance: 'DEBIT', taxableEffect: 'ADD', differenceType: 'PERMANENT', amountCents: 2_500, code: 'MEALS_50' },
      // tax-exempt interest: SUBTRACT $10 book income
      { accountId: 'muni', normalBalance: 'CREDIT', taxableEffect: 'SUBTRACT', differenceType: 'PERMANENT', amountCents: 1_000, code: 'TAX_EXEMPT_INTEREST' },
    ];
    const derived = deriveTaxAdjustmentsFromM1(diffs, 're');
    // the derived set always balances in debit-positive space
    expect(derived.netDebitPositiveCents).toBe(0);
    // one leg per difference + a single equity offset
    expect(derived.adjustments).toHaveLength(3);

    const meals = derived.adjustments.find((a) => a.accountId === 'meals')!;
    // ADD on a debit-normal expense → the expense shrinks on tax basis (−A)
    expect(meals.amountCents).toBe(-2_500);
    expect(meals.adjustmentType).toBe('PERMANENT');

    const muni = derived.adjustments.find((a) => a.accountId === 'muni')!;
    // SUBTRACT on a credit-normal revenue → revenue shrinks (−A)
    expect(muni.amountCents).toBe(-1_000);

    const offset = derived.adjustments.find((a) => a.accountId === 're')!;
    expect(offset.adjustmentType).toBe('RECLASS');
    // net income change nc = +2500 (add) + (−1000) (subtract) = +1500;
    // each P&L leg's debit-positive delta = −nc, summing to −1500, so equity offset natural = −1500
    expect(offset.amountCents).toBe(-1_500);
  });

  it('emits nothing for an empty difference set (degrade-safe, still balances)', () => {
    const derived = deriveTaxAdjustmentsFromM1([], 're');
    expect(derived.adjustments).toHaveLength(0);
    expect(derived.netDebitPositiveCents).toBe(0);
    expect(derived.equityOffsetCents).toBe(0);
  });
});
