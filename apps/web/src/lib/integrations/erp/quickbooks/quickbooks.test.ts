/**
 * QuickBooks Online connect (slice W6) — unit tests with a mocked fetch.
 * No network, no DB: every Intuit call goes through an injected fetch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getQboConfigStatus, QBO_MINOR_VERSION, type QboConfig } from './config';
import { createQboState, safeReturnTo, verifyQboState } from './state';
import {
  buildAuthorizeUrl,
  exchangeCode,
  QboAuthRevokedError,
  refreshTokens,
  revokeToken,
  type FetchLike,
  type QboTokenSet,
} from './oauth';
import { __resetQboInflight, QboTokenManager, type QboTokenStore } from './token-manager';
import { QboClient } from './client';
import {
  centsToDollarStr,
  dollarsStrToCents,
  fiscalYearStartFor,
  flattenBill,
  flattenInvoice,
  flattenParty,
  parseTrialBalanceReport,
  tbLinesToRaw,
  toAccountSnapshot,
  type QboReport,
} from './transforms';
import { parseCompanyInfo } from './company-info';
import { runQboPreflight } from './preflight';
import { parseTokens, serializeTokens } from './connection-store';
import { QboLiveSource, defaultCutoverDate } from './live-source';
import {
  RealConnectorProvider,
  selectMigrationProvider,
  isProductionRuntime,
  transformOpenItem,
  transformParty,
  transformTrialBalanceRow,
  trialBalanceToConversionInput,
} from '../providers';

const CONFIG: QboConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://app.example.com/api/integrations/erp/quickbooks/callback',
  environment: 'sandbox',
  stateSecret: 'x'.repeat(40),
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type Call = { url: string; init?: RequestInit };
function mockFetch(handler: (url: string, init?: RequestInit, n?: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { fn, calls };
}

const TOKENS: QboTokenSet = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessExpiresAt: 0,
  refreshExpiresAt: null,
  realmId: '9130350000000000',
};

// ─────────────────────────────────────────────────────────────────────────────

describe('config — degrades safe', () => {
  it('reports exactly which env vars are missing (names only)', () => {
    const s = getQboConfigStatus({} as NodeJS.ProcessEnv);
    expect(s.configured).toBe(false);
    if (!s.configured) {
      expect(s.missing).toEqual(['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REDIRECT_URI', 'QBO_ENVIRONMENT', 'QBO_STATE_SECRET']);
      expect(s.reason).toMatch(/export/i);
    }
  });
  it('rejects a short state secret and a bad environment', () => {
    const s = getQboConfigStatus({
      QBO_CLIENT_ID: 'a', QBO_CLIENT_SECRET: 'b', QBO_REDIRECT_URI: 'c', QBO_ENVIRONMENT: 'prod', QBO_STATE_SECRET: 'short',
    } as unknown as NodeJS.ProcessEnv);
    expect(s.configured).toBe(false);
    if (!s.configured) expect(s.missing).toEqual(['QBO_ENVIRONMENT', 'QBO_STATE_SECRET']);
  });
  it('is configured with all five values', () => {
    const s = getQboConfigStatus({
      QBO_CLIENT_ID: 'a', QBO_CLIENT_SECRET: 'b', QBO_REDIRECT_URI: 'https://x/cb', QBO_ENVIRONMENT: 'Production', QBO_STATE_SECRET: 'y'.repeat(32),
    } as unknown as NodeJS.ProcessEnv);
    expect(s.configured).toBe(true);
    if (s.configured) expect(s.config.environment).toBe('production');
  });
});

describe('OAuth state — signed, org-bound, expiring, browser-bound', () => {
  const now = 1_800_000_000_000;
  const base = { orgId: 'org-a', userId: 'user_1', nonce: 'nonce-abc', returnTo: '/onboarding?step=2' };

  it('round-trips a valid state with the matching cookie nonce', () => {
    const s = createQboState(base, CONFIG.stateSecret, now);
    const r = verifyQboState(s, CONFIG.stateSecret, { now: now + 1000, cookieNonce: 'nonce-abc' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.orgId).toBe('org-a');
      expect(r.payload.returnTo).toBe('/onboarding?step=2');
    }
  });

  it('rejects a tampered payload (org swapped)', () => {
    const s = createQboState(base, CONFIG.stateSecret, now);
    const [body, sig] = s.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    payload.orgId = 'org-victim';
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect(verifyQboState(forged, CONFIG.stateSecret, { now })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a state signed with another secret', () => {
    const s = createQboState(base, 'z'.repeat(40), now);
    expect(verifyQboState(s, CONFIG.stateSecret, { now }).ok).toBe(false);
  });

  it('rejects an expired state', () => {
    const s = createQboState(base, CONFIG.stateSecret, now);
    expect(verifyQboState(s, CONFIG.stateSecret, { now: now + 11 * 60 * 1000 })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a missing or different cookie nonce (CSRF)', () => {
    const s = createQboState(base, CONFIG.stateSecret, now);
    expect(verifyQboState(s, CONFIG.stateSecret, { now, cookieNonce: null })).toEqual({ ok: false, reason: 'nonce_mismatch' });
    expect(verifyQboState(s, CONFIG.stateSecret, { now, cookieNonce: 'nonce-xyz' })).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it('rejects garbage', () => {
    for (const bad of [null, '', 'abc', 'a.b.c', '.sig']) {
      expect(verifyQboState(bad, CONFIG.stateSecret, { now }).ok).toBe(false);
    }
  });

  it('returnTo never allows an open redirect', () => {
    expect(safeReturnTo('https://evil.com')).toBe('/onboarding');
    expect(safeReturnTo('//evil.com/x')).toBe('/onboarding');
    expect(safeReturnTo('/\\evil.com')).toBe('/onboarding');
    expect(safeReturnTo('/settings/integrations')).toBe('/settings/integrations');
  });
});

describe('OAuth endpoints', () => {
  it('builds the Intuit authorize URL with the accounting scope', () => {
    const u = new URL(buildAuthorizeUrl(CONFIG, 'STATE'));
    expect(u.origin + u.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(u.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(u.searchParams.get('state')).toBe('STATE');
  });

  it('exchanges the code with Basic auth and returns a token set', async () => {
    const { fn, calls } = mockFetch(() =>
      jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, x_refresh_token_expires_in: 8_726_400, token_type: 'bearer' }),
    );
    const t = await exchangeCode(CONFIG, 'CODE', '123', fn, { now: 1000 });
    expect(t).toEqual({ accessToken: 'AT', refreshToken: 'RT', accessExpiresAt: 1000 + 3_600_000, refreshExpiresAt: 1000 + 8_726_400_000, realmId: '123' });
    expect(calls[0].url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('CODE');
    expect(body.get('redirect_uri')).toBe(CONFIG.redirectUri);
  });

  it('refresh returns the ROTATED refresh token', async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }));
    const next = await refreshTokens(CONFIG, { ...TOKENS, refreshExpiresAt: 999 }, fn, { now: 5 });
    expect(next.refreshToken).toBe('RT2');
    expect(next.accessToken).toBe('AT2');
    expect(next.refreshExpiresAt).toBe(999); // kept when Intuit omits it
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('invalid_grant → QboAuthRevokedError (plain message, no token in it)', async () => {
    const { fn } = mockFetch(() => jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(refreshTokens(CONFIG, TOKENS, fn)).rejects.toBeInstanceOf(QboAuthRevokedError);
    await expect(refreshTokens(CONFIG, TOKENS, fn)).rejects.not.toThrow(/refresh-1/);
  });

  it('revoke posts the token and never throws', async () => {
    const ok = mockFetch(() => new Response(null, { status: 200 }));
    expect(await revokeToken(CONFIG, 'RT', ok.fn)).toBe(true);
    expect(ok.calls[0].url).toBe('https://developer.api.intuit.com/v2/oauth2/tokens/revoke');
    expect(JSON.parse(String(ok.calls[0].init?.body))).toEqual({ token: 'RT' });
    const down: FetchLike = async () => { throw new Error('ECONNRESET'); };
    expect(await revokeToken(CONFIG, 'RT', down)).toBe(false);
  });
});

describe('token manager — auto-refresh with rotation', () => {
  beforeEach(() => __resetQboInflight());

  function memStore(initial: QboTokenSet | null) {
    const state = { tokens: initial, saved: [] as QboTokenSet[], error: null as string | null };
    const store: QboTokenStore = {
      load: async () => state.tokens,
      save: async (t) => { state.tokens = t; state.saved.push(t); },
      markError: async (m) => { state.error = m; },
    };
    return { store, state };
  }

  it('returns the stored token while it is fresh (no network)', async () => {
    const { store } = memStore({ ...TOKENS, accessExpiresAt: 10_000_000 });
    const { fn, calls } = mockFetch(() => jsonResponse({}));
    const m = new QboTokenManager('k1', CONFIG, store, fn, () => 0);
    expect((await m.getAccessToken()).accessToken).toBe('access-1');
    expect(calls).toHaveLength(0);
  });

  it('refreshes near expiry and PERSISTS the rotated refresh token before use', async () => {
    const { store, state } = memStore({ ...TOKENS, accessExpiresAt: 60_000 });
    const { fn } = mockFetch(() => jsonResponse({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }));
    const m = new QboTokenManager('k2', CONFIG, store, fn, () => 0);
    const t = await m.getAccessToken();
    expect(t.accessToken).toBe('AT2');
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0].refreshToken).toBe('RT2');
    expect(state.tokens?.refreshToken).toBe('RT2');
  });

  it('concurrent callers share ONE refresh (never burn a refresh token twice)', async () => {
    const { store } = memStore({ ...TOKENS, accessExpiresAt: 0 });
    const { fn, calls } = mockFetch(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 });
    });
    const m = new QboTokenManager('k3', CONFIG, store, fn, () => 0);
    const [a, b, c] = await Promise.all([m.getAccessToken(), m.getAccessToken(), m.getAccessToken()]);
    expect([a.accessToken, b.accessToken, c.accessToken]).toEqual(['AT2', 'AT2', 'AT2']);
    expect(calls).toHaveLength(1);
  });

  it('revoked refresh token flips the connection to error with a plain message', async () => {
    const { store, state } = memStore({ ...TOKENS, accessExpiresAt: 0 });
    const { fn } = mockFetch(() => jsonResponse({ error: 'invalid_grant' }, 400));
    const m = new QboTokenManager('k4', CONFIG, store, fn, () => 0);
    await expect(m.getAccessToken()).rejects.toBeInstanceOf(QboAuthRevokedError);
    expect(state.error).toMatch(/Connect QuickBooks/);
    expect(state.saved).toHaveLength(0);
  });

  it('a refresh token past its hard expiry is treated as revoked without calling Intuit', async () => {
    const { store, state } = memStore({ ...TOKENS, accessExpiresAt: 0, refreshExpiresAt: 100 });
    const { fn, calls } = mockFetch(() => jsonResponse({}));
    const m = new QboTokenManager('k5', CONFIG, store, fn, () => 200);
    await expect(m.getAccessToken()).rejects.toBeInstanceOf(QboAuthRevokedError);
    expect(calls).toHaveLength(0);
    expect(state.error).not.toBeNull();
  });

  it('token serialization round-trips and rejects junk', () => {
    const t = { ...TOKENS, accessExpiresAt: 5, refreshExpiresAt: 9 };
    expect(parseTokens(serializeTokens(t))).toEqual(t);
    expect(parseTokens('not json')).toBeNull();
    expect(parseTokens(JSON.stringify({ a: 'x' }))).toBeNull();
    expect(parseTokens(null)).toBeNull();
  });
});

describe('QboClient — pagination, minorversion, 401 refresh, 429 backoff, timeout', () => {
  function tokenSource() {
    const calls: (boolean | undefined)[] = [];
    let n = 0;
    return {
      calls,
      src: {
        getAccessToken: async (o?: { forceRefresh?: boolean }) => {
          calls.push(o?.forceRefresh);
          if (o?.forceRefresh) n += 1;
          return { accessToken: `AT${n}`, realmId: '123' };
        },
      },
    };
  }

  it('pages with STARTPOSITION/MAXRESULTS until a short page, sending minorversion', async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ Id: String(start + i), DisplayName: `C${start + i}` }));
    const { fn, calls } = mockFetch((url) => {
      const q = decodeURIComponent(new URL(url).searchParams.get('query') ?? '');
      const start = Number(/STARTPOSITION (\d+)/.exec(q)?.[1]);
      return jsonResponse({ QueryResponse: { Customer: start === 1 ? page(1, 1000) : page(1001, 7) } });
    });
    const client = new QboClient({ environment: 'sandbox', tokens: tokenSource().src, fetchImpl: fn });
    const rows = await client.queryAll('Customer');
    expect(rows).toHaveLength(1007);
    expect(calls).toHaveLength(2);
    const u = new URL(calls[0].url);
    expect(u.origin).toBe('https://sandbox-quickbooks.api.intuit.com');
    expect(u.pathname).toBe('/v3/company/123/query');
    expect(u.searchParams.get('minorversion')).toBe(QBO_MINOR_VERSION);
    expect(u.searchParams.get('query')).toBe('select * from Customer STARTPOSITION 1 MAXRESULTS 1000');
    expect(new URL(calls[1].url).searchParams.get('query')).toContain('STARTPOSITION 1001');
  });

  it('an empty QueryResponse is zero rows, not an error', async () => {
    const { fn } = mockFetch(() => jsonResponse({ QueryResponse: {} }));
    const client = new QboClient({ environment: 'production', tokens: tokenSource().src, fetchImpl: fn });
    expect(await client.queryAll('Bill', "Balance > '0'")).toEqual([]);
  });

  it('401 → forces one refresh and retries; a second 401 is revoked', async () => {
    const ts = tokenSource();
    const { fn } = mockFetch((_u, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer AT1' ? jsonResponse({ ok: 1 }) : jsonResponse({}, 401);
    });
    const client = new QboClient({ environment: 'sandbox', tokens: ts.src, fetchImpl: fn });
    expect(await client.get('/companyinfo/123')).toEqual({ ok: 1 });
    expect(ts.calls).toEqual([undefined, true]);

    const always401 = mockFetch(() => jsonResponse({}, 401));
    const c2 = new QboClient({ environment: 'sandbox', tokens: tokenSource().src, fetchImpl: always401.fn });
    await expect(c2.get('/x')).rejects.toBeInstanceOf(QboAuthRevokedError);
  });

  it('429 → honors Retry-After, then succeeds', async () => {
    const sleeps: number[] = [];
    const { fn, calls } = mockFetch((_u, _i, n) =>
      n === 1 ? jsonResponse({ Fault: {} }, 429, { 'retry-after': '2' }) : jsonResponse({ ok: true }),
    );
    const client = new QboClient({
      environment: 'sandbox', tokens: tokenSource().src, fetchImpl: fn,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(await client.get('/x')).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('429 forever → gives up with a plain message after maxThrottleRetries', async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({}, 429));
    const client = new QboClient({
      environment: 'sandbox', tokens: tokenSource().src, fetchImpl: fn,
      maxThrottleRetries: 2, sleep: async () => undefined,
    });
    await expect(client.get('/x')).rejects.toThrow(/busy/i);
    expect(calls).toHaveLength(3);
  });

  it('hard timeout aborts a hung request', async () => {
    const hung: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const client = new QboClient({ environment: 'sandbox', tokens: tokenSource().src, fetchImpl: hung, requestTimeoutMs: 20 });
    await expect(client.get('/x')).rejects.toThrow(/too long/i);
  });

  it('surfaces the Intuit Fault message (no token)', async () => {
    const { fn } = mockFetch(() => jsonResponse({ Fault: { Error: [{ Message: 'Invalid Query', Detail: 'bad field' }] } }, 400));
    const client = new QboClient({ environment: 'sandbox', tokens: tokenSource().src, fetchImpl: fn });
    await expect(client.get('/x')).rejects.toThrow('QuickBooks returned an error: Invalid Query — bad field');
  });
});

// ── Realistic Intuit payloads ────────────────────────────────────────────────

const QBO_ACCOUNTS = [
  { Id: '35', Name: 'Checking', FullyQualifiedName: 'Checking', AccountType: 'Bank', AccountSubType: 'Checking', CurrentBalance: 84250, Active: true },
  { Id: '84', Name: 'Accounts Receivable (A/R)', FullyQualifiedName: 'Accounts Receivable (A/R)', AccountType: 'Accounts Receivable', AccountSubType: 'AccountsReceivable', CurrentBalance: 33000, Active: true },
  { Id: '4', Name: 'Undeposited Funds', FullyQualifiedName: 'Undeposited Funds', AccountType: 'Other Current Asset', AccountSubType: 'UndepositedFunds', CurrentBalance: 1200, Active: true },
  { Id: '33', Name: 'Accounts Payable (A/P)', FullyQualifiedName: 'Accounts Payable (A/P)', AccountType: 'Accounts Payable', AccountSubType: 'AccountsPayable', CurrentBalance: 18750, Active: true },
  { Id: '34', Name: 'Opening Balance Equity', FullyQualifiedName: 'Opening Balance Equity', AccountType: 'Equity', AccountSubType: 'OpeningBalanceEquity', CurrentBalance: -100000, Active: true },
  { Id: '79', AcctNum: '4000', Name: 'Sales', FullyQualifiedName: 'Sales', AccountType: 'Income', AccountSubType: 'SalesOfProductIncome', CurrentBalance: 0, Active: true },
  { Id: '15', Name: 'Office Expense', FullyQualifiedName: 'Office Expense', AccountType: 'Expense', AccountSubType: 'OfficeGeneralAdministrativeExpenses', CurrentBalance: 0, Active: true },
  { Id: '16', Name: 'Rent', FullyQualifiedName: 'Rent or Lease', AccountType: 'Expense', AccountSubType: 'RentOrLeaseOfBuildings', CurrentBalance: 0, Active: true },
  { Id: '90', Name: 'Ask My Accountant', FullyQualifiedName: 'Ask My Accountant', AccountType: 'Expense', AccountSubType: 'OtherMiscellaneousServiceCost', CurrentBalance: 0, Active: true },
];

const TB_REPORT: QboReport = {
  Header: { ReportName: 'TrialBalance', StartPeriod: '2026-01-01', EndPeriod: '2026-09-30' },
  Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Debit', ColType: 'Money' }, { ColTitle: 'Credit', ColType: 'Money' }] },
  Rows: {
    Row: [
      { ColData: [{ value: 'Checking', id: '35' }, { value: '84250.00' }, { value: '' }] },
      { ColData: [{ value: 'Accounts Receivable (A/R)', id: '84' }, { value: '32500.00' }, { value: '' }] },
      { ColData: [{ value: 'Undeposited Funds', id: '4' }, { value: '1200.00' }, { value: '' }] },
      { ColData: [{ value: 'Accounts Payable (A/P)', id: '33' }, { value: '' }, { value: '18750.00' }] },
      { ColData: [{ value: 'Opening Balance Equity', id: '34' }, { value: '' }, { value: '100000.00' }] },
      { ColData: [{ value: 'Sales', id: '79' }, { value: '' }, { value: '50000.00' }] },
      { ColData: [{ value: 'Office Expense', id: '15' }, { value: '-50.00' }, { value: '' }] },
      { ColData: [{ value: 'Rent or Lease', id: '16' }, { value: '50850.00' }, { value: '' }] },
      { ColData: [{ value: 'Ask My Accountant', id: '90' }, { value: '0.00' }, { value: '' }] },
      { Summary: { ColData: [{ value: 'TOTAL' }, { value: '168800.00' }, { value: '168800.00' }] }, type: 'Section', group: 'GrandTotal' },
    ],
  },
};

describe('TB report transform → existing mapping → conversion input', () => {
  const byId = new Map(QBO_ACCOUNTS.map((a) => [a.Id, toAccountSnapshot(a)]));

  it('parses, nets negatives, drops zero + total rows, joins AcctNum', () => {
    const lines = parseTrialBalanceReport(TB_REPORT, byId);
    expect(lines).toHaveLength(8);
    const office = lines.find((l) => l.accountId === '15')!;
    expect(office).toMatchObject({ debitCents: 0, creditCents: 5_000 });
    expect(lines.find((l) => l.accountId === '79')!.code).toBe('4000'); // AcctNum used
    expect(lines.find((l) => l.accountId === '35')!.code).toBe('Checking'); // name fallback
    expect(lines.find((l) => l.accountId === '16')!.name).toBe('Rent or Lease');
    expect(lines.some((l) => l.accountId === '90')).toBe(false);
  });

  it('flows through the UNCHANGED QBO mapping profile and stays balanced', () => {
    const raw = tbLinesToRaw(parseTrialBalanceReport(TB_REPORT, byId));
    const rows = raw.map((r) => transformTrialBalanceRow('quickbooks', r));
    const dr = rows.reduce((s, r) => s + r.debitCents, 0);
    const cr = rows.reduce((s, r) => s + r.creditCents, 0);
    expect(dr).toBe(16_880_000);
    expect(cr).toBe(16_880_000);
    const input = trialBalanceToConversionInput(rows);
    expect(input.rows).toHaveLength(8);
    expect(input.rows[0]).toEqual({ Account: 'Checking', 'Account Name': 'Checking', Debit: '84250.00', Credit: '' });
  });

  it('falls back to columns 1/2 and walks nested sections', () => {
    const nested: QboReport = {
      Columns: { Column: [{ ColTitle: '' }, { ColTitle: '' }, { ColTitle: '' }] },
      Rows: { Row: [{ type: 'Section', Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Cash', id: '1' }, { value: '10.00' }, { value: '' }] }] } }] },
    };
    expect(parseTrialBalanceReport(nested)).toEqual([{ accountId: '1', code: 'Cash', name: 'Cash', debitCents: 1000, creditCents: 0 }]);
  });

  it('cents helpers are integer-exact', () => {
    expect(dollarsStrToCents('1,234.565')).toBe(123_457);
    expect(dollarsStrToCents(0.1 + 0.2)).toBe(30);
    expect(dollarsStrToCents('-50.00')).toBe(-5000);
    expect(dollarsStrToCents('')).toBe(0);
    expect(centsToDollarStr(123_456)).toBe('1234.56');
    expect(centsToDollarStr(0)).toBe('');
  });

  it('fiscal-year window for the TB', () => {
    expect(fiscalYearStartFor('2026-09-30', 1)).toBe('2026-01-01');
    expect(fiscalYearStartFor('2026-03-31', 7)).toBe('2025-07-01');
    expect(fiscalYearStartFor('2026-07-31', 7)).toBe('2026-07-01');
  });

  it('default cutover = last day of the prior month', () => {
    expect(defaultCutoverDate(new Date('2026-10-16T12:00:00Z'))).toBe('2026-09-30');
    expect(defaultCutoverDate(new Date('2026-01-05T12:00:00Z'))).toBe('2025-12-31');
    expect(defaultCutoverDate(new Date('2026-03-01T00:00:00Z'))).toBe('2026-02-28');
  });
});

describe('entity flatteners match the fixture shapes', () => {
  it('customer / invoice / bill', () => {
    const c = flattenParty({ Id: '1', DisplayName: 'Northwind', PrimaryEmailAddr: { Address: 'ap@nw.example' }, PrimaryPhone: { FreeFormNumber: '(515) 555-0101' } });
    expect(transformParty('quickbooks', c, 'customers')).toEqual({ externalId: '1', name: 'Northwind', email: 'ap@nw.example', phone: '(515) 555-0101' });

    const inv = flattenInvoice({ Id: '130', DocNumber: '1042', TxnDate: '2026-09-05', DueDate: '2026-10-05', TotalAmt: 18500, Balance: 18500.5, CustomerRef: { value: '1', name: 'Northwind' } });
    expect(transformOpenItem('quickbooks', inv, 'openAR')).toEqual({ partyName: 'Northwind', docNumber: '1042', date: '2026-09-05', dueDate: '2026-10-05', totalCents: 1_850_000, balanceCents: 1_850_050 });

    const bill = flattenBill({ Id: '77', TxnDate: '2026-09-10', TotalAmt: 12750, Balance: 12750, VendorRef: { value: '10', name: 'Ace Supply' } });
    expect(transformOpenItem('quickbooks', bill, 'openAP')).toMatchObject({ partyName: 'Ace Supply', docNumber: 'QBO-BILL-77', dueDate: '2026-09-10', balanceCents: 1_275_000 });
  });
});

describe('CompanyInfo prefill', () => {
  it('parses name, legal name, address, EIN, FY start month', () => {
    const p = parseCompanyInfo({
      CompanyInfo: {
        CompanyName: 'Heritage Interiors', LegalName: 'Heritage Interiors LLC',
        CompanyAddr: { Line1: '1 Main St', City: 'Des Moines', CountrySubDivisionCode: 'IA', PostalCode: '50309', Country: 'US' },
        FiscalYearStartMonth: 'July', Country: 'US', EmployerId: '123456789',
        Email: { Address: 'owner@heritage.example' }, PrimaryPhone: { FreeFormNumber: '515-555-0100' }, WebAddr: { URI: 'https://heritage.example' },
      },
    });
    expect(p).toEqual({
      companyName: 'Heritage Interiors', legalName: 'Heritage Interiors LLC',
      address: { line1: '1 Main St', line2: null, city: 'Des Moines', region: 'IA', postalCode: '50309', country: 'US' },
      ein: '12-3456789', fiscalYearStartMonth: 7, country: 'US',
      email: 'owner@heritage.example', phone: '515-555-0100', website: 'https://heritage.example',
    });
  });
  it('tolerates a half-empty company', () => {
    const p = parseCompanyInfo({ CompanyInfo: { CompanyName: 'X' } });
    expect(p.legalName).toBe('X');
    expect(p.ein).toBeNull();
    expect(p.fiscalYearStartMonth).toBeNull();
    expect(p.address).toBeNull();
  });
});

describe('pre-flight checks (T5)', () => {
  const accounts = QBO_ACCOUNTS.map(toAccountSnapshot);
  const tb = parseTrialBalanceReport(TB_REPORT, new Map(accounts.map((a) => [a.id, a])));

  it('flags AR gap, Undeposited Funds and OBE — in dollars, blockers first', () => {
    const f = runQboPreflight({
      accounts,
      trialBalance: tb,
      openInvoiceBalancesCents: [1_850_000, 1_400_000], // $32,500 vs A/R $33,000
      openBillBalancesCents: [1_875_000],                 // ties to A/P
      asOfDate: '2026-09-30',
    });
    expect(f.map((x) => x.id)).toEqual(['ar_control_mismatch', 'opening_balance_equity', 'undeposited_funds']);
    expect(f[0]).toMatchObject({ severity: 'blocker', amountCents: 50_000 });
    expect(f[0].plainEnglishMessage).toContain('$500.00');
    expect(f[1]).toMatchObject({ severity: 'warning', amountCents: 10_000_000 });
    expect(f[2].plainEnglishMessage).toContain('$1,200.00');
    expect(f[2].plainEnglishMessage).toContain('2026-09-30');
  });

  it('AP mismatch, uncategorized and Ask My Accountant (current balances when no TB)', () => {
    const accts = [
      ...accounts.filter((a) => a.accountType === 'Accounts Payable'),
      toAccountSnapshot({ Id: '200', Name: 'Uncategorized Expense', AccountType: 'Expense', CurrentBalance: 431.27 }),
      toAccountSnapshot({ Id: '201', Name: 'Ask My Accountant', AccountType: 'Expense', CurrentBalance: -25 }),
    ];
    const f = runQboPreflight({ accounts: accts, openBillBalancesCents: [1_000_000] });
    const ids = f.map((x) => x.id);
    expect(ids).toEqual(['ap_control_mismatch', 'uncategorized', 'ask_my_accountant']);
    expect(f[0].amountCents).toBe(875_000);
    expect(f[1].amountCents).toBe(43_127);
    expect(f[2].amountCents).toBe(2_500);
  });

  it('clean books → no findings; control checks skipped when docs not pulled', () => {
    const clean = [
      toAccountSnapshot({ Id: '1', Name: 'Checking', AccountType: 'Bank', CurrentBalance: 100 }),
      toAccountSnapshot({ Id: '2', Name: 'Accounts Receivable', AccountType: 'Accounts Receivable', CurrentBalance: 250 }),
      toAccountSnapshot({ Id: '3', Name: 'Opening Balance Equity', AccountType: 'Equity', AccountSubType: 'OpeningBalanceEquity', CurrentBalance: 0 }),
    ];
    expect(runQboPreflight({ accounts: clean, openInvoiceBalancesCents: [25_000] })).toEqual([]);
    expect(runQboPreflight({ accounts: clean, openInvoiceBalancesCents: null })).toEqual([]);
  });
});

describe('provider selection — mock is never used for a real org in production', () => {
  const base = { providerId: 'quickbooks' as const, requestedMock: false, isProduction: true, qboConfigured: true, connectionStatus: null };

  it('live only for a connected QBO org', () => {
    expect(selectMigrationProvider({ ...base, connectionStatus: 'connected' })).toEqual({ kind: 'live' });
    expect(selectMigrationProvider({ ...base, connectionStatus: 'pending' }).kind).toBe('not_connected');
    expect(selectMigrationProvider({ ...base, connectionStatus: null }).kind).toBe('not_connected');
  });
  it('an errored connection surfaces its plain message, never falls back to mock', () => {
    const s = selectMigrationProvider({ ...base, connectionStatus: 'error', connectionError: 'Reconnect please' });
    expect(s).toEqual({ kind: 'not_connected', reason: 'Reconnect please' });
  });
  it('sample data is refused in production, allowed elsewhere only on explicit request', () => {
    expect(selectMigrationProvider({ ...base, requestedMock: true }).kind).toBe('sample_blocked');
    expect(selectMigrationProvider({ ...base, requestedMock: true, isProduction: false })).toEqual({ kind: 'mock' });
    expect(selectMigrationProvider({ ...base, isProduction: false }).kind).toBe('not_connected');
  });
  it('unconfigured platform / other ERPs → honest not-connected', () => {
    expect(selectMigrationProvider({ ...base, qboConfigured: false, connectionStatus: 'connected' }).kind).toBe('not_connected');
    const x = selectMigrationProvider({ ...base, providerId: 'xero' });
    expect(x.kind).toBe('not_connected');
    if (x.kind === 'not_connected') expect(x.reason).toMatch(/drop the file/);
  });
  it('isProductionRuntime: the stricter rule — Vercel previews count as production', () => {
    expect(isProductionRuntime({ VERCEL_ENV: 'production', NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    // Previews may hit the production database, so they are treated as production.
    expect(isProductionRuntime({ VERCEL_ENV: 'preview', NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionRuntime({ VERCEL_ENV: 'preview' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionRuntime({ VERCEL_ENV: 'development', NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isProductionRuntime({ NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('end-to-end: live source through RealConnectorProvider (mocked Intuit)', () => {
  function intuit() {
    return mockFetch((url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/companyinfo/123')) {
        return jsonResponse({ CompanyInfo: { CompanyName: 'Heritage', FiscalYearStartMonth: 'January' } });
      }
      if (u.pathname.endsWith('/reports/TrialBalance')) return jsonResponse(TB_REPORT);
      const q = u.searchParams.get('query') ?? '';
      if (q.includes('from Account')) return jsonResponse({ QueryResponse: { Account: QBO_ACCOUNTS } });
      if (q.includes('from Invoice')) {
        return jsonResponse({ QueryResponse: { Invoice: [
          { Id: '1', DocNumber: '1042', TxnDate: '2026-09-05', DueDate: '2026-10-05', TotalAmt: 18500, Balance: 18500, CustomerRef: { name: 'Northwind' } },
          { Id: '2', DocNumber: '1043', TxnDate: '2026-09-18', DueDate: '2026-10-18', TotalAmt: 14000, Balance: 14000, CustomerRef: { name: 'Cedar Ridge' } },
        ] } });
      }
      if (q.includes('from Bill')) {
        return jsonResponse({ QueryResponse: { Bill: [
          { Id: '9', DocNumber: 'B-1', TxnDate: '2026-09-10', DueDate: '2026-10-10', TotalAmt: 18750, Balance: 18750, VendorRef: { name: 'Ace' } },
        ] } });
      }
      if (q.includes('from Customer')) return jsonResponse({ QueryResponse: { Customer: [{ Id: '1', DisplayName: 'Northwind' }] } });
      if (q.includes('from Vendor')) return jsonResponse({ QueryResponse: { Vendor: [{ Id: '9', DisplayName: 'Ace' }] } });
      return jsonResponse({ Fault: { Error: [{ Message: 'unexpected' }] } }, 400);
    });
  }
  const tokens = { getAccessToken: async () => ({ accessToken: 'AT', realmId: '123' }) };

  it('pulls a balanced TB as of the cutover with the right date window, plus pre-flight', async () => {
    const { fn, calls } = intuit();
    const live = new QboLiveSource(new QboClient({ environment: 'sandbox', tokens, fetchImpl: fn }), { asOfDate: '2026-09-30' });
    const provider = new RealConnectorProvider('quickbooks', {} as NodeJS.ProcessEnv, { live });

    const tb = await provider.fetchTrialBalance();
    expect(tb.connected).toBe(true);
    if (!tb.connected) return;
    expect(tb.source).toBe('live');
    const dr = tb.records.reduce((s, r) => s + r.debitCents, 0);
    expect(dr).toBe(tb.records.reduce((s, r) => s + r.creditCents, 0));

    const tbCall = calls.find((c) => c.url.includes('/reports/TrialBalance'))!;
    const p = new URL(tbCall.url).searchParams;
    expect(p.get('start_date')).toBe('2026-01-01');
    expect(p.get('end_date')).toBe('2026-09-30');
    expect(p.get('accounting_method')).toBe('Accrual');

    const ar = await provider.fetchOpenAR();
    expect(ar.connected && ar.records.map((r) => r.docNumber)).toEqual(['1042', '1043']);

    const findings = await live.preflight();
    expect(findings.map((x) => x.id)).toEqual(['ar_control_mismatch', 'opening_balance_equity', 'undeposited_funds']);

    // Cached: the Account list was fetched once despite TB + accounts + pre-flight.
    const accountCalls = calls.filter((c) => (new URL(c.url).searchParams.get('query') ?? '').includes('from Account'));
    expect(accountCalls).toHaveLength(1);
  });

  it('a live failure degrades to not-connected with a plain reason (never throws)', async () => {
    const down: FetchLike = vi.fn(async () => jsonResponse({}, 503));
    const live = new QboLiveSource(
      new QboClient({ environment: 'sandbox', tokens, fetchImpl: down, sleep: async () => undefined }),
      { asOfDate: '2026-09-30', fiscalYearStartMonth: 1 },
    );
    const provider = new RealConnectorProvider('quickbooks', {} as NodeJS.ProcessEnv, { live });
    const res = await provider.fetchCustomers();
    expect(res.connected).toBe(false);
    if (!res.connected) expect(res.reason).toMatch(/QuickBooks/);
  });

  it('without a live source the real adapter stays honestly not-connected', async () => {
    const env = { QBO_CLIENT_ID: 'a', QBO_CLIENT_SECRET: 'b', QBO_REDIRECT_URI: 'c', QBO_ENVIRONMENT: 'sandbox', QBO_STATE_SECRET: 's'.repeat(32) } as unknown as NodeJS.ProcessEnv;
    const p = new RealConnectorProvider('quickbooks', env);
    expect(p.hasCredentials()).toBe(true);
    const res = await p.fetchTrialBalance();
    expect(res.connected).toBe(false);
    if (!res.connected) expect(res.reason).toMatch(/not connected/i);
  });
});
