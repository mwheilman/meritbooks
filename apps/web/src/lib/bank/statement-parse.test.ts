import { describe, it, expect } from 'vitest';
import {
  normalizeStatementExtraction,
  computeBalanceTie,
  dedupeKey,
  mapStatementAccountType,
  signFactorForType,
} from './statement-parse';

describe('mapStatementAccountType', () => {
  it('maps direct enum values', () => {
    expect(mapStatementAccountType('CHECKING')).toBe('CHECKING');
    expect(mapStatementAccountType('credit_card')).toBe('CREDIT_CARD');
  });
  it('maps free-form language', () => {
    expect(mapStatementAccountType('Visa Signature Credit Card')).toBe('CREDIT_CARD');
    expect(mapStatementAccountType('Business Money Market')).toBe('SAVINGS');
    expect(mapStatementAccountType('Commercial Operating Checking')).toBe('CHECKING');
    expect(mapStatementAccountType('Revolving Line of Credit')).toBe('LINE_OF_CREDIT');
  });
  it('returns null when unknown', () => {
    expect(mapStatementAccountType('foobar')).toBeNull();
    expect(mapStatementAccountType(42)).toBeNull();
    expect(mapStatementAccountType('')).toBeNull();
  });
});

describe('signFactorForType', () => {
  it('is +1 for asset accounts and -1 for liability accounts', () => {
    expect(signFactorForType('CHECKING')).toBe(1);
    expect(signFactorForType('SAVINGS')).toBe(1);
    expect(signFactorForType('CREDIT_CARD')).toBe(-1);
    expect(signFactorForType('LINE_OF_CREDIT')).toBe(-1);
  });
});

describe('dedupeKey', () => {
  it('normalizes description whitespace + case', () => {
    expect(dedupeKey('2026-07-01', -1200, '  Acme   Corp  ')).toBe('2026-07-01|-1200|ACME CORP');
  });
  it('distinguishes on signed amount', () => {
    expect(dedupeKey('2026-07-01', -1200, 'x')).not.toBe(dedupeKey('2026-07-01', 1200, 'x'));
  });
  it('handles null date/amount', () => {
    expect(dedupeKey(null, null, 'X')).toBe('||X');
  });
});

describe('normalizeStatementExtraction — asset (checking) account', () => {
  const raw = {
    account: { name: 'Operating', account_number: '****6789', type: 'checking' },
    period_start: '2026-07-01',
    period_end: '2026-07-31',
    opening_balance: 1000, // dollars
    closing_balance: 1150,
    transactions: [
      { transaction_date: '2026-07-03', description: 'Client Deposit', amount: 500, direction: 'money_in', confidence: 0.98 },
      { transaction_date: '2026-07-10', description: 'Office Rent', amount: 350, direction: 'money_out', confidence: 0.95 },
    ],
    document_note: null,
  };

  it('signs amounts by direction (money_out negative, money_in positive) in cents', () => {
    const s = normalizeStatementExtraction(raw, { accountType: 'CHECKING' });
    expect(s.transactions).toHaveLength(2);
    expect(s.transactions[0].amount_cents).toBe(50000);
    expect(s.transactions[1].amount_cents).toBe(-35000);
    expect(s.openingCents).toBe(100000);
    expect(s.closingCents).toBe(115000);
    expect(s.account.last4).toBe('6789');
    expect(s.account.type).toBe('CHECKING');
    expect(s.periodStart).toBe('2026-07-01');
  });

  it('ties out: closing - opening = sum(signed amounts)', () => {
    const s = normalizeStatementExtraction(raw, { accountType: 'CHECKING' });
    expect(s.balanceTie.checkable).toBe(true);
    expect(s.balanceTie.sumCents).toBe(15000); // +500 - 350 = +150.00
    expect(s.balanceTie.expectedSumCents).toBe(15000); // 1150 - 1000
    expect(s.balanceTie.differenceCents).toBe(0);
    expect(s.balanceTie.tied).toBe(true);
  });

  it('flags a mismatch when the lines do not foot to the balance delta', () => {
    const bad = { ...raw, closing_balance: 2000 };
    const s = normalizeStatementExtraction(bad, { accountType: 'CHECKING' });
    expect(s.balanceTie.expectedSumCents).toBe(100000); // 2000 - 1000
    expect(s.balanceTie.differenceCents).toBe(-85000);
    expect(s.balanceTie.tied).toBe(false);
  });
});

describe('normalizeStatementExtraction — liability (credit card) account', () => {
  // Opening owed 500; charged 200, paid 300 => new balance owed 400.
  const raw = {
    account: { name: 'Rewards Visa', last4: '4321', type: 'CREDIT_CARD' },
    opening_balance: 500,
    closing_balance: 400,
    transactions: [
      { transaction_date: '2026-07-05', description: 'Supplies', amount: 200, direction: 'money_out', confidence: 0.9 },
      { transaction_date: '2026-07-20', description: 'Payment Received', amount: 300, direction: 'money_in', confidence: 0.9 },
    ],
  };

  it('ties liability-side: closing - opening = -sum(signed amounts)', () => {
    const s = normalizeStatementExtraction(raw, { accountType: 'CREDIT_CARD' });
    // charge money_out => -200_00; payment money_in => +300_00 ; sum = +100_00
    expect(s.balanceTie.sumCents).toBe(10000);
    // signFactor -1 * (400 - 500) = -1 * -100_00 = +100_00
    expect(s.balanceTie.expectedSumCents).toBe(10000);
    expect(s.balanceTie.differenceCents).toBe(0);
    expect(s.balanceTie.tied).toBe(true);
  });
});

describe('computeBalanceTie — not checkable when a balance is missing', () => {
  it('marks not checkable but still sums, and never contradicts', () => {
    const tie = computeBalanceTie(null, 500_00, [{ amount_cents: 100 }, { amount_cents: -50 }], 'CHECKING');
    expect(tie.checkable).toBe(false);
    expect(tie.sumCents).toBe(50);
    expect(tie.expectedSumCents).toBeNull();
    expect(tie.tied).toBe(true);
  });
});

describe('normalizeStatementExtraction — robustness', () => {
  it('returns an empty, not-checkable statement for garbage input', () => {
    const s = normalizeStatementExtraction(null, { accountType: 'CHECKING' });
    expect(s.transactions).toEqual([]);
    expect(s.balanceTie.checkable).toBe(false);
    expect(s.balanceTie.sumCents).toBe(0);
  });

  it('parses parenthesized/negative/comma dollar strings and infers direction from sign', () => {
    const s = normalizeStatementExtraction(
      {
        opening_balance: '$1,000.00',
        closing_balance: '$650.00',
        transactions: [
          { transaction_date: '2026-07-02', description: 'ACH DEBIT', amount: '(350.00)' },
          { transaction_date: '2026-07-02', description: 'Junk Row' }, // no amount, no direction — kept but flagged
        ],
      },
      { accountType: 'CHECKING' },
    );
    expect(s.openingCents).toBe(100000);
    expect(s.closingCents).toBe(65000);
    // '(350.00)' parsed to a negative magnitude => direction inferred money_out => -35000
    expect(s.transactions[0].amount_cents).toBe(-35000);
    expect(s.transactions[0].direction).toBe('money_out');
    // second line: no amount => null, flagged low confidence
    expect(s.transactions[1].amount_cents).toBeNull();
    expect(s.transactions[1].lowConfidence).toBe(true);
  });

  it('drops fully-empty noise rows (no description and no amount)', () => {
    const s = normalizeStatementExtraction(
      { transactions: [{ confidence: 0.5 }, { description: 'Real', amount: 10, direction: 'money_in' }] },
      { accountType: 'SAVINGS' },
    );
    expect(s.transactions).toHaveLength(1);
    expect(s.transactions[0].description).toBe('Real');
  });

  it('assigns deterministic _id per line index', () => {
    const s = normalizeStatementExtraction(
      {
        transactions: [
          { description: 'A', amount: 1, direction: 'money_in' },
          { description: 'B', amount: 2, direction: 'money_out' },
        ],
      },
      { accountType: 'CHECKING' },
    );
    expect(s.transactions.map((t) => t._id)).toEqual(['t0', 't1']);
  });

  it('rejects impossible calendar dates (Feb 30)', () => {
    const s = normalizeStatementExtraction(
      { transactions: [{ transaction_date: '2026-02-30', description: 'X', amount: 5, direction: 'money_in' }] },
      { accountType: 'CHECKING' },
    );
    expect(s.transactions[0].transaction_date).toBeNull();
    expect(s.transactions[0].lowConfidence).toBe(true);
  });
});
