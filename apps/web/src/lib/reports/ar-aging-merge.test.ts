import { describe, it, expect } from 'vitest';
import {
  mergeArAging,
  AR_BUCKET_ORDER,
  type BilledInvoiceLine,
  type UnbilledJobRow,
} from './ar-aging-merge';

function billed(
  customerName: string,
  agingBucket: string,
  balanceCents: number,
  invoiceNumber = 'INV',
): BilledInvoiceLine {
  return { customerName, agingBucket, balanceCents, invoiceNumber, invoiceDate: '2026-01-01', dueDate: '2026-02-01', locationName: 'Co' };
}

function unbilled(customerName: string, buckets: Partial<Record<string, number>>, jobLabel: string | null = 'Job'): UnbilledJobRow {
  const full = { CURRENT: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0, ...buckets };
  const totalCents = AR_BUCKET_ORDER.reduce((s, b) => s + (full[b] ?? 0), 0);
  return { customerName, jobLabel, buckets: full, totalCents };
}

describe('mergeArAging — combine billed + unbilled by customer', () => {
  it('sums billed and unbilled per bucket into one combined customer row', () => {
    const m = mergeArAging(
      [billed('Acme', 'CURRENT', 10000), billed('Acme', '31-60', 5000)],
      [unbilled('Acme', { CURRENT: 2000, '31-60': 3000 })],
    );
    expect(m.customers).toHaveLength(1);
    const c = m.customers[0];
    expect(c.customerName).toBe('Acme');
    // combined per-bucket = billed + unbilled
    expect(c.buckets.CURRENT).toBe(12000);
    expect(c.buckets['31-60']).toBe(8000);
    expect(c.totalCents).toBe(20000);
    // children carry their own split
    expect(c.billed.totalCents).toBe(15000);
    expect(c.unbilled.totalCents).toBe(5000);
    expect(c.billed.buckets.CURRENT).toBe(10000);
    expect(c.unbilled.buckets['31-60']).toBe(3000);
  });

  it('renders customers with only-billed, only-unbilled, or both — missing side is zero', () => {
    const m = mergeArAging(
      [billed('OnlyBilled', 'CURRENT', 4000)],
      [unbilled('OnlyUnbilled', { '1-30': 7000 })],
    );
    const map = new Map(m.customers.map((c) => [c.customerName, c]));
    const ob = map.get('OnlyBilled')!;
    expect(ob.hasBilled).toBe(true);
    expect(ob.hasUnbilled).toBe(false);
    expect(ob.unbilled.totalCents).toBe(0);
    expect(ob.buckets.CURRENT).toBe(4000);
    const ou = map.get('OnlyUnbilled')!;
    expect(ou.hasBilled).toBe(false);
    expect(ou.hasUnbilled).toBe(true);
    expect(ou.billed.totalCents).toBe(0);
    expect(ou.buckets['1-30']).toBe(7000);
  });

  it('grand combined total ties to billed subtotal + unbilled subtotal', () => {
    const m = mergeArAging(
      [billed('A', 'CURRENT', 10000), billed('B', '90+', 25000), billed('A', '1-30', 5000)],
      [unbilled('A', { CURRENT: 1000 }), unbilled('C', { '61-90': 8000 })],
    );
    expect(m.billedTotalCents).toBe(40000);
    expect(m.unbilledTotalCents).toBe(9000);
    expect(m.combinedTotalCents).toBe(49000);
    expect(m.combinedTotalCents).toBe(m.billedTotalCents + m.unbilledTotalCents);
    // per-bucket combined ties too
    const perBucketSum = AR_BUCKET_ORDER.reduce((s, b) => s + m.combinedTotals[b], 0);
    expect(perBucketSum).toBe(49000);
    // and combined = billed band + unbilled band, band by band
    for (const b of AR_BUCKET_ORDER) {
      expect(m.combinedTotals[b]).toBe(m.billedTotals[b] + m.unbilledTotals[b]);
    }
  });

  it('sorts customers by combined total descending (most material first)', () => {
    const m = mergeArAging(
      [billed('Small', 'CURRENT', 1000), billed('Big', 'CURRENT', 50000)],
      [unbilled('Medium', { CURRENT: 20000 })],
    );
    expect(m.customers.map((c) => c.customerName)).toEqual(['Big', 'Medium', 'Small']);
  });
});
