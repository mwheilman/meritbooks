import { describe, it, expect } from 'vitest';
import { scoreToTier, type TierPolicy } from './score-tier';

const policy: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };

describe('scoreToTier', () => {
  it('auto when confidence >= auto threshold and within cap', () => {
    expect(scoreToTier({ confidence: 0.92, amountCents: 5000 }, policy).tier).toBe('auto');
    expect(scoreToTier({ confidence: 0.85, amountCents: 5000 }, policy).tier).toBe('auto');
  });

  it('review when between review and auto thresholds', () => {
    expect(scoreToTier({ confidence: 0.75 }, policy).tier).toBe('review');
    expect(scoreToTier({ confidence: 0.7 }, policy).tier).toBe('review');
  });

  it('escalate when below the review threshold', () => {
    expect(scoreToTier({ confidence: 0.69 }, policy).tier).toBe('escalate');
    expect(scoreToTier({ confidence: 0.1 }, policy).tier).toBe('escalate');
  });

  it('blocks auto (falls to review) when the amount exceeds the cap', () => {
    const r = scoreToTier({ confidence: 0.99, amountCents: 2_000_000 }, policy);
    expect(r.tier).toBe('review');
    expect(r.reason).toMatch(/cap/i);
  });

  it('blocks auto (falls to review) when the vendor is explicitly untrusted', () => {
    expect(scoreToTier({ confidence: 0.99, amountCents: 100, trustedVendor: false }, policy).tier).toBe('review');
  });

  it('no cap (null) never blocks on amount', () => {
    const noCap: TierPolicy = { ...policy, autoMaxCents: null };
    expect(scoreToTier({ confidence: 0.99, amountCents: 999_999_999 }, noCap).tier).toBe('auto');
  });

  it('reason strings are populated for every tier', () => {
    expect(scoreToTier({ confidence: 0.9 }, policy).reason).toBeTruthy();
    expect(scoreToTier({ confidence: 0.75 }, policy).reason).toBeTruthy();
    expect(scoreToTier({ confidence: 0.5 }, policy).reason).toBeTruthy();
  });
});
