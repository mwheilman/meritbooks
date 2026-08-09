/**
 * Onboarding conversion — opening-TB balance validator + mapping application.
 *
 * These are the two correctness-critical pure functions:
 *   • validateOpeningBalance — the blocking tie-out check (debits == credits).
 *   • applyMapping           — folds source amounts into target accounts, in code,
 *                              so the AI mapping can never move a balance.
 * All fixtures are in cents.
 */

import { describe, it, expect } from 'vitest';
import {
  applyMapping,
  validateOpeningBalance,
  validateBalanceSheet,
  buildOpeningEntryLines,
  tieOutBlockers,
  distinctSourceAccounts,
  type SourceLine,
  type MappingTable,
  type TargetAccount,
  type OpeningBalanceLine,
} from './conversion';

const targets: TargetAccount[] = [
  { accountNumber: '1000', name: 'Operating Bank', accountType: 'ASSET' },
  { accountNumber: '1100', name: 'Accounts Receivable', accountType: 'ASSET' },
  { accountNumber: '2000', name: 'Accounts Payable', accountType: 'LIABILITY' },
  { accountNumber: '3000', name: 'Owners Capital', accountType: 'EQUITY' },
  { accountNumber: '4000', name: 'Revenue', accountType: 'REVENUE' },
];

// A balanced source TB: cash 100 + AR 50 (debits) = AP 30 + equity 120 (credits).
const balancedSource: SourceLine[] = [
  { sourceAccount: 'CASH', sourceName: 'Cash in Bank', debitCents: 10_000, creditCents: 0 },
  { sourceAccount: 'AR', sourceName: 'Receivables', debitCents: 5_000, creditCents: 0 },
  { sourceAccount: 'AP', sourceName: 'Payables', debitCents: 0, creditCents: 3_000 },
  { sourceAccount: 'EQ', sourceName: 'Capital', debitCents: 0, creditCents: 12_000 },
];

const fullMapping: MappingTable = {
  CASH: { targetAccountNumber: '1000', confidence: 0.99, source: 'heuristic' },
  AR: { targetAccountNumber: '1100', confidence: 0.9, source: 'ai' },
  AP: { targetAccountNumber: '2000', confidence: 0.9, source: 'ai' },
  EQ: { targetAccountNumber: '3000', confidence: 0.8, source: 'ai' },
};

describe('validateOpeningBalance', () => {
  it('reports balanced when debits equal credits', () => {
    const lines: OpeningBalanceLine[] = [
      { targetAccountNumber: '1000', targetName: 'Bank', debitCents: 15_000, creditCents: 0, sourceAccounts: [] },
      { targetAccountNumber: '3000', targetName: 'Equity', debitCents: 0, creditCents: 15_000, sourceAccounts: [] },
    ];
    const check = validateOpeningBalance(lines);
    expect(check).toEqual({ balanced: true, totalDebitCents: 15_000, totalCreditCents: 15_000, differenceCents: 0 });
  });

  it('reports the exact out-of-balance difference (debits heavy)', () => {
    const lines: OpeningBalanceLine[] = [
      { targetAccountNumber: '1000', targetName: 'Bank', debitCents: 15_001, creditCents: 0, sourceAccounts: [] },
      { targetAccountNumber: '3000', targetName: 'Equity', debitCents: 0, creditCents: 15_000, sourceAccounts: [] },
    ];
    const check = validateOpeningBalance(lines);
    expect(check.balanced).toBe(false);
    expect(check.differenceCents).toBe(1); // one cent over on the debit side
  });

  it('an empty TB is trivially balanced at zero', () => {
    expect(validateOpeningBalance([])).toEqual({ balanced: true, totalDebitCents: 0, totalCreditCents: 0, differenceCents: 0 });
  });
});

describe('applyMapping', () => {
  it('assembles a balanced opening TB from a balanced, fully-mapped source', () => {
    const tb = applyMapping(balancedSource, fullMapping, targets);
    expect(tb.balance.balanced).toBe(true);
    expect(tb.balance.totalDebitCents).toBe(15_000);
    expect(tb.balance.totalCreditCents).toBe(15_000);
    expect(tb.unmapped).toEqual([]);
    expect(tb.unknownTargets).toEqual([]);
    expect(tb.openingBalances).toHaveLength(4);
    const bank = tb.openingBalances.find((l) => l.targetAccountNumber === '1000')!;
    expect(bank.debitCents).toBe(10_000);
    expect(bank.creditCents).toBe(0);
    expect(bank.targetName).toBe('Operating Bank');
  });

  it('NETS multiple source accounts that map to the same target', () => {
    const src: SourceLine[] = [
      { sourceAccount: 'CHK', sourceName: 'Checking', debitCents: 8_000, creditCents: 0 },
      { sourceAccount: 'SAV', sourceName: 'Savings', debitCents: 2_000, creditCents: 0 },
      { sourceAccount: 'EQ', sourceName: 'Capital', debitCents: 0, creditCents: 10_000 },
    ];
    const map: MappingTable = {
      CHK: { targetAccountNumber: '1000', confidence: 1, source: 'human' },
      SAV: { targetAccountNumber: '1000', confidence: 1, source: 'human' },
      EQ: { targetAccountNumber: '3000', confidence: 1, source: 'human' },
    };
    const tb = applyMapping(src, map, targets);
    const bank = tb.openingBalances.find((l) => l.targetAccountNumber === '1000')!;
    expect(bank.debitCents).toBe(10_000); // 8,000 + 2,000 netted into one line
    expect(bank.sourceAccounts).toEqual(['CHK', 'SAV']);
    expect(tb.balance.balanced).toBe(true);
  });

  it('nets a debit and a credit on the same target to the residual', () => {
    const src: SourceLine[] = [
      { sourceAccount: 'A', sourceName: null, debitCents: 7_000, creditCents: 0 },
      { sourceAccount: 'B', sourceName: null, debitCents: 0, creditCents: 2_000 },
      { sourceAccount: 'EQ', sourceName: null, debitCents: 0, creditCents: 5_000 },
    ];
    const map: MappingTable = {
      A: { targetAccountNumber: '1000', confidence: 1, source: 'human' },
      B: { targetAccountNumber: '1000', confidence: 1, source: 'human' },
      EQ: { targetAccountNumber: '3000', confidence: 1, source: 'human' },
    };
    const tb = applyMapping(src, map, targets);
    const bank = tb.openingBalances.find((l) => l.targetAccountNumber === '1000')!;
    expect(bank.debitCents).toBe(5_000); // 7,000 DR − 2,000 CR
    expect(bank.creditCents).toBe(0);
  });

  it('flags source accounts with a balance that are not mapped', () => {
    const map: MappingTable = { ...fullMapping };
    delete map.AP; // leave AP (a credit balance) unmapped
    const tb = applyMapping(balancedSource, map, targets);
    expect(tb.unmapped).toContain('AP');
    expect(tb.balance.balanced).toBe(false); // dropping AP breaks the balance
    expect(tieOutBlockers(tb).length).toBeGreaterThan(0);
  });

  it('flags a mapped target that does not exist in the chart of accounts', () => {
    const map: MappingTable = { ...fullMapping, EQ: { targetAccountNumber: '9999', confidence: 0.5, source: 'ai' } };
    const tb = applyMapping(balancedSource, map, targets);
    expect(tb.unknownTargets).toContain('9999');
  });

  it('ignores zero-balance source rows (no mapping required)', () => {
    const src: SourceLine[] = [
      ...balancedSource,
      { sourceAccount: 'DEAD', sourceName: 'Closed account', debitCents: 0, creditCents: 0 },
    ];
    const tb = applyMapping(src, fullMapping, targets);
    expect(tb.unmapped).not.toContain('DEAD');
    expect(tb.balance.balanced).toBe(true);
  });

  it('exposes the raw source totals for book-vs-source reconciliation', () => {
    const tb = applyMapping(balancedSource, fullMapping, targets);
    expect(tb.sourceTotals).toEqual({ debitCents: 15_000, creditCents: 15_000 });
  });
});

describe('validateBalanceSheet', () => {
  it('ties on its own when only balance-sheet accounts carry balances', () => {
    const tb = applyMapping(balancedSource, fullMapping, targets);
    const bs = tb.balanceSheet;
    expect(bs.assetsCents).toBe(15_000); // cash 10,000 + AR 5,000
    expect(bs.liabilitiesCents).toBe(3_000);
    expect(bs.equityCents).toBe(12_000);
    expect(bs.plNetCents).toBe(0);
    expect(bs.standalone).toBe(true);
    expect(bs.untyped).toEqual([]);
  });

  it('does NOT stand alone when an income-statement account carries a balance', () => {
    // Mid-year: revenue 4,000 CR sits open; equity absorbs less so the TB still balances.
    const src: SourceLine[] = [
      { sourceAccount: 'CASH', sourceName: 'Cash', debitCents: 12_000, creditCents: 0 },
      { sourceAccount: 'EQ', sourceName: 'Capital', debitCents: 0, creditCents: 8_000 },
      { sourceAccount: 'REV', sourceName: 'Sales', debitCents: 0, creditCents: 4_000 },
    ];
    const map: MappingTable = {
      CASH: { targetAccountNumber: '1000', confidence: 1, source: 'human' },
      EQ: { targetAccountNumber: '3000', confidence: 1, source: 'human' },
      REV: { targetAccountNumber: '4000', confidence: 1, source: 'human' },
    };
    const tb = applyMapping(src, map, targets);
    expect(tb.balance.balanced).toBe(true); // debits == credits
    expect(tb.balanceSheet.plNetCents).toBe(4_000); // open revenue
    expect(tb.balanceSheet.standalone).toBe(false);
    // Blocks tie-out until acknowledged; passes once the user confirms mid-year go-live.
    expect(tieOutBlockers(tb).some((b) => b.toLowerCase().includes('balance sheet'))).toBe(true);
    expect(tieOutBlockers(tb, { plAcknowledged: true })).toEqual([]);
  });
});

describe('tieOutBlockers', () => {
  it('is empty for a balanced, fully-mapped, ≥2-line TB (clean year-end)', () => {
    const tb = applyMapping(balancedSource, fullMapping, targets);
    expect(tieOutBlockers(tb)).toEqual([]);
    expect(validateBalanceSheet(tb.openingBalances).standalone).toBe(true);
  });

  it('blocks a single-line TB even if it were "balanced"', () => {
    const single: SourceLine[] = [{ sourceAccount: 'X', sourceName: null, debitCents: 0, creditCents: 0 }];
    const tb = applyMapping(single, { X: { targetAccountNumber: '1000', confidence: 1, source: 'human' } }, targets);
    expect(tieOutBlockers(tb).some((b) => b.includes('at least two'))).toBe(true);
  });
});

describe('buildOpeningEntryLines', () => {
  it('builds balanced engine lines and resolves account ids', () => {
    const tb = applyMapping(balancedSource, fullMapping, targets);
    const ids = new Map([
      ['1000', 'id-1000'],
      ['1100', 'id-1100'],
      ['2000', 'id-2000'],
      ['3000', 'id-3000'],
    ]);
    const { lines, missing } = buildOpeningEntryLines(tb.openingBalances, ids);
    expect(missing).toEqual([]);
    const dr = lines.reduce((s, l) => s + l.debit_cents, 0);
    const cr = lines.reduce((s, l) => s + l.credit_cents, 0);
    expect(dr).toBe(cr);
    expect(dr).toBe(15_000);
    expect(lines.every((l) => l.account_id.startsWith('id-'))).toBe(true);
  });

  it('reports target account numbers with no id (blocks the post)', () => {
    const tb = applyMapping(balancedSource, fullMapping, targets);
    const ids = new Map([['1000', 'id-1000']]); // deliberately incomplete
    const { missing } = buildOpeningEntryLines(tb.openingBalances, ids);
    expect(missing).toContain('1100');
    expect(missing).toContain('2000');
    expect(missing).toContain('3000');
  });
});

describe('distinctSourceAccounts (no balances leave this function)', () => {
  it('dedupes and keeps the first non-empty name; carries NO amounts', () => {
    const src: SourceLine[] = [
      { sourceAccount: 'CASH', sourceName: '', debitCents: 100, creditCents: 0 },
      { sourceAccount: 'CASH', sourceName: 'Cash in Bank', debitCents: 200, creditCents: 0 },
    ];
    const distinct = distinctSourceAccounts(src);
    expect(distinct).toHaveLength(1);
    expect(distinct[0]).toEqual({ sourceAccount: 'CASH', sourceName: 'Cash in Bank' });
    // The returned shape has exactly two keys — no debit/credit can leak to the AI.
    expect(Object.keys(distinct[0]).sort()).toEqual(['sourceAccount', 'sourceName']);
  });
});
