/**
 * FPB-onboarding B3 — sample/fixture data can never reach a real company's books in
 * production. Covers: the environment gate, fixture fingerprinting, the adapter's
 * marker, the session detector (marker / name prefix / fingerprint), and the exact
 * refusal bodies the go-live post and import routes return.
 */

import { describe, it, expect } from 'vitest';
import {
  SAMPLE_SOURCE_NAME_PREFIX,
  sampleImportsAllowed,
  isFixtureTrialBalance,
  isSampleSourcedSession,
  sampleSessionPostBlock,
  sampleImportRequestBlock,
} from './sample-guard';
import { getMigrationProvider, trialBalanceToConversionInput, CONVERSION_HEADERS } from '@/lib/integrations/erp/providers';
import type { MigrationProviderId, ProviderTrialBalanceRow } from '@/lib/integrations/erp/providers';

const PROD = { NODE_ENV: 'production' };
const ORG = '7b0c2a52-1d1e-4a57-9a0e-2f3b6a1c9d10';

async function fixtureTb(id: MigrationProviderId): Promise<ProviderTrialBalanceRow[]> {
  const res = await getMigrationProvider(id, { mock: true }).fetchTrialBalance();
  if (!res.connected) throw new Error('mock provider should always be connected');
  return res.records;
}

/** Shape a provider TB the way the conversion route persists it (SourceLine[]). */
function asSessionLines(rows: ProviderTrialBalanceRow[], name = (r: ProviderTrialBalanceRow) => r.accountName) {
  return rows.map((r) => ({ sourceAccount: r.accountCode, sourceName: name(r), debitCents: r.debitCents, creditCents: r.creditCents }));
}

const REAL_LINES = [
  { sourceAccount: '1010', sourceName: 'Operating Checking', debitCents: 1_234_567, creditCents: 0 },
  { sourceAccount: '2010', sourceName: 'Accounts Payable', debitCents: 0, creditCents: 234_567 },
  { sourceAccount: '3010', sourceName: 'Retained Earnings', debitCents: 0, creditCents: 1_000_000 },
];

describe('sampleImportsAllowed (environment gate)', () => {
  it('allows sample data outside production', () => {
    expect(sampleImportsAllowed({ env: { NODE_ENV: 'development' } })).toBe(true);
    expect(sampleImportsAllowed({ env: { NODE_ENV: 'test' } })).toBe(true);
  });

  it('fails closed in production with nothing set', () => {
    expect(sampleImportsAllowed({ env: PROD })).toBe(false);
    expect(sampleImportsAllowed({ env: PROD, orgId: ORG })).toBe(false);
  });

  it('treats a Vercel preview as production (previews may hit the prod database)', () => {
    expect(sampleImportsAllowed({ env: { VERCEL_ENV: 'preview', NODE_ENV: 'production' } })).toBe(false);
    expect(sampleImportsAllowed({ env: { VERCEL_ENV: 'preview' } })).toBe(false);
  });

  it('honours the explicit flag only when exactly "true"', () => {
    expect(sampleImportsAllowed({ env: { ...PROD, NEXT_PUBLIC_ENABLE_SAMPLE_IMPORTS: 'true' } })).toBe(true);
    expect(sampleImportsAllowed({ env: { ...PROD, NEXT_PUBLIC_ENABLE_SAMPLE_IMPORTS: '1' } })).toBe(false);
  });

  it('honours the sandbox org allowlist (case/space-insensitive) for that org only', () => {
    const env = { ...PROD, SAMPLE_DATA_ORG_IDS: ` other-org , ${ORG.toUpperCase()} ` };
    expect(sampleImportsAllowed({ env, orgId: ORG })).toBe(true);
    expect(sampleImportsAllowed({ env, orgId: 'a-real-customer' })).toBe(false);
    expect(sampleImportsAllowed({ env })).toBe(false);
  });
});

describe('fixture fingerprinting', () => {
  for (const id of ['quickbooks', 'xero', 'sage'] as MigrationProviderId[]) {
    it(`${id}: the shipped fixture TB is recognised (in any order)`, async () => {
      const rows = await fixtureTb(id);
      expect(isFixtureTrialBalance(rows)).toBe(true);
      expect(isFixtureTrialBalance([...rows].reverse())).toBe(true);
    });
  }

  it('a real TB, an empty TB, or a fixture with one amount changed is NOT sample', async () => {
    expect(isFixtureTrialBalance([])).toBe(false);
    expect(isFixtureTrialBalance(REAL_LINES.map((l) => ({ accountCode: l.sourceAccount, accountName: l.sourceName, debitCents: l.debitCents, creditCents: l.creditCents })))).toBe(false);
    const rows = await fixtureTb('quickbooks');
    const tweaked = rows.map((r, i) => (i === 0 ? { ...r, debitCents: r.debitCents + 1 } : r));
    expect(isFixtureTrialBalance(tweaked)).toBe(false);
  });
});

describe('conversion adapter marks sample rows', () => {
  it('auto-detects a fixture pull and stamps every name with the SAMPLE prefix', async () => {
    const input = trialBalanceToConversionInput(await fixtureTb('quickbooks'));
    expect(input.rows.length).toBeGreaterThan(0);
    for (const row of input.rows) {
      expect(row[CONVERSION_HEADERS.name].startsWith(SAMPLE_SOURCE_NAME_PREFIX)).toBe(true);
    }
  });

  it('leaves a real pull untouched, and honours an explicit override', () => {
    const real = REAL_LINES.map((l) => ({ accountCode: l.sourceAccount, accountName: l.sourceName, debitCents: l.debitCents, creditCents: l.creditCents }));
    const plain = trialBalanceToConversionInput(real);
    expect(plain.rows[0][CONVERSION_HEADERS.name]).toBe('Operating Checking');
    const forced = trialBalanceToConversionInput(real, { sample: true });
    expect(forced.rows[0][CONVERSION_HEADERS.name]).toBe(`${SAMPLE_SOURCE_NAME_PREFIX}Operating Checking`);
  });
});

describe('isSampleSourcedSession', () => {
  it('detects the explicit marker', () => {
    expect(isSampleSourcedSession({ sourceLines: REAL_LINES, sampleSource: 'quickbooks' })).toBe(true);
    expect(isSampleSourcedSession({ sourceLines: REAL_LINES, sampleSource: false })).toBe(false);
  });

  it('detects the adapter name prefix on any line', () => {
    const lines = REAL_LINES.map((l, i) => (i === 1 ? { ...l, sourceName: `${SAMPLE_SOURCE_NAME_PREFIX}${l.sourceName}` } : l));
    expect(isSampleSourcedSession({ sourceLines: lines })).toBe(true);
  });

  it('fingerprints a pre-marker fixture session (no prefix, no marker)', async () => {
    expect(isSampleSourcedSession({ sourceLines: asSessionLines(await fixtureTb('xero')) })).toBe(true);
  });

  it('a real session, an empty one, or a malformed blob is NOT sample', () => {
    expect(isSampleSourcedSession({ sourceLines: REAL_LINES })).toBe(false);
    expect(isSampleSourcedSession({ sourceLines: [] })).toBe(false);
    expect(isSampleSourcedSession(null)).toBe(false);
    expect(isSampleSourcedSession(undefined)).toBe(false);
    expect(isSampleSourcedSession({ sourceLines: null })).toBe(false);
  });
});

describe('refusal bodies', () => {
  it('go-live post: blocks a sample session in production with a clear message', async () => {
    const data = { sourceLines: asSessionLines(await fixtureTb('sage')) };
    const block = sampleSessionPostBlock(data, { env: PROD, orgId: ORG });
    expect(block?.code).toBe('SAMPLE_DATA_BLOCKED');
    expect(block?.error).toMatch(/SAMPLE data/);
  });

  it('go-live post: never blocks a real session, and allows sample where permitted', async () => {
    expect(sampleSessionPostBlock({ sourceLines: REAL_LINES }, { env: PROD })).toBeNull();
    const data = { sourceLines: asSessionLines(await fixtureTb('sage')) };
    expect(sampleSessionPostBlock(data, { env: { NODE_ENV: 'development' } })).toBeNull();
    expect(sampleSessionPostBlock(data, { env: { ...PROD, SAMPLE_DATA_ORG_IDS: ORG }, orgId: ORG })).toBeNull();
  });

  it('import routes: refuse useFixture in production, pass real pulls', () => {
    expect(sampleImportRequestBlock(true, { env: PROD })?.code).toBe('SAMPLE_DATA_BLOCKED');
    expect(sampleImportRequestBlock(false, { env: PROD })).toBeNull();
    expect(sampleImportRequestBlock(undefined, { env: PROD })).toBeNull();
    expect(sampleImportRequestBlock(true, { env: { NODE_ENV: 'development' } })).toBeNull();
  });
});
