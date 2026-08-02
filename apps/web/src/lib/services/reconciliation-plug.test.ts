/**
 * Plug + stale-item detector (FPB Bank Reconciliation, Wave B).
 * Proves: stale items are flagged strictly past the threshold, oldest-first;
 * totals split checks vs deposits; the plug equals the residual and is never zeroed.
 */

import { describe, it, expect } from 'vitest';
import {
  ageDaysBetween,
  detectStaleItems,
  summarizeStaleItems,
  assessPlug,
  DEFAULT_STALE_THRESHOLD_DAYS,
  type OutstandingItem,
} from './reconciliation-plug';

const item = (over: Partial<OutstandingItem>): OutstandingItem => ({
  id: 'i1',
  description: 'Check 1001',
  amountCents: -50_00,
  transactionDate: '2026-01-01',
  ...over,
});

describe('ageDaysBetween', () => {
  it('counts whole days forward', () => {
    expect(ageDaysBetween('2026-01-01', '2026-01-31')).toBe(30);
  });
  it('clamps a future item at 0 (never negative)', () => {
    expect(ageDaysBetween('2026-02-15', '2026-01-31')).toBe(0);
  });
  it('returns 0 for an unparseable date', () => {
    expect(ageDaysBetween('not-a-date', '2026-01-31')).toBe(0);
  });
});

describe('detectStaleItems', () => {
  it('flags only items strictly older than the threshold', () => {
    const items = [
      item({ id: 'old', transactionDate: '2026-01-01' }), // 60d
      item({ id: 'edge', transactionDate: '2026-02-01' }), // exactly 29d -> not stale
      item({ id: 'fresh', transactionDate: '2026-02-25' }), // 5d
    ];
    const stale = detectStaleItems(items, { asOfDate: '2026-03-02', thresholdDays: 30 });
    expect(stale.map((s) => s.id)).toEqual(['old']);
    expect(stale[0].ageDays).toBe(60);
  });

  it('sorts flagged items oldest-first', () => {
    const items = [
      item({ id: 'a', transactionDate: '2026-01-15' }),
      item({ id: 'b', transactionDate: '2026-01-01' }),
      item({ id: 'c', transactionDate: '2026-01-20' }),
    ];
    const stale = detectStaleItems(items, { asOfDate: '2026-03-01', thresholdDays: 30 });
    expect(stale.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('marks outflow vs inflow', () => {
    const stale = detectStaleItems(
      [item({ id: 'chk', amountCents: -100_00 }), item({ id: 'dep', amountCents: 250_00 })],
      { asOfDate: '2026-06-01', thresholdDays: 30 },
    );
    expect(stale.find((s) => s.id === 'chk')?.isOutflow).toBe(true);
    expect(stale.find((s) => s.id === 'dep')?.isOutflow).toBe(false);
  });

  it('uses the default threshold when none is passed', () => {
    const stale = detectStaleItems([item({ transactionDate: '2026-01-01' })], { asOfDate: '2026-03-01' });
    expect(DEFAULT_STALE_THRESHOLD_DAYS).toBe(30);
    expect(stale).toHaveLength(1);
  });
});

describe('summarizeStaleItems', () => {
  it('splits checks and deposits and nets them', () => {
    const stale = detectStaleItems(
      [
        item({ id: 'chk1', amountCents: -100_00, transactionDate: '2026-01-01' }),
        item({ id: 'chk2', amountCents: -25_00, transactionDate: '2026-01-01' }),
        item({ id: 'dep1', amountCents: 40_00, transactionDate: '2026-01-01' }),
      ],
      { asOfDate: '2026-06-01', thresholdDays: 30 },
    );
    const t = summarizeStaleItems(stale);
    expect(t.count).toBe(3);
    expect(t.outstandingChecksCents).toBe(125_00);
    expect(t.depositsInTransitCents).toBe(40_00);
    expect(t.netCents).toBe(-85_00);
  });
});

describe('assessPlug', () => {
  it('reports a non-zero residual as the plug, never zeroing it', () => {
    const p = assessPlug(-1_234);
    expect(p.plugCents).toBe(-1_234);
    expect(p.hasPlug).toBe(true);
    expect(p.ties).toBe(false);
  });
  it('ties at exactly zero', () => {
    const p = assessPlug(0);
    expect(p.plugCents).toBe(0);
    expect(p.hasPlug).toBe(false);
    expect(p.ties).toBe(true);
  });
});
