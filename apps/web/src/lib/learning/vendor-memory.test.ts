/**
 * Vendor categorization memory (M14 learning layer) — pure-core guards.
 *
 * Covers the three properties the feature promises:
 *   1. RANKING — the account a vendor is coded to most is suggested first.
 *   2. CONFIDENCE FROM CONSISTENCY — a 9-of-10 history is high-confidence; a
 *      1-of-1 history is not; a split history is middling.
 *   3. CORRECTIONS WIN — because memory is recomputed from the latest approved
 *      history and is recency-weighted, a fresh re-coding outranks stale codings.
 * Plus the memory→confidence booster only ever RAISES an agreeing proposal and
 * caps below certainty (canon: AI proposes, human approves).
 */

import { describe, it, expect } from 'vitest';
import {
  rankSuggestions,
  boostConfidenceWithMemory,
  type ApprovedCoding,
} from './vendor-memory';

const AT = (daysAgo: number): string =>
  new Date(Date.UTC(2026, 6, 1) - daysAgo * 86_400_000).toISOString();

/** n codings to `accountId`, spread day-by-day starting `startDaysAgo` back. */
function codings(accountId: string, n: number, startDaysAgo: number, amountCents = 10_000): ApprovedCoding[] {
  return Array.from({ length: n }, (_, i) => ({ accountId, approvedAt: AT(startDaysAgo + i), amountCents }));
}

describe('rankSuggestions — ranking', () => {
  it('suggests the most-used account first', () => {
    const history = [...codings('supplies', 9, 0), ...codings('meals', 1, 20)];
    const ranked = rankSuggestions(history);
    expect(ranked[0].accountId).toBe('supplies');
    expect(ranked[0].count).toBe(9);
    expect(ranked[0].total).toBe(10);
  });

  it('returns nothing for an unseen vendor (no history)', () => {
    expect(rankSuggestions([])).toEqual([]);
  });
});

describe('rankSuggestions — confidence derived from consistency', () => {
  it('9 of 10 to one account is high confidence', () => {
    const history = [...codings('supplies', 9, 0), ...codings('meals', 1, 30)];
    const top = rankSuggestions(history)[0];
    expect(top.share).toBeCloseTo(0.9, 5);
    expect(top.confidence).toBeGreaterThan(0.85); // clears the auto-approve bar
    expect(top.confidence).toBeLessThan(1); // never certain
  });

  it('a single data point is low confidence even though share is 100%', () => {
    const top = rankSuggestions(codings('supplies', 1, 0))[0];
    expect(top.share).toBe(1);
    expect(top.confidence).toBeLessThan(0.4); // sample too thin to trust
  });

  it('a 50/50 split is middling and picks the more recent side', () => {
    const history = [...codings('a', 4, 10), ...codings('b', 4, 0)];
    const top = rankSuggestions(history)[0];
    expect(top.share).toBeCloseTo(0.5, 5);
    expect(top.confidence).toBeLessThan(0.6);
    expect(top.accountId).toBe('b'); // recency breaks the tie toward the newer coding
  });
});

describe('rankSuggestions — corrections win (recency-weighted)', () => {
  it('a recent correction streak outranks an equal-count older account', () => {
    // Historically coded to "wrong" 4x (older), then re-coded to "right" 4x (recent).
    const history = [...codings('wrong', 4, 30), ...codings('right', 4, 0)];
    const ranked = rankSuggestions(history);
    expect(ranked[0].accountId).toBe('right');
  });

  it('even a slightly smaller but recent correction can lead', () => {
    // 5 old codings vs 4 very recent corrections — recency lifts the correction.
    const history = [...codings('old', 5, 40), ...codings('corrected', 4, 0)];
    const ranked = rankSuggestions(history);
    expect(ranked[0].accountId).toBe('corrected');
  });

  it('a re-code enters the sample immediately, and a correction streak takes over', () => {
    const before = rankSuggestions(codings('a', 3, 5));
    expect(before[0].accountId).toBe('a');
    // One correction: "b" is now known, but 3 prior "a" codings still lead (as they should).
    const afterOne = rankSuggestions([...codings('a', 3, 5), ...codings('b', 1, 0)]);
    expect(afterOne.find((s) => s.accountId === 'b')).toBeDefined();
    expect(afterOne[0].accountId).toBe('a');
    // The human keeps correcting to "b": the recent streak now leads.
    const afterStreak = rankSuggestions([...codings('a', 3, 10), ...codings('b', 3, 0)]);
    expect(afterStreak[0].accountId).toBe('b');
  });
});

describe('rankSuggestions — amount affinity (optional)', () => {
  it('biases toward the account used for similar-sized charges', () => {
    // Two accounts, equal counts, but "big" was used for large charges.
    const history = [
      ...codings('small', 3, 0, 5_000),
      ...codings('big', 3, 1, 500_000),
    ];
    const ranked = rankSuggestions(history, { amountCents: 480_000 });
    expect(ranked[0].accountId).toBe('big');
  });
});

describe('boostConfidenceWithMemory', () => {
  const top = (over: Partial<Parameters<typeof boostConfidenceWithMemory>[2]> = {}) => ({
    accountId: 'supplies', accountNumber: '6100', accountName: 'Job Supplies', accountType: 'OPEX',
    count: 9, total: 10, share: 0.9, confidence: 0.9, lastUsedAt: AT(0), weightedScore: 5,
    ...over,
  });

  it('raises an agreeing proposal above the auto-approve bar', () => {
    const r = boostConfidenceWithMemory(0.7, 'supplies', top(), 'Home Depot');
    expect(r.applied).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.85);
    expect(r.note).toContain('9 of 10');
  });

  it('never claims certainty', () => {
    const r = boostConfidenceWithMemory(0.95, 'supplies', top({ confidence: 0.97 }));
    expect(r.confidence).toBeLessThan(1);
  });

  it('does not boost when memory disagrees with the proposal', () => {
    const r = boostConfidenceWithMemory(0.6, 'travel', top());
    expect(r.applied).toBe(false);
    expect(r.confidence).toBe(0.6);
  });

  it('does not boost off a single data point', () => {
    const r = boostConfidenceWithMemory(0.6, 'supplies', top({ count: 1, total: 1, confidence: 0.25 }));
    expect(r.applied).toBe(false);
  });

  it('is a no-op with no memory', () => {
    const r = boostConfidenceWithMemory(0.6, 'supplies', null);
    expect(r.applied).toBe(false);
    expect(r.confidence).toBe(0.6);
  });
});
