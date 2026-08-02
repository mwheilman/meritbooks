import { describe, it, expect } from 'vitest';
import {
  computeM1,
  resolveAccountDifferenceCents,
  effectiveDisallowancePct,
  findMLine,
  STANDARD_M_LINES,
  type TaggedDifference,
} from './book-tax';
import { heuristicTagForAccount } from './book-tax-tag-ai';

describe('heuristicTagForAccount — AI proposes the TAG, never a number', () => {
  it('classifies meals, penalties, and depreciation from the account name', () => {
    expect(heuristicTagForAccount({ name: 'Meals & Entertainment', accountNumber: '6420' })?.code).toBe('MEALS_50');
    expect(heuristicTagForAccount({ name: 'Late Payment Penalties', accountNumber: '6900' })?.code).toBe('PENALTIES_FINES');
    expect(heuristicTagForAccount({ name: 'Depreciation Expense', accountNumber: '6800' })?.code).toBe('BOOK_DEPR_EXCESS');
  });
  it('returns null for an ordinary fully-deductible account (no book-tax difference)', () => {
    expect(heuristicTagForAccount({ name: 'Office Supplies', accountNumber: '6100' })).toBeNull();
  });
  it('never returns an off-catalog code', () => {
    const hit = heuristicTagForAccount({ name: 'Federal Income Tax Expense', accountNumber: '9000' });
    expect(hit).not.toBeNull();
    expect(findMLine(hit!.code)).toBeDefined();
  });
});

describe('effectiveDisallowancePct', () => {
  it('uses the per-tag override when present', () => {
    expect(effectiveDisallowancePct('MEALS_50', 80)).toBe(80);
  });
  it('falls back to the standard M-line default', () => {
    expect(effectiveDisallowancePct('MEALS_50', null)).toBe(50);
    expect(effectiveDisallowancePct('PENALTIES_FINES', undefined)).toBe(100);
  });
  it('is null for a pure timing item and an unknown code', () => {
    expect(effectiveDisallowancePct('BOOK_DEPR_EXCESS', null)).toBeNull();
    expect(effectiveDisallowancePct('NOT_A_CODE', undefined)).toBeNull();
  });
});

describe('resolveAccountDifferenceCents', () => {
  it('applies a 50% disallowance to book meals activity, rounding to the cent', () => {
    // $1,234.57 of meals → add back 50% = $617.285 → 61729 cents (round half up)
    expect(resolveAccountDifferenceCents(123457, 'MEALS_50', null)).toBe(61729);
  });
  it('adds back 100% for a fully-nondeductible permanent item', () => {
    expect(resolveAccountDifferenceCents(500000, 'PENALTIES_FINES', null)).toBe(500000);
  });
  it('honors a per-tag percentage override', () => {
    expect(resolveAccountDifferenceCents(200000, 'MEALS_50', 100)).toBe(200000);
  });
  it('returns 0 for a timing item (no percentage) — amount must be pinned explicitly', () => {
    expect(resolveAccountDifferenceCents(9_000_000, 'BOOK_DEPR_EXCESS', null)).toBe(0);
  });
  it('returns 0 for zero or negative activity', () => {
    expect(resolveAccountDifferenceCents(0, 'MEALS_50', null)).toBe(0);
    expect(resolveAccountDifferenceCents(-100, 'MEALS_50', null)).toBe(0);
  });
});

describe('computeM1 — degrade-safe (no tags)', () => {
  it('taxable income equals book NI with an empty adjustments list', () => {
    const r = computeM1(5_000_000, []);
    expect(r.taxableIncomeCents).toBe(5_000_000);
    expect(r.additions).toHaveLength(0);
    expect(r.subtractions).toHaveLength(0);
    expect(r.adjustmentCount).toBe(0);
    expect(r.totalAdditionsCents).toBe(0);
    expect(r.totalSubtractionsCents).toBe(0);
    expect(r.permanentNetCents).toBe(0);
    expect(r.temporaryNetCents).toBe(0);
  });
  it('drops zero-amount differences (still a pass-through)', () => {
    const r = computeM1(1_000_000, [
      { code: 'MEALS_50', label: 'Meals', differenceType: 'PERMANENT', taxableEffect: 'ADD', amountCents: 0 },
    ]);
    expect(r.adjustmentCount).toBe(0);
    expect(r.taxableIncomeCents).toBe(1_000_000);
  });
});

describe('computeM1 — additions and subtractions bridge book NI → taxable income', () => {
  const diffs: TaggedDifference[] = [
    // permanent add-backs
    { code: 'MEALS_50', label: 'Meals — 50%', differenceType: 'PERMANENT', taxableEffect: 'ADD', amountCents: 25_000, source: 'account' },
    { code: 'PENALTIES_FINES', label: 'Penalties & fines', differenceType: 'PERMANENT', taxableEffect: 'ADD', amountCents: 40_000, source: 'account' },
    // temporary add-back
    { code: 'ACCRUED_BONUS', label: 'Accrued bonuses', differenceType: 'TEMPORARY', taxableEffect: 'ADD', amountCents: 100_000, source: 'override' },
    // permanent subtraction
    { code: 'TAX_EXEMPT_INTEREST', label: 'Tax-exempt interest', differenceType: 'PERMANENT', taxableEffect: 'SUBTRACT', amountCents: 15_000, source: 'account' },
    // temporary subtraction (tax depreciation > book)
    { code: 'TAX_DEPR_EXCESS', label: 'Bonus depreciation', differenceType: 'TEMPORARY', taxableEffect: 'SUBTRACT', amountCents: 300_000, source: 'override' },
  ];

  it('computes taxable income = book NI + additions − subtractions', () => {
    const r = computeM1(1_000_000, diffs);
    // additions 25k+40k+100k = 165,000 ; subtractions 15k+300k = 315,000
    expect(r.totalAdditionsCents).toBe(165_000);
    expect(r.totalSubtractionsCents).toBe(315_000);
    expect(r.taxableIncomeCents).toBe(1_000_000 + 165_000 - 315_000);
    expect(r.taxableIncomeCents).toBe(850_000);
  });

  it('splits permanent vs temporary correctly (M-3 / ASC 740 dimension)', () => {
    const r = computeM1(1_000_000, diffs);
    expect(r.permanentAdditionsCents).toBe(65_000); // 25k + 40k
    expect(r.temporaryAdditionsCents).toBe(100_000);
    expect(r.permanentSubtractionsCents).toBe(15_000);
    expect(r.temporarySubtractionsCents).toBe(300_000);
    expect(r.permanentNetCents).toBe(65_000 - 15_000); // +50,000
    expect(r.temporaryNetCents).toBe(100_000 - 300_000); // −200,000
    // perm + temp net must equal total additions − total subtractions
    expect(r.permanentNetCents + r.temporaryNetCents).toBe(
      r.totalAdditionsCents - r.totalSubtractionsCents,
    );
  });

  it('places each difference on its labeled line, sorted largest-first', () => {
    const r = computeM1(1_000_000, diffs);
    expect(r.additions.map((l) => l.code)).toEqual(['ACCRUED_BONUS', 'PENALTIES_FINES', 'MEALS_50']);
    expect(r.subtractions.map((l) => l.code)).toEqual(['TAX_DEPR_EXCESS', 'TAX_EXEMPT_INTEREST']);
    expect(r.adjustmentCount).toBe(5);
    // each carries its cited code section from the standard catalog
    const meals = r.additions.find((l) => l.code === 'MEALS_50');
    expect(meals?.codeSection).toBe('§274(n)');
    expect(meals?.m1Line).toBe('5c');
  });
});

describe('computeM1 — aggregation by code', () => {
  it('collapses the same difference code from multiple accounts into one M-1 line', () => {
    const r = computeM1(0, [
      { code: 'MEALS_50', label: 'Meals', differenceType: 'PERMANENT', taxableEffect: 'ADD', amountCents: 10_000 },
      { code: 'MEALS_50', label: 'Meals', differenceType: 'PERMANENT', taxableEffect: 'ADD', amountCents: 5_000 },
    ]);
    expect(r.additions).toHaveLength(1);
    expect(r.additions[0].amountCents).toBe(15_000);
    expect(r.taxableIncomeCents).toBe(15_000);
  });
});

describe('computeM1 — a book loss can still yield positive taxable income', () => {
  it('handles a negative book NI with large permanent add-backs', () => {
    const r = computeM1(-200_000, [
      { code: 'PENALTIES_FINES', label: 'Fines', differenceType: 'PERMANENT', taxableEffect: 'ADD', amountCents: 500_000 },
    ]);
    expect(r.taxableIncomeCents).toBe(300_000);
  });
});

describe('standard catalog integrity', () => {
  it('every catalog code resolves and carries consistent fields', () => {
    for (const l of STANDARD_M_LINES) {
      const found = findMLine(l.code);
      expect(found).toBeDefined();
      expect(['PERMANENT', 'TEMPORARY']).toContain(l.differenceType);
      expect(['ADD', 'SUBTRACT']).toContain(l.taxableEffect);
      if (l.defaultDisallowancePct != null) {
        expect(l.defaultDisallowancePct).toBeGreaterThanOrEqual(0);
        expect(l.defaultDisallowancePct).toBeLessThanOrEqual(100);
      }
    }
  });
  it('has unique codes', () => {
    const codes = STANDARD_M_LINES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
