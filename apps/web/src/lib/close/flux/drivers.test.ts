/** AC-3E.3 — driver ranking: largest first, new counterparty, one-off, reclass, decomposition. */

import { describe, it, expect } from 'vitest';
import { NO_COUNTERPARTY, isReclass, rankDrivers, signatureOf, type DriverLineInput } from './drivers';

let seq = 0;
const L = (over: Partial<DriverLineInput>): DriverLineInput => {
  seq += 1;
  return {
    glLineId: `l${seq}`, glEntryId: `e${seq}`, entryNumber: `JE-${seq}`, entryDate: '2026-10-15', periodKey: '2026-10',
    memo: null, sourceModule: 'BILL', entryType: 'STANDARD', counterparty: null, netDebitCents: 0,
    entryAllSameStatement: false, entryTouchesCash: false, ...over,
  };
};

describe('rankDrivers', () => {
  const current = [
    L({ counterparty: 'Acme Supply', netDebitCents: 300_000, entryDate: '2026-10-03' }),
    L({ counterparty: 'Brand New LLC', netDebitCents: 1_200_000, memo: 'Emergency compressor', entryDate: '2026-10-20' }),
    L({ counterparty: 'Acme Supply', netDebitCents: 250_000 }),
    L({ sourceModule: 'MANUAL', memo: 'Reclass rent to COGS', netDebitCents: -400_000, entryAllSameStatement: true, entryTouchesCash: false, counterparty: null }),
    L({ sourceModule: 'RECURRING', memo: 'Monthly software', netDebitCents: 50_000 }),
  ];
  const comparison = [L({ periodKey: '2026-09', counterparty: 'Acme Supply', netDebitCents: 500_000 })];
  const prior = [
    L({ periodKey: '2026-08', counterparty: 'Acme Supply', netDebitCents: 450_000 }),
    L({ periodKey: '2026-07', memo: 'Monthly software', netDebitCents: 50_000, sourceModule: 'RECURRING' }),
  ];
  const d = rankDrivers({ sign: 1, current, comparison, prior, changeCents: 900_000 });

  it('ranks by |effect| and numbers refs L1..Ln', () => {
    expect(d.lines.map((x) => x.amountCents)).toEqual([1_200_000, -400_000, 300_000, 250_000, 50_000]);
    expect(d.lines.map((x) => x.ref)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    expect(d.lines.slice(0, 3).every((x) => x.tags.includes('LARGEST'))).toBe(true);
    expect(d.lines[3].tags).not.toContain('LARGEST');
  });

  it('flags a new counterparty and a one-off (≥ 25% of the change, never seen)', () => {
    expect(d.lines[0].tags).toEqual(expect.arrayContaining(['NEW_COUNTERPARTY', 'ONE_OFF']));
    expect(d.lines[2].tags).not.toContain('NEW_COUNTERPARTY'); // Acme seen before
  });

  it('a recurring-source line is never a one-off', () => {
    const sw = d.lines.find((x) => x.memo === 'Monthly software')!;
    expect(sw.tags).not.toContain('ONE_OFF');
  });

  it('detects a manual same-statement, no-cash entry as a reclass', () => {
    expect(d.lines[1].tags).toContain('RECLASS');
    expect(isReclass(L({ sourceModule: 'MANUAL', entryAllSameStatement: true, entryTouchesCash: true }))).toBe(false);
    expect(isReclass(L({ sourceModule: 'BILL', entryAllSameStatement: true }))).toBe(false);
    expect(isReclass(L({ sourceModule: 'BILL', entryType: 'ADJUSTING', entryAllSameStatement: true }))).toBe(true);
  });

  it('decomposes the change by counterparty (largest |change| first)', () => {
    expect(d.counterparties[0]).toMatchObject({ counterparty: 'Brand New LLC', currentCents: 1_200_000, comparisonCents: 0, changeCents: 1_200_000, isNew: true });
    const acme = d.counterparties.find((c) => c.counterparty === 'Acme Supply')!;
    expect(acme).toMatchObject({ currentCents: 550_000, comparisonCents: 500_000, changeCents: 50_000, isNew: false });
    expect(d.counterparties.some((c) => c.counterparty === NO_COUNTERPARTY)).toBe(true);
  });

  it('sums activity and counts lines', () => {
    expect(d.activityCents).toBe(1_200_000 + 300_000 + 250_000 - 400_000 + 50_000);
    expect(d.lineCount).toBe(5);
  });

  it('applies the credit-normal sign', () => {
    const r = rankDrivers({ sign: -1, current: [L({ netDebitCents: -900_000, counterparty: 'Client A' })], comparison: [], prior: [], changeCents: 900_000 });
    expect(r.lines[0].amountCents).toBe(900_000);
    expect(r.counterparties[0].changeCents).toBe(900_000);
  });

  it('caps the driver list', () => {
    const many = Array.from({ length: 20 }, (_, i) => L({ netDebitCents: (i + 1) * 100 }));
    expect(rankDrivers({ sign: 1, current: many, comparison: [], prior: [], changeCents: 1, limit: 8 }).lines).toHaveLength(8);
  });
});

describe('signatureOf', () => {
  it('prefers the counterparty, else the memo words without numbers', () => {
    expect(signatureOf({ counterparty: ' ACME ', memo: 'x' })).toBe('cp:acme');
    expect(signatureOf({ counterparty: null, memo: 'Invoice #1234 - Oct' })).toBe(signatureOf({ counterparty: null, memo: 'Invoice #9876 - Oct' }));
    expect(signatureOf({ counterparty: null, memo: '12' })).toBeNull();
  });
});
