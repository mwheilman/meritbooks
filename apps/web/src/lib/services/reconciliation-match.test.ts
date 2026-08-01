/**
 * Reconciliation match scoring — locks the documented composite weights
 * (Vendor 40% + Amount 40% + Date 20%) and the individual similarity curves.
 *
 * The composite is the whole point of the reconciliation autopilot: change a
 * weight or a curve and every AI proposal + tier decision shifts, so these
 * assertions are the guardrail.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  vendorSimilarity,
  amountSimilarity,
  dateSimilarity,
  compositeMatchScore,
  toMatchConfidence,
  MATCH_WEIGHTS,
} from './reconciliation-match';

describe('normalizeText', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeText('HOME DEPOT #4021  ')).toBe('home depot 4021');
    expect(normalizeText('AMZN Mktp US*2Z9')).toBe('amzn mktp us 2z9');
    expect(normalizeText(null)).toBe('');
  });
});

describe('vendorSimilarity', () => {
  it('scores a fully-contained vendor name high', () => {
    expect(vendorSimilarity('HOME DEPOT #4021', 'Home Depot')).toBeGreaterThan(0.9);
  });
  it('scores unrelated text at zero', () => {
    expect(vendorSimilarity('SHELL OIL 887', 'Comcast Business')).toBe(0);
  });
  it('returns 0 when either side is empty', () => {
    expect(vendorSimilarity('', 'Home Depot')).toBe(0);
    expect(vendorSimilarity('Home Depot', '')).toBe(0);
  });
});

describe('amountSimilarity', () => {
  it('is 1 for an exact cents match (sign-insensitive)', () => {
    expect(amountSimilarity(-125000, 125000)).toBe(1);
  });
  it('degrades to 0 at a 5% difference (relative to the larger amount)', () => {
    // diff 5000 / max 100000 = 0.05 → curve hits 0
    expect(amountSimilarity(95000, 100000)).toBe(0);
  });
  it('is partial within tolerance', () => {
    const s = amountSimilarity(100000, 101000); // 1% off
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe('dateSimilarity', () => {
  it('is 1 for the same day', () => {
    expect(dateSimilarity('2026-03-10', '2026-03-10')).toBe(1);
  });
  it('is 0 at 30+ days apart', () => {
    expect(dateSimilarity('2026-03-01', '2026-04-30')).toBe(0);
  });
  it('is ~0.5 at 15 days apart', () => {
    expect(dateSimilarity('2026-03-01', '2026-03-16')).toBeCloseTo(0.5, 2);
  });
});

describe('compositeMatchScore', () => {
  it('applies the documented 40/40/20 weights', () => {
    expect(MATCH_WEIGHTS).toEqual({ vendor: 0.4, amount: 0.4, date: 0.2 });
  });

  it('a perfect vendor+amount+date match scores 1.0', () => {
    const b = compositeMatchScore({
      txnText: 'HOME DEPOT #4021',
      txnAmountCents: -125000,
      txnDate: '2026-03-10',
      candidateText: 'Home Depot',
      candidateAmountCents: 125000,
      candidateDate: '2026-03-10',
    });
    expect(b.amountScore).toBe(1);
    expect(b.dateScore).toBe(1);
    expect(b.score).toBeGreaterThan(0.9);
  });

  it('exact amount + date but wrong vendor caps at the 0.6 non-vendor weight', () => {
    const b = compositeMatchScore({
      txnText: 'RANDOM ACH DEBIT',
      txnAmountCents: -50000,
      txnDate: '2026-03-10',
      candidateText: 'Totally Different Vendor',
      candidateAmountCents: 50000,
      candidateDate: '2026-03-10',
    });
    // vendor 0 → composite = 0.4*amount + 0.2*date = 0.6
    expect(b.vendorScore).toBe(0);
    expect(b.score).toBeCloseTo(0.6, 5);
  });
});

describe('toMatchConfidence', () => {
  it('clamps into the numeric(5,4) range', () => {
    expect(toMatchConfidence(1)).toBe(0.9999);
    expect(toMatchConfidence(-1)).toBe(0);
    expect(toMatchConfidence(0.87654)).toBe(0.8765);
  });
});
