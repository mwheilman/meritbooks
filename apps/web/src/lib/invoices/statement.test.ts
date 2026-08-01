import { describe, it, expect } from 'vitest';
import {
  daysPastDue,
  agingBucketFor,
  computeAging,
  totalBalanceCents,
  summarizeStatement,
} from './statement';

const AS_OF = '2026-08-01';

describe('daysPastDue', () => {
  it('is 0 when due today', () => {
    expect(daysPastDue('2026-08-01', AS_OF)).toBe(0);
  });
  it('is negative when not yet due', () => {
    expect(daysPastDue('2026-08-15', AS_OF)).toBe(-14);
  });
  it('counts whole days past due', () => {
    expect(daysPastDue('2026-07-02', AS_OF)).toBe(30);
    expect(daysPastDue('2026-07-01', AS_OF)).toBe(31);
  });
  it('is DST-safe (uses UTC date math, not local midnight)', () => {
    // A US DST boundary window — naive local-time subtraction would drift by an
    // hour and mis-round; UTC keeps the day count exact.
    expect(daysPastDue('2026-03-01', '2026-03-31')).toBe(30);
  });
  it('returns 0 for malformed dates rather than NaN', () => {
    expect(daysPastDue('', AS_OF)).toBe(0);
    expect(daysPastDue('2026-08-01', 'nope')).toBe(0);
  });
});

describe('agingBucketFor', () => {
  it('current when not yet due or due today', () => {
    expect(agingBucketFor('2026-08-01', AS_OF)).toBe('current');
    expect(agingBucketFor('2026-09-01', AS_OF)).toBe('current');
  });
  it('bucket boundaries are inclusive at 30/60/90', () => {
    expect(agingBucketFor('2026-07-31', AS_OF)).toBe('d1_30'); // 1 day
    expect(agingBucketFor('2026-07-02', AS_OF)).toBe('d1_30'); // 30 days
    expect(agingBucketFor('2026-07-01', AS_OF)).toBe('d31_60'); // 31 days
    expect(agingBucketFor('2026-06-02', AS_OF)).toBe('d31_60'); // 60 days
    expect(agingBucketFor('2026-06-01', AS_OF)).toBe('d61_90'); // 61 days
    expect(agingBucketFor('2026-05-03', AS_OF)).toBe('d61_90'); // 90 days
    expect(agingBucketFor('2026-05-02', AS_OF)).toBe('d90_plus'); // 91 days
  });
});

describe('computeAging', () => {
  it('buckets open balances by days past due and ignores paid lines', () => {
    const lines = [
      { dueDate: '2026-08-15', balanceCents: 100_00 }, // current (future)
      { dueDate: '2026-07-20', balanceCents: 250_00 }, // 12 days -> 1-30
      { dueDate: '2026-06-15', balanceCents: 400_00 }, // 47 days -> 31-60
      { dueDate: '2026-05-10', balanceCents: 300_00 }, // 83 days -> 61-90
      { dueDate: '2026-01-01', balanceCents: 500_00 }, // >90
      { dueDate: '2026-07-01', balanceCents: 0 }, // fully paid — contributes nothing
    ];
    expect(computeAging(lines, AS_OF)).toEqual({
      current: 100_00,
      d1_30: 250_00,
      d31_60: 400_00,
      d61_90: 300_00,
      d90_plus: 500_00,
    });
  });

  it('never ages a credit (negative balance) into a bucket', () => {
    const lines = [
      { dueDate: '2026-01-01', balanceCents: 200_00 },
      { dueDate: '2026-01-01', balanceCents: -50_00 }, // credit memo residue
    ];
    const aging = computeAging(lines, AS_OF);
    expect(aging.d90_plus).toBe(200_00);
    const sum = Object.values(aging).reduce((a, b) => a + b, 0);
    expect(sum).toBe(200_00);
  });
});

describe('totalBalanceCents', () => {
  it('sums positive balances only (credits do not reduce what is owed)', () => {
    const lines = [
      { balanceCents: 100_00 },
      { balanceCents: 250_00 },
      { balanceCents: -75_00 },
      { balanceCents: 0 },
    ];
    expect(totalBalanceCents(lines)).toBe(350_00);
  });
});

describe('summarizeStatement', () => {
  it('aging total ties to the total balance due', () => {
    const lines = [
      { dueDate: '2026-08-15', balanceCents: 100_00 },
      { dueDate: '2026-07-20', balanceCents: 250_00 },
      { dueDate: '2026-01-01', balanceCents: 500_00 },
      { dueDate: '2026-07-01', balanceCents: 0 },
    ];
    const { aging, totalBalanceCents: total, openInvoiceCount } = summarizeStatement(lines, AS_OF);
    const agingSum = Object.values(aging).reduce((a, b) => a + b, 0);
    expect(agingSum).toBe(total); // the fundamental statement invariant
    expect(total).toBe(850_00);
    expect(openInvoiceCount).toBe(3);
  });

  it('is all-zero for a fully-paid account', () => {
    const lines = [
      { dueDate: '2026-07-01', balanceCents: 0 },
      { dueDate: '2026-06-01', balanceCents: 0 },
    ];
    const s = summarizeStatement(lines, AS_OF);
    expect(s.totalBalanceCents).toBe(0);
    expect(s.openInvoiceCount).toBe(0);
    expect(Object.values(s.aging).every((v) => v === 0)).toBe(true);
  });
});
