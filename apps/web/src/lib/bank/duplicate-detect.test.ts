import { describe, it, expect } from 'vitest';
import { findDuplicateGroups, normalizeDupDescription, duplicateIdSet, type DupTxn } from './duplicate-detect';

const t = (id: string, description: string, amountCents: number, date: string, status = 'PENDING'): DupTxn => ({
  id, description, amountCents, date, status,
});

describe('normalizeDupDescription', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeDupDescription('  ACH  Debit: Home-Depot #4021 ')).toBe('ach debit home depot 4021');
  });
  it('handles empty/nullish', () => {
    expect(normalizeDupDescription('')).toBe('');
    expect(normalizeDupDescription(null)).toBe('');
  });
});

describe('findDuplicateGroups', () => {
  it('flags same description + amount within the window', () => {
    const groups = findDuplicateGroups([
      t('a', 'ACME LLC INV 100', -50000, '2026-02-01'),
      t('b', 'ACME LLC INV 100', -50000, '2026-02-02'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].transactionIds).toEqual(['a', 'b']);
    expect(groups[0].amountCents).toBe(50000);
    expect(groups[0].hasOpen).toBe(true);
  });

  it('folds sign so a charge and its refund are grouped only by absolute amount', () => {
    // Same abs amount + same text within window → grouped (both are "the same line" candidates).
    const groups = findDuplicateGroups([
      t('a', 'STRIPE PAYOUT', 120000, '2026-02-01'),
      t('b', 'STRIPE PAYOUT', -120000, '2026-02-01'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
  });

  it('does NOT group when amounts differ', () => {
    const groups = findDuplicateGroups([
      t('a', 'ACME LLC', -50000, '2026-02-01'),
      t('b', 'ACME LLC', -50001, '2026-02-01'),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('does NOT group when dates are outside the window', () => {
    const groups = findDuplicateGroups(
      [
        t('a', 'RENT', -200000, '2026-02-01'),
        t('b', 'RENT', -200000, '2026-03-01'), // ~monthly recurring, not a duplicate
      ],
      { windowDays: 3 },
    );
    expect(groups).toHaveLength(0);
  });

  it('ignores rows with no textual signal (amount-only is too weak)', () => {
    const groups = findDuplicateGroups([
      t('a', '', -50000, '2026-02-01'),
      t('b', '   ', -50000, '2026-02-01'),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('marks hasOpen false when every member is already posted', () => {
    const groups = findDuplicateGroups([
      t('a', 'ACME', -50000, '2026-02-01', 'POSTED'),
      t('b', 'ACME', -50000, '2026-02-02', 'APPROVED'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].hasOpen).toBe(false);
  });

  it('duplicateIdSet flattens all member ids', () => {
    const groups = findDuplicateGroups([
      t('a', 'ACME', -50000, '2026-02-01'),
      t('b', 'ACME', -50000, '2026-02-02'),
      t('c', 'BETA', -9900, '2026-02-01'),
      t('d', 'BETA', -9900, '2026-02-01'),
    ]);
    const ids = duplicateIdSet(groups);
    expect(ids.size).toBe(4);
    expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
