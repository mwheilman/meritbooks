import { describe, expect, it } from 'vitest';
import { canIssueChecks, checkAccountsForPicker, checkIneligibleReason, defaultCheckAccountId, type CheckAccountCandidate } from './check-accounts';

const acct = (id: string, account_name: string, account_type = 'CHECKING', extra: Partial<CheckAccountCandidate> = {}): CheckAccountCandidate => ({
  id,
  account_name,
  account_type,
  institution_name: 'First Bank',
  is_active: true,
  ...extra,
});

describe('canIssueChecks', () => {
  it('accepts checking and operating accounts', () => {
    for (const n of ['Business Checking', 'Operating', 'Payroll Checking ••1234', 'Main account', 'Total Checking', 'DDA 0021']) {
      expect(canIssueChecks(acct('a', n)), n).toBe(true);
    }
  });

  it('rejects the retirement, health, investment and loan accounts Plaid stores as CHECKING', () => {
    for (const n of [
      '401k', '401(k) Plan', 'Roth IRA', 'Traditional IRA', 'IRA', 'HSA', 'Health Savings Account', 'Brokerage',
      'Mortgage', 'Student Loan', 'Auto Loan', 'Business Line of Credit', 'Savings', 'Money Market', 'CD 12-month',
      'Retirement', '529 College Plan', 'HELOC', 'Escrow',
    ]) {
      expect(canIssueChecks(acct('a', n)), n).toBe(false);
    }
  });

  it('looks at the institution name too', () => {
    expect(canIssueChecks(acct('a', 'Account', 'CHECKING', { institution_name: 'Fidelity Investments' }))).toBe(false);
  });

  it('rejects non-checking types and inactive accounts', () => {
    expect(checkIneligibleReason(acct('a', 'Operating', 'SAVINGS'))).toMatch(/checking/i);
    expect(checkIneligibleReason(acct('a', 'Operating', 'CREDIT_CARD'))).toMatch(/checking/i);
    expect(checkIneligibleReason(acct('a', 'Operating', 'CHECKING', { is_active: false }))).toMatch(/inactive/i);
  });
});

describe('checkAccountsForPicker', () => {
  const rows = [acct('z', 'Zeta account'), acct('h', 'HSA'), acct('o', 'Operating'), acct('b', 'Business Checking'), acct('p', 'Payables account')];

  it('filters and puts the stock-profile account first', () => {
    expect(checkAccountsForPicker(rows, new Set(['p'])).map((a) => a.id)).toEqual(['p', 'b', 'o', 'z']);
  });

  it('without a profile, checking/operating names lead', () => {
    expect(checkAccountsForPicker(rows, new Set()).map((a) => a.id)).toEqual(['b', 'o', 'p', 'z']);
  });

  it('is empty when nothing can issue checks', () => {
    expect(checkAccountsForPicker([acct('h', 'HSA'), acct('m', 'Mortgage')], new Set())).toEqual([]);
  });
});

describe('defaultCheckAccountId', () => {
  it('prefers the account with a stock profile, else the first, else null', () => {
    expect(defaultCheckAccountId([{ id: 'a' }, { id: 'b', hasStockProfile: true }])).toBe('b');
    expect(defaultCheckAccountId([{ id: 'a' }, { id: 'b' }])).toBe('a');
    expect(defaultCheckAccountId([])).toBeNull();
  });
});
