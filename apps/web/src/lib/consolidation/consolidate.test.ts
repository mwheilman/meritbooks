import { describe, it, expect } from 'vitest';
import {
  consolidate,
  entityNetIncomeCents,
  entityBookedEquityCents,
  entityPeriodEndEquityCents,
  isEliminatingAccount,
  type EntityMeta,
  type EntityAccountBalance,
} from './consolidate';

/**
 * GATE 11a correctness. The consolidation engine is the multi-entity moat, so its
 * arithmetic is pinned down exactly: eliminations net to zero, NCI carves the
 * minority slice, equity-method entities collapse to one line, and a lone entity
 * consolidates to itself. All money is bigint cents.
 */

// Convenience builder for a natural-balance account line.
const bal = (
  entityId: string,
  accountNumber: string,
  accountType: EntityAccountBalance['accountType'],
  naturalBalanceCents: number,
  opts: Partial<Pick<EntityAccountBalance, 'isEliminating' | 'role' | 'accountName'>> = {},
): EntityAccountBalance => ({
  entityId,
  accountNumber,
  accountName: opts.accountName ?? `${accountType} ${accountNumber}`,
  accountType,
  isEliminating: opts.isEliminating ?? false,
  role: opts.role ?? null,
  naturalBalanceCents,
});

const full = (entityId: string, name: string, ownershipPercent = 100): EntityMeta => ({
  entityId,
  name,
  method: 'FULL',
  ownershipPercent,
});

describe('helpers', () => {
  it('entityNetIncomeCents = revenue − (COGS+OPEX+OTHER)', () => {
    const b = [
      bal('A', '4000', 'REVENUE', 100_000),
      bal('A', '5000', 'COGS', 40_000),
      bal('A', '6000', 'OPEX', 25_000),
      bal('A', '7000', 'OTHER', 5_000),
      bal('B', '4000', 'REVENUE', 999_999), // different entity ignored
    ];
    expect(entityNetIncomeCents(b, 'A')).toBe(30_000);
  });

  it('booked vs period-end equity (period-end folds in current earnings)', () => {
    const b = [
      bal('A', '3000', 'EQUITY', 200_000),
      bal('A', '4000', 'REVENUE', 80_000),
      bal('A', '6000', 'OPEX', 30_000),
    ];
    expect(entityBookedEquityCents(b, 'A')).toBe(200_000);
    expect(entityPeriodEndEquityCents(b, 'A')).toBe(250_000); // 200k + (80k−30k)
  });

  it('isEliminatingAccount honors the flag and the role set', () => {
    const roles = new Set(['INTERCOMPANY_AR', 'INTERCOMPANY_AP']);
    expect(isEliminatingAccount({ isEliminating: true, role: null }, roles)).toBe(true);
    expect(isEliminatingAccount({ isEliminating: false, role: 'INTERCOMPANY_AR' }, roles)).toBe(true);
    expect(isEliminatingAccount({ isEliminating: false, role: 'AR_CONTROL' }, roles)).toBe(false);
  });
});

describe('single-entity degrade', () => {
  it('one FULL/100% entity consolidates to itself (no NCI, no equity method)', () => {
    const balances = [
      bal('A', '1000', 'ASSET', 500_000),
      bal('A', '2000', 'LIABILITY', 150_000),
      bal('A', '3000', 'EQUITY', 300_000),
      bal('A', '4000', 'REVENUE', 90_000),
      bal('A', '6000', 'OPEX', 40_000),
    ];
    // No entities/structure passed → defaults to FULL/100.
    const r = consolidate({ entities: [], balances });
    expect(r.entitiesFull).toEqual(['A']);
    expect(r.equityMethod).toHaveLength(0);
    expect(r.nci.equityCents).toBe(0);
    expect(r.nci.netIncomeCents).toBe(0);
    expect(r.totals.assetsCents).toBe(500_000);
    expect(r.totals.liabilitiesCents).toBe(150_000);
    expect(r.totals.netIncomeFullCents).toBe(50_000);
    expect(r.totals.netIncomeCents).toBe(50_000);
    expect(r.totals.netIncomeParentCents).toBe(50_000);
    // A balanced TB (assets 500k = liab 150k + equity 300k + NI 50k) ties.
    expect(r.totals.balanceCheckCents).toBe(0);
  });
});

describe('eliminations', () => {
  it('nets is_eliminating interdept revenue/cost to zero across the group', () => {
    const balances = [
      // Genuine third-party P&L on non-eliminating accounts stays.
      bal('A', '4000', 'REVENUE', 200_000),
      bal('B', '6000', 'OPEX', 60_000),
      // Interdepartmental services: A charges, B bears — must net to zero.
      bal('A', '4990', 'REVENUE', 50_000, { isEliminating: true }),
      bal('B', '5990', 'COGS', 50_000, { isEliminating: true }),
    ];
    const r = consolidate({ entities: [full('A', 'A'), full('B', 'B')], balances });

    // Eliminating accounts consolidate to zero; residual is exactly 0.
    expect(r.totals.eliminatingResidualCents).toBe(0);
    const elimRev = r.accounts.find((a) => a.accountNumber === '4990')!;
    const elimCost = r.accounts.find((a) => a.accountNumber === '5990')!;
    expect(elimRev.consolidatedCents).toBe(0);
    expect(elimCost.consolidatedCents).toBe(0);
    expect(elimRev.eliminationCents).toBe(-50_000);
    expect(elimCost.eliminationCents).toBe(-50_000);
    expect(r.totals.eliminationsCents).toBe(-100_000);

    // Third-party revenue/expense (and net income) untouched by internal activity.
    expect(r.totals.revenueCents).toBe(200_000);
    expect(r.totals.opexCents).toBe(60_000);
    expect(r.totals.netIncomeFullCents).toBe(140_000);
  });

  it('eliminates intercompany AR/AP by role, keeping the balance sheet tied', () => {
    const balances = [
      bal('A', '1160', 'ASSET', 75_000, { role: 'INTERCOMPANY_AR' }),
      bal('B', '2020', 'LIABILITY', 75_000, { role: 'INTERCOMPANY_AP' }),
      bal('A', '1000', 'ASSET', 300_000),
      bal('A', '3000', 'EQUITY', 375_000),
      bal('B', '1000', 'ASSET', 75_000),
    ];
    const r = consolidate({ entities: [full('A', 'A'), full('B', 'B')], balances });
    const ar = r.accounts.find((a) => a.accountNumber === '1160')!;
    const ap = r.accounts.find((a) => a.accountNumber === '2020')!;
    expect(ar.consolidatedCents).toBe(0);
    expect(ap.consolidatedCents).toBe(0);
    // Consolidated assets = 300k + 75k (interco AR eliminated) = 375k = equity.
    expect(r.totals.assetsCents).toBe(375_000);
    expect(r.totals.liabilitiesCents).toBe(0);
    expect(r.totals.balanceCheckCents).toBe(0);
  });

  it('eliminate=false is a pass-through (nothing netted)', () => {
    const balances = [
      bal('A', '4990', 'REVENUE', 50_000, { isEliminating: true }),
      bal('B', '5990', 'COGS', 50_000, { isEliminating: true }),
    ];
    const r = consolidate({
      entities: [full('A', 'A'), full('B', 'B')],
      balances,
      eliminate: false,
    });
    expect(r.totals.eliminationsCents).toBe(0);
    const elimRev = r.accounts.find((a) => a.accountNumber === '4990')!;
    expect(elimRev.consolidatedCents).toBe(50_000); // not netted
    expect(r.eliminationsApplied).toBe(false);
  });
});

describe('non-controlling interest (NCI)', () => {
  it('carves the minority share of a partially-owned subsidiary equity and earnings', () => {
    // Parent P wholly owned; Sub S is 80% owned → 20% minority.
    const balances = [
      // Parent
      bal('P', '1000', 'ASSET', 1_000_000),
      bal('P', '3000', 'EQUITY', 800_000),
      bal('P', '4000', 'REVENUE', 300_000),
      bal('P', '6000', 'OPEX', 100_000),
      // Subsidiary S: equity 500k, NI = 200k − 50k = 150k, period-end equity 650k.
      bal('S', '1000', 'ASSET', 700_000),
      bal('S', '3000', 'EQUITY', 500_000),
      bal('S', '4000', 'REVENUE', 200_000),
      bal('S', '6000', 'OPEX', 50_000),
    ];
    const entities = [full('P', 'Parent', 100), full('S', 'Sub', 80)];
    const r = consolidate({ entities, balances });

    // NCI equity = 20% × 650k = 130k; NCI NI = 20% × 150k = 30k.
    expect(r.nci.equityCents).toBe(130_000);
    expect(r.nci.netIncomeCents).toBe(30_000);
    expect(r.nci.byEntity).toHaveLength(1);
    expect(r.nci.byEntity[0].entityId).toBe('S');
    expect(r.nci.byEntity[0].minorityPercent).toBeCloseTo(20, 4);

    // Consolidated (100% line-by-line) NI = parent 200k + sub 150k = 350k.
    expect(r.totals.netIncomeFullCents).toBe(350_000);
    expect(r.totals.netIncomeCents).toBe(350_000);
    // Split: NCI 30k, parent 320k.
    expect(r.totals.netIncomeNciCents).toBe(30_000);
    expect(r.totals.netIncomeParentCents).toBe(320_000);
    // 100% of the sub rolls in: assets 1,000k + 700k = 1,700k.
    expect(r.totals.assetsCents).toBe(1_700_000);
  });

  it('rounds the minority share to the nearest cent deterministically', () => {
    // 1/3 minority of an odd-cent equity exercises Math.round once.
    const balances = [
      bal('S', '3000', 'EQUITY', 100_001), // period-end equity = 100,001 (no P&L)
    ];
    const r = consolidate({ entities: [full('S', 'Sub', 66.6667)], balances });
    // minority = 33.3333% → round(0.333333 * 100001) = round(33333.6...) = 33334
    const minority = (100 - 66.6667) / 100;
    expect(r.nci.equityCents).toBe(Math.round(minority * 100_001));
  });
});

describe('equity method vs full', () => {
  it('collapses an equity-method affiliate to a one-line investment + earnings', () => {
    const balances = [
      bal('P', '1000', 'ASSET', 1_000_000),
      bal('P', '3000', 'EQUITY', 1_000_000),
      // Affiliate F: not rolled in line-by-line.
      bal('F', '1000', 'ASSET', 400_000),
      bal('F', '3000', 'EQUITY', 300_000), // period-end equity = 300k + 100k NI = 400k
      bal('F', '4000', 'REVENUE', 250_000),
      bal('F', '6000', 'OPEX', 150_000), // NI = 100k
    ];
    const entities: EntityMeta[] = [
      full('P', 'Parent', 100),
      { entityId: 'F', name: 'Affiliate', method: 'EQUITY', ownershipPercent: 30 },
    ];
    const r = consolidate({ entities, balances });

    // Affiliate is NOT in the line-by-line accounts (no F contribution).
    expect(r.entitiesEquityMethod).toEqual(['F']);
    const anyF = r.accounts.some((a) => Object.keys(a.byEntity).includes('F'));
    expect(anyF).toBe(false);
    // Assets are ONLY the parent's — the affiliate is one investment line, not rolled in.
    expect(r.totals.assetsCents).toBe(1_000_000);

    // One equity-method line: investment = 30% × 400k = 120k; earnings = 30% × 100k = 30k.
    expect(r.equityMethod).toHaveLength(1);
    expect(r.equityMethod[0].investmentCents).toBe(120_000);
    expect(r.equityMethod[0].equityInEarningsCents).toBe(30_000);

    // Total consolidated NI = FULL group (parent 0 P&L) + equity pickup 30k.
    expect(r.totals.netIncomeFullCents).toBe(0);
    expect(r.totals.netIncomeCents).toBe(30_000);
    expect(r.totals.netIncomeParentCents).toBe(30_000);
  });

  it('excludes NONE-method entities entirely', () => {
    const balances = [
      bal('P', '1000', 'ASSET', 500_000),
      bal('X', '1000', 'ASSET', 999_000),
      bal('X', '4000', 'REVENUE', 999_000),
    ];
    const entities: EntityMeta[] = [
      full('P', 'Parent', 100),
      { entityId: 'X', name: 'Excluded', method: 'NONE', ownershipPercent: 10 },
    ];
    const r = consolidate({ entities, balances });
    expect(r.entitiesExcluded).toEqual(['X']);
    expect(r.totals.assetsCents).toBe(500_000); // X not rolled in
    expect(r.totals.revenueCents).toBe(0);
    expect(r.equityMethod).toHaveLength(0);
  });
});

describe('mixed group end-to-end', () => {
  it('combines full + NCI + equity-method + eliminations coherently', () => {
    const balances = [
      // Parent P (100%)
      bal('P', '1000', 'ASSET', 2_000_000),
      bal('P', '2000', 'LIABILITY', 400_000),
      bal('P', '3000', 'EQUITY', 1_600_000),
      bal('P', '4000', 'REVENUE', 500_000),
      bal('P', '6000', 'OPEX', 200_000),
      // Interco: P lent S; nets on consolidation.
      bal('P', '1160', 'ASSET', 100_000, { role: 'INTERCOMPANY_AR' }),
      bal('S', '2020', 'LIABILITY', 100_000, { role: 'INTERCOMPANY_AP' }),
      // Sub S (75% owned) — full consolidation + NCI.
      bal('S', '1000', 'ASSET', 600_000),
      bal('S', '3000', 'EQUITY', 300_000),
      bal('S', '4000', 'REVENUE', 300_000),
      bal('S', '6000', 'OPEX', 100_000), // S NI = 200k; period-end equity 500k
      // Affiliate F (equity method, 40%)
      bal('F', '3000', 'EQUITY', 250_000),
      bal('F', '4000', 'REVENUE', 100_000),
      bal('F', '6000', 'OPEX', 50_000), // F NI = 50k; period-end equity 300k
    ];
    const entities: EntityMeta[] = [
      full('P', 'Parent', 100),
      full('S', 'Sub', 75),
      { entityId: 'F', name: 'Affiliate', method: 'EQUITY', ownershipPercent: 40 },
    ];
    const r = consolidate({ entities, balances });

    // Interco eliminated.
    expect(r.totals.eliminatingResidualCents).toBe(0);
    // FULL net income = P(300k) + S(200k) = 500k.
    expect(r.totals.netIncomeFullCents).toBe(500_000);
    // Equity pickup from F = 40% × 50k = 20k → total NI 520k.
    expect(r.equityMethod[0].equityInEarningsCents).toBe(20_000);
    expect(r.totals.netIncomeCents).toBe(520_000);
    // NCI: 25% of S. NI share = 25% × 200k = 50k; equity share = 25% × 500k = 125k.
    expect(r.totals.netIncomeNciCents).toBe(50_000);
    expect(r.nci.equityCents).toBe(125_000);
    // Parent-attributable NI = 520k − 50k = 470k.
    expect(r.totals.netIncomeParentCents).toBe(470_000);
    // Assets = P 2,000k + S 600k (interco AR 100k eliminated) = 2,600k.
    expect(r.totals.assetsCents).toBe(2_600_000);
  });
});
