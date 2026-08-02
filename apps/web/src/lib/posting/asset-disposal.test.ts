import { describe, it, expect } from 'vitest';
import {
  computeDisposalGainLoss,
  buildDisposalLines,
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
