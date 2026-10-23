import { describe, it, expect } from 'vitest';
import { decidePayLink, pickArConnection, type ConnectionLite, type PayLinkInput } from './pay-link';
import { resolveRecipients, parseEmailList } from './recipients';
import { summarizeOnlineActivity } from './online-activity';

const stripe = (over: Partial<ConnectionLite> = {}): ConnectionLite => ({
  capability: 'AR_COLLECTION', provider: 'stripe', status: 'active', environment: 'test', account_handle: 'acct_1', ...over,
});
const input = (over: Partial<PayLinkInput> = {}): PayLinkInput => ({
  publicToken: '11111111-1111-4111-8111-111111111111', status: 'SENT', balanceCents: 10_000, locationId: 'loc-a',
  methodLevels: {}, connections: [stripe()], ...over,
});

describe('decidePayLink — never a dead link', () => {
  it('payable with an active connection; mode reported honestly', () => {
    expect(decidePayLink(input())).toMatchObject({ payable: true, mode: 'test', code: 'OK', methods: ['ACH'] });
    expect(decidePayLink(input({ connections: [stripe({ environment: 'live' })] })).mode).toBe('live');
    expect(decidePayLink(input()).url).toMatch(/\/pay\/11111111-/);
  });
  it('no connection, a disconnected one, or one without an account → not payable', () => {
    expect(decidePayLink(input({ connections: [] })).code).toBe('NO_CONNECTION');
    expect(decidePayLink(input({ connections: [stripe({ status: 'disconnected' })] })).payable).toBe(false);
    expect(decidePayLink(input({ connections: [stripe({ account_handle: null })] })).payable).toBe(false);
  });
  it('per-company connections (Wave 1A): own company wins, another company never applies', () => {
    const own = stripe({ location_id: 'loc-a', account_handle: 'acct_a' });
    const theirs = stripe({ location_id: 'loc-b', account_handle: 'acct_b' });
    const orgWide = stripe({ location_id: null, account_handle: 'acct_org' });
    expect(pickArConnection([theirs, own], 'loc-a')?.account_handle).toBe('acct_a');
    expect(pickArConnection([theirs, orgWide], 'loc-a')?.account_handle).toBe('acct_org');
    expect(pickArConnection([theirs], 'loc-a')).toBeNull();
  });
  it('online methods come from the invoice → job → customer → company cascade', () => {
    expect(decidePayLink(input({ methodLevels: { customer: ['CHECK'] } })).code).toBe('NO_ONLINE_METHOD');
    expect(decidePayLink(input({ methodLevels: { invoice: ['ACH', 'CARD'], customer: ['CHECK'] } })).methods).toEqual(['ACH', 'CARD']);
  });
  it('paid, voided and written-off invoices are not payable', () => {
    expect(decidePayLink(input({ balanceCents: 0 })).code).toBe('PAID');
    expect(decidePayLink(input({ status: 'VOIDED' })).code).toBe('CLOSED');
    expect(decidePayLink(input({ status: 'WRITTEN_OFF' })).code).toBe('CLOSED');
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
