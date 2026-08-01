/**
 * AI Cash Application matching logic — locks the confidence model, the single vs
 * sum-to-total selection, the payer-resolution gate, the subset-sum, the
 * auto→review tier floor (auto-post OFF), and the idempotent dedup_key.
 *
 * Pure logic only — no Supabase, no Date.now (dates are fixed ISO strings).
 */

import { describe, it, expect } from 'vitest';
import {
  scoreCashMatch,
  matchDeposit,
  subsetSumExact,
  resolveCashAppTier,
  cashAppDedupKey,
  toConfidence,
  cashAppReason,
  CASHAPP_THRESHOLDS,
  type DepositInput,
  type OpenInvoiceInput,
  type CashAppMatch,
} from './cash-application';
import type { TierPolicy } from '@/lib/trust/score-tier';

const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };

function deposit(over: Partial<DepositInput>): DepositInput {
  return { id: 'd1', locationId: 'loc1', date: '2026-03-14', amountCents: 500_000, description: 'ACH CREDIT', ...over };
}
function invoice(over: Partial<OpenInvoiceInput>): OpenInvoiceInput {
  return {
    id: 'i1',
    customerId: 'c1',
    invoiceNumber: 'INV-1042',
    invoiceDate: '2026-02-14',
    dueDate: '2026-03-14',
    balanceCents: 500_000,
    ...over,
  };
}
const CUSTOMERS = new Map<string, string>([
  ['c1', 'Acme Corp'],
  ['c2', 'Globex LLC'],
]);

describe('cashAppDedupKey', () => {
  it('is deterministic and one-per-deposit', () => {
    expect(cashAppDedupKey('bt-9')).toBe('cashapp:bt-9');
    expect(cashAppDedupKey('bt-9')).toBe(cashAppDedupKey('bt-9'));
    expect(cashAppDedupKey('bt-9')).not.toBe(cashAppDedupKey('bt-8'));
  });
});

describe('toConfidence', () => {
  it('clamps into the numeric(5,4) range', () => {
    expect(toConfidence(1.5)).toBeLessThanOrEqual(0.9999);
    expect(toConfidence(-1)).toBe(0);
    expect(toConfidence(Number.NaN)).toBe(0);
    expect(toConfidence(0.12345)).toBe(0.1235);
  });
});

describe('scoreCashMatch', () => {
  it('exact + unique + named payer + near date ⇒ near-certain', () => {
    const s = scoreCashMatch({
      deposit: deposit({ description: 'ACH ACME CORP INV1042' }),
      matchedBalanceCents: 500_000,
      customerName: 'Acme Corp',
      representativeDate: '2026-03-14',
      uniqueExactAmount: true,
    });
    expect(s.amountExact).toBe(true);
    expect(s.confidence).toBeGreaterThan(0.9);
  });

  it('exact + unique but ANONYMOUS line still surfaces on the uniqueness bonus', () => {
    const s = scoreCashMatch({
      deposit: deposit({ description: 'REMOTE DEPOSIT' }),
      matchedBalanceCents: 500_000,
      customerName: 'Acme Corp',
      representativeDate: '2026-03-14', // same day ⇒ date bonus
      uniqueExactAmount: true,
    });
    expect(s.customerScore).toBe(0); // no shared tokens
    expect(s.confidence).toBeGreaterThanOrEqual(CASHAPP_THRESHOLDS.minSurface);
  });

  it('exact but AMBIGUOUS (not unique) + anonymous ⇒ penalized below the floor', () => {
    const s = scoreCashMatch({
      deposit: deposit({ description: 'REMOTE DEPOSIT', date: '2026-06-01' }),
      matchedBalanceCents: 500_000,
      customerName: 'Acme Corp',
      representativeDate: '2026-03-14', // far ⇒ no date help
      uniqueExactAmount: false,
    });
    expect(s.confidence).toBeLessThan(CASHAPP_THRESHOLDS.minSurface);
  });
});

describe('subsetSumExact', () => {
  it('finds a subset summing exactly to the target (fewest, largest first)', () => {
    const items = [{ balanceCents: 7500 }, { balanceCents: 5000 }, { balanceCents: 2500 }];
    const got = subsetSumExact(items, 12_500);
    expect(got).not.toBeNull();
    expect(got!.reduce((n, x) => n + x.balanceCents, 0)).toBe(12_500);
  });

  it('requires at least two items (a single-invoice hit is not a "sum")', () => {
    const items = [{ balanceCents: 12_500 }, { balanceCents: 1 }];
    // 12_500 alone would hit target, but a lump remittance must be >= 2 invoices.
    expect(subsetSumExact(items, 12_500)).toBeNull();
  });

  it('returns null when no exact subset exists', () => {
    const items = [{ balanceCents: 3000 }, { balanceCents: 4000 }];
    expect(subsetSumExact(items, 10_000)).toBeNull();
  });
});

describe('matchDeposit', () => {
  it('single exact + unique ⇒ a single-invoice application', () => {
    const m = matchDeposit(
      deposit({ description: 'ACH ACME CORP' }),
      [invoice({}), invoice({ id: 'i2', customerId: 'c2', invoiceNumber: 'INV-2000', balanceCents: 990_000 })],
      CUSTOMERS,
    );
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('single');
    expect(m!.invoiceIds).toEqual(['i1']);
    expect(m!.customerId).toBe('c1');
    expect(m!.score.confidence).toBeGreaterThanOrEqual(CASHAPP_THRESHOLDS.minSurface);
  });

  it('anonymous line but a UNIQUE exact-amount invoice still surfaces', () => {
    const m = matchDeposit(
      deposit({ description: 'REMOTE DEPOSIT' }),
      [invoice({})],
      CUSTOMERS,
    );
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('single');
  });

  it('anonymous line + AMBIGUOUS exact amount (two invoices share it) ⇒ no proposal', () => {
    const m = matchDeposit(
      deposit({ description: 'REMOTE DEPOSIT', date: '2026-06-01' }),
      [
        invoice({ id: 'i1', customerId: 'c1', balanceCents: 500_000, dueDate: '2026-01-01' }),
        invoice({ id: 'i2', customerId: 'c2', balanceCents: 500_000, dueDate: '2026-01-01' }),
      ],
      CUSTOMERS,
    );
    expect(m).toBeNull();
  });

  it('lump remittance from a RESOLVED payer ⇒ sum-to-total across invoices', () => {
    const m = matchDeposit(
      deposit({ amountCents: 1_250_000, description: 'ACH ACME CORP LOCKBOX' }),
      [
        invoice({ id: 'i1', customerId: 'c1', invoiceNumber: 'INV-1', balanceCents: 750_000 }),
        invoice({ id: 'i2', customerId: 'c1', invoiceNumber: 'INV-2', balanceCents: 500_000 }),
      ],
      CUSTOMERS,
    );
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('sum_to_total');
    expect(m!.invoiceIds.sort()).toEqual(['i1', 'i2']);
    expect(m!.matchedBalanceCents).toBe(1_250_000);
  });

  it('does NOT attempt a lump remittance for an UNRESOLVED payer', () => {
    const m = matchDeposit(
      deposit({ amountCents: 1_250_000, description: 'DEPOSIT' }),
      [
        invoice({ id: 'i1', customerId: 'c1', balanceCents: 750_000 }),
        invoice({ id: 'i2', customerId: 'c1', balanceCents: 500_000 }),
      ],
      CUSTOMERS,
    );
    // Neither invoice matches the amount singly, and the payer isn't resolvable.
    expect(m).toBeNull();
  });

  it('never returns a match below the surfacing floor', () => {
    const m = matchDeposit(
      deposit({ amountCents: 500_000, description: 'X', date: '2026-06-01' }),
      [invoice({ id: 'i1', customerId: 'c1', balanceCents: 470_000, dueDate: '2026-01-01' })], // ~6% off ⇒ amountScore 0
      CUSTOMERS,
    );
    expect(m).toBeNull();
  });
});

describe('resolveCashAppTier — auto-post is OFF, so auto floors to review', () => {
  it('floors a would-be auto to review (AI proposes, never moves money)', () => {
    expect(resolveCashAppTier(0.99, 100_000, POLICY)).toBe('review');
  });
  it('review stays review', () => {
    expect(resolveCashAppTier(0.75, 100_000, POLICY)).toBe('review');
  });
  it('below the review threshold escalates', () => {
    expect(resolveCashAppTier(0.5, 100_000, POLICY)).toBe('escalate');
  });
});

describe('cashAppReason', () => {
  it('single-invoice reason names the invoice, balance, and customer', () => {
    const match: CashAppMatch = {
      kind: 'single',
      invoiceIds: ['i1'],
      customerId: 'c1',
      customerName: 'Acme Corp',
      matchedBalanceCents: 500_000,
      representativeDate: '2026-03-14',
      score: { confidence: 0.9, amountScore: 1, customerScore: 1, dateScore: 1, amountExact: true, explanation: '' },
    };
    const r = cashAppReason(deposit({}), match, new Map([['i1', 'INV-1042']]));
    expect(r).toContain('INV-1042');
    expect(r).toContain('Acme Corp');
    expect(r).toContain('$5,000');
  });

  it('sum-to-total reason lists every invoice and the total', () => {
    const match: CashAppMatch = {
      kind: 'sum_to_total',
      invoiceIds: ['i1', 'i2'],
      customerId: 'c1',
      customerName: 'Acme Corp',
      matchedBalanceCents: 1_250_000,
      representativeDate: '2026-03-14',
      score: { confidence: 0.9, amountScore: 1, customerScore: 1, dateScore: 1, amountExact: true, explanation: '' },
    };
    const r = cashAppReason(
      deposit({ amountCents: 1_250_000 }),
      match,
      new Map([['i1', 'INV-1'], ['i2', 'INV-2']]),
    );
    expect(r).toContain('INV-1');
    expect(r).toContain('INV-2');
    expect(r).toContain('2 open invoices');
  });
});
