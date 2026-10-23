import { describe, it, expect } from 'vitest';
import { accountSupportedMethods, decidePayLink, evaluatePayLink, type PayLinkInput } from './pay-link';
import { resolvePaymentTerms } from '@/lib/money/payment-terms';
import { buildInvoiceEmail, payMethodsSentence } from './invoice-email';
import { resolveRecipients, parseEmailList } from './recipients';
import { summarizeOnlineActivity } from './online-activity';
import type { ConnectedAccountSnapshot, ProviderConnection } from '@/lib/money/providers/types';

const READY: ConnectedAccountSnapshot = { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, disabledReason: null, requirementsDue: [], payoutBankName: 'Chase', payoutBankLast4: '6789', checkedAt: '2026-10-23T00:00:00Z' };
const UNKNOWN: ConnectedAccountSnapshot = { ...READY, chargesEnabled: null, payoutsEnabled: null, detailsSubmitted: null, payoutBankName: null, payoutBankLast4: null, checkedAt: null };

const stripe = (over: Partial<ProviderConnection> = {}): ProviderConnection => ({
  id: 'c1', orgId: 'org', capability: 'AR_COLLECTION', provider: 'stripe', environment: 'test', locationId: 'loc-a',
  accountHandle: 'acct_a', secretRef: null, status: 'active', connectedBy: 'u', statusDetail: null, metadata: {},
  account: READY, createdAt: '', updatedAt: '', ...over,
});
/** Company default = bank transfer on, card off (the owner default). */
const terms = (levels: Parameters<typeof resolvePaymentTerms>[0] = {}) => resolvePaymentTerms(levels);
const input = (over: Partial<PayLinkInput> = {}): PayLinkInput => ({
  publicToken: '11111111-1111-4111-8111-111111111111', status: 'SENT', balanceCents: 10_000, locationId: 'loc-a',
  terms: terms(), connections: [stripe()], accountMode: 'per_company',
  stripe: { canCharge: true, environment: 'test' }, cardFeeBps: 290, ...over,
});

describe('pay link — ONE source of truth (live check Wave 1, fix 1G-1)', () => {
  it('NOT CONNECTED: the live bug — only a tenant-level account, per-company mode → not payable', () => {
    const tenantOnly = [stripe({ locationId: null, account: UNKNOWN })];
    const d = decidePayLink(input({ connections: tenantOnly }));
    expect(d).toMatchObject({ payable: false, code: 'NO_CONNECTION', methods: [] });
    expect(decidePayLink(input({ connections: [] })).code).toBe('NO_CONNECTION');
    // another company's account never serves this one
    expect(decidePayLink(input({ connections: [stripe({ locationId: 'loc-b' })] })).code).toBe('NO_CONNECTION');
    expect(decidePayLink(input({ connections: [stripe({ status: 'disconnected' })] })).code).toBe('NO_CONNECTION');
    expect(decidePayLink(input({ connections: [stripe({ accountHandle: null })] })).code).toBe('NO_CONNECTION');
  });

  it('CONNECTED (test): own company account in the current mode, charges confirmed → payable, TEST reported', () => {
    const d = evaluatePayLink(input());
    expect(d.state).toMatchObject({ payable: true, mode: 'test', code: 'OK', methods: ['ACH'], cardFeePct: 2.9 });
    expect(d.state.url).toMatch(/\/pay\/11111111-/);
    expect(d.connection?.accountHandle).toBe('acct_a');
    expect(d.source).toBe('company');
    // the state the browser sees never carries the account id
    expect(JSON.stringify(d.state)).not.toContain('acct_');
  });

  it('the current mode decides: a test account under a live key (and the reverse) is not used', () => {
    expect(decidePayLink(input({ stripe: { canCharge: true, environment: 'live' } })).code).toBe('NO_CONNECTION');
    const live = decidePayLink(input({ connections: [stripe({ environment: 'live' })], stripe: { canCharge: true, environment: 'live' } }));
    expect(live).toMatchObject({ payable: true, mode: 'live' });
  });

  it('server keys missing or mismatched → off for everyone', () => {
    expect(decidePayLink(input({ stripe: { canCharge: false, environment: 'test' } })).code).toBe('PAYMENTS_OFF');
    expect(decidePayLink(input({ stripe: { canCharge: false, environment: null } })).payable).toBe(false);
  });

  it('charges must be confirmed by Stripe: never checked or disabled → not payable', () => {
    expect(decidePayLink(input({ connections: [stripe({ account: UNKNOWN })] }))).toMatchObject({ payable: false, code: 'NOT_READY', mode: 'test' });
    const off = decidePayLink(input({ connections: [stripe({ account: { ...READY, chargesEnabled: false } })] }));
    expect(off.code).toBe('NOT_READY');
    expect(off.reason).toMatch(/paused/);
  });

  it('METHOD OFF: card off at the company → card never offered; nothing online → not payable', () => {
    expect(decidePayLink(input()).methods).not.toContain('CARD');
    expect(decidePayLink(input({ terms: terms({ entity: { payment_methods_allowed: ['CHECK'] } }) })).code).toBe('NO_ONLINE_METHOD');
    expect(decidePayLink(input({ terms: terms({ entity: { payment_methods_allowed: ['CHECK', 'ACH', 'CARD'] } }) })).methods).toEqual(['ACH', 'CARD']);
    // most-specific wins: an invoice that allows card overrides a company that doesn't
    expect(decidePayLink(input({ terms: terms({ invoice: { payment_methods_allowed: ['CARD'] }, entity: { payment_methods_allowed: ['ACH'] } }) })).methods).toEqual(['CARD']);
    expect(decidePayLink(input({ terms: terms({ customer: { payment_methods_allowed: ['CHECK'] } }) })).code).toBe('NO_ONLINE_METHOD');
  });

  it('methods = enabled ∩ what the account supports', () => {
    const noCard = stripe({ metadata: { capabilities: { card_payments: 'inactive', us_bank_account_ach_payments: 'active' } } });
    expect(accountSupportedMethods(noCard)).toEqual(['ACH']);
    expect(accountSupportedMethods(stripe())).toEqual(['ACH', 'CARD']);
    const all = terms({ entity: { payment_methods_allowed: ['ACH', 'CARD'] } });
    expect(decidePayLink(input({ connections: [noCard], terms: all })).methods).toEqual(['ACH']);
    const onlyCard = terms({ entity: { payment_methods_allowed: ['CARD'] } });
    expect(decidePayLink(input({ connections: [noCard], terms: onlyCard })).code).toBe('NO_ONLINE_METHOD');
  });

  it('SHARED-ACCOUNT mode: the tenant account serves every company; a company account still wins', () => {
    const tenant = stripe({ id: 't', locationId: null, accountHandle: 'acct_shared' });
    const shared = evaluatePayLink(input({ accountMode: 'single', connections: [tenant] }));
    expect(shared.state.payable).toBe(true);
    expect(shared.connection?.accountHandle).toBe('acct_shared');
    expect(shared.source).toBe('tenant');
    const own = evaluatePayLink(input({ accountMode: 'single', connections: [tenant, stripe()] }));
    expect(own.connection?.accountHandle).toBe('acct_a');
    // and the shared account is never used in per-company mode
    expect(decidePayLink(input({ accountMode: 'per_company', connections: [tenant] })).code).toBe('NO_CONNECTION');
  });

  it('card fee: pass-through + % from the merchant fee schedule', () => {
    expect(decidePayLink(input()).cardPassThrough).toBe(true);
    expect(decidePayLink(input({ terms: terms({ entity: { card_surcharge_enabled: false } }) })).cardPassThrough).toBe(false);
    expect(decidePayLink(input({ cardFeeBps: undefined })).cardFeePct).toBe(3);
  });

  it('paid, voided and written-off invoices are not payable', () => {
    expect(decidePayLink(input({ balanceCents: 0 })).code).toBe('PAID');
    expect(decidePayLink(input({ status: 'VOIDED' })).code).toBe('CLOSED');
    expect(decidePayLink(input({ status: 'WRITTEN_OFF' })).code).toBe('CLOSED');
  });

  it('a DRAFT invoice is never payable, even fully set up with a balance', () => {
    const d = decidePayLink(input({ status: 'DRAFT' }));
    expect(d.payable).toBe(false);
    expect(d.code).toBe('NOT_ISSUED');
    expect(d.methods).toEqual([]);
    expect(decidePayLink(input({ status: 'SENT' })).payable).toBe(true);
  });

  it('the email sentence names only the methods really offered', () => {
    expect(payMethodsSentence(['ACH', 'CARD'])).toBe('Pay by bank transfer or card.');
    expect(payMethodsSentence(['CARD'])).toBe('Pay by card.');
    expect(payMethodsSentence(['ACH'])).toBe('Pay by bank transfer.');
    expect(typeof buildInvoiceEmail).toBe('function');
  });
});

describe('resolveRecipients', () => {
  it('To defaults to the customer; CC = typed list, else invoice list, else customer default', () => {
    expect(resolveRecipients({ customerEmail: 'ap@c.test', customerCc: ['pm@c.test'] })).toEqual({ ok: true, to: 'ap@c.test', cc: ['pm@c.test'], bcc: [] });
    expect(resolveRecipients({ customerEmail: 'ap@c.test', invoiceCc: ['x@c.test'], customerCc: ['pm@c.test'] })).toMatchObject({ cc: ['x@c.test'] });
    expect(resolveRecipients({ customerEmail: 'ap@c.test', explicitCc: [], invoiceCc: ['x@c.test'] })).toMatchObject({ cc: [] });
  });
  it('de-duplicates across To / CC / BCC, case-insensitively', () => {
    expect(resolveRecipients({ explicitTo: 'A@c.test', explicitCc: ['a@c.test', 'b@c.test', 'B@c.test'], copyToSelf: 'b@c.test' }))
      .toEqual({ ok: true, to: 'A@c.test', cc: ['b@c.test'], bcc: [] });
  });
  it('refuses a missing To, a bad address and too many copies', () => {
    expect(resolveRecipients({})).toMatchObject({ ok: false, code: 'CUSTOMER_EMAIL_MISSING' });
    expect(resolveRecipients({ customerEmail: 'ap@c.test', explicitCc: ['nope'] })).toMatchObject({ ok: false, code: 'INVALID_EMAIL' });
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@c.test`);
    expect(resolveRecipients({ customerEmail: 'ap@c.test', explicitCc: many })).toMatchObject({ ok: false, code: 'TOO_MANY_CC' });
  });
  it('parses a free-typed list', () => {
    expect(parseEmailList('a@x.test, b@y.test;c@z.test  d@w.test')).toEqual(['a@x.test', 'b@y.test', 'c@z.test', 'd@w.test']);
  });
});

describe('summarizeOnlineActivity', () => {
  const ev = (event_type: string, at: string, meta: Record<string, unknown> = {}) => ({ event_type, created_at: `2026-06-0${at}T10:00:00Z`, meta });
  it('not viewed → viewed → started → processing → paid online', () => {
    expect(summarizeOnlineActivity([]).status).toBe('NOT_VIEWED');
    expect(summarizeOnlineActivity([ev('VIEWED', '1'), ev('VIEWED', '2')])).toMatchObject({ status: 'VIEWED', views: 2, label: 'Viewed 2×' });
    expect(summarizeOnlineActivity([ev('VIEWED', '1'), ev('PAY_INITIATED', '2')]).status).toBe('STARTED');
    expect(summarizeOnlineActivity([ev('PAY_INITIATED', '2'), ev('PAY_PROCESSING', '3')]).status).toBe('PROCESSING');
    const paid = summarizeOnlineActivity([ev('PAY_INITIATED', '2'), ev('PAY_SUCCEEDED', '4', { amount_cents: 1234 })]);
    expect(paid).toMatchObject({ status: 'PAID_ONLINE', label: 'Paid online', paidOnlineCents: 1234 });
  });
  it('a failure after an attempt shows failed; a later retry shows started', () => {
    expect(summarizeOnlineActivity([ev('PAY_INITIATED', '1'), ev('PAY_FAILED', '2')]).status).toBe('FAILED');
    expect(summarizeOnlineActivity([ev('PAY_INITIATED', '1'), ev('PAY_FAILED', '2'), ev('PAY_INITIATED', '3')]).status).toBe('STARTED');
  });
});
