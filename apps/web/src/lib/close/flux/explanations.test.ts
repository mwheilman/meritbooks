/** AC-3E.4 / AC-3E.7 — explanation rules: validation, staleness, SoD, carry-forward. */

import { describe, it, expect } from 'vitest';
import { carryForwardSuggestion, isStale, lineStatus, reviewDecision, validateSubmission } from './explanations';
import type { FluxExplanation } from './types';

const E = (over: Partial<FluxExplanation> = {}): FluxExplanation => ({
  id: 'x1', locationId: 'loc', periodKey: '2026-10', lineKey: 'acct', accountId: 'acct', status: 'EXPLAINED',
  explanation: 'Timing of the October insurance renewal.', category: 'TIMING', comparisonBasis: 'PRIOR_MONTH',
  currentCents: 2_000_000, comparisonCents: 1_000_000, changeCents: 1_000_000, changePctBps: 10_000,
  attachmentDocumentId: null, draftedByAi: false, aiDecisionId: null, carriedFromId: null,
  preparedBy: 'user_prep', preparedAt: '2026-11-03T00:00:00Z', reviewedBy: null, reviewedAt: null, reviewNote: null, explanationHash: 'h', reviewedExplanationHash: null, updatedAt: null,
  ...over,
});

describe('validateSubmission', () => {
  it('needs ≥ 10 characters and a category', () => {
    expect(validateSubmission('too short', 'TIMING').ok).toBe(false);
    expect(validateSubmission('Insurance renewal paid early', 'NOPE').ok).toBe(false);
    expect(validateSubmission('  Insurance renewal paid early  ', 'TIMING')).toEqual({ ok: true, text: 'Insurance renewal paid early', category: 'TIMING' });
    expect(validateSubmission('x'.repeat(4001), 'TIMING').ok).toBe(false);
  });
});

describe('isStale / lineStatus', () => {
  it('stale once the live change moves ≥ max($100, 5%)', () => {
    expect(isStale(1_000_000, 1_049_999)).toBe(false); // 5% of $10k = $500
    expect(isStale(1_000_000, 1_050_000)).toBe(true);
    expect(isStale(50_000, 59_999)).toBe(false); // floor $100
    expect(isStale(50_000, 60_000)).toBe(true);
  });

  it('maps an explanation to a line status', () => {
    expect(lineStatus(null, 5)).toBe('UNEXPLAINED');
    expect(lineStatus(E({ status: 'DRAFT' }), 1_000_000)).toBe('DRAFT');
    expect(lineStatus(E(), 1_000_000)).toBe('EXPLAINED');
    expect(lineStatus(E({ status: 'REVIEWED' }), 1_000_000)).toBe('REVIEWED');
    expect(lineStatus(E({ status: 'REVIEWED' }), 2_000_000)).toBe('STALE');
  });
});

describe('reviewDecision — segregation of duties', () => {
  it('the preparer can never review their own explanation', () => {
    expect(reviewDecision(E(), 'user_prep', 1_000_000)).toMatchObject({ ok: false, code: 'SOD' });
    expect(reviewDecision(E({ preparedBy: null }), 'user_rev', 1_000_000)).toMatchObject({ ok: false, code: 'SOD' });
  });

  it('a different person can review a submitted, current explanation', () => {
    expect(reviewDecision(E(), 'user_rev', 1_000_000)).toEqual({ ok: true });
  });

  it('refuses drafts, already-reviewed and stale explanations', () => {
    expect(reviewDecision(E({ status: 'DRAFT' }), 'user_rev', 1_000_000)).toMatchObject({ ok: false, code: 'NOT_SUBMITTED' });
    expect(reviewDecision(E({ status: 'REVIEWED' }), 'user_rev', 1_000_000)).toMatchObject({ ok: false, code: 'ALREADY_REVIEWED' });
    expect(reviewDecision(E(), 'user_rev', 3_000_000)).toMatchObject({ ok: false, code: 'STALE' });
  });
});

describe('carryForwardSuggestion', () => {
  it('offers last month for a recurring category', () => {
    const s = carryForwardSuggestion([E({ id: 'sep', periodKey: '2026-09', category: 'TIMING' })], '2026-10');
    expect(s).toMatchObject({ fromId: 'sep', periodKey: '2026-09', category: 'TIMING' });
    expect(s!.reason).toMatch(/timing/i);
  });

  it('offers a non-recurring category only when it repeats in 2 of the last 3 months', () => {
    const once = [E({ id: 'sep', periodKey: '2026-09', category: 'ONE_TIME' })];
    expect(carryForwardSuggestion(once, '2026-10')).toBeNull();
    const twice = [E({ id: 'sep', periodKey: '2026-09', category: 'RECLASS' }), E({ id: 'aug', periodKey: '2026-08', category: 'RECLASS' })];
    expect(carryForwardSuggestion(twice, '2026-10')).toMatchObject({ fromId: 'sep', reason: 'Reclass in 2 of the last 3 months' });
  });

  it('ignores drafts, empty history and the current month', () => {
    expect(carryForwardSuggestion([], '2026-10')).toBeNull();
    expect(carryForwardSuggestion([E({ periodKey: '2026-09', status: 'DRAFT' })], '2026-10')).toBeNull();
    expect(carryForwardSuggestion([E({ periodKey: '2026-10' })], '2026-10')).toBeNull();
  });
});
