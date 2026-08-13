/**
 * Pure onboarding-kit helpers: confidence-band mapping + board-card status derivation.
 * These gate the "review, don't enter" UX invariants (spec §5 thresholds, §3 board).
 */

import { describe, it, expect } from 'vitest';
import {
  confidenceBand,
  confidenceLabel,
  deriveBoardCardStatus,
} from './helpers';

describe('confidenceBand (spec §5 thresholds)', () => {
  it('>= 0.90 is high, bulk-acceptable', () => {
    expect(confidenceBand(0.9)).toBe('high');
    expect(confidenceBand(0.99, 'ai')).toBe('high');
    expect(confidenceBand(1)).toBe('high');
  });

  it('0.60–0.89 is review', () => {
    expect(confidenceBand(0.6)).toBe('review');
    expect(confidenceBand(0.75, 'heuristic')).toBe('review');
    expect(confidenceBand(0.89)).toBe('review');
  });

  it('< 0.60 or null/NaN is needs-you (never guessed)', () => {
    expect(confidenceBand(0.59)).toBe('needs-you');
    expect(confidenceBand(0)).toBe('needs-you');
    expect(confidenceBand(null)).toBe('needs-you');
    expect(confidenceBand(undefined)).toBe('needs-you');
    expect(confidenceBand(Number.NaN)).toBe('needs-you');
  });

  it('a human-sourced value is always high; unmapped is always needs-you', () => {
    expect(confidenceBand(0.1, 'human')).toBe('high');
    expect(confidenceBand(0.99, 'unmapped')).toBe('needs-you');
  });
});

describe('deriveBoardCardStatus (spec §3 board)', () => {
  it('done wins over detected', () => {
    expect(deriveBoardCardStatus({ done: true, detected: true })).toBe('done');
    expect(deriveBoardCardStatus({ done: true })).toBe('done');
  });

  it('detected surfaces when not done', () => {
    expect(deriveBoardCardStatus({ detected: true })).toBe('detected');
  });

  it('defaults to the neutral add-later (never a red nag)', () => {
    expect(deriveBoardCardStatus({})).toBe('add-later');
    expect(deriveBoardCardStatus({ done: false, detected: false })).toBe('add-later');
  });
});

describe('confidenceLabel', () => {
  it('gives plain-language labels for each band', () => {
    expect(confidenceLabel('high')).toBe('High confidence');
    expect(confidenceLabel('review')).toBe('Worth a look');
    expect(confidenceLabel('needs-you')).toBe('Needs you');
  });
});
