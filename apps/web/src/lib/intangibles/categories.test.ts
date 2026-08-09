import { describe, it, expect } from 'vitest';
import {
  INTANGIBLE_CATEGORIES,
  INTANGIBLE_CATEGORY_LABELS,
  NON_AMORTIZING_CATEGORIES,
  isIntangibleCategory,
  isNonAmortizing,
  type IntangibleCategory,
} from './categories';

describe('intangibles/categories', () => {
  it('gives every canonical category a human label', () => {
    for (const c of INTANGIBLE_CATEGORIES) {
      expect(INTANGIBLE_CATEGORY_LABELS[c]).toBeTruthy();
    }
    // No stray labels beyond the canonical set.
    expect(Object.keys(INTANGIBLE_CATEGORY_LABELS).sort()).toEqual([...INTANGIBLE_CATEGORIES].sort());
  });

  it('prefixes every category with INTANGIBLE_ so it never collides with tangible categories', () => {
    for (const c of INTANGIBLE_CATEGORIES) {
      expect(c.startsWith('INTANGIBLE_')).toBe(true);
    }
    // A tangible category must not be misread as intangible.
    expect(isIntangibleCategory('EQUIPMENT')).toBe(false);
    expect(isIntangibleCategory('VEHICLE')).toBe(false);
  });

  describe('isIntangibleCategory', () => {
    it('accepts canonical values', () => {
      for (const c of INTANGIBLE_CATEGORIES) {
        expect(isIntangibleCategory(c)).toBe(true);
      }
    });

    it('accepts any forward-compatible INTANGIBLE_-prefixed value', () => {
      expect(isIntangibleCategory('INTANGIBLE_FUTURE_KIND')).toBe(true);
    });

    it('rejects null, undefined, and empty', () => {
      expect(isIntangibleCategory(null)).toBe(false);
      expect(isIntangibleCategory(undefined)).toBe(false);
      expect(isIntangibleCategory('')).toBe(false);
    });
  });

  describe('isNonAmortizing', () => {
    it('treats goodwill as non-amortizing (ASC 350) and everything else as amortizing', () => {
      expect(isNonAmortizing('INTANGIBLE_GOODWILL')).toBe(true);
      const amortizing = INTANGIBLE_CATEGORIES.filter((c) => c !== 'INTANGIBLE_GOODWILL');
      for (const c of amortizing) {
        expect(isNonAmortizing(c)).toBe(false);
      }
    });

    it('is null-safe', () => {
      expect(isNonAmortizing(null)).toBe(false);
      expect(isNonAmortizing(undefined)).toBe(false);
    });

    it('agrees with the shared NON_AMORTIZING_CATEGORIES set', () => {
      for (const c of INTANGIBLE_CATEGORIES) {
        expect(isNonAmortizing(c)).toBe(NON_AMORTIZING_CATEGORIES.has(c as IntangibleCategory));
      }
    });
  });
});
