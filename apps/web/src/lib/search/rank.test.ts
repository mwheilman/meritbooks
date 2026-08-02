/**
 * Ranker tests — field weighting, amount boost, recency, and match derivation.
 */

import { describe, it, expect } from 'vitest';
import { computeScore, deriveFieldMatches, type ScoreInput } from './rank';
import type { AmountConstraint } from './types';

const NOW = Date.parse('2026-08-15T00:00:00Z');
const NO_AMOUNT: AmountConstraint = { exact: [], min: null, max: null };

function base(over: Partial<ScoreInput>): ScoreInput {
  return { fieldMatches: [], date: null, amountCents: null, amounts: NO_AMOUNT, nowMs: NOW, ...over };
}

describe('computeScore field weighting', () => {
  it('ranks an exact number match above an exact name match', () => {
    const num = computeScore(base({ fieldMatches: [{ field: 'number', kind: 'exact' }] }));
    const name = computeScore(base({ fieldMatches: [{ field: 'name', kind: 'exact' }] }));
    expect(num).toBeGreaterThan(name);
  });
  it('ranks an exact match above a partial on the same field', () => {
    const exact = computeScore(base({ fieldMatches: [{ field: 'name', kind: 'exact' }] }));
    const partial = computeScore(base({ fieldMatches: [{ field: 'name', kind: 'partial' }] }));
    expect(exact).toBeGreaterThan(partial);
  });
  it('does not stack repeated partials on the same field', () => {
    const one = computeScore(base({ fieldMatches: [{ field: 'name', kind: 'partial' }] }));
    const two = computeScore(base({ fieldMatches: [
      { field: 'name', kind: 'partial' },
      { field: 'name', kind: 'partial' },
    ] }));
    expect(two).toBe(one);
  });
  it('sums matches across different fields', () => {
    const combined = computeScore(base({ fieldMatches: [
      { field: 'name', kind: 'partial' },
      { field: 'memo', kind: 'partial' },
    ] }));
    const single = computeScore(base({ fieldMatches: [{ field: 'name', kind: 'partial' }] }));
    expect(combined).toBeGreaterThan(single);
  });
});

describe('computeScore amount boost', () => {
  it('boosts an exact amount match', () => {
    const amounts: AmountConstraint = { exact: [420000], min: null, max: null };
    const withAmt = computeScore(base({ fieldMatches: [{ field: 'name', kind: 'partial' }], amountCents: 420000, amounts }));
    const without = computeScore(base({ fieldMatches: [{ field: 'name', kind: 'partial' }] }));
    expect(withAmt).toBeGreaterThan(without);
  });
  it('is sign-agnostic (matches a negative bank amount)', () => {
    const amounts: AmountConstraint = { exact: [50000], min: null, max: null };
    const s = computeScore(base({ amountCents: -50000, amounts }));
    expect(s).toBeGreaterThan(0);
  });
});

describe('computeScore recency', () => {
  it('scores a newer dated hit above an older one', () => {
    const recent = computeScore(base({ fieldMatches: [{ field: 'name', kind: 'partial' }], date: '2026-08-01' }));
    const old = computeScore(base({ fieldMatches: [{ field: 'name', kind: 'partial' }], date: '2024-01-01' }));
    expect(recent).toBeGreaterThan(old);
  });
});

describe('deriveFieldMatches', () => {
  it('marks a whole-field equality as exact', () => {
    const m = deriveFieldMatches([{ field: 'number', value: '1042' }], [], ['1042']);
    expect(m).toEqual([{ field: 'number', kind: 'exact' }]);
  });
  it('marks a substring as partial', () => {
    const m = deriveFieldMatches([{ field: 'name', value: 'Home Depot' }], ['home'], []);
    expect(m).toEqual([{ field: 'name', kind: 'partial' }]);
  });
  it('ignores empty field values', () => {
    const m = deriveFieldMatches([{ field: 'memo', value: null }], ['x'], []);
    expect(m).toEqual([]);
  });
  it('prefers exact over partial when both could match', () => {
    const m = deriveFieldMatches([{ field: 'name', value: 'acme' }], ['acme', 'ac'], []);
    expect(m).toEqual([{ field: 'name', kind: 'exact' }]);
  });
});
