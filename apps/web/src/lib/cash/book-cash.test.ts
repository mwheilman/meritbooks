import { describe, it, expect } from 'vitest';
import { cashSeries, selectCashAccountIds, sumCashAsOf, type CashAccountCandidate, type CashLine } from './book-cash';

// The live chart of accounts for the tenant in audit L6.
const ACCOUNTS: CashAccountCandidate[] = [
  { id: 'a1000', account_number: '1000', account_type: 'ASSET', is_bank_account: true, is_credit_card: false }, // Operating Checking
  { id: 'a1010', account_number: '1010', account_type: 'ASSET', is_bank_account: true, is_credit_card: false }, // Payroll Checking
  { id: 'a1020', account_number: '1020', account_type: 'ASSET', is_bank_account: true, is_credit_card: false }, // Savings
  { id: 'a1050', account_number: '1050', account_type: 'ASSET', is_bank_account: false, is_credit_card: false }, // Petty Cash (role default)
  { id: 'a1090', account_number: '1090', account_type: 'ASSET', is_bank_account: false, is_credit_card: false }, // Undeposited Funds (mapped)
  { id: 'a1095', account_number: '1095', account_type: 'ASSET', is_bank_account: false, is_credit_card: false }, // Processor clearing — NOT cash
  { id: 'a1160', account_number: '1160', account_type: 'ASSET', is_bank_account: false, is_credit_card: false }, // IC receivable — NOT cash
  { id: 'a2100', account_number: '2100', account_type: 'LIABILITY', is_bank_account: true, is_credit_card: true }, // credit card
];
const ROLES = [{ role_key: 'UNDEPOSITED_FUNDS', account_id: 'a1090' }];

const COHO = 'loc-coho';
const NWC = 'loc-nwc';
const l = (accountId: string, locationId: string, entryDate: string, debitCents: number, creditCents: number): CashLine => ({
  accountId,
  locationId,
  entryDate,
  debitCents,
  creditCents,
});

// Every posted cash-account line on the live ledger (gl_entry_lines, POSTED).
const LINES: CashLine[] = [
  l('a1000', COHO, '2024-09-17', 106_000_000, 0), // term-loan proceeds
  l('a1000', COHO, '2024-09-17', 40_000_000, 0), // revolver proceeds
  l('a1010', COHO, '2026-04-12', 50_000, 0),
  l('a1010', COHO, '2026-05-11', 0, 1_200),
  l('a1010', COHO, '2026-05-12', 50_000, 0),
  l('a1010', COHO, '2026-05-29', 0, 50_000),
  l('a1000', COHO, '2026-06-04', 0, 5_000_000), // intercompany truck payment
  l('a1095', NWC, '2026-07-28', 9_700, 0), // processor clearing — excluded
  l('a1000', NWC, '2026-06-04', 5_000_000, 0),
  l('a2100', COHO, '2026-06-10', 0, 41_000), // card charge — excluded
];

describe('canonical cash (lib/cash/book-cash) — audit L6 tie-out', () => {
  const ids = selectCashAccountIds(ACCOUNTS, ROLES);

  it('cash accounts = bank-flagged (non-card) + cash-role accounts; never clearing / IC / cards', () => {
    expect([...ids].sort()).toEqual(['a1000', 'a1010', 'a1020', 'a1050', 'a1090']);
  });

  it('Coho book cash as of 2026-10-19 is $1,410,488.00 (dashboard had $213.5K bank-feed, board $0)', () => {
    const cash = sumCashAsOf(LINES, ids, '2026-10-19', [COHO]);
    expect(cash.totalCents).toBe(141_048_800);
    // Payroll Checking (1010) is cash too — the old role-only snapshot read $1.41M without it.
    expect(cash.byAccount.a1010).toBe(48_800);
    expect(cash.byAccount.a1000).toBe(141_000_000);
  });

  it('company scope + as-of date', () => {
    expect(sumCashAsOf(LINES, ids, '2026-10-19', [NWC]).totalCents).toBe(5_000_000);
    expect(sumCashAsOf(LINES, ids, '2026-06-03', [COHO]).totalCents).toBe(146_048_800);
    const all = sumCashAsOf(LINES, ids, '2026-10-19');
    expect(all.totalCents).toBe(146_048_800);
    expect(all.byLocation).toEqual({ [COHO]: 141_048_800, [NWC]: 5_000_000 });
  });

  it('series (cash-flow bookends / trend) uses the same definition', () => {
    expect(cashSeries(LINES, ids, ['2026-09-30', '2026-10-31'], [COHO])).toEqual([141_048_800, 141_048_800]);
  });

  it('an explicit role mapping replaces the default-number fallback for that role', () => {
    const custom = selectCashAccountIds(ACCOUNTS, [{ role_key: 'CASH_ON_HAND', account_id: 'a1020' }]);
    expect(custom.has('a1050')).toBe(false); // CASH_ON_HAND mapped elsewhere
    expect(custom.has('a1090')).toBe(true); // UNDEPOSITED_FUNDS falls back to 1090
  });
});
