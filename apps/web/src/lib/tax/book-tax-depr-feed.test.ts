import { describe, it, expect } from 'vitest';
import { classifyDepreciationDifference, BOOK_DEPR_EXCESS_CODE, TAX_DEPR_EXCESS_CODE } from './book-tax-depr-feed';
import { findMLine } from './book-tax';

describe('classifyDepreciationDifference — book-vs-tax temporary M-1 difference', () => {
  it('book > tax → BOOK_DEPR_EXCESS, an ADD (M-1 line 5a)', () => {
    const d = classifyDepreciationDifference(500_000, 300_000);
    expect(d).not.toBeNull();
    expect(d!.code).toBe(BOOK_DEPR_EXCESS_CODE);
    expect(d!.taxableEffect).toBe('ADD');
    expect(d!.differenceType).toBe('TEMPORARY');
    expect(d!.amountCents).toBe(200_000);
  });

  it('tax > book → TAX_DEPR_EXCESS, a SUBTRACT (M-1 line 8a), positive magnitude', () => {
    const d = classifyDepreciationDifference(300_000, 1_000_000);
    expect(d!.code).toBe(TAX_DEPR_EXCESS_CODE);
    expect(d!.taxableEffect).toBe('SUBTRACT');
    expect(d!.amountCents).toBe(700_000); // |300k − 1,000k|
  });

  it('book == tax → no difference (null, degrade-safe)', () => {
    expect(classifyDepreciationDifference(450_000, 450_000)).toBeNull();
    expect(classifyDepreciationDifference(0, 0)).toBeNull();
  });

  it('the emitted codes exist in the M-1 catalog and are TEMPORARY', () => {
    for (const code of [BOOK_DEPR_EXCESS_CODE, TAX_DEPR_EXCESS_CODE]) {
      const def = findMLine(code);
      expect(def).toBeDefined();
      expect(def!.differenceType).toBe('TEMPORARY');
    }
    expect(findMLine(BOOK_DEPR_EXCESS_CODE)!.taxableEffect).toBe('ADD');
    expect(findMLine(TAX_DEPR_EXCESS_CODE)!.taxableEffect).toBe('SUBTRACT');
  });
});
