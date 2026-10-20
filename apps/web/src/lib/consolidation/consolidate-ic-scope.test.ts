import { describe, it, expect } from 'vitest';
import {
  consolidate,
  balanceCheckEffectOfRemoval,
  UNCLOSED_EARNINGS_ACCOUNT_NAME,
  UNCLOSED_EARNINGS_ACCOUNT_NUMBER,
  type EntityAccountBalance,
  type EntityMeta,
} from './consolidate';

/**
 * Audit L5 — consolidation balance check read −$50,000 for a one-entity group:
 * Coho's $50,000 intercompany receivable from Northwind was eliminated although
 * Northwind (the counterparty) was not in the group, so assets dropped $50,000
 * with nothing offsetting it. Live ledger figures below.
 */

const COHO = 'coho';
const NWC = 'nwc';
const b = (
  entityId: string,
  accountNumber: string,
  accountType: EntityAccountBalance['accountType'],
  naturalBalanceCents: number,
  extra: Partial<EntityAccountBalance> = {},
): EntityAccountBalance => ({
  entityId,
  accountNumber,
  accountName: accountNumber,
  accountType,
  isEliminating: false,
  role: null,
  naturalBalanceCents,
  ...extra,
});
const full = (entityId: string): EntityMeta => ({ entityId, name: entityId, method: 'FULL', ownershipPercent: 100 });

// Coho as of 2026-10-19 (FY Jan period 2026-01-01..2026-10-19): P&L in period = +$488.
const cohoTb: EntityAccountBalance[] = [
  b(COHO, '1000', 'ASSET', 141_000_000),
  b(COHO, '1010', 'ASSET', 48_800),
  b(COHO, '1160', 'ASSET', 5_000_000, { role: 'INTERCOMPANY_AR', counterpartyEntityId: NWC }),
  b(COHO, '2500', 'LIABILITY', 146_000_000),
  b(COHO, '6520', 'OPEX', 1_200),
  b(COHO, '6530', 'OPEX', -50_000),
];
// Northwind: IC payable to Coho $50,000 + its own activity.
const nwcTb: EntityAccountBalance[] = [
  b(NWC, '1000', 'ASSET', 5_000_000),
  b(NWC, '1100', 'ASSET', 14_990_000),
  b(NWC, '1095', 'ASSET', 9_700),
  b(NWC, '2020', 'LIABILITY', 5_000_000, { role: 'INTERCOMPANY_AP', counterpartyEntityId: COHO }),
  b(NWC, '2400', 'LIABILITY', 12_000_000),
  b(NWC, '2410', 'LIABILITY', 15_000_000),
  b(NWC, '5000', 'COGS', 12_000_000),
  b(NWC, '4990', 'REVENUE', 500_000, { isEliminating: true }),
  b(NWC, '5990', 'COGS', 500_000, { isEliminating: true }),
  b(NWC, '6630', 'OPEX', 300),
];

describe('intercompany elimination is scoped to the consolidation group', () => {
  it('one-entity group (Coho only): the IC receivable from an OUTSIDE company is kept; check = 0', () => {
    const r = consolidate({ entities: [full(COHO)], balances: cohoTb });
    expect(r.totals.balanceCheckCents).toBe(0); // was −5,000,000 (−$50,000)
    expect(r.totals.assetsCents).toBe(146_048_800);
    expect(r.totals.externalIntercompanyCents).toBe(5_000_000);
    expect(r.totals.eliminationsCents).toBe(0);
    expect(r.totals.eliminatingResidualCents).toBe(0);
  });

  it('full group (Coho + Northwind): the IC pair eliminates both sides; check = 0', () => {
    const r = consolidate({ entities: [full(COHO), full(NWC)], balances: [...cohoTb, ...nwcTb] });
    const ar = r.accounts.find((a) => a.accountNumber === '1160')!;
    const ap = r.accounts.find((a) => a.accountNumber === '2020')!;
    expect(ar.consolidatedCents).toBe(0);
    expect(ap.consolidatedCents).toBe(0);
    expect(r.totals.externalIntercompanyCents).toBe(0);
    expect(r.totals.eliminatingResidualCents).toBe(0);
    expect(r.totals.balanceCheckCents).toBe(0);
  });

  it('a mismatched IC pair inside the group is surfaced as the residual (= the balance-check gap)', () => {
    const mismatched = nwcTb.map((x) => (x.accountNumber === '2020' ? { ...x, naturalBalanceCents: 4_500_000 } : x));
    // Make Northwind's own TB balance with the smaller payable (plug its equity).
    const nwc = [...mismatched, b(NWC, '3000', 'EQUITY', 500_000)];
    const r = consolidate({ entities: [full(COHO), full(NWC)], balances: [...cohoTb, ...nwc] });
    expect(r.totals.eliminatingResidualCents).toBe(-500_000);
    expect(r.totals.balanceCheckCents).toBe(r.totals.eliminatingResidualCents);
  });

  it('legacy IC lines with no counterparty tag eliminate only in a multi-entity group', () => {
    const untagged = [b(COHO, '1160', 'ASSET', 5_000_000, { role: 'INTERCOMPANY_AR' }), b(COHO, '2500', 'LIABILITY', 5_000_000)];
    expect(consolidate({ entities: [full(COHO)], balances: untagged }).totals.eliminationsCents).toBe(0);
    expect(
      consolidate({ entities: [full(COHO), full(NWC)], balances: untagged }).totals.eliminationsCents,
    ).toBe(-5_000_000);
  });

  it('removal effect signs', () => {
    expect(balanceCheckEffectOfRemoval('ASSET', 100)).toBe(-100);
    expect(balanceCheckEffectOfRemoval('LIABILITY', 100)).toBe(100);
    expect(balanceCheckEffectOfRemoval('REVENUE', 100)).toBe(100);
    expect(balanceCheckEffectOfRemoval('COGS', 100)).toBe(-100);
  });
});

describe('pre-period earnings roll into equity (loader convention)', () => {
  it('a monthly snapshot balances when earlier-month P&L is folded into the unclosed-earnings line', () => {
    // Coho, October 2026 period: none of its P&L falls in October; the $488 is
    // earlier in the year. Without the fold the snapshot read "Out of balance by $488".
    const tb: EntityAccountBalance[] = [
      b(COHO, '1000', 'ASSET', 141_000_000),
      b(COHO, '1010', 'ASSET', 48_800),
      b(COHO, '1160', 'ASSET', 5_000_000, { role: 'INTERCOMPANY_AR', counterpartyEntityId: NWC }),
      b(COHO, '2500', 'LIABILITY', 146_000_000),
    ];
    const before = consolidate({ entities: [full(COHO)], balances: tb, eliminate: false });
    expect(before.totals.balanceCheckCents).toBe(48_800);
    const withFold = [
      ...tb,
      { ...b(COHO, UNCLOSED_EARNINGS_ACCOUNT_NUMBER, 'EQUITY', 48_800), accountName: UNCLOSED_EARNINGS_ACCOUNT_NAME },
    ];
    const after = consolidate({ entities: [full(COHO)], balances: withFold, eliminate: false });
    expect(after.totals.balanceCheckCents).toBe(0);
    expect(after.totals.equitySectionCents).toBe(48_800);
  });
});
