import { describe, it, expect } from 'vitest';
import { normalizeTrialBalance, isNonAccountRow } from './parse-tb';

describe('normalizeTrialBalance — happy path (balanced TB)', () => {
  const raw = {
    lines: [
      { account_number: '1000', account_name: 'Cash', debit: 5000, credit: null, confidence: 0.98, snippet: '1000 Cash 5,000.00' },
      { account_number: '1200', account_name: 'Accounts Receivable', debit: 3000, credit: null, confidence: 0.95 },
      { account_number: '2000', account_name: 'Accounts Payable', debit: null, credit: 2000, confidence: 0.9 },
      { account_number: '3000', account_name: 'Owner Equity', debit: null, credit: 6000, confidence: 0.9 },
    ],
    document_note: null,
  };
  const out = normalizeTrialBalance(raw);

  it('keeps every real account line', () => {
    expect(out.lines).toHaveLength(4);
  });

  it('computes totals in CENTS (dollars * 100)', () => {
    expect(out.totalDebitCents).toBe(800000); // (5000 + 3000) * 100
    expect(out.totalCreditCents).toBe(800000); // (2000 + 6000) * 100
  });

  it('ties out', () => {
    expect(out.differenceCents).toBe(0);
    expect(out.balanced).toBe(true);
  });

  it('echoes cents per line', () => {
    const cash = out.lines.find((l) => l.account_number === '1000');
    expect(cash?.debitCents).toBe(500000);
    expect(cash?.creditCents).toBe(0);
    expect(cash?.debit).toBe(5000);
    expect(cash?.credit).toBeNull();
  });
});

describe('normalizeTrialBalance — out of balance', () => {
  const out = normalizeTrialBalance({
    lines: [
      { account_number: '1000', account_name: 'Cash', debit: 5000, credit: null, confidence: 1 },
      { account_number: '3000', account_name: 'Equity', debit: null, credit: 4000, confidence: 1 },
    ],
  });
  it('flags the imbalance in cents', () => {
    expect(out.balanced).toBe(false);
    expect(out.differenceCents).toBe(100000); // 500000 - 400000
  });
});

describe('normalizeTrialBalance — drops non-account rows', () => {
  const out = normalizeTrialBalance({
    lines: [
      { account_number: '1000', account_name: 'Cash', debit: 5000, credit: null, confidence: 1 },
      { account_number: null, account_name: 'Total Assets', debit: 5000, credit: null, confidence: 1 },
      { account_number: null, account_name: 'Net Income', debit: null, credit: 5000, confidence: 1 },
      { account_number: '9999', account_name: 'Totals', debit: 5000, credit: 5000, confidence: 1 }, // both sides = total row
      { account_number: null, account_name: null, debit: null, credit: null }, // blank
      { account_number: '5000', account_name: 'Suspense', debit: null, credit: 5000, confidence: 1 },
    ],
  });

  it('keeps only the two real accounts', () => {
    expect(out.lines.map((l) => l.account_name).sort()).toEqual(['Cash', 'Suspense']);
  });

  it('records every dropped row with a reason (never silent)', () => {
    expect(out.dropped.length).toBe(4);
  });

  it('ties out on the retained lines', () => {
    expect(out.balanced).toBe(true);
    expect(out.totalDebitCents).toBe(500000);
    expect(out.totalCreditCents).toBe(500000);
  });
});

describe('normalizeTrialBalance — money parsing & folding', () => {
  it('parses "$1,234.56" and parenthesized negatives, folding sign to the opposite column', () => {
    const out = normalizeTrialBalance({
      lines: [
        { account_number: '1000', account_name: 'Cash', debit: '$1,234.56', credit: null, confidence: 1 },
        // A negative debit is really a credit balance — fold it.
        { account_number: '2000', account_name: 'Note Payable', debit: '(1,234.56)', credit: null, confidence: 1 },
      ],
    });
    const cash = out.lines.find((l) => l.account_number === '1000');
    const note = out.lines.find((l) => l.account_number === '2000');
    expect(cash?.debitCents).toBe(123456);
    expect(note?.debit).toBeNull();
    expect(note?.creditCents).toBe(123456);
    expect(out.balanced).toBe(true);
  });

  it('drops zero-balance accounts (nothing to post)', () => {
    const out = normalizeTrialBalance({
      lines: [
        { account_number: '1000', account_name: 'Cash', debit: 0, credit: 0, confidence: 1 },
        { account_number: '1100', account_name: 'AR', debit: 10, credit: null, confidence: 1 },
        { account_number: '3000', account_name: 'Equity', debit: null, credit: 10, confidence: 1 },
      ],
    });
    expect(out.lines).toHaveLength(2);
    expect(out.dropped.some((d) => /zero balance/i.test(d.reason))).toBe(true);
  });
});

describe('normalizeTrialBalance — defensive', () => {
  it('never throws on garbage; yields an empty balanced result', () => {
    for (const junk of [null, undefined, 42, 'x', {}, { lines: 'nope' }, { lines: [null, 1, 'x'] }]) {
      const out = normalizeTrialBalance(junk);
      expect(out.lines).toEqual([]);
      expect(out.balanced).toBe(true);
      expect(out.totalDebitCents).toBe(0);
    }
  });

  it('reads alternate list keys (rows/accounts) and alternate field names', () => {
    const out = normalizeTrialBalance({
      rows: [
        { account: '1000', name: 'Cash', debit: 100, confidence: 1 },
        { account_code: '3000', account_name: 'Equity', credit: 100, confidence: 1 },
      ],
    });
    expect(out.lines).toHaveLength(2);
    expect(out.balanced).toBe(true);
  });
});

describe('isNonAccountRow', () => {
  it('drops a both-sided (totals) row', () => {
    expect(isNonAccountRow({ accountNumber: '9', accountName: 'x', debitDollars: 5, creditDollars: 5 })).toBeTruthy();
  });
  it('drops a summary label with no code', () => {
    expect(isNonAccountRow({ accountNumber: null, accountName: 'Total Liabilities', debitDollars: null, creditDollars: 100 })).toBeTruthy();
  });
  it('keeps a real coded account', () => {
    expect(isNonAccountRow({ accountNumber: '1000', accountName: 'Cash', debitDollars: 100, creditDollars: null })).toBeNull();
  });
});
