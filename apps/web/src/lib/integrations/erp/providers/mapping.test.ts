/**
 * Direct-API migration providers — mapping-profile + adapter unit tests.
 *
 * These lock the correctness-critical seams:
 *   • Each provider's mapping profile transforms a native record → the MeritBooks
 *     normalized (cents) shape correctly.
 *   • The credential-gated real adapter degrades safe (not-connected) without creds.
 *   • The mock adapter returns a balanced trial balance whose conversion-input shape
 *     is exactly what the existing /api/onboarding/conversion route accepts.
 */

import { describe, it, expect } from 'vitest';
import {
  transformTrialBalanceRow,
  transformParty,
  transformOpenItem,
  getMigrationProvider,
  MockConnectorProvider,
  RealConnectorProvider,
  trialBalanceToConversionInput,
  conversionMapping,
  conversionMappingIsValid,
  centsToDecimalString,
} from './index';
import type { MigrationProviderId } from './index';

describe('mapping profiles → normalized trial balance (cents)', () => {
  it('QBO: AcctNum/Name/Debit/Credit (string dollars) → cents', () => {
    const row = transformTrialBalanceRow('quickbooks', {
      AcctNum: '1000',
      Name: 'Checking',
      Debit: '84250.00',
      Credit: '',
    });
    expect(row).toEqual({
      accountCode: '1000',
      accountName: 'Checking',
      debitCents: 8_425_000,
      creditCents: 0,
    });
  });

  it('Xero: AccountCode/AccountName/Debit/Credit (number dollars) → cents', () => {
    const row = transformTrialBalanceRow('xero', {
      AccountCode: '2000',
      AccountName: 'Accounts Payable',
      Debit: 0,
      Credit: 18750,
    });
    expect(row).toEqual({
      accountCode: '2000',
      accountName: 'Accounts Payable',
      debitCents: 0,
      creditCents: 1_875_000,
    });
  });

  it('Sage: nominal_code/name/debit/credit (string dollars) → cents', () => {
    const row = transformTrialBalanceRow('sage', {
      nominal_code: '3000',
      name: "Owner's Capital",
      debit: '0.00',
      credit: '138500.00',
    });
    expect(row).toEqual({
      accountCode: '3000',
      accountName: "Owner's Capital",
      debitCents: 0,
      creditCents: 13_850_000,
    });
  });

  it('maps parties and open items using provider-native field names', () => {
    const cust = transformParty('quickbooks', { Id: '1', DisplayName: 'Northwind', PrimaryEmailAddr: 'a@b.co', PrimaryPhone: '515' }, 'customers');
    expect(cust).toEqual({ externalId: '1', name: 'Northwind', email: 'a@b.co', phone: '515' });

    const ap = transformOpenItem('xero', { Contact: 'Timber & Co', InvoiceNumber: 'BILL-880', Date: '2025-12-11', DueDate: '2026-01-10', Total: 14250, AmountDue: 14250 }, 'openAP');
    expect(ap.partyName).toBe('Timber & Co');
    expect(ap.balanceCents).toBe(1_425_000);
  });
});

describe('centsToDecimalString (integer-only, no float)', () => {
  it('formats cents to a decimal-dollar string; 0 → empty', () => {
    expect(centsToDecimalString(8_425_000)).toBe('84250.00');
    expect(centsToDecimalString(1_875_050)).toBe('18750.50');
    expect(centsToDecimalString(5)).toBe('0.05');
    expect(centsToDecimalString(0)).toBe('');
    expect(centsToDecimalString(-1_23)).toBe('-1.23');
  });
});

describe('credential-gated real adapter degrades safe', () => {
  const ids: MigrationProviderId[] = ['quickbooks', 'xero', 'sage'];

  for (const id of ids) {
    it(`${id}: returns not-connected with no credentials`, async () => {
      const provider = new RealConnectorProvider(id, {} as NodeJS.ProcessEnv);
      expect(provider.hasCredentials()).toBe(false);
      const res = await provider.fetchTrialBalance();
      expect(res.connected).toBe(false);
      if (!res.connected) expect(res.reason).toMatch(/not connected/i);
    });
  }

  it('getMigrationProvider(default) is the credential-gated real adapter', async () => {
    const provider = getMigrationProvider('xero', { env: {} as NodeJS.ProcessEnv });
    const res = await provider.fetchAccounts();
    expect(res.connected).toBe(false);
  });
});

describe('mock adapter → conversion-input feeds the existing pipeline', () => {
  it('the synthetic mapping only references known conversion field keys', () => {
    expect(conversionMappingIsValid()).toBe(true);
    expect(conversionMapping()).toMatchObject({
      source_account: expect.any(String),
      debit_cents: expect.any(String),
      credit_cents: expect.any(String),
    });
  });

  const ids: MigrationProviderId[] = ['quickbooks', 'xero', 'sage'];
  for (const id of ids) {
    it(`${id}: mock trial balance is balanced and shapes into conversion rows`, async () => {
      const provider = getMigrationProvider(id, { mock: true });
      expect(provider).toBeInstanceOf(MockConnectorProvider);
      const res = await provider.fetchTrialBalance();
      expect(res.connected).toBe(true);
      if (!res.connected) return;
      expect(res.source).toBe('mock');

      // Debits must equal credits (a valid opening TB that can post).
      const debits = res.records.reduce((s, r) => s + r.debitCents, 0);
      const credits = res.records.reduce((s, r) => s + r.creditCents, 0);
      expect(debits).toBe(credits);
      expect(debits).toBeGreaterThan(0);

      // Shapes into the { mapping, rows } input the conversion route accepts.
      const input = trialBalanceToConversionInput(res.records);
      expect(Object.keys(input.mapping)).toContain('source_account');
      expect(input.rows.length).toBe(res.records.filter((r) => r.accountCode).length);
      const header = input.mapping.source_account;
      expect(input.rows[0][header]).toBeTruthy();
    });
  }
});
