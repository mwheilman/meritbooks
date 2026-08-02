import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeDisposalGainLoss,
  buildDisposalLines,
  previewAssetDisposal,
  type DisposalLinePlan,
} from './asset-disposal';
import { PostingError } from './account-roles';

const balanced = (lines: DisposalLinePlan[]) => {
  const d = lines.reduce((s, l) => s + l.debitCents, 0);
  const c = lines.reduce((s, l) => s + l.creditCents, 0);
  return d === c;
};

describe('computeDisposalGainLoss', () => {
  it('gain when proceeds exceed net book value', () => {
    // cost 100k, accum 60k → NBV 40k; sell for 55k → gain 15k
    const m = computeDisposalGainLoss(100_000, 60_000, 55_000);
    expect(m.netBookValueCents).toBe(40_000);
    expect(m.gainLossCents).toBe(15_000);
    expect(m.outcome).toBe('GAIN');
  });

  it('loss when proceeds are below net book value', () => {
    const m = computeDisposalGainLoss(100_000, 60_000, 25_000);
    expect(m.gainLossCents).toBe(-15_000);
    expect(m.outcome).toBe('LOSS');
  });

  it('abandonment (zero proceeds) is a loss equal to NBV', () => {
    const m = computeDisposalGainLoss(100_000, 70_000, 0);
    expect(m.gainLossCents).toBe(-30_000);
    expect(m.outcome).toBe('LOSS');
  });

  it('breakeven when proceeds equal NBV', () => {
    const m = computeDisposalGainLoss(100_000, 60_000, 40_000);
    expect(m.outcome).toBe('BREAKEVEN');
    expect(m.gainLossCents).toBe(0);
  });

  it('rejects invalid states', () => {
    expect(() => computeDisposalGainLoss(100_000, 60_000, -1)).toThrow(PostingError);
    expect(() => computeDisposalGainLoss(100_000, 120_000, 0)).toThrow(PostingError);
    expect(() => computeDisposalGainLoss(100_000.5, 0, 0)).toThrow(PostingError);
  });
});

describe('buildDisposalLines — balanced posting', () => {
  const base = {
    assetName: 'Truck',
    costCents: 100_000,
    accumulatedCents: 60_000,
    assetAccountId: 'asset-acct',
    accumDepAccountId: 'accum-acct',
  };

  it('gain sale: DR accum + DR cash, CR asset cost + CR gain — balanced', () => {
    const { lines, math } = buildDisposalLines({ ...base, proceedsCents: 55_000, cashAccountId: 'cash-acct', gainAccountId: 'gain-acct' });
    expect(balanced(lines)).toBe(true);
    expect(math.gainLossCents).toBe(15_000);
    const gain = lines.find((l) => l.role === 'GAIN');
    expect(gain?.creditCents).toBe(15_000);
    expect(lines.find((l) => l.role === 'ASSET_COST')?.creditCents).toBe(100_000);
    expect(lines.find((l) => l.role === 'ACCUMULATED_DEPRECIATION')?.debitCents).toBe(60_000);
    expect(lines.find((l) => l.role === 'CASH')?.debitCents).toBe(55_000);
  });

  it('loss sale: loss is a DEBIT and the entry balances', () => {
    const { lines } = buildDisposalLines({ ...base, proceedsCents: 25_000, cashAccountId: 'cash-acct', lossAccountId: 'loss-acct' });
    expect(balanced(lines)).toBe(true);
    expect(lines.find((l) => l.role === 'LOSS')?.debitCents).toBe(15_000);
  });

  it('abandonment (no proceeds): no cash line, loss balances', () => {
    const { lines } = buildDisposalLines({ ...base, proceedsCents: 0, lossAccountId: 'loss-acct' });
    expect(balanced(lines)).toBe(true);
    expect(lines.some((l) => l.role === 'CASH')).toBe(false);
    expect(lines.find((l) => l.role === 'LOSS')?.debitCents).toBe(40_000);
  });

  it('breakeven: only removal lines, still balanced', () => {
    const { lines } = buildDisposalLines({ ...base, proceedsCents: 40_000, cashAccountId: 'cash-acct' });
    expect(balanced(lines)).toBe(true);
    expect(lines.some((l) => l.role === 'GAIN' || l.role === 'LOSS')).toBe(false);
  });

  it('fully-depreciated sale is a pure gain', () => {
    const { lines, math } = buildDisposalLines({ assetName: 'Old rig', costCents: 100_000, accumulatedCents: 100_000, assetAccountId: 'a', accumDepAccountId: 'ad', proceedsCents: 5_000, cashAccountId: 'c', gainAccountId: 'g' });
    expect(balanced(lines)).toBe(true);
    expect(math.gainLossCents).toBe(5_000);
  });

  it('refuses proceeds with no cash account, and gain with no gain account', () => {
    expect(() => buildDisposalLines({ ...base, proceedsCents: 55_000 })).toThrow(PostingError);
    expect(() => buildDisposalLines({ ...base, proceedsCents: 55_000, cashAccountId: 'cash-acct' })).toThrow(PostingError);
  });
});

// ── Disposal resolves gain/loss BY ROLE (migration 079) ──────────────────────
interface StubOpts {
  asset: Record<string, unknown>;
  roleRows?: Record<string, { account_id: string; location_id: string | null }[]>;
  accountsById?: Record<string, Record<string, unknown>>;
  accountsByNumber?: Record<string, Record<string, unknown>>;
}

/** Minimal supabase stub: fixed_assets.single, account_roles (awaited list), accounts.maybeSingle. */
function stubDb(opts: StubOpts): SupabaseClient {
  function builder(table: string) {
    const f: Record<string, unknown> = {};
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => { f[k] = v; return b; },
      or: () => b,
      limit: () => b,
      single: async () => ({ data: table === 'fixed_assets' ? opts.asset : null, error: null }),
      maybeSingle: async () => {
        if (table === 'accounts') {
          if (f.id != null) return { data: opts.accountsById?.[String(f.id)] ?? null, error: null };
          if (f.account_number != null) return { data: opts.accountsByNumber?.[String(f.account_number)] ?? null, error: null };
        }
        return { data: null, error: null };
      },
      then: (onF: (r: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) => {
        const data = table === 'account_roles' ? (opts.roleRows?.[String(f.role_key)] ?? []) : null;
        return Promise.resolve({ data, error: null }).then(onF, onR);
      },
    };
    return b as unknown as ReturnType<SupabaseClient['from']>;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const OTHER_INCOME = { account_type: 'OTHER', account_sub_type: 'OTHER_INCOME' };
const OTHER_EXPENSE = { account_type: 'OTHER', account_sub_type: 'OTHER_EXPENSE' };

describe('previewAssetDisposal — resolves gain/loss by ROLE', () => {
  const gainAsset = {
    id: 'asset-1', location_id: 'loc-1', name: 'Forklift',
    acquisition_cost_cents: 100_000, accumulated_depreciation_cents: 100_000,
    asset_account_id: 'fa-acct', accumulated_depreciation_account_id: 'ad-acct', status: 'ACTIVE',
  };

  it('uses the GAIN_ON_DISPOSAL role mapping (per-tenant account_roles row)', async () => {
    const db = stubDb({
      asset: gainAsset,
      roleRows: { GAIN_ON_DISPOSAL: [{ account_id: 'mapped-gain', location_id: null }] },
      accountsById: { 'mapped-gain': { id: 'mapped-gain', account_number: '7010', ...OTHER_INCOME } },
    });
    const res = await previewAssetDisposal(db, { orgId: 'o', assetId: 'asset-1', disposalDate: '2026-06-30', proceedsCents: 5_000, cashAccountId: 'cash' });
    expect(res.outcome).toBe('GAIN');
    expect(res.lines.find((l) => l.role === 'GAIN')?.accountId).toBe('mapped-gain');
  });

  it('falls back to the LOSS_ON_DISPOSAL default number when unmapped', async () => {
    const lossAsset = { ...gainAsset, accumulated_depreciation_cents: 40_000 }; // NBV 60k
    const db = stubDb({
      asset: lossAsset,
      roleRows: {}, // no explicit mapping
      accountsByNumber: { '8010': { id: 'loss-8010', account_number: '8010', ...OTHER_EXPENSE } },
    });
    const res = await previewAssetDisposal(db, { orgId: 'o', assetId: 'asset-1', disposalDate: '2026-06-30', proceedsCents: 25_000, cashAccountId: 'cash' });
    expect(res.outcome).toBe('LOSS');
    expect(res.lines.find((l) => l.role === 'LOSS')?.accountId).toBe('loss-8010');
  });

  it('refuses to post when neither a role mapping nor the default account resolves', async () => {
    const db = stubDb({ asset: gainAsset, roleRows: {}, accountsByNumber: {} });
    await expect(
      previewAssetDisposal(db, { orgId: 'o', assetId: 'asset-1', disposalDate: '2026-06-30', proceedsCents: 5_000, cashAccountId: 'cash' }),
    ).rejects.toBeInstanceOf(PostingError);
  });
});
