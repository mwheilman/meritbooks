import { describe, expect, it } from 'vitest';
import { accountReadiness, disabledReasonText, pickCollectionConnection } from './payment-accounts';
import { accountView, feeLines } from './payments-overview';
import { accountDetailsFromObject, destinationOf } from './providers/stripe';
import { DEFAULT_FEE_SCHEDULE } from './fees';
import type { ConnectedAccountSnapshot, ProviderConnection } from './providers/types';

const READY: ConnectedAccountSnapshot = { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, disabledReason: null, requirementsDue: [], payoutBankName: 'Chase', payoutBankLast4: '6789', checkedAt: '2026-10-23T00:00:00Z' };
const UNKNOWN: ConnectedAccountSnapshot = { chargesEnabled: null, payoutsEnabled: null, detailsSubmitted: null, disabledReason: null, requirementsDue: [], payoutBankName: null, payoutBankLast4: null, checkedAt: null };

function conn(p: Partial<ProviderConnection> & { id: string }): ProviderConnection {
  return {
    orgId: 'org', capability: 'AR_COLLECTION', provider: 'stripe', environment: 'test', locationId: null,
    accountHandle: `acct_${p.id}`, secretRef: null, status: 'active', connectedBy: 'u', statusDetail: null, metadata: {},
    account: READY, createdAt: '', updatedAt: '', ...p,
  };
}

const A = 'loc-a';
const B = 'loc-b';
const C = 'loc-c';
const all = [
  conn({ id: 'A', locationId: A }),
  conn({ id: 'B', locationId: B }),
  conn({ id: 'T', locationId: null }),
  conn({ id: 'A-live', locationId: A, environment: 'live' }),
  conn({ id: 'plaid', capability: 'BANK_FEED', provider: 'plaid', locationId: C }),
];

describe('per-company collection routing (FPB §17.2)', () => {
  it("company A's invoice collects into A's account, B's into B's", () => {
    expect(pickCollectionConnection(all, { locationId: A, mode: 'per_company', environment: 'test' }).connection?.accountHandle).toBe('acct_A');
    expect(pickCollectionConnection(all, { locationId: B, mode: 'per_company', environment: 'test' }).connection?.accountHandle).toBe('acct_B');
  });

  it('per-company mode (default): a company without its own account gets no account — never the tenant one', () => {
    const p = pickCollectionConnection(all, { locationId: C, mode: 'per_company', environment: 'test' });
    expect(p.connection).toBeNull();
    expect(p.ready).toBe(false);
  });

  it('single mode: a company without its own account falls back to the tenant-level account', () => {
    const p = pickCollectionConnection(all, { locationId: C, mode: 'single', environment: 'test' });
    expect(p.connection?.accountHandle).toBe('acct_T');
    expect(p.source).toBe('tenant');
    // …and a company WITH its own account still uses it.
    expect(pickCollectionConnection(all, { locationId: A, mode: 'single', environment: 'test' }).source).toBe('company');
  });

  it('only connections of the current environment are used (a test acct is never charged under a live key)', () => {
    expect(pickCollectionConnection(all, { locationId: A, mode: 'per_company', environment: 'live' }).connection?.id).toBe('A-live');
    expect(pickCollectionConnection(all, { locationId: B, mode: 'single', environment: 'live' }).connection).toBeNull();
  });

  it('inactive / handle-less / non-Stripe rows are ignored; charges disabled → not ready', () => {
    const rows = [conn({ id: 'x', locationId: A, status: 'disconnected' }), conn({ id: 'y', locationId: B, accountHandle: null }), conn({ id: 'z', locationId: C, account: { ...READY, chargesEnabled: false } })];
    expect(pickCollectionConnection(rows, { locationId: A, mode: 'single', environment: 'test' }).connection).toBeNull();
    expect(pickCollectionConnection(rows, { locationId: B, mode: 'single', environment: 'test' }).connection).toBeNull();
    const z = pickCollectionConnection(rows, { locationId: C, mode: 'per_company', environment: 'test' });
    expect(z.connection?.id).toBe('z');
    expect(z.ready).toBe(false);
    // never-checked accounts are NOT ready: no pay link until Stripe confirms charges (1G-1).
    expect(pickCollectionConnection([conn({ id: 'n', locationId: A, account: UNKNOWN })], { locationId: A, mode: 'per_company', environment: 'test' }).ready).toBe(false);
  });
});

describe('readiness + the TEST / LIVE badge', () => {
  it('readiness from the cached snapshot', () => {
    expect(accountReadiness(null)).toBe('not_connected');
    expect(accountReadiness(conn({ id: 'a', accountHandle: null }))).toBe('not_connected');
    expect(accountReadiness(conn({ id: 'a', account: UNKNOWN }))).toBe('setup_incomplete');
    expect(accountReadiness(conn({ id: 'a', account: { ...UNKNOWN, detailsSubmitted: true, chargesEnabled: false } }))).toBe('restricted');
    expect(accountReadiness(conn({ id: 'a', account: { ...READY, disabledReason: 'requirements.past_due' } }))).toBe('restricted');
    expect(accountReadiness(conn({ id: 'a' }))).toBe('ready');
  });

  it('never LIVE in test: a ready account under a test key is TEST', () => {
    expect(accountView(conn({ id: 'a' }), 'company', false).modeBadge).toBe('TEST');
  });

  it('LIVE only with a live key AND a live-environment AND ready account', () => {
    expect(accountView(conn({ id: 'a', environment: 'live' }), 'company', true).modeBadge).toBe('LIVE');
    expect(accountView(conn({ id: 'a', environment: 'live', account: UNKNOWN }), 'company', true).modeBadge).toBe('TEST');
    expect(accountView(conn({ id: 'a', environment: 'test' }), 'company', true).modeBadge).toBe('TEST');
    expect(accountView(null, null, true).modeBadge).toBeNull();
  });

  it('problems are plain English, never Stripe codes', () => {
    const v = accountView(conn({ id: 'a', account: { ...READY, chargesEnabled: false, disabledReason: 'requirements.past_due', requirementsDue: ['external_account'] } }), 'company', false);
    expect(v.problem).toMatch(/needs more information/);
    expect(v.problem).not.toMatch(/requirements\./);
    expect(v.requirementsDueCount).toBe(1);
    expect(disabledReasonText('rejected.fraud')).toMatch(/declined/);
    expect(disabledReasonText(null)).toBeNull();
  });
});

describe('Stripe account normalization', () => {
  it('reads status, requirements and the default payout bank (last 4 only)', () => {
    const d = accountDetailsFromObject({
      charges_enabled: true, payouts_enabled: false, details_submitted: true,
      requirements: { disabled_reason: null, currently_due: ['tos_acceptance.date'], past_due: ['tos_acceptance.date', 'external_account'] },
      external_accounts: { data: [
        { object: 'card', last4: '1111' },
        { object: 'bank_account', bank_name: 'Old Bank', last4: '0001' },
        { object: 'bank_account', bank_name: 'Chase', last4: '6789', default_for_currency: true },
      ] },
    });
    expect(d).toEqual({ chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true, disabledReason: null, requirementsDue: ['tos_acceptance.date', 'external_account'], payoutBankName: 'Chase', payoutBankLast4: '6789' });
    expect(accountDetailsFromObject({}).payoutBankLast4).toBeNull();
    expect(accountDetailsFromObject({ external_accounts: { data: [{ object: 'bank_account', last4: 'xx12' }] } }).payoutBankLast4).toBeNull();
  });

  it('destinationOf reads a string or expanded destination', () => {
    expect(destinationOf({ transfer_data: { destination: 'acct_1' } })).toBe('acct_1');
    expect(destinationOf({ transfer_data: { destination: { id: 'acct_2' } } })).toBe('acct_2');
    expect(destinationOf({})).toBeNull();
  });
});

describe('Layer-1 fee lines (read-only display)', () => {
  it('describes the default schedule in plain words with an example', () => {
    const [card, ach] = feeLines(DEFAULT_FEE_SCHEDULE);
    expect(card).toEqual({ method: 'CARD', rate: '3%', exampleOn100000: 3000 });
    expect(ach).toEqual({ method: 'ACH', rate: '1%, at most $10.00', exampleOn100000: 1000 });
  });
});
